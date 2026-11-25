use super::resp::{Failure, Reply, Wire};
use serde::Serialize;

pub(super) const TYPE: &str = "ReJSON-RL";
pub(super) const EDIT_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Support {
    ReadWrite,
    ReadOnly,
    Unavailable,
    Unknown,
}

impl Support {
    pub(super) fn may_write(self) -> bool {
        matches!(self, Self::ReadWrite | Self::Unknown)
    }
}

pub(super) async fn support(wire: &mut Wire) -> Result<Support, Failure> {
    match wire
        .command(&[b"COMMAND", b"INFO", b"JSON.GET", b"JSON.SET"])
        .await
    {
        Ok(Reply::Array(commands)) => Ok(match commands.as_slice() {
            [Reply::Array(_), Reply::Array(_)] => Support::ReadWrite,
            [Reply::Array(_), Reply::Null] => Support::ReadOnly,
            [Reply::Null, Reply::Array(_) | Reply::Null] => Support::Unavailable,
            _ => Support::Unknown,
        }),
        Ok(_) | Err(Failure::Server(_)) => Ok(Support::Unknown),
        Err(error) => Err(error),
    }
}

pub(super) async fn read(wire: &mut Wire, key: &[u8]) -> Result<Option<Vec<u8>>, Failure> {
    match wire.command(&[b"JSON.GET", key, b"."]).await? {
        Reply::Null => Ok(None),
        reply => reply.bytes().map(Some),
    }
}

pub(super) fn validate(text: &str) -> Result<(), Failure> {
    if text.len() > EDIT_LIMIT {
        return Err(Failure::Server(
            "Redis JSON 문서는 64 KiB까지 편집할 수 있습니다.",
        ));
    }
    serde_json::from_str::<&serde_json::value::RawValue>(text)
        .map_err(|_| Failure::Server("올바른 Redis JSON 문서 한 개를 입력하세요."))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redis::{edit::State, RedisEditInput};
    use serde_json::Value;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        task::JoinHandle,
    };
    use uuid::Uuid;

    fn fixture(exchanges: Vec<(Vec<&'static [u8]>, Vec<u8>)>) -> (Wire, JoinHandle<()>) {
        let (local, mut server) = tokio::io::duplex(16 * 1024);
        let task = tokio::spawn(async move {
            for (args, reply) in exchanges {
                let mut expected = format!("*{}\r\n", args.len()).into_bytes();
                for arg in args {
                    expected.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
                    expected.extend_from_slice(arg);
                    expected.extend_from_slice(b"\r\n");
                }
                let mut request = vec![0; expected.len()];
                server.read_exact(&mut request).await.unwrap();
                assert_eq!(request, expected);
                server.write_all(&reply).await.unwrap();
            }
        });
        (Wire::new(Box::new(local)), task)
    }

    #[tokio::test]
    async fn reports_json_capability_without_requiring_command_privileges() {
        for (reply, label) in [
            (
                b"*2\r\n*1\r\n$8\r\njson.get\r\n*1\r\n$8\r\njson.set\r\n".as_slice(),
                "read_write",
            ),
            (b"*2\r\n*1\r\n$8\r\njson.get\r\n$-1\r\n", "read_only"),
            (b"*2\r\n$-1\r\n$-1\r\n", "unavailable"),
            (
                b"-NOPERM this user has no permissions to run the command\r\n",
                "unknown",
            ),
        ] {
            let (mut wire, server) = fixture(vec![(
                vec![b"COMMAND", b"INFO", b"JSON.GET", b"JSON.SET"],
                reply.to_vec(),
            )]);
            assert_eq!(
                serde_json::to_value(support(&mut wire).await.unwrap()).unwrap(),
                label
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn compares_json_under_watch_and_sends_the_exact_reviewed_document() {
        const KEY: &[u8] = b"json:fixture";
        const ORIGINAL: &str = r#"{"id":9007199254740993,"nested":[true,null]}"#;
        const DOCUMENT: &str = "{\n  \"id\": 9007199254740995, \"nested\": [false, null]\n}";
        let response = format!("${}\r\n{ORIGINAL}\r\n", ORIGINAL.len()).into_bytes();
        let mut expected = vec![];
        for exec_reply in [
            None,
            Some(b"*-1\r\n".as_slice()),
            Some(b"*1\r\n+OK\r\n".as_slice()),
        ] {
            expected.extend([
                (vec![b"WATCH".as_slice(), KEY], b"+OK\r\n".to_vec()),
                (vec![b"TYPE".as_slice(), KEY], b"+ReJSON-RL\r\n".to_vec()),
                (vec![b"PTTL".as_slice(), KEY], b":23999\r\n".to_vec()),
                (vec![b"JSON.GET".as_slice(), KEY, b"."], response.clone()),
            ]);
            if let Some(receipt) = exec_reply {
                expected.extend([
                    (vec![b"MULTI".as_slice()], b"+OK\r\n".to_vec()),
                    (
                        vec![
                            b"JSON.SET".as_slice(),
                            KEY,
                            b".",
                            DOCUMENT.as_bytes(),
                            b"XX",
                        ],
                        b"+QUEUED\r\n".to_vec(),
                    ),
                    (vec![b"EXEC".as_slice()], receipt.to_vec()),
                ]);
            } else {
                expected.push((vec![b"UNWATCH"], b"+OK\r\n".to_vec()));
            }
        }
        let (wire, server) = fixture(expected);
        let mut client = State::new(wire);
        let key = "anNvbjpmaXh0dXJl".to_owned();
        let input = |original: &str| RedisEditInput::Json {
            original: original.into(),
            document: DOCUMENT.into(),
        };
        assert!(
            matches!(client.preview(key.clone(), input("null")).await, Err(Failure::Server(message)) if message.contains("문서가 바뀌었습니다"))
        );
        for status in ["conflict", "applied"] {
            let review: Value =
                serde_json::to_value(client.preview(key.clone(), input(ORIGINAL)).await.unwrap())
                    .unwrap();
            assert_eq!(review["ttl_ms"], 23999);
            assert_eq!(review["changes"][0]["before"]["text"], ORIGINAL);
            assert_eq!(review["changes"][0]["after"]["text"], DOCUMENT);
            let token = Uuid::parse_str(review["token"].as_str().unwrap()).unwrap();
            let report = serde_json::to_value(client.apply(token, false).await.unwrap()).unwrap();
            assert_eq!(report["status"], status);
        }
        server.await.unwrap();
        assert!(validate("null false").is_err());
        assert!(validate(&format!("\"{}\"", "한".repeat(EDIT_LIMIT / 3))).is_err());
    }
}
