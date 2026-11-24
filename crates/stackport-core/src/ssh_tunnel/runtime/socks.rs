use std::{
    io,
    net::{Ipv4Addr, Ipv6Addr},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const REQUEST_ERROR: &str = "올바른 SOCKS5 요청을 받지 못했습니다.";

pub(super) async fn negotiate(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
) -> Result<(String, u16), &'static str> {
    let mut hello = [0; 2];
    stream
        .read_exact(&mut hello)
        .await
        .map_err(|_| REQUEST_ERROR)?;
    if hello[0] != 5 {
        return Err(REQUEST_ERROR);
    }
    let mut methods = [0u8; 255];
    let offered = &mut methods[..usize::from(hello[1])];
    stream
        .read_exact(offered)
        .await
        .map_err(|_| REQUEST_ERROR)?;
    if !offered.contains(&0) {
        let _ = stream.write_all(&[5, 255]).await;
        return Err("클라이언트가 SOCKS5 무인증 방식을 허용하지 않습니다.");
    }
    stream.write_all(&[5, 0]).await.map_err(|_| REQUEST_ERROR)?;
    match request(stream).await {
        Ok(target) => Ok(target),
        Err(code) => {
            let _ = reply(stream, code).await;
            Err(if code == 7 {
                "이 SOCKS5 터널은 TCP CONNECT를 지원합니다."
            } else {
                REQUEST_ERROR
            })
        }
    }
}

async fn request(stream: &mut (impl AsyncRead + Unpin)) -> Result<(String, u16), u8> {
    let mut header = [0; 4];
    stream.read_exact(&mut header).await.map_err(|_| 1u8)?;
    if header[0] != 5 || header[2] != 0 {
        return Err(1);
    }
    if header[1] != 1 {
        return Err(7);
    }
    let address = match header[3] {
        1 => {
            let mut address = [0; 4];
            stream.read_exact(&mut address).await.map_err(|_| 1u8)?;
            Ipv4Addr::from(address).to_string()
        }
        3 => {
            let length = stream.read_u8().await.map_err(|_| 1u8)?;
            let mut bytes = [0u8; 255];
            let name = &mut bytes[..usize::from(length)];
            stream.read_exact(name).await.map_err(|_| 1u8)?;
            let name = std::str::from_utf8(name).map_err(|_| 8u8)?;
            let normalized = crate::ssh::normalize_host(name).map_err(|_| 8u8)?;
            if name.contains(':') || !normalized.eq_ignore_ascii_case(name) {
                return Err(8);
            }
            normalized
        }
        4 => {
            let mut address = [0; 16];
            stream.read_exact(&mut address).await.map_err(|_| 1u8)?;
            Ipv6Addr::from(address).to_string()
        }
        _ => return Err(8),
    };
    let port = stream.read_u16().await.map_err(|_| 1u8)?;
    if port == 0 {
        return Err(1);
    }
    Ok((address, port))
}

pub(super) async fn reply(stream: &mut (impl AsyncWrite + Unpin), code: u8) -> io::Result<()> {
    // direct-tcpip does not report the socket bound on the SSH server.
    stream.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}
