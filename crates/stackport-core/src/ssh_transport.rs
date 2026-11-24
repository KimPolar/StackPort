use crate::{ssh, Result, SshHostInfo, SshManager, SshProfile};
use russh::{
    client::{self, Handle},
    keys::{
        decode_secret_key, key::PrivateKeyWithHashAlg, Algorithm, HashAlg, PublicKey,
        PublicKeyOrCertificate,
    },
    Disconnect, Preferred,
};
use serde::{Deserialize, Deserializer};
use std::{
    borrow::Cow,
    fs,
    io::Read,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::timeout;
use zeroize::Zeroizing;

const MAX_KEY_FILE: u64 = 128 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshCredentials {
    Password {
        #[serde(deserialize_with = "secret")]
        password: Zeroizing<String>,
    },
    PrivateKey {
        path: String,
        #[serde(default, deserialize_with = "secret")]
        passphrase: Zeroizing<String>,
    },
}

fn secret<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(Zeroizing::new)
}

pub(crate) type SshConnection = Handle<HostVerifier>;

pub(crate) enum Endpoint {
    Authenticated(SshConnection),
    TrustRequired(SshHostInfo),
}

pub(crate) enum HostVerifier {
    Pinned(PublicKey),
    Capture(Arc<Mutex<Option<PublicKey>>>),
}

impl client::Handler for HostVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        offered: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, russh::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = offered else {
            return Ok(false);
        };
        match self {
            Self::Pinned(pinned) => Ok(key.key_data() == pinned.key_data()),
            Self::Capture(slot) => {
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(key.clone());
                }
                Ok(false)
            }
        }
    }
}

pub(crate) async fn connect_endpoint(
    manager: Arc<SshManager>,
    profile: &SshProfile,
    credentials: SshCredentials,
    previous: Option<&SshConnection>,
    capture_unknown: bool,
) -> Result<Endpoint> {
    timeout(
        CONNECT_TIMEOUT,
        connect(manager, profile, credentials, previous, capture_unknown),
    )
    .await
    .map_err(|_| "SSH 연결 시간이 초과되었습니다.")?
}

async fn connect(
    manager: Arc<SshManager>,
    profile: &SshProfile,
    credentials: SshCredentials,
    previous: Option<&SshConnection>,
    capture_unknown: bool,
) -> Result<Endpoint> {
    let host = ssh::normalize_host(&profile.host)?;
    let port = profile.port;
    ssh::validate_port(port)?;
    let username = ssh::normalize_username(&profile.username)?;
    let key_host = host.clone();
    let keys = Arc::clone(&manager);
    let pinned = tokio::task::spawn_blocking(move || keys.pinned_public_key(&key_host, port))
        .await
        .map_err(|_| "저장된 SSH 호스트 키를 확인할 수 없습니다.")??;
    let capture = Arc::new(Mutex::new(None));
    let mut config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(5 * 60)),
        nodelay: true,
        ..client::Config::default()
    };
    let verifier = match pinned {
        Some(pinned) => {
            let key = PublicKey::from_openssh(&pinned)
                .map_err(|_| "저장된 SSH 호스트 키 형식을 읽을 수 없습니다.")?;
            let algorithms = match key.algorithm() {
                Algorithm::Rsa { .. } => vec![
                    Algorithm::Rsa {
                        hash: Some(HashAlg::Sha512),
                    },
                    Algorithm::Rsa {
                        hash: Some(HashAlg::Sha256),
                    },
                ],
                algorithm => vec![algorithm],
            };
            config.preferred = Preferred {
                key: Cow::Owned(algorithms),
                ..Preferred::default()
            };
            HostVerifier::Pinned(key)
        }
        None if capture_unknown => HostVerifier::Capture(Arc::clone(&capture)),
        None => return Err("먼저 이 서버의 SSH 호스트 키 지문을 확인하고 신뢰하세요.".into()),
    };
    let config = Arc::new(config);
    let connection = if let Some(previous) = previous {
        let channel = previous
            .channel_open_direct_tcpip(host.as_str(), port.into(), "127.0.0.1", 0)
            .await
            .map_err(|_| "이전 경유 서버가 이 주소로의 TCP 연결을 열지 못했습니다.")?;
        client::connect_stream(config, channel.into_stream(), verifier).await
    } else {
        client::connect(config, (host.as_str(), port), verifier).await
    };
    let mut connection = match connection {
        Ok(connection) => connection,
        Err(_) => {
            let offered = capture
                .lock()
                .map_err(|_| "서버 지문을 읽을 수 없습니다.")?
                .take();
            if let Some(key) = offered {
                let encoded = key
                    .to_openssh()
                    .map_err(|_| "서버 지문을 읽을 수 없습니다.")?;
                let review = tokio::task::spawn_blocking(move || {
                    manager.record_offered_key(&host, port, &encoded)
                })
                .await
                .map_err(|_| "서버 지문을 검토할 수 없습니다.")??;
                return Ok(Endpoint::TrustRequired(review));
            }
            return Err("SSH 연결 또는 호스트 키 검증에 실패했습니다. 서버 주소, 접근 권한과 저장된 지문을 확인하세요.".into());
        }
    };
    authenticate(&mut connection, &username, credentials).await?;
    Ok(Endpoint::Authenticated(connection))
}

