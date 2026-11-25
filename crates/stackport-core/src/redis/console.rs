use super::{
    keys::{display, RedisBytes},
    resp::Reply,
    RedisManager,
};
use crate::Result;
use serde::Serialize;

const LINE_BYTES: usize = 4096;
const MAX_ARGUMENTS: usize = 64;
const RESULT_ITEMS: usize = 256;

#[derive(Copy, Clone, Serialize)]
pub struct RedisConsoleCommand {
    name: &'static str,
    usage: &'static str,
    warning: Option<&'static str>,
}

const READ_ONLY: &[(&str, &str)] = &[
    ("DBSIZE", "DBSIZE"),
    ("ECHO", "ECHO message"),
    ("EXISTS", "EXISTS key [key ...]"),
    ("GET", "GET key"),
    ("GETRANGE", "GETRANGE key start end"),
    ("HEXISTS", "HEXISTS key field"),
    ("HGET", "HGET key field"),
    ("HLEN", "HLEN key"),
    ("HMGET", "HMGET key field [field ...]"),
    ("HSTRLEN", "HSTRLEN key field"),
    ("LINDEX", "LINDEX key index"),
    ("LLEN", "LLEN key"),
    ("LRANGE", "LRANGE key start stop"),
    ("MGET", "MGET key [key ...]"),
    ("PING", "PING [message]"),
    ("PTTL", "PTTL key"),
    ("SCARD", "SCARD key"),
    ("SISMEMBER", "SISMEMBER key member"),
    ("SMISMEMBER", "SMISMEMBER key member [member ...]"),
    ("STRLEN", "STRLEN key"),
    ("TTL", "TTL key"),
    ("TYPE", "TYPE key"),
    ("XLEN", "XLEN key"),
    ("XRANGE", "XRANGE key start end [COUNT count]"),
    ("XREVRANGE", "XREVRANGE key end start [COUNT count]"),
    ("ZCARD", "ZCARD key"),
    ("ZCOUNT", "ZCOUNT key min max"),
    ("ZMSCORE", "ZMSCORE key member [member ...]"),
    (
        "ZRANGE",
        "ZRANGE key start stop [BYSCORE | BYLEX] [REV] [LIMIT offset count] [WITHSCORES]",
    ),
    ("ZRANK", "ZRANK key member"),
    ("ZREVRANK", "ZREVRANK key member"),
    ("ZSCORE", "ZSCORE key member"),
];

const REMOVE: &str = "키나 DB의 데이터를 삭제하는 명령입니다. 이 콘솔에서는 실행할 수 없습니다.";
const WRITE: &str =
    "키를 변경하는 명령입니다. 지원하는 값의 변경은 키 상세에서 미리 보고 적용하세요.";
const ADMIN: &str =
    "관리 권한, 연결 또는 서버 상태를 바꾸는 명령입니다. 이 콘솔에서는 실행할 수 없습니다.";
const SCRIPT: &str =
    "스크립트나 서버 함수가 데이터를 읽거나 변경할 수 있습니다. 이 콘솔에서는 실행할 수 없습니다.";
const PUBSUB: &str = "Redis 작업 공간의 Pub/Sub에서 구독하거나 발행을 검토하세요.";
const PROTECTED: &[(&str, &str)] = &[
    ("ACL", ADMIN), ("AUTH", ADMIN), ("CLIENT", ADMIN), ("CLUSTER", ADMIN), ("CONFIG", ADMIN),
    ("DEBUG", ADMIN), ("DEL", REMOVE), ("EVAL", SCRIPT), ("EVALSHA", SCRIPT),
    ("EXPIRE", WRITE), ("FCALL", SCRIPT), ("FLUSHALL", REMOVE), ("FLUSHDB", REMOVE), ("FUNCTION", SCRIPT),
    ("GEOADD", WRITE), ("HELLO", ADMIN), ("HDEL", REMOVE), ("HSET", WRITE), ("INCR", WRITE),
    ("KEYS", "모든 키를 한 번에 조회하면 서버의 다른 작업이 지연될 수 있습니다. 작업 공간의 키 검색을 사용하세요."),
    ("LPOP", REMOVE), ("LPUSH", WRITE), ("LSET", WRITE), ("MIGRATE", ADMIN), ("MODULE", ADMIN),
    ("MSET", WRITE), ("MULTI", ADMIN), ("PERSIST", WRITE), ("PSUBSCRIBE", PUBSUB), ("PUBLISH", PUBSUB),
    ("RENAME", WRITE), ("REPLICAOF", ADMIN), ("RESTORE", WRITE), ("RPOP", REMOVE), ("RPUSH", WRITE),
    ("SADD", WRITE), ("SCRIPT", SCRIPT), ("SELECT", "연결할 논리 DB는 Redis 연결 설정에서 선택하세요."),
    ("SET", WRITE), ("SHUTDOWN", ADMIN), ("SREM", REMOVE), ("SUBSCRIBE", PUBSUB), ("UNLINK", REMOVE),
    ("XADD", WRITE), ("XDEL", REMOVE), ("ZADD", WRITE), ("ZREM", REMOVE),
];

