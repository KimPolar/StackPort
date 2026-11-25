mod catalog;
mod definition;
mod profiles;
mod structure;

pub use catalog::{CatalogPage, Column, DataPage, Object};
pub use profiles::{Authentication, Encryption, Profile, ProfileSettings};
pub use structure::{Structure, StructureSection};

use crate::{Result, Store};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tiberius::{error::Error, AuthMethod, Client, Config, EncryptionLevel, Row, ToSql};
use tokio::{
    io::AsyncReadExt,
    net::TcpStream,
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore},
    time::timeout,
};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use uuid::Uuid;
use zeroize::Zeroizing;

const TIMEOUT: Duration = Duration::from_secs(12);
const CA_LIMIT: u64 = 256 * 1024;
type SqlClient = Client<Compat<TcpStream>>;

#[derive(Deserialize)]
#[serde(transparent)]
pub struct Password(#[serde(deserialize_with = "deserialize_password")] Zeroizing<String>);

fn deserialize_password<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(Zeroizing::new)
}

#[derive(Serialize)]
pub struct SessionInfo {
    id: String,
    database: String,
    version: String,
}

struct Session {
    connection: AsyncMutex<SqlClient>,
    closed: AtomicBool,
    _permit: OwnedSemaphorePermit,
}

pub struct Manager {
    store: Store,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    capacity: Arc<Semaphore>,
}

