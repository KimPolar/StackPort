use super::{
    keys::{display, key_bytes, valid_stream_id, RedisBytes, DISPLAY_BYTES},
    resp::{Failure, Reply, Wire},
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use uuid::Uuid;

const LIFETIME: Duration = Duration::from_secs(300);
const MAX_CHANGE_BYTES: usize = 1024 * 1024;
const MAX_STREAM_FIELDS: usize = 64;

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
}

#[derive(Serialize)]
pub struct RedisEditPreview {
    token: String,
    key: RedisBytes,
    kind: &'static str,
    ttl_ms: Option<u64>,
    changes: Vec<Change>,
    stream_length: Option<i64>,
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
    key: Vec<u8>,
    change: Mutation,
}

type Bytes = Vec<u8>;

enum Mutation {
    String(Bytes),
    Hash(Bytes, Bytes),
    List(String, Bytes),
    Set(Bytes),
    Zset(Bytes, String),
    Stream(Vec<(Bytes, Bytes)>),
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
        if self.plan.is_some() {
            self.clear().await?;
        }
        status(&mut self.wire, &[b"WATCH", &key], b"OK").await?;
        let token = Uuid::new_v4();
        let preview = self.describe(&key, &change, token).await;
        match preview {
            Ok(preview) => {
                self.plan = Some(Plan {
                    token,
                    expires: Instant::now() + LIFETIME,
                    key,
                    change,
                });
                Ok(preview)
            }
            Err(error @ Failure::Server(_)) => {
                self.clear().await?;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    async fn describe(
        &mut self,
        key: &[u8],
        change: &Mutation,
        token: Uuid,
    ) -> Result<RedisEditPreview, Failure> {
        let kind = change.kind();
        let actual = self.wire.command(&[b"TYPE", key]).await?.bytes()?;
        if actual != kind.as_bytes() {
            return Err(Failure::Server(
                "Redis 키가 사라졌거나 타입이 바뀌었습니다. 키를 다시 열어 주세요.",
            ));
        }
        let ttl = self.wire.command(&[b"PTTL", key]).await?.integer()?;
        if ttl == -2 {
            return Err(Failure::Server("Redis 키가 만료되었습니다."));
        }
        let (changes, stream_length) = change.describe(&mut self.wire, key).await?;
        Ok(RedisEditPreview {
            token: token.to_string(),
            key: display(key, false),
            kind,
            ttl_ms: u64::try_from(ttl).ok(),
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

    pub(super) async fn apply(&mut self, token: Uuid) -> Result<RedisEditReport, Failure> {
        if !self.plan.as_ref().is_some_and(|plan| plan.token == token) {
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
        let command = plan.change.command(&plan.key);
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
        let (status, entry_id) = match reply {
            Reply::Null => (EditStatus::Conflict, None),
            Reply::Array(mut replies) if replies.len() == 1 => {
                plan.change.receipt(replies.remove(0))?
            }
            _ => return Err(Failure::Protocol),
        };
        self.committing = false;
        Ok(RedisEditReport {
            status,
            entry_id,
            audit_warning: false,
        })
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
                let score = score
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|score| score.is_finite())
                    .ok_or(Failure::Server(
                        "Sorted Set 점수는 유한한 숫자로 입력하세요.",
                    ))?;
                Self::Zset(member.decode()?, score.to_string())
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
        }
    }

    fn command<'a>(&'a self, key: &'a [u8]) -> Vec<&'a [u8]> {
        match self {
            Self::String(value) => vec![b"SET", key, value, b"XX", b"KEEPTTL"],
            Self::Hash(field, value) => vec![b"HSET", key, field, value],
            Self::List(index, value) => vec![b"LSET", key, index.as_bytes(), value],
            Self::Set(member) => vec![b"SADD", key, member],
            Self::Zset(member, score) => vec![b"ZADD", key, score.as_bytes(), member],
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
        };
        Ok((vec![row], None))
    }

    fn receipt(&self, reply: Reply) -> Result<(EditStatus, Option<String>), Failure> {
        match (self, reply) {
            (_, Reply::Error) => Ok((EditStatus::Rejected, None)),
            (Self::String(_) | Self::Stream(_), Reply::Null) => Ok((EditStatus::Conflict, None)),
            (Self::String(_) | Self::List(..), Reply::Bytes(bytes)) if bytes == b"OK" => {
                Ok((EditStatus::Applied, None))
            }
            (Self::Set(_), Reply::Integer(0)) => Ok((EditStatus::Conflict, None)),
            (Self::Set(_), Reply::Integer(1))
            | (Self::Hash(..) | Self::Zset(..), Reply::Integer(0 | 1)) => {
                Ok((EditStatus::Applied, None))
            }
            (Self::Stream(_), Reply::Bytes(bytes)) => {
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