pub fn redis_console_commands() -> Vec<RedisConsoleCommand> {
    READ_ONLY
        .iter()
        .map(|&(name, usage)| RedisConsoleCommand {
            name,
            usage,
            warning: None,
        })
        .chain(
            PROTECTED
                .iter()
                .map(|&(name, warning)| RedisConsoleCommand {
                    name,
                    usage: name,
                    warning: Some(warning),
                }),
        )
        .collect()
}

#[derive(Serialize)]
pub struct RedisConsoleResult {
    reply: ConsoleReply,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ConsoleReply {
    Simple {
        value: RedisBytes,
    },
    Bulk {
        value: RedisBytes,
    },
    Integer {
        value: String,
    },
    Array {
        length: usize,
        items: Vec<ConsoleReply>,
    },
    Null,
    Error,
}

impl RedisManager {
    pub async fn run_console(&self, id: &str, line: String) -> Result<RedisConsoleResult> {
        let arguments = checked_arguments(&line)?;
        drop(line);
        let session = self.session(id)?;
        self.run(id, &session, |state| {
            Box::pin(async move {
                let refs = arguments.iter().map(Vec::as_slice).collect::<Vec<_>>();
                let reply = state.wire.command(&refs).await?;
                let mut budget = RESULT_ITEMS;
                let mut truncated = false;
                let reply = ConsoleReply::limited(reply, &mut budget, &mut truncated);
                Ok(RedisConsoleResult { reply, truncated })
            })
        })
        .await
    }
}

impl ConsoleReply {
    fn limited(reply: Reply, remaining: &mut usize, truncated: &mut bool) -> Self {
        *remaining -= 1;
        match reply {
            Reply::Simple(bytes) => Self::Simple {
                value: display(&bytes, true),
            },
            Reply::Bytes(bytes) => Self::Bulk {
                value: display(&bytes, true),
            },
            Reply::Integer(value) => Self::Integer {
                value: value.to_string(),
            },
            Reply::Null => Self::Null,
            Reply::Error => Self::Error,
            Reply::Array(values) => {
                let length = values.len();
                let mut items = Vec::new();
                for value in values {
                    if *remaining == 0 {
                        *truncated = true;
                        break;
                    }
                    items.push(Self::limited(value, remaining, truncated));
                }
                Self::Array { length, items }
            }
        }
    }
}

fn checked_arguments(line: &str) -> Result<Vec<Vec<u8>>> {
    if line.len() > LINE_BYTES || line.chars().any(|ch| ch.is_control() && ch != '\t') {
        return Err("Redis 명령은 한 줄에 4,096바이트 이하로 입력하세요.".into());
    }
    let mut rest = line.trim_start_matches([' ', '\t']).as_bytes();
    let Some(first) = rest.first() else {
        return Err("Redis 명령을 입력하세요.".into());
    };
    if !first.is_ascii_alphabetic() {
        return Err("Redis 명령 이름을 영문으로 입력하세요.".into());
    }
    let mut arguments = Vec::new();
    while let Some(&start) = rest.first() {
        if arguments.len() == MAX_ARGUMENTS {
            return Err("Redis 명령의 인수는 최대 63개입니다.".into());
        }
        let argument = if matches!(start, b'\'' | b'"') {
            rest = &rest[1..];
            quoted_argument(&mut rest, start)?
        } else {
            let end = rest.iter().position(separator).unwrap_or(rest.len());
            let (value, next) = rest.split_at(end);
            if value.iter().any(|byte| matches!(byte, b'\'' | b'"')) {
                return Err("따옴표는 Redis 인수 전체를 감싸야 합니다.".into());
            }
            rest = next;
            value.to_vec()
        };
        arguments.push(argument);
        rest = rest.trim_ascii_start();
    }
    let command = &mut arguments[0];
    command.make_ascii_uppercase();
    if let Some((_, warning)) = PROTECTED
        .iter()
        .find(|(name, _)| name.as_bytes() == command)
    {
        return Err((*warning).into());
    }
    if !READ_ONLY.iter().any(|(name, _)| name.as_bytes() == command) {
        return Err("지원 명령에서 읽기 전용 Redis 명령을 선택하세요.".into());
    }
    Ok(arguments)
}

fn separator(byte: &u8) -> bool {
    matches!(byte, b' ' | b'\t')
}

fn quoted_argument(rest: &mut &[u8], quote: u8) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some((&byte, tail)) = rest.split_first() {
        *rest = tail;
        if byte == quote {
            if rest.first().is_some_and(|next| !separator(next)) {
                return Err("닫는 따옴표 뒤에 공백을 넣으세요.".into());
            }
            return Ok(bytes);
        }
        if byte == b'\\' && quote == b'"' {
            bytes.push(double_escape(rest)?);
        } else if byte == b'\\' && rest.first() == Some(&b'\'') {
            bytes.push(b'\'');
            *rest = &rest[1..];
        } else {
            bytes.push(byte);
        }
    }
    Err("Redis 인수의 따옴표를 닫으세요.".into())
}

