use super::{
    json,
    keys::{
        display, display_complete, display_json, key_bytes, valid_stream_id, RedisBytes,
        DISPLAY_BYTES,
    },
    resp::{Failure, Reply, Wire},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use uuid::Uuid;

const LIFETIME: Duration = Duration::from_secs(300);
const MAX_CHANGE_BYTES: usize = 1024 * 1024;
const MAX_STREAM_FIELDS: usize = 64;
const MAX_DELETE_KEYS: usize = 50;
const MAX_DELETE_NAMES_BYTES: usize = 64 * 1024;
const MAX_TTL_MS: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(tag = "encoding", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputBytes {
    Utf8 { text: String },
    Hex { text: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamField {
    field: InputBytes,
    value: InputBytes,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RedisEditInput {
    String {
        value: InputBytes,
    },
    Hash {
        field: InputBytes,
        value: InputBytes,
    },
    List {
        index: String,
        value: InputBytes,
    },
    Set {
        member: InputBytes,
    },
    Zset {
        member: InputBytes,
        score: String,
    },
    Stream {
        fields: Vec<StreamField>,
    },
    Json {
        original: String,
        document: String,
    },
    Ttl {
        milliseconds: Option<String>,
    },
}

#[derive(Serialize)]
pub struct RedisEditPreview {
    token: String,
    key: RedisBytes,
    kind: &'static str,
    ttl_ms: Option<u64>,
    next_ttl_ms: Option<u64>,
    changes: Vec<Change>,
    stream_length: Option<i64>,
    expires_seconds: u64,
}

#[derive(Serialize)]
pub struct RedisKeyDeletePreview {
    token: String,
    kind: &'static str,
    keys: Vec<RedisBytes>,
    expires_seconds: u64,
}

#[derive(Serialize)]
struct Change {
    selector: Option<RedisBytes>,
    before: Option<RedisBytes>,
    after: RedisBytes,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditStatus {
    Applied,
    Conflict,
    Rejected,
}

#[derive(Serialize)]
pub struct RedisEditReport {
    pub status: EditStatus,
    pub entry_id: Option<String>,
    pub affected_count: usize,
    pub audit_warning: bool,
}

pub(super) struct State {
    pub wire: Wire,
    plan: Option<Plan>,
    pub committing: bool,
}

struct Plan {
    token: Uuid,
    expires: Instant,
    change: PlannedChange,
}

type Bytes = Vec<u8>;

enum PlannedChange {
    Edit { key: Bytes, change: Mutation },
    Delete(Vec<Bytes>),
}

enum Mutation {
    String(Bytes),
    Hash(Bytes, Bytes),
    List(String, Bytes),
    Set(Bytes),
    Zset(Bytes, String),
    Stream(Vec<(Bytes, Bytes)>),
    Json { original: String, document: String },
    Ttl(Option<String>),
}

impl State {
    pub(super) fn new(wire: Wire) -> Self {
        Self {
            wire,
            plan: None,
            committing: false,
        }
    }

    pub(super) async fn expire(&mut self) -> Result<(), Failure> {
        if self
            .plan
            .as_ref()
            .is_some_and(|plan| Instant::now() >= plan.expires)
        {
            self.clear().await?;
        }
        Ok(())
    }

    pub(super) async fn preview(
        &mut self,
        key: String,
        input: RedisEditInput,
    ) -> Result<RedisEditPreview, Failure> {
        let key = key_bytes(&key)?;
        let change = Mutation::parse(input)?;
        self.watch(&[b"WATCH", &key]).await?;
        let token = Uuid::new_v4();
        let preview = self.describe(&key, &change, token).await;
        match preview {
            Ok(preview) => {
                self.remember(token, PlannedChange::Edit { key, change });
                Ok(preview)
            }
            Err(error @ Failure::Server(_)) => {
                self.clear().await?;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn preview_delete(
        &mut self,
        keys: Vec<String>,
    ) -> Result<RedisKeyDeletePreview, Failure> {
        let keys = deletion_keys(keys)?;
        self.watch(&key_command(b"WATCH", &keys)).await?;
        let exists = self
            .wire
            .command(&key_command(b"EXISTS", &keys))
            .await
            .and_then(Reply::integer);
        match exists {
            Ok(count) if count == keys.len() as i64 => {}
            Ok(_) => {
                self.clear().await?;
                return Err(Failure::Server(
                    "선택한 키가 사라졌습니다. 목록을 새로 고친 뒤 다시 선택하세요.",
                ));
            }
            Err(error @ Failure::Server(_)) => {
                self.clear().await?;
                return Err(error);
            }
            Err(error) => return Err(error),
        }
        let token = Uuid::new_v4();
        let preview = RedisKeyDeletePreview {
            token: token.to_string(),
            kind: "delete",
            keys: keys.iter().map(|key| display_complete(key)).collect(),
            expires_seconds: LIFETIME.as_secs(),
        };
        self.remember(token, PlannedChange::Delete(keys));
        Ok(preview)
    }

    async fn watch(&mut self, command: &[&[u8]]) -> Result<(), Failure> {
        if self.plan.is_some() {
            self.clear().await?;
        }
        status(&mut self.wire, command, b"OK").await
    }

    fn remember(&mut self, token: Uuid, change: PlannedChange) {
        self.plan = Some(Plan {
            token,
            expires: Instant::now() + LIFETIME,
            change,
        });
    }

    async fn describe(
        &mut self,
        key: &[u8],
        change: &Mutation,
        token: Uuid,
    ) -> Result<RedisEditPreview, Failure> {
        let kind = change.kind();
        let actual = self.wire.command(&[b"TYPE", key]).await?.bytes()?;
        let expected = if kind == "json" { json::TYPE } else { kind };
        if actual == b"none" || (kind != "ttl" && actual != expected.as_bytes()) {
            return Err(Failure::Server(
                "Redis 키가 사라졌거나 타입이 바뀌었습니다. 키를 다시 열어 주세요.",
            ));
        }
        let ttl = self.wire.command(&[b"PTTL", key]).await?.integer()?;
        if ttl == -2 {
            return Err(Failure::Server("Redis 키가 만료되었습니다."));
        }
        if ttl == -1 && matches!(change, Mutation::Ttl(None)) {
            return Err(Failure::Server(
                "이 키에는 만료 시간이 설정되어 있지 않습니다.",
            ));
        }
        let next_ttl_ms = match change {
            Mutation::Ttl(Some(ms)) => ms.parse().ok(),
            _ => None,
        };
        let (changes, stream_length) = change.describe(&mut self.wire, key).await?;
        Ok(RedisEditPreview {
            token: token.to_string(),
            key: display(key, false),
            kind,
            ttl_ms: u64::try_from(ttl).ok(),
            next_ttl_ms,
            changes,
            stream_length,
            expires_seconds: LIFETIME.as_secs(),
        })
    }

    pub(super) async fn discard(&mut self, token: Uuid) -> Result<(), Failure> {
        if self.plan.as_ref().is_some_and(|plan| plan.token == token) {
            self.clear().await?;
        }
        Ok(())
    }

    async fn clear(&mut self) -> Result<(), Failure> {
        self.plan = None;
        reset(&mut self.wire, b"UNWATCH").await
    }

    pub(super) async fn apply(
        &mut self,
        token: Uuid,
        deleting: bool,
    ) -> Result<RedisEditReport, Failure> {
        if !self.plan.as_ref().is_some_and(|plan| {
            plan.token == token && matches!(plan.change, PlannedChange::Delete(_)) == deleting
        }) {
            return Err(Failure::Server(
                "Redis 변경 미리보기가 만료되었거나 사용되었습니다. 다시 미리 보세요.",
            ));
        }
        let plan = self.plan.take().unwrap();
        if let Err(error) = status(&mut self.wire, &[b"MULTI"], b"OK").await {
            if matches!(error, Failure::Server(_)) {
                self.clear().await?;
            }
            return Err(error);
        }
        let command = plan.change.command();
        if let Err(error) = status(&mut self.wire, &command, b"QUEUED").await {
            if matches!(error, Failure::Server(_)) {
                reset(&mut self.wire, b"DISCARD").await?;
            }
            return Err(error);
        }
        self.committing = true;
        let reply = match self.wire.command(&[b"EXEC"]).await {
            Ok(reply) => reply,
            Err(error @ Failure::Server(_)) => {
                self.committing = false;
                reset(&mut self.wire, b"DISCARD").await?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let (status, entry_id, affected_count) = match reply {
            Reply::Null => (EditStatus::Conflict, None, 0),
            Reply::Array(mut replies) if replies.len() == 1 => {
                plan.change.receipt(replies.remove(0))?
            }
            _ => return Err(Failure::Protocol),
        };
        self.committing = false;
        Ok(RedisEditReport {
            status,
            entry_id,
            affected_count,
            audit_warning: false,
        })
    }
}

fn deletion_keys(ids: Vec<String>) -> Result<Vec<Bytes>, Failure> {
    if ids.is_empty() || ids.len() > MAX_DELETE_KEYS {
        return Err(Failure::Server(
            "한 번에 삭제할 Redis 키를 1~50개 선택하세요.",
        ));
    }
    let mut names = Vec::with_capacity(ids.len());
    let mut seen = HashSet::new();
    let mut bytes = 0;
    for id in ids {
        if id.len() > (MAX_DELETE_NAMES_BYTES + 2) / 3 * 4 {
            return Err(Failure::Server(
                "선택한 Redis 키 이름의 합계는 64 KiB 이하여야 합니다.",
            ));
        }
        let key = key_bytes(&id)?;
        bytes += key.len();
        if bytes > MAX_DELETE_NAMES_BYTES {
            return Err(Failure::Server(
                "선택한 Redis 키 이름의 합계는 64 KiB 이하여야 합니다.",
            ));
        }
        if !seen.insert(key.clone()) {
            return Err(Failure::Server("중복된 키 없이 삭제 대상을 선택하세요."));
        }
        names.push(key);
    }
    Ok(names)
}

fn key_command<'a>(command: &'static [u8], keys: &'a [Bytes]) -> Vec<&'a [u8]> {
    std::iter::once(command)
        .chain(keys.iter().map(Vec::as_slice))
        .collect()
}

impl PlannedChange {
    fn command(&self) -> Vec<&[u8]> {
        match self {
            Self::Edit { key, change } => change.command(key),
            Self::Delete(keys) => key_command(b"UNLINK", keys),
        }
    }

    fn receipt(&self, reply: Reply) -> Result<(EditStatus, Option<String>, usize), Failure> {
        match (self, reply) {
            (Self::Edit { change, .. }, reply) => {
                let (status, entry_id) = change.receipt(reply)?;
                let affected = usize::from(matches!(status, EditStatus::Applied));
                Ok((status, entry_id, affected))
            }
            (Self::Delete(_), Reply::Error) => Ok((EditStatus::Rejected, None, 0)),
            (Self::Delete(keys), Reply::Integer(count)) if count == keys.len() as i64 => {
                Ok((EditStatus::Applied, None, keys.len()))
            }
            _ => Err(Failure::Protocol),
        }
    }
}

async fn status(wire: &mut Wire, command: &[&[u8]], expected: &[u8]) -> Result<(), Failure> {
    if wire.command(command).await?.bytes()? == expected {
        Ok(())
    } else {
        Err(Failure::Protocol)
    }
}

async fn reset(wire: &mut Wire, command: &[u8]) -> Result<(), Failure> {
    status(wire, &[command], b"OK")
        .await
        .map_err(|error| match error {
            Failure::Server(_) => Failure::Protocol,
            other => other,
        })
}

impl InputBytes {
    fn decode(self) -> Result<Bytes, Failure> {
        match self {
            Self::Utf8 { text } if text.len() <= MAX_CHANGE_BYTES => Ok(text.into_bytes()),
            Self::Hex { text } if text.len() <= 4 * MAX_CHANGE_BYTES => {
                let digits: Vec<_> = text
                    .bytes()
                    .filter(|byte| !byte.is_ascii_whitespace())
                    .collect();
                if digits.len() > 2 * MAX_CHANGE_BYTES {
                    return Err(size_error());
                }
                if !digits.iter().all(u8::is_ascii_hexdigit) {
                    return Err(Failure::Server("HEX 입력에는 0–9와 A–F를 사용하세요."));
                }
                let pairs = digits.chunks_exact(2);
                if !pairs.remainder().is_empty() {
                    return Err(Failure::Server(
                        "HEX 입력은 바이트마다 두 자리를 입력하세요.",
                    ));
                }
                pairs
                    .map(|pair| {
                        let invalid = || Failure::Server("HEX 입력에는 0–9와 A–F를 사용하세요.");
                        let pair = std::str::from_utf8(pair).map_err(|_| invalid())?;
                        u8::from_str_radix(pair, 16).map_err(|_| invalid())
                    })
                    .collect()
            }
            _ => Err(size_error()),
        }
    }
}

fn size_error() -> Failure {
    Failure::Server("한 번에 변경할 Redis 값은 합계 1 MiB 이하여야 합니다.")
}

impl Mutation {
    fn parse(input: RedisEditInput) -> Result<Self, Failure> {
        let change = match input {
            RedisEditInput::String { value } => Self::String(value.decode()?),
            RedisEditInput::Hash { field, value } => Self::Hash(field.decode()?, value.decode()?),
            RedisEditInput::List { index, value } => Self::List(
                index
                    .trim()
                    .parse::<i64>()
                    .map_err(|_| Failure::Server("List 위치를 정수로 입력하세요."))?
                    .to_string(),
                value.decode()?,
            ),
            RedisEditInput::Set { member } => Self::Set(member.decode()?),
            RedisEditInput::Zset { member, score } => {
                let score = score.trim();
                let score = match score.to_ascii_lowercase().as_str() {
                    "inf" | "+inf" => "+inf".to_owned(),
                    "-inf" => "-inf".to_owned(),
                    _ => score
                        .parse::<f64>()
                        .ok()
                        .filter(|score| score.is_finite())
                        .ok_or(Failure::Server(
                            "Sorted Set 점수는 숫자 또는 +inf, -inf로 입력하세요.",
                        ))?
                        .to_string(),
                };
                Self::Zset(member.decode()?, score)
            }
            RedisEditInput::Stream { fields } => {
                if fields.is_empty() || fields.len() > MAX_STREAM_FIELDS {
                    return Err(Failure::Server(
                        "Stream 메시지에는 1~64개 필드가 필요합니다.",
                    ));
                }
                let mut pairs = Vec::with_capacity(fields.len());
                let mut bytes = 0;
                for item in fields {
                    let field = item.field.decode()?;
                    let value = item.value.decode()?;
                    bytes += field.len() + value.len();
                    if bytes > MAX_CHANGE_BYTES {
                        return Err(size_error());
                    }
                    pairs.push((field, value));
                }
                Self::Stream(pairs)
            }
            RedisEditInput::Json { original, document } => {
                json::validate(&original)?;
                json::validate(&document)?;
                Self::Json { original, document }
            }
            RedisEditInput::Ttl { milliseconds } => {
                let ttl = milliseconds
                    .map(|ms| {
                        ms.parse::<u64>()
                            .ok()
                            .filter(|ms| (1..=MAX_TTL_MS).contains(ms))
                            .map(|ms| ms.to_string())
                            .ok_or(Failure::Server("만료 시간은 1ms 이상의 정수로 입력하세요."))
                    })
                    .transpose()?;
                Self::Ttl(ttl)
            }
        };
        let bytes: usize = change
            .command(&[])
            .into_iter()
            .skip(2)
            .map(<[u8]>::len)
            .sum();
        if bytes > MAX_CHANGE_BYTES {
            return Err(size_error());
        }
        Ok(change)
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::String(_) => "string",
            Self::Hash(..) => "hash",
            Self::List(..) => "list",
            Self::Set(_) => "set",
            Self::Zset(..) => "zset",
            Self::Stream(_) => "stream",
            Self::Json { .. } => "json",
            Self::Ttl(_) => "ttl",
        }
    }

    fn command<'a>(&'a self, key: &'a [u8]) -> Vec<&'a [u8]> {
        match self {
            Self::String(value) => vec![b"SET", key, value, b"XX", b"KEEPTTL"],
            Self::Hash(field, value) => vec![b"HSET", key, field, value],
            Self::List(index, value) => vec![b"LSET", key, index.as_bytes(), value],
            Self::Set(member) => vec![b"SADD", key, member],
            Self::Zset(member, score) => vec![b"ZADD", key, score.as_bytes(), member],
            Self::Json { document, .. } => vec![b"JSON.SET", key, b".", document.as_bytes(), b"XX"],
            Self::Ttl(Some(ms)) => vec![b"PEXPIRE", key, ms.as_bytes()],
            Self::Ttl(None) => vec![b"PERSIST", key],
            Self::Stream(fields) => {
                let mut command = vec![b"XADD".as_slice(), key, b"NOMKSTREAM", b"*"];
                command.extend(
                    fields
                        .iter()
                        .flat_map(|(field, value)| [field.as_slice(), value.as_slice()]),
                );
                command
            }
        }
    }

    async fn describe(
        &self,
        wire: &mut Wire,
        key: &[u8],
    ) -> Result<(Vec<Change>, Option<i64>), Failure> {
        let row = match self {
            Self::String(value) => {
                let bytes = wire.command(&[b"STRLEN", key]).await?.integer()?;
                let last = (DISPLAY_BYTES - 1).to_string();
                let sample = wire
                    .command(&[b"GETRANGE", key, b"0", last.as_bytes()])
                    .await?
                    .bytes()?;
                let mut previous = display(&sample, true);
                previous.bytes = usize::try_from(bytes).map_err(|_| Failure::Protocol)?;
                previous.truncated |= sample.len() < previous.bytes;
                Change {
                    selector: None,
                    before: Some(previous),
                    after: display(value, true),
                }
            }
            Self::Hash(field, value) => {
                compare(wire.command(&[b"HGET", key, field]).await?, field, value)?
            }
            Self::List(index, value) => {
                let old = wire.command(&[b"LINDEX", key, index.as_bytes()]).await?;
                if matches!(old, Reply::Null) {
                    return Err(Failure::Server("List에서 해당 위치를 찾을 수 없습니다."));
                }
                compare(old, index.as_bytes(), value)?
            }
            Self::Set(member) => {
                if wire
                    .command(&[b"SISMEMBER", key, member])
                    .await?
                    .integer()?
                    != 0
                {
                    return Err(Failure::Server("Set에 이미 같은 멤버가 있습니다."));
                }
                Change {
                    selector: None,
                    before: None,
                    after: display(member, true),
                }
            }
            Self::Zset(member, score) => compare(
                wire.command(&[b"ZSCORE", key, member]).await?,
                member,
                score.as_bytes(),
            )?,
            Self::Stream(fields) => {
                let previous = wire.command(&[b"XLEN", key]).await?.integer()?;
                let rows = fields
                    .iter()
                    .map(|(field, value)| Change {
                        selector: Some(display(field, true)),
                        before: None,
                        after: display(value, true),
                    })
                    .collect();
                return Ok((rows, Some(previous)));
            }
            Self::Json { original, document } => {
                let previous = json::read(wire, key).await?;
                if previous.as_deref() != Some(original.as_bytes()) {
                    return Err(Failure::Server(
                        "JSON 문서가 바뀌었습니다. 현재 값을 다시 열어 주세요.",
                    ));
                }
                Change {
                    selector: None,
                    before: Some(display_json(original.as_bytes())?),
                    after: display_json(document.as_bytes())?,
                }
            }
            Self::Ttl(_) => return Ok((vec![], None)),
        };
        Ok((vec![row], None))
    }

    fn receipt(&self, reply: Reply) -> Result<(EditStatus, Option<String>), Failure> {
        match (self, reply) {
            (_, Reply::Error) => Ok((EditStatus::Rejected, None)),
            (Self::String(_) | Self::Stream(_) | Self::Json { .. }, Reply::Null) => {
                Ok((EditStatus::Conflict, None))
            }
            (
                Self::String(_) | Self::List(..) | Self::Json { .. },
                Reply::Simple(bytes) | Reply::Bytes(bytes),
            ) if bytes == b"OK" => Ok((EditStatus::Applied, None)),
            (Self::Set(_), Reply::Integer(0)) => Ok((EditStatus::Conflict, None)),
            (Self::Ttl(_), Reply::Integer(0)) => Ok((EditStatus::Conflict, None)),
            (Self::Set(_) | Self::Ttl(_), Reply::Integer(1))
            | (Self::Hash(..) | Self::Zset(..), Reply::Integer(0 | 1)) => {
                Ok((EditStatus::Applied, None))
            }
            (Self::Stream(_), Reply::Simple(bytes) | Reply::Bytes(bytes)) => {
                let id = String::from_utf8(bytes).map_err(|_| Failure::Protocol)?;
                if !valid_stream_id(&id) {
                    return Err(Failure::Protocol);
                }
                Ok((EditStatus::Applied, Some(id)))
            }
            _ => Err(Failure::Protocol),
        }
    }
}

fn compare(reply: Reply, selector: &[u8], after: &[u8]) -> Result<Change, Failure> {
    let before = match reply {
        Reply::Null => None,
        reply => Some(display(&reply.bytes()?, true)),
    };
    Ok(Change {
        selector: Some(display(selector, true)),
        before,
        after: display(after, true),
    })
}
