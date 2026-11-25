use super::resp::{Failure, Reply, Wire};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const VALUE_BATCH: u64 = 32;
pub(super) const DISPLAY_BYTES: usize = 512;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedisKeyType {
    String,
    Hash,
    List,
    Set,
    Zset,
    Stream,
}

impl RedisKeyType {
    fn name(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Hash => "hash",
            Self::List => "list",
            Self::Set => "set",
            Self::Zset => "zset",
            Self::Stream => "stream",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedisScanInput {
    cursor: String,
    pattern: String,
    kind: Option<RedisKeyType>,
}

#[derive(Serialize)]
pub struct RedisKeyPage {
    keys: Vec<RedisKey>,
    cursor: String,
    total: Option<u64>,
}

#[derive(Serialize)]
struct RedisKey {
    id: String,
    display: RedisBytes,
}

#[derive(Clone, Serialize)]
pub(super) struct RedisBytes {
    text: String,
    encoding: &'static str,
    pub bytes: usize,
    pub truncated: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedisValueInput {
    key: String,
    position: Option<Position>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Position {
    Index { index: u64 },
    Scan { cursor: String },
    Stream { after: String },
}

#[derive(Serialize)]
pub struct RedisValuePage {
    kind: String,
    ttl_ms: Option<u64>,
    memory_bytes: Option<u64>,
    length: Option<u64>,
    columns: Vec<&'static str>,
    rows: Vec<Vec<RedisBytes>>,
    next: Option<Position>,
}

pub(super) async fn scan(wire: &mut Wire, input: RedisScanInput) -> Result<RedisKeyPage, Failure> {
    let cursor = validate_cursor(&input.cursor)?;
    if input.pattern.len() > 1024 {
        return Err(Failure::Server(
            "Redis 검색 패턴은 1,024바이트 이하로 입력하세요.",
        ));
    }
    let pattern = if input.pattern.is_empty() {
        b"*".as_slice()
    } else {
        input.pattern.as_bytes()
    };
    let mut command = vec![
        b"SCAN".as_slice(),
        cursor.as_bytes(),
        b"MATCH",
        pattern,
        b"COUNT",
        b"100",
    ];
    if let Some(kind) = input.kind {
        command.extend([b"TYPE", kind.name().as_bytes()]);
    }
    let (cursor, entries) = scan_reply(wire.command(&command).await?)?;
    let mut seen = HashSet::new();
    let mut keys = Vec::new();
    for entry in entries {
        let key = entry.bytes()?;
        let id = STANDARD.encode(&key);
        if seen.insert(id.clone()) {
            keys.push(RedisKey {
                display: display(&key, false),
                id,
            });
        }
    }
    let total = optional_size(wire, &[b"DBSIZE"]).await?;
    Ok(RedisKeyPage {
        keys,
        cursor,
        total,
    })
}

pub(super) async fn value(
    wire: &mut Wire,
    input: RedisValueInput,
) -> Result<RedisValuePage, Failure> {
    let key = key_bytes(&input.key)?;
    let kind = wire.command(&[b"TYPE", &key]).await?.bytes()?;
    let kind = std::str::from_utf8(&kind)
        .map_err(|_| Failure::Protocol)?
        .to_owned();
    let ttl = wire.command(&[b"PTTL", &key]).await?.integer()?;
    let mut page = RedisValuePage {
        kind,
        ttl_ms: u64::try_from(ttl).ok(),
        memory_bytes: None,
        length: None,
        columns: vec![],
        rows: vec![],
        next: None,
    };
    if ttl == -2 || page.kind == "none" {
        page.kind = "none".into();
        return Ok(page);
    }
    page.memory_bytes = optional_size(wire, &[b"MEMORY", b"USAGE", &key, b"SAMPLES", b"5"]).await?;
    match page.kind.as_str() {
        "string" | "list" | "zset" => read_indexed(wire, &key, input.position, &mut page).await?,
        "hash" | "set" => read_scanned(wire, &key, input.position, &mut page).await?,
        "stream" => read_stream(wire, &key, input.position, &mut page).await?,
        _ => {}
    }
    Ok(page)
}

async fn read_indexed(
    wire: &mut Wire,
    key: &[u8],
    position: Option<Position>,
    page: &mut RedisValuePage,
) -> Result<(), Failure> {
    let start = match position {
        None => 0,
        Some(Position::Index { index }) if index <= i64::MAX as u64 - DISPLAY_BYTES as u64 => index,
        _ => return Err(position_error()),
    };
    let (length_command, range_command, batch, width): (&[u8], &[u8], u64, usize) =
        match page.kind.as_str() {
            "string" => (b"STRLEN", b"GETRANGE", DISPLAY_BYTES as u64, 1),
            "list" => (b"LLEN", b"LRANGE", VALUE_BATCH, 1),
            _ => (b"ZCARD", b"ZRANGE", VALUE_BATCH, 2),
        };
    page.columns = if width == 2 {
        vec!["멤버", "점수"]
    } else {
        vec!["값"]
    };
    let length = numeric_size(wire.command(&[length_command, key]).await?)?;
    page.length = Some(length);
    let offset = start.to_string();
    let end = (start + batch - 1).to_string();
    let mut args = vec![range_command, key, offset.as_bytes(), end.as_bytes()];
    if width == 2 {
        args.push(b"WITHSCORES");
    }
    let response = wire.command(&args).await?;
    if page.kind == "string" {
        page.rows = vec![vec![display(&response.bytes()?, true)]];
    } else {
        page.rows = display_rows(response.array()?, width)?;
    }
    if start + batch < length {
        page.next = Some(Position::Index {
            index: start + batch,
        });
    }
    Ok(())
}

async fn read_scanned(
    wire: &mut Wire,
    key: &[u8],
    position: Option<Position>,
    page: &mut RedisValuePage,
) -> Result<(), Failure> {
    let start = match position {
        None => "0".to_owned(),
        Some(Position::Scan { cursor }) => validate_cursor(&cursor)?,
        _ => return Err(position_error()),
    };
    let (length, scan_command, width): (&[u8], &[u8], usize) = if page.kind == "hash" {
        (b"HLEN", b"HSCAN", 2)
    } else {
        (b"SCARD", b"SSCAN", 1)
    };
    page.columns = if width == 2 {
        vec!["필드", "값"]
    } else {
        vec!["멤버"]
    };
    page.length = Some(numeric_size(wire.command(&[length, key]).await?)?);
    let (cursor, entries) = scan_reply(
        wire.command(&[scan_command, key, start.as_bytes(), b"COUNT", b"32"])
            .await?,
    )?;
    page.rows = display_rows(entries, width)?;
    if cursor != "0" {
        page.next = Some(Position::Scan { cursor });
    }
    Ok(())
}

async fn read_stream(
    wire: &mut Wire,
    key: &[u8],
    position: Option<Position>,
    page: &mut RedisValuePage,
) -> Result<(), Failure> {
    let start = match position {
        None => "-".to_owned(),
        Some(Position::Stream { after }) if valid_stream_id(&after) => format!("({after}"),
        _ => return Err(position_error()),
    };
    page.columns = vec!["메시지 ID", "필드", "값"];
    page.length = Some(numeric_size(wire.command(&[b"XLEN", key]).await?)?);
    let entries = wire
        .command(&[b"XRANGE", key, start.as_bytes(), b"+", b"COUNT", b"33"])
        .await?
        .array()?;
    let has_more = entries.len() > VALUE_BATCH as usize;
    let mut last = None;
    for entry in entries.into_iter().take(VALUE_BATCH as usize) {
        let (id, fields) = two(entry)?;
        let id = String::from_utf8(id.bytes()?).map_err(|_| Failure::Protocol)?;
        if !valid_stream_id(&id) {
            return Err(Failure::Protocol);
        }
        for pair in display_rows(fields.array()?, 2)? {
            let mut row = vec![display(id.as_bytes(), false)];
            row.extend(pair);
            page.rows.push(row);
        }
        last = Some(id);
    }
    if has_more {
        page.next = last.map(|after| Position::Stream { after });
    }
    Ok(())
}

fn display_rows(entries: Vec<Reply>, width: usize) -> Result<Vec<Vec<RedisBytes>>, Failure> {
    if entries.len() % width != 0 {
        return Err(Failure::Protocol);
    }
    let rows = entries
        .into_iter()
        .map(|entry| entry.bytes().map(|value| display(&value, true)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut cells = rows.into_iter();
    Ok(std::iter::from_fn(|| {
        let first = cells.next()?;
        Some(
            std::iter::once(first)
                .chain(cells.by_ref().take(width - 1))
                .collect(),
        )
    })
    .collect())
}

pub(super) fn key_bytes(id: &str) -> Result<Vec<u8>, Failure> {
    if id.len() > 6 * 1024 * 1024 {
        return Err(Failure::Server("Redis 키가 표시 한도를 넘었습니다."));
    }
    STANDARD
        .decode(id)
        .map_err(|_| Failure::Server("Redis 키 식별자가 올바르지 않습니다."))
}

pub(super) fn display(bytes: &[u8], multiline: bool) -> RedisBytes {
    let limit = bytes.len().min(DISPLAY_BYTES);
    let mut end = limit;
    let data = match std::str::from_utf8(&bytes[..limit]) {
        Ok(text) => Some(text),
        Err(error) if error.error_len().is_none() && limit < bytes.len() => {
            end = error.valid_up_to();
            std::str::from_utf8(&bytes[..end]).ok()
        }
        Err(_) => None,
    };
    if let Some(text) = data.filter(|text| {
        !text
            .chars()
            .any(|ch| ch.is_control() && !(multiline && "\r\n\t".contains(ch)))
    }) {
        return RedisBytes {
            text: text.into(),
            encoding: "utf8",
            bytes: bytes.len(),
            truncated: end < bytes.len(),
        };
    }
    RedisBytes {
        text: bytes[..limit]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        encoding: "hex",
        bytes: bytes.len(),
        truncated: limit < bytes.len(),
    }
}

pub(super) fn valid_stream_id(id: &str) -> bool {
    id.split_once('-').is_some_and(|(time, sequence)| {
        time.parse::<u64>().is_ok() && sequence.parse::<u64>().is_ok()
    })
}

fn position_error() -> Failure {
    Failure::Server("키의 탐색 위치가 달라졌습니다. 처음부터 다시 열어 주세요.")
}

fn validate_cursor(cursor: &str) -> Result<String, Failure> {
    cursor
        .parse::<u64>()
        .map(|value| value.to_string())
        .map_err(|_| Failure::Server("Redis 탐색 커서가 올바르지 않습니다."))
}

fn scan_reply(response: Reply) -> Result<(String, Vec<Reply>), Failure> {
    let (cursor, entries) = two(response)?;
    let cursor = String::from_utf8(cursor.bytes()?).map_err(|_| Failure::Protocol)?;
    Ok((
        validate_cursor(&cursor).map_err(|_| Failure::Protocol)?,
        entries.array()?,
    ))
}

fn two(value: Reply) -> Result<(Reply, Reply), Failure> {
    let [first, second] = value.array()?.try_into().map_err(|_| Failure::Protocol)?;
    Ok((first, second))
}

fn numeric_size(reply: Reply) -> Result<u64, Failure> {
    u64::try_from(reply.integer()?).map_err(|_| Failure::Protocol)
}

async fn optional_size(wire: &mut Wire, command: &[&[u8]]) -> Result<Option<u64>, Failure> {
    match wire.command(command).await {
        Ok(Reply::Null) | Err(Failure::Server(_)) => Ok(None),
        reply => Ok(Some(numeric_size(reply?)?)),
    }
}