fn double_escape(rest: &mut &[u8]) -> Result<u8> {
    let (&escape, tail) = rest
        .split_first()
        .ok_or("Redis 인수의 이스케이프가 끝나지 않았습니다.")?;
    *rest = tail;
    match escape {
        b'n' => Ok(b'\n'),
        b'r' => Ok(b'\r'),
        b't' => Ok(b'\t'),
        b'b' => Ok(8),
        b'a' => Ok(7),
        b'x' => {
            let hex = |index| {
                rest.get(index)
                    .and_then(|&byte| char::from(byte).to_digit(16))
            };
            let (Some(high), Some(low)) = (hex(0), hex(1)) else {
                return Err("16진수 이스케이프는 두 자리로 입력하세요.".into());
            };
            *rest = &rest[2..];
            Ok((high * 16 + low) as u8)
        }
        byte => Ok(byte),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_line_binary_safe_redis_arguments() {
        let line = r#"  mget "공백 키" "\x00\xff\x61" '' 'it\'s' "x\r\n""#;
        assert_eq!(
            checked_arguments(line).unwrap(),
            vec![
                b"MGET".to_vec(),
                "공백 키".as_bytes().to_vec(),
                vec![0, 255, 97],
                Vec::new(),
                b"it's".to_vec(),
                b"x\r\n".to_vec(),
            ]
        );
        assert!(checked_arguments("GET plain\t  ").is_ok());
        for line in [
            "GET 'missing",
            "GET 'key'suffix",
            r#"GET "\x9z""#,
            "GET one\nGET two",
        ] {
            assert!(checked_arguments(line).is_err(), "{line}");
        }
    }

    #[test]
    fn blocks_destructive_admin_and_unknown_commands_before_sending() {
        assert_eq!(checked_arguments(" flushall ASYNC").unwrap_err(), REMOVE);
        assert_eq!(
            checked_arguments("CONFIG GET requirepass").unwrap_err(),
            ADMIN
        );
        assert_eq!(checked_arguments("EVAL 'return 0' 0").unwrap_err(), SCRIPT);
        assert!(checked_arguments("RESET").is_err());
        assert!(checked_arguments(&format!("MGET{}", " a".repeat(64))).is_err());
    }
}