impl Manager {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            sessions: Mutex::new(HashMap::new()),
            capacity: Arc::new(Semaphore::new(8)),
        }
    }

    pub async fn open(
        &self,
        profile_id: String,
        revision: i64,
        password: Password,
        confirmation: &str,
    ) -> Result<SessionInfo> {
        let store = self.store.clone();
        let profile =
            tokio::task::spawn_blocking(move || store.sql_server_profile(&profile_id, revision))
                .await
                .map_err(|_| "SQL Server 연결 설정을 읽을 수 없습니다.")??;
        let settings = profile.settings;
        if settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if password.0.encode_utf16().count() > 128 || password.0.contains('\0') {
            return Err("SQL Server 로그인 암호를 확인하세요.".into());
        }
        let permit = Arc::clone(&self.capacity)
            .try_acquire_owned()
            .map_err(|_| "열린 SQL Server 연결이 너무 많습니다.")?;
        let (client, version, database) = timeout(TIMEOUT, async {
            let auth = match settings.authentication {
                Authentication::SqlLogin => {
                    let username = settings
                        .username
                        .as_deref()
                        .ok_or("SQL Server 로그인 이름을 입력하세요.")?;
                    AuthMethod::sql_server(username, password.0.as_str())
                }
                Authentication::Windows if !password.0.is_empty() => {
                    return Err("Windows 통합 인증에는 암호를 입력하지 않습니다.".into());
                }
                Authentication::Windows => {
                    #[cfg(windows)]
                    {
                        AuthMethod::Integrated
                    }
                    #[cfg(not(windows))]
                    {
                        return Err("이 플랫폼에서 Windows 통합 인증을 사용할 수 없습니다.".into());
                    }
                }
            };
            drop(password);
            let mut config = Config::new();
            config.host(&settings.host);
            config.port(settings.port);
            config.database(&settings.database);
            config.application_name("StackPort");
            config.authentication(auth);
            config.encryption(match settings.encryption {
                Encryption::Required => EncryptionLevel::Required,
                Encryption::Strict => EncryptionLevel::Strict,
            });
            if let Some(path) = settings.ca_path {
                let mut bundle = Vec::new();
                let file = tokio::fs::File::open(path)
                    .await
                    .map_err(|_| "SQL Server CA 인증서 파일을 읽을 수 없습니다.")?;
                file.take(CA_LIMIT + 1)
                    .read_to_end(&mut bundle)
                    .await
                    .map_err(|_| "SQL Server CA 인증서 파일을 읽을 수 없습니다.")?;
                if bundle.is_empty() || bundle.len() as u64 > CA_LIMIT {
                    return Err(
                        "SQL Server CA 인증서는 256 KiB 이하의 PEM 파일을 지정하세요.".into(),
                    );
                }
                config.trust_cert_ca_bundle(bundle);
            }
            let tcp = TcpStream::connect((settings.host.as_str(), settings.port))
                .await
                .map_err(|_| "SQL Server에 연결할 수 없습니다. 호스트와 포트를 확인하세요.")?;
            let mut client = Client::connect(config, tcp.compat_write())
                .await
                .map_err(connection_error)?;
            let row = client
                .simple_query(
                    "SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')), DB_NAME()",
                )
                .await
                .map_err(query_error)?
                .into_row()
                .await
                .map_err(query_error)?
                .ok_or("SQL Server 연결 정보를 읽을 수 없습니다.")?;
            Ok::<_, String>((
                client,
                required_text(&row, 0)?.to_owned(),
                required_text(&row, 1)?.to_owned(),
            ))
        })
        .await
        .map_err(|_| "SQL Server 연결 시간이 초과되었습니다.")??;
        let id = Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .map_err(|_| "SQL Server 연결 목록을 읽을 수 없습니다.")?
            .insert(
                id.clone(),
                Arc::new(Session {
                    connection: AsyncMutex::new(client),
                    closed: AtomicBool::new(false),
                    _permit: permit,
                }),
            );
        Ok(SessionInfo {
            id,
            database,
            version,
        })
    }

    pub fn close(&self, id: &str) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "SQL Server 연결 목록을 읽을 수 없습니다.")?
            .remove(id);
        if let Some(session) = session {
            session.closed.store(true, Ordering::Release);
        }
        Ok(())
    }

    async fn rows(&self, id: &str, sql: &str, params: &[&dyn ToSql]) -> Result<Vec<Row>> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "SQL Server 연결 목록을 읽을 수 없습니다.")?
            .get(id)
            .cloned()
            .ok_or("SQL Server 연결이 닫혔습니다. 다시 연결하세요.")?;
        let mut client = timeout(TIMEOUT, session.connection.lock())
            .await
            .map_err(|_| "앞선 SQL Server 조회가 아직 끝나지 않았습니다.")?;
        if session.closed.load(Ordering::Acquire) {
            return Err("SQL Server 연결이 닫혔습니다. 다시 연결하세요.".into());
        }
        match timeout(TIMEOUT, async {
            client.query(sql, params).await?.into_first_result().await
        })
        .await
        {
            Ok(Ok(rows)) => Ok(rows),
            Ok(Err(error)) => {
                if matches!(error, Error::Io { .. } | Error::Protocol(_)) {
                    self.close(id)?;
                }
                Err(query_error(error))
            }
            Err(_) => {
                self.close(id)?;
                Err("SQL Server 조회 시간이 초과되어 연결이 닫혔습니다. 다시 연결하세요.".into())
            }
        }
    }
}

fn required_text(row: &Row, index: usize) -> Result<&str> {
    row.try_get::<&str, _>(index)
        .map_err(query_error)?
        .ok_or_else(|| "SQL Server 응답에서 필요한 값을 읽을 수 없습니다.".into())
}

fn connection_error(error: Error) -> String {
    match error.code() {
        Some(18452 | 18456) => "SQL Server 인증을 확인하세요. 로그인 계정과 암호를 확인하세요.",
        Some(4060) => "SQL Server 데이터베이스를 열 수 없습니다. 이름과 접근 권한을 확인하세요.",
        _ => "SQL Server 연결을 열 수 없습니다. TLS 모드, 서버 인증서, 호스트와 인증 설정을 확인하세요.",
    }.into()
}

fn query_error(error: Error) -> String {
    match error.code() {
        Some(229 | 230 | 916) => "현재 SQL Server 계정에 조회 권한이 없습니다.",
        Some(208) => "SQL Server 객체를 찾을 수 없습니다. 목록을 새로 고치세요.",
        _ => "SQL Server 조회에 실패했습니다. 연결과 객체를 확인하세요.",
    }
    .into()
}