async fn authenticate(
    connection: &mut SshConnection,
    username: &str,
    credentials: SshCredentials,
) -> Result<()> {
    let authentication = match credentials {
        SshCredentials::Password { password } => {
            if password.is_empty() || password.len() > 4096 {
                return Err("SSH 암호를 확인하세요.".into());
            }
            connection
                .authenticate_password(username, password.as_str())
                .await
        }
        SshCredentials::PrivateKey { path, passphrase } => {
            let key = tokio::task::spawn_blocking(move || load_key(&path, &passphrase))
                .await
                .map_err(|_| "SSH 개인 키를 읽을 수 없습니다.")??;
            let rsa_hash = if key.algorithm().is_rsa() {
                let supported = connection
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|_| "서버의 RSA 서명 방식을 확인할 수 없습니다.")?;
                Some(
                    supported
                        .flatten()
                        .or_else(|| supported.is_none().then_some(HashAlg::Sha256))
                        .ok_or("서버가 SHA-2 RSA 서명을 지원하지 않습니다.")?,
                )
            } else {
                None
            };
            connection
                .authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash),
                )
                .await
        }
    }
    .map_err(|_| "SSH 사용자 인증을 완료할 수 없습니다.")?;
    if !authentication.success() {
        return Err("서버가 SSH 사용자 인증을 거부했습니다.".into());
    }
    Ok(())
}

pub(crate) async fn disconnect(connection: &SshConnection) {
    let _ = connection
        .disconnect(Disconnect::ByApplication, "", "")
        .await;
}

fn load_key(path: &str, phrase: &str) -> Result<russh::keys::PrivateKey> {
    let path = Path::new(path.trim());
    if !path.is_absolute() || !path.is_file() || phrase.len() > 4096 {
        return Err("SSH 개인 키 파일의 절대 경로와 암호를 확인하세요.".into());
    }
    let mut contents = Zeroizing::new(String::new());
    fs::File::open(path)
        .and_then(|file| file.take(MAX_KEY_FILE + 1).read_to_string(&mut contents))
        .map_err(|_| "SSH 개인 키 파일을 읽을 수 없습니다.")?;
    if contents.is_empty() || contents.len() as u64 > MAX_KEY_FILE {
        return Err("SSH 개인 키 파일 크기를 확인하세요.".into());
    }
    decode_secret_key(&contents, (!phrase.is_empty()).then_some(phrase))
        .map_err(|_| "SSH 개인 키 형식 또는 키 암호를 확인하세요.".into())
}
