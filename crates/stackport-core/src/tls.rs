use crate::Result;
use native_tls::{Certificate, Protocol, TlsConnector};
use std::{fs::File, io::Read};

pub(crate) fn verified_connector(ca_path: Option<&str>, engine: &str) -> Result<TlsConnector> {
    const CA_SIZE: u64 = 256 * 1024;
    let mut builder = TlsConnector::builder();
    builder.min_protocol_version(Some(Protocol::Tlsv12));
    if let Some(path) = ca_path {
        let mut pem = Vec::new();
        File::open(path)
            .and_then(|file| file.take(CA_SIZE + 1).read_to_end(&mut pem))
            .map_err(|_| format!("{engine} CA 인증서를 읽을 수 없습니다."))?;
        if pem.len() as u64 > CA_SIZE {
            return Err("CA 인증서 크기는 256 KiB 이하여야 합니다.".into());
        }
        let ca =
            Certificate::from_pem(&pem).map_err(|_| "올바른 PEM 형식의 CA 인증서를 선택하세요.")?;
        builder.add_root_certificate(ca);
    }
    builder
        .build()
        .map_err(|_| format!("{engine} TLS 검증을 초기화할 수 없습니다."))
}
