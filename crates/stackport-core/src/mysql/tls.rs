use super::{MysqlSettings, Result};
use mysql_async::{ClientIdentity, SslOpts};
use rustls::RootCertStore;
use std::{
    fs::{self, File},
    io::Read,
    path::PathBuf,
};

const FILE_LIMIT: u64 = 256 * 1024;

pub(super) fn options(settings: &MysqlSettings) -> Result<SslOpts> {
    // The Oracle dependency also enables AWS-LC. mysql_async needs a process default when both providers are enabled.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let mut roots = RootCertStore::empty();
    let mut certificates = Vec::new();
    // The driver uses its bundled roots by default. Keep the platform's configured roots.
    for certificate in rustls_native_certs::load_native_certs().certs {
        if roots.add(certificate.clone()).is_ok() {
            certificates.push(certificate.as_ref().to_vec().into());
        }
    }
    if let Some(path) = &settings.ca_path {
        let mut ca = Vec::new();
        File::open(path)
            .and_then(|file| file.take(FILE_LIMIT + 1).read_to_end(&mut ca))
            .map_err(|_| "MySQL CA 인증서를 읽을 수 없습니다.")?;
        if ca.len() as u64 > FILE_LIMIT {
            return Err("CA 인증서 크기는 256 KiB 이하여야 합니다.".into());
        }
        if ca.is_empty() {
            return Err("MySQL CA 인증서 파일이 비어 있습니다.".into());
        }
        certificates.push(ca.into());
    }
    if certificates.is_empty() {
        return Err(
            "시스템의 TLS 신뢰 인증서를 읽을 수 없습니다. 연결 설정에서 CA 인증서를 지정하세요."
                .into(),
        );
    }
    let mut options = SslOpts::default()
        .with_disable_built_in_roots(true)
        .with_root_certs(certificates);
    if let (Some(certificate), Some(key)) =
        (&settings.client_certificate_path, &settings.client_key_path)
    {
        let certificate = identity_file(certificate, "클라이언트 인증서")?;
        let key = identity_file(key, "클라이언트 개인 키")?;
        options =
            options.with_client_identity(Some(ClientIdentity::new(certificate.into(), key.into())));
    }
    Ok(options)
}

fn identity_file(path: &str, label: &str) -> Result<PathBuf> {
    let path = PathBuf::from(path);
    let valid = fs::metadata(&path)
        .is_ok_and(|file| file.is_file() && (1..=FILE_LIMIT).contains(&file.len()));
    if !valid {
        return Err(format!(
            "MySQL {label} 파일을 확인하세요. 256 KiB 이하의 읽을 수 있는 파일을 지정하세요."
        ));
    }
    Ok(path)
}
