mod catalog;
mod data_pump;
mod export;
mod profiles;
mod query;

pub use crate::result_export::{
    ResultFileOptions as ExportOptions, ResultFileOutcome as ExportOutcome,
};
pub use catalog::{CatalogPage, Column, DataPage, Object};
pub use crate::credential_store::CredentialStatus;
pub use data_pump::{
    DumpHeader, PumpCapabilities, PumpExportOptions, PumpImportOptions, PumpImportOutcome,
    PumpImportPreview, PumpOutcome, PumpPreview, PumpProgress,
};
pub use profiles::{Profile, ProfileSettings, Target, Transport};
pub use query::{QueryInput, QueryOutcome, QuerySource};

use crate::{Result, Store};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use oracledb::{Config, Connection, Error, ErrorKind};
use rustls::pki_types::{pem::PemObject, CertificateDer};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore},
    time::timeout,
};
use uuid::Uuid;
use zeroize::Zeroizing;

const OPEN_TIMEOUT: Duration = Duration::from_secs(12);
const IO_TIMEOUT: Duration = Duration::from_secs(8);
const READ_TIMEOUT: Duration = Duration::from_secs(16);
const CA_LIMIT: u64 = 256 * 1024;
const CLOSED: &str = "Oracle 연결이 닫혔습니다. 다시 연결하세요.";

#[derive(Deserialize)]
#[serde(transparent)]
pub struct Password(#[serde(deserialize_with = "deserialize_password")] Zeroizing<String>);

pub type PasswordAuthentication = crate::db_profiles::CredentialAuthentication<Password>;

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
    credential_warning: Option<String>,
}

struct Session {
    connection: Arc<AsyncMutex<Connection>>,
    closed: AtomicBool,
    profile: Profile,
    password: Mutex<Option<Password>>,
    export: Mutex<export::State>,
    data_pump: Mutex<data_pump::State>,
    query: Mutex<Option<query::ActiveQuery>>,
    _wallet: Option<TempDir>,
    _permit: OwnedSemaphorePermit,
}

pub struct Manager {
    store: Store,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    capacity: Arc<Semaphore>,
}

impl Store {
    pub fn oracle_credential_status(&self, id: &str, revision: i64) -> Result<CredentialStatus> {
        self.native_db_credential_status::<ProfileSettings>(id, revision, "Oracle")
    }

    pub fn forget_oracle_password(&self, id: &str, revision: i64) -> Result<()> {
        self.forget_native_db_password::<ProfileSettings>(id, revision, "oracle.credential.delete")
    }
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
        credentials: impl Into<PasswordAuthentication>,
        confirmation: String,
    ) -> Result<SessionInfo> {
        let store = self.store.clone();
        let credentials = credentials.into();
        let permit = Arc::clone(&self.capacity)
            .try_acquire_owned()
            .map_err(|_| "열린 Oracle 연결이 너무 많습니다.")?;
        let opened = tokio::task::spawn_blocking(move || {
            let profile = store.oracle_profile(&profile_id, revision)?;
            let settings = &profile.settings;
            if settings.environment == "PROD" && confirmation != "PROD" {
                return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
            }
            let (password, remember) = credentials.resolve(&store, &profile, "Oracle", Password)?;
            if password.0.is_empty() || password.0.len() > 256 || password.0.contains('\0') {
                return Err("Oracle 로그인 암호를 확인하세요.".into());
            }
            let (connection, wallet) = connect(settings, connection_config(settings, &password)?)?;
            let service = connection.service_name().map_err(query_error)?.to_owned();
            let database = if service.is_empty() {
                settings.service.clone()
            } else {
                service
            };
            let version = connection.version().map_err(query_error)?.to_string();
            Ok::<_, String>((connection, wallet, profile, password, remember, database, version, permit))
        });
        let (connection, wallet, profile, password, remember, database, version, permit) = timeout(OPEN_TIMEOUT, opened)
            .await
            .map_err(|_| "Oracle 연결 시간이 초과되었습니다.")?
            .map_err(|_| "Oracle 연결 작업을 마치지 못했습니다.")??;
        let credential_warning = if remember {
            self.store
                .remember_connected_credential(&profile, "Oracle", &password.0, "oracle.credential.save")
                .await
        } else {
            None
        };
        let session = Session {
            connection: Arc::new(AsyncMutex::new(connection)),
            closed: AtomicBool::new(false),
            profile,
            password: Mutex::new(Some(password)),
            export: Mutex::new(export::State::default()),
            data_pump: Mutex::new(data_pump::State::default()),
            query: Mutex::new(None),
            _wallet: wallet,
            _permit: permit,
        };
        let id = Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .map_err(|_| "Oracle 연결 목록을 읽을 수 없습니다.")?
            .insert(id.clone(), Arc::new(session));
        Ok(SessionInfo {
            id,
            database,
            version,
            credential_warning,
        })
    }

    pub fn close(&self, id: &str) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "Oracle 연결 목록을 읽을 수 없습니다.")?
            .remove(id);
        if let Some(session) = session {
            session.closed.store(true, Ordering::Release);
            session.stop_query();
            session.stop_data_pump()?;
            session
                .password
                .lock()
                .map_err(|_| "Oracle 인증 상태를 읽을 수 없습니다.")?
                .take();
            session.stop_export()?;
            tokio::task::spawn_blocking(move || drop(session));
        }
        Ok(())
    }

    async fn read<T, F>(&self, id: &str, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        self.read_with_deadline(id, READ_TIMEOUT, operation).await
    }

    fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .map_err(|_| "Oracle 연결 목록을 읽을 수 없습니다.")?
            .get(id)
            .cloned()
            .ok_or_else(|| CLOSED.into())
    }

    async fn read_with_deadline<T, F>(
        &self,
        id: &str,
        deadline: Duration,
        operation: F,
    ) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        let session = self.session(id)?;
        let connection = timeout(READ_TIMEOUT, Arc::clone(&session.connection).lock_owned())
            .await
            .map_err(|_| "앞선 Oracle 조회가 아직 끝나지 않았습니다.")?;
        if session.closed.load(Ordering::Acquire) {
            return Err(CLOSED.into());
        }
        let job = tokio::task::spawn_blocking(move || {
            let result = operation(&connection);
            drop(connection);
            drop(session);
            result
        });
        match timeout(deadline, job).await {
            Ok(result) => result.map_err(|_| "Oracle 조회 작업을 마치지 못했습니다.")?,
            Err(_) => {
                self.close(id)?;
                Err("Oracle 조회 시간이 초과되어 연결이 닫혔습니다. 다시 연결하세요.".into())
            }
        }
    }
}

