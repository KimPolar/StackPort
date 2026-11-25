use std::{future::Future, io::Write, pin::Pin};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use zeroize::Zeroizing;

const MAX_REPLY: usize = 4 * 1024 * 1024;
const MAX_HEADER: u64 = 16 * 1024;
const MAX_ITEMS: usize = 8192;
const MAX_DEPTH: usize = 8;

pub(super) type Work<'a, T> = Pin<Box<dyn Future<Output = Result<T, Failure>> + Send + 'a>>;

pub(super) trait Socket: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Socket for T {}

pub(super) struct Wire(BufReader<Box<dyn Socket>>);

#[derive(Debug)]
pub(super) enum Reply {
    Bytes(Vec<u8>),
    Integer(i64),
    Array(Vec<Reply>),
    Null,
    Error,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum Failure {
    Transport,
    Protocol,
    Budget,
    Server(&'static str),
}

impl Failure {
    pub(super) fn message(&self) -> &'static str {
        match self {
            Self::Transport => "Redis 연결이 끊겼습니다. 다시 연결하세요.",
            Self::Protocol => "Redis 응답 형식을 읽을 수 없습니다. 연결이 닫혔습니다.",
            Self::Budget => "Redis 응답이 4 MiB 또는 항목 한도를 넘었습니다. 연결이 닫혔습니다.",
            Self::Server(message) => message,
        }
    }
}

impl Wire {
    pub(super) fn new(socket: Box<dyn Socket>) -> Self {
        Self(BufReader::new(socket))
    }

    pub(super) async fn command(&mut self, args: &[&[u8]]) -> Result<Reply, Failure> {
        let mut request = Zeroizing::new(Vec::new());
        write!(*request, "*{}\r\n", args.len()).map_err(|_| Failure::Protocol)?;
        for arg in args {
            write!(*request, "${}\r\n", arg.len()).map_err(|_| Failure::Protocol)?;
            request.extend_from_slice(arg);
            request.extend_from_slice(b"\r\n");
        }
        self.0
            .write_all(&request)
            .await
            .map_err(|_| Failure::Transport)?;
        self.0.flush().await.map_err(|_| Failure::Transport)?;
        drop(request);
        self.receive().await
    }

    pub(super) async fn receive(&mut self) -> Result<Reply, Failure> {
        let mut budget = Budget {
            bytes: MAX_REPLY,
            items: MAX_ITEMS,
        };
        self.read(0, &mut budget).await
    }

    fn read<'a>(&'a mut self, depth: usize, budget: &'a mut Budget) -> Work<'a, Reply> {
        Box::pin(async move {
            if depth > MAX_DEPTH || budget.items == 0 {
                return Err(Failure::Budget);
            }
            budget.items -= 1;
            let mut line = Vec::new();
            let count = (&mut self.0)
                .take(MAX_HEADER.min(budget.bytes as u64 + 1))
                .read_until(b'\n', &mut line)
                .await
                .map_err(|_| Failure::Transport)?;
            if count == 0 {
                return Err(Failure::Transport);
            }
            budget.consume(count)?;
            if count < 3 || !line.ends_with(b"\r\n") {
                return Err(Failure::Protocol);
            }
            let header = &line[1..line.len() - 2];
            match line[0] {
                b'+' => Ok(Reply::Bytes(header.to_vec())),
                b'-' if depth == 0 => Err(server_error(header)),
                b'-' => Ok(Reply::Error),
                b':' => Ok(Reply::Integer(number(header)?)),
                b'$' => {
                    let len = number(header)?;
                    if len == -1 {
                        return Ok(Reply::Null);
                    }
                    let bytes = usize::try_from(len).map_err(|_| Failure::Protocol)?;
                    let framed = bytes.checked_add(2).ok_or(Failure::Budget)?;
                    budget.consume(framed)?;
                    let mut output = vec![0; framed];
                    self.0
                        .read_exact(&mut output)
                        .await
                        .map_err(|_| Failure::Transport)?;
                    if !output.ends_with(b"\r\n") {
                        return Err(Failure::Protocol);
                    }
                    output.truncate(bytes);
                    Ok(Reply::Bytes(output))
                }
                b'*' => {
                    let count = number(header)?;
                    if count == -1 {
                        return Ok(Reply::Null);
                    }
                    let count = usize::try_from(count).map_err(|_| Failure::Protocol)?;
                    if count > budget.items {
                        return Err(Failure::Budget);
                    }
                    let mut items = Vec::with_capacity(count);
                    for _ in 0..count {
                        items.push(self.read(depth + 1, budget).await?);
                    }
                    Ok(Reply::Array(items))
                }
                _ => Err(Failure::Protocol),
            }
        })
    }
}

struct Budget {
    bytes: usize,
    items: usize,
}

impl Budget {
    fn consume(&mut self, bytes: usize) -> Result<(), Failure> {
        self.bytes = self.bytes.checked_sub(bytes).ok_or(Failure::Budget)?;
        Ok(())
    }
}

fn number(bytes: &[u8]) -> Result<i64, Failure> {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|text| text.parse().ok())
        .ok_or(Failure::Protocol)
}

fn server_error(message: &[u8]) -> Failure {
    Failure::Server(
        match message
            .split(|byte| *byte == b' ')
            .next()
            .unwrap_or_default()
        {
            b"NOAUTH" | b"WRONGPASS" => "Redis 사용자 또는 암호를 확인하세요.",
            b"NOPERM" => "현재 Redis 역할에 이 명령의 권한이 없습니다.",
            b"WRONGTYPE" => "키의 타입이 변경되었습니다. 값을 다시 열어 주세요.",
            b"MOVED" | b"ASK" => "Redis Cluster 연결에는 클러스터 어댑터가 필요합니다.",
            _ => "Redis 서버가 요청을 거부했습니다. 연결 설정과 지원 명령을 확인하세요.",
        },
    )
}

impl Reply {
    pub(super) fn bytes(self) -> Result<Vec<u8>, Failure> {
        match self {
            Self::Bytes(value) => Ok(value),
            _ => Err(Failure::Protocol),
        }
    }
    pub(super) fn array(self) -> Result<Vec<Reply>, Failure> {
        match self {
            Self::Array(items) => Ok(items),
            _ => Err(Failure::Protocol),
        }
    }
    pub(super) fn integer(self) -> Result<i64, Failure> {
        match self {
            Self::Integer(value) => Ok(value),
            _ => Err(Failure::Protocol),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn response(bytes: &[u8]) -> Result<Reply, Failure> {
        let (socket, mut server) = tokio::io::duplex(1024);
        server.write_all(bytes).await.unwrap();
        let mut wire = Wire::new(Box::new(socket));
        wire.command(&[b"TEST"]).await
    }

    #[tokio::test]
    async fn keeps_bulk_bytes_and_rejects_oversized_or_bad_frames() {
        assert_eq!(
            response(b"$4\r\n\x00\xff\r\n\r\n")
                .await
                .unwrap()
                .bytes()
                .unwrap(),
            b"\x00\xff\r\n"
        );
        assert_eq!(
            response(b"$4194305\r\n").await.unwrap_err(),
            Failure::Budget
        );
        assert_eq!(
            response(b"*10000000\r\n").await.unwrap_err(),
            Failure::Budget
        );
        assert_eq!(response(b"$1\r\nx??").await.unwrap_err(), Failure::Protocol);
        assert_eq!(
            response(b"-WRONGPASS fixture secret text\r\n")
                .await
                .unwrap_err()
                .message(),
            "Redis 사용자 또는 암호를 확인하세요."
        );
    }
}