impl Session {
    fn operation_config(&self) -> Result<Config> {
        let password = self
            .password
            .lock()
            .map_err(|_| "Oracle 인증 상태를 읽을 수 없습니다.")?;
        connection_config(&self.profile.settings, password.as_ref().ok_or(CLOSED)?)
    }
}

fn connection_config(settings: &ProfileSettings, password: &Password) -> Result<Config> {
    Ok(Config::default()
        .set_connect_string(&settings.descriptor())
        .map_err(connection_error)?
        .set_credentials(&settings.username, password.0.as_str())
        .set_driver_name("StackPort")
        .set_transport_connect_timeout(Some(Duration::from_secs(5))))
}

fn connect(
    settings: &ProfileSettings,
    mut config: Config,
) -> Result<(Connection, Option<TempDir>)> {
    let wallet = settings
        .ca_path
        .as_deref()
        .map(Path::new)
        .map(create_ca_wallet)
        .transpose()?;
    if let Some(directory) = &wallet {
        config = config.set_wallet_location(directory.path().to_string_lossy());
    }
    let connection = oracledb::connect(config).map_err(connection_error)?;
    connection
        .set_call_timeout(Some(IO_TIMEOUT))
        .map_err(query_error)?;
    if settings.transport == Transport::Tcps {
        let row = connection
            .query_row(
                "SELECT SYS_CONTEXT('USERENV','NETWORK_PROTOCOL') FROM DUAL",
                &[],
            )
            .map_err(query_error)?;
        if !row
            .get::<&str>(0)
            .map_err(query_error)?
            .eq_ignore_ascii_case("tcps")
        {
            return Err("Oracle 서버가 TCPS 세션을 제공하지 않았습니다.".into());
        }
    }
    Ok((connection, wallet))
}

fn create_ca_wallet(path: &Path) -> Result<TempDir> {
    const INVALID: &str = "Oracle CA 인증서는 256 KiB 이하의 PEM 파일을 지정하세요.";
    let file = File::open(path).map_err(|_| "Oracle CA 인증서 파일을 읽을 수 없습니다.")?;
    let mut bytes = Vec::new();
    file.take(CA_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| INVALID)?;
    if bytes.len() as u64 > CA_LIMIT {
        return Err(INVALID.into());
    }
    let certs = CertificateDer::pem_slice_iter(&bytes)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| INVALID)?;
    if certs.is_empty() {
        return Err(INVALID.into());
    }
    let directory =
        tempfile::tempdir().map_err(|_| "Oracle 임시 인증서 폴더를 만들 수 없습니다.")?;
    let mut wallet = File::create(directory.path().join("ewallet.pem")).map_err(|_| INVALID)?;
    for cert in certs {
        let encoded = STANDARD.encode(cert.as_ref());
        writeln!(
            wallet,
            "-----BEGIN CERTIFICATE-----\n{encoded}\n-----END CERTIFICATE-----"
        )
        .map_err(|_| INVALID)?;
    }
    Ok(directory)
}

fn connection_error(error: Error) -> String {
    match error.db_error_code() {
        Some(1017 | 28000 | 28001) => "Oracle 사용자 이름, 암호와 계정 상태를 확인하세요.",
        _ => match error.kind() {
            ErrorKind::InvalidServiceName(..) | ErrorKind::InvalidSid(..) => {
                "Oracle 리스너에서 서비스 이름 또는 SID를 찾을 수 없습니다."
            }
            ErrorKind::TlsOperation => "Oracle TCPS 서버 인증서와 호스트 이름을 확인하세요.",
            _ => "Oracle 연결을 열 수 없습니다. 호스트, 포트, 서비스와 TCPS 설정을 확인하세요.",
        },
    }
    .into()
}

fn query_error(error: Error) -> String {
    match error.db_error_code() {
        Some(942 | 1031) => "Oracle 객체를 찾을 수 없거나 현재 계정에 조회 권한이 없습니다.",
        _ => match error.kind() {
            ErrorKind::CallTimeoutExceeded => "Oracle 조회 시간이 초과되었습니다.",
            ErrorKind::DeadConnection | ErrorKind::NotConnected => CLOSED,
            _ => "Oracle 조회에 실패했습니다. 연결과 객체를 확인하세요.",
        },
    }
    .into()
}
