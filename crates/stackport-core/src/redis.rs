mod console;
mod edit;
mod keys;
mod monitor;
mod profiles;
mod pubsub;
mod resp;

pub use console::{redis_console_commands, RedisConsoleCommand, RedisConsoleResult};
pub use keys::{RedisKeyPage, RedisScanInput, RedisValueInput, RedisValuePage};
pub use monitor::RedisServerSnapshot;
pub(crate) use profiles::{copy_profiles, SCHEMA};
pub use profiles::{RedisProfile, RedisSettings};
pub use pubsub::{RedisPublishReport, RedisSubscriptionSnapshot};

use crate::{insert_audit, tls, AuditRecord, Result, Store};
use resp::{Failure, Socket, Wire, Work};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore},
    time::timeout,
};
use uuid::Uuid;
use zeroize::Zeroizing;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(8);
const SESSION_LIMIT: usize = 8;
const UPDATE_UNKNOWN: &str =
    "Redis 변경 결과를 확인할 수 없습니다. 연결이 닫혔습니다. 다시 연결해 현재 값을 확인하세요.";

#[derive(Deserialize)]
#[serde(transparent)]
pub struct RedisPassword(#[serde(deserialize_with = "deserialize_secret")] Zeroizing<String>);

fn deserialize_secret<'de, D: Deserializer<'de>>(
    input: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(input).map(Zeroizing::new)
}

#[derive(Serialize)]
pub struct RedisSessionInfo {
    id: String,
    engine: &'static str,
    version: String,
    allow_edits: bool,
    allow_publish: bool,
}

struct Session {
    state: AsyncMutex<Option<edit::State>>,
    profile: RedisProfile,
    allow_edits: bool,
    allow_publish: bool,
    subscription: AsyncMutex<Option<pubsub::Subscription>>,
    _permit: OwnedSemaphorePermit,
}

pub struct RedisManager {
    store: Store,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    permits: Arc<Semaphore>,
}

impl RedisManager {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            sessions: Mutex::default(),
            permits: Arc::new(Semaphore::new(SESSION_LIMIT)),
        }
    }

    pub async fn open(
        &self,
        id: String,
        revision: i64,
        password: RedisPassword,
        confirmation: &str,
        allow_edits: bool,
        allow_publish: bool,
    ) -> Result<RedisSessionInfo> {
        if password.0.len() > 4096 {
            return Err("Redis 암호가 너무 깁니다.".into());
        }
        let store = self.store.clone();
        let profile = tokio::task::spawn_blocking(move || {
            let profile = store.redis_profile(&id, revision)?;
            let tls = connector(&profile.settings)?;
            Ok::<_, String>((profile, tls))
        })
        .await
        .map_err(|_| "Redis 연결 설정을 읽을 수 없습니다.")??;
        let (profile, tls) = profile;
        let settings = &profile.settings;
        if settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let permit = Arc::clone(&self.permits)
            .try_acquire_owned()
            .map_err(|_| "열린 Redis 연결이 너무 많습니다.")?;
        let (engine, version, wire) = timeout(CONNECT_TIMEOUT, establish(settings, tls, &password))
            .await
            .map_err(|_| "Redis 연결 시간이 초과되었습니다.")??;
        let id = Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .map_err(|_| "Redis 연결 목록을 읽을 수 없습니다.")?
            .insert(
                id.clone(),
                Arc::new(Session {
                    state: AsyncMutex::new(Some(edit::State::new(wire))),
                    profile,
                    allow_edits,
                    allow_publish,
                    subscription: AsyncMutex::new(None),
                    _permit: permit,
                }),
            );
        Ok(RedisSessionInfo {
            id,
            engine,
            version,
            allow_edits,
            allow_publish,
        })
    }

    pub fn close(&self, id: &str) -> Result<()> {
        self.sessions
            .lock()
            .map_err(|_| "Redis 연결 목록을 읽을 수 없습니다.")?
            .remove(id);
        Ok(())
    }

    pub async fn keys(&self, id: &str, input: RedisScanInput) -> Result<RedisKeyPage> {
        let session = self.session(id)?;
        self.run(id, &session, |state| {
            Box::pin(keys::scan(&mut state.wire, input))
        })
        .await
    }

    pub async fn value(&self, id: &str, input: RedisValueInput) -> Result<RedisValuePage> {
        let session = self.session(id)?;
        self.run(id, &session, |state| {
            Box::pin(keys::value(&mut state.wire, input))
        })
        .await
    }

    pub async fn server_snapshot(&self, id: &str) -> Result<RedisServerSnapshot> {
        let session = self.session(id)?;
        self.run(id, &session, |state| {
            Box::pin(monitor::snapshot(&mut state.wire))
        })
        .await
    }

    pub async fn preview_edit(
        &self,
        id: &str,
        key: String,
        input: RedisEditInput,
    ) -> Result<RedisEditPreview> {
        let session = self.edit_session(id)?;
        self.run(id, &session, |state| Box::pin(state.preview(key, input)))
            .await
    }

    pub async fn discard_edit(&self, id: &str, token: &str) -> Result<()> {
        let session = self.edit_session(id)?;
        let token = Uuid::parse_str(token).map_err(|_| "Redis 변경을 다시 미리 보세요.")?;
        self.run(id, &session, |state| Box::pin(state.discard(token)))
            .await
    }

    pub async fn preview_delete(
        &self,
        id: &str,
        keys: Vec<String>,
    ) -> Result<RedisKeyDeletePreview> {
        let session = self.edit_session(id)?;
        self.run(id, &session, |state| Box::pin(state.preview_delete(keys)))
            .await
    }

    pub async fn apply_edit(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
    ) -> Result<RedisEditReport> {
        self.apply_change(id, token, confirmation, false).await
    }

    pub async fn apply_delete(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
        approval: &str,
    ) -> Result<RedisEditReport> {
        if approval != "DELETE" {
            return Err("선택한 Redis 키를 삭제하려면 DELETE를 입력하세요.".into());
        }
        self.apply_change(id, token, confirmation, true).await
    }

    async fn apply_change(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
        deleting: bool,
    ) -> Result<RedisEditReport> {
        let session = self.edit_session(id)?;
        let token = Uuid::parse_str(token).map_err(|_| "Redis 변경을 다시 미리 보세요.")?;
        if session.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let store = self.store.clone();
        let profile = session.profile.clone();
        tokio::task::spawn_blocking(move || {
            store.redis_profile(&profile.id, profile.revision)?;
            if deleting {
                edit_audit(&store, &profile, token, "redis.key.delete", "started", None)?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "Redis 연결 설정을 확인할 수 없습니다.")??;
        let result = self
            .run(id, &session, |state| Box::pin(state.apply(token, deleting)))
            .await;
        let (outcome, affected_count) = match &result {
            Ok(report) if matches!(report.status, RedisEditStatus::Applied) => {
                ("succeeded", Some(report.affected_count as i64))
            }
            Err(message) if message == UPDATE_UNKNOWN => ("started", None),
            _ => ("failed", None),
        };
        let operation = match (deleting, outcome == "started") {
            (false, false) => "redis.key.edit",
            (false, true) => "redis.key.edit.unconfirmed",
            (true, false) => "redis.key.delete",
            (true, true) => "redis.key.delete.unconfirmed",
        };
        let store = self.store.clone();
        let profile = session.profile.clone();
        let audit_warning = !matches!(
            tokio::task::spawn_blocking(move || {
                edit_audit(&store, &profile, token, operation, outcome, affected_count)
            })
            .await,
            Ok(Ok(()))
        );
        result.map(|mut report| {
            report.audit_warning = audit_warning;
            report
        })
    }

    fn edit_session(&self, id: &str) -> Result<Arc<Session>> {
        let session = self.session(id)?;
        if !session.allow_edits {
            return Err("Redis 키 편집을 허용한 연결을 여세요.".into());
        }
        Ok(session)
    }

    fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .map_err(|_| "Redis 연결 목록을 읽을 수 없습니다.")?
            .get(id)
            .cloned()
            .ok_or_else(|| "Redis 연결이 닫혔습니다. 다시 연결하세요.".into())
    }

    async fn run<T>(
        &self,
        id: &str,
        session: &Session,
        query: impl for<'a> FnOnce(&'a mut edit::State) -> Work<'a, T>,
    ) -> Result<T> {
        let mut slot = timeout(READ_TIMEOUT, session.state.lock())
            .await
            .map_err(|_| "Redis의 앞선 작업이 끝날 때까지 기다려 주세요.")?;
        let Some(mut state) = slot.take() else {
            self.close(id)?;
            return Err("Redis 연결이 닫혔습니다. 다시 연결하세요.".into());
        };
        let result = timeout(READ_TIMEOUT, async {
            state.expire().await?;
            query(&mut state).await
        })
        .await;
        match result {
            Ok(Ok(value)) => {
                *slot = Some(state);
                Ok(value)
            }
            Ok(Err(Failure::Server(message))) => {
                *slot = Some(state);
                Err(message.into())
            }
            Ok(Err(error)) => {
                self.close(id)?;
                Err(if state.committing {
                    UPDATE_UNKNOWN
                } else {
                    error.message()
                }
                .into())
            }
            Err(_) => {
                self.close(id)?;
                Err(if state.committing {
                    UPDATE_UNKNOWN
                } else {
                    "Redis 응답 시간이 초과되어 연결이 닫혔습니다."
                }
                .into())
            }
        }
    }
}

fn edit_audit(
    store: &Store,
    profile: &RedisProfile,
    token: Uuid,
    operation: &'static str,
    outcome: &'static str,
    affected_count: Option<i64>,
) -> Result<()> {
    insert_audit(
        &store.connect()?,
        AuditRecord {
            correlation_id: &token.to_string(),
            operation,
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(&profile.settings.environment),
            object_name: None,
            outcome,
            affected_count,
        },
    )
}

async fn establish(
    settings: &RedisSettings,
    connector: Option<native_tls::TlsConnector>,
    password: &RedisPassword,
) -> Result<(&'static str, String, Wire)> {
    let socket = TcpStream::connect((settings.host.as_str(), settings.port))
        .await
        .map_err(|_| "Redis 호스트 또는 포트에 연결할 수 없습니다.")?;
    let keepalive = socket2::TcpKeepalive::new().with_time(Duration::from_secs(30));
    let _ = socket2::SockRef::from(&socket).set_tcp_keepalive(&keepalive);
    let socket: Box<dyn Socket> = if let Some(connector) = connector {
        let connector = tokio_native_tls::TlsConnector::from(connector);
        Box::new(
            connector
                .connect(&settings.host, socket)
                .await
                .map_err(|_| "Redis TLS 인증서의 호스트 이름과 신뢰 체인을 확인하세요.")?,
        )
    } else {
        Box::new(socket)
    };
    let mut wire = Wire::new(socket);
    if !settings.username.is_empty() {
        verify_status(
            &mut wire,
            &[b"AUTH", settings.username.as_bytes(), password.0.as_bytes()],
            b"OK",
        )
        .await?;
    } else if !password.0.is_empty() {
        verify_status(&mut wire, &[b"AUTH", password.0.as_bytes()], b"OK").await?;
    }
    let cluster = info(&mut wire, b"cluster").await?;
    if info_field(&cluster, "cluster_enabled") != Some("0") {
        return Err(
            "Redis 단독 서버를 선택하세요. 클러스터에서는 노드별 탐색이 필요합니다.".into(),
        );
    }
    let server = info(&mut wire, b"server").await?;
    let redis_version =
        info_field(&server, "redis_version").ok_or("Redis 서버 버전을 확인할 수 없습니다.")?;
    let mut version_numbers = redis_version.split('.');
    if !matches!((version_numbers.next().and_then(|v| v.parse::<u32>().ok()),
        version_numbers.next().and_then(|v| v.parse::<u32>().ok())), (Some(major), Some(minor)) if (major, minor) >= (6, 2))
    {
        return Err("Redis 6.2 이상과 호환되는 서버를 사용하세요.".into());
    }
    let (engine, version) = match info_field(&server, "valkey_version") {
        Some(version) => ("Valkey", version),
        None => ("Redis", redis_version),
    };
    if settings.database != 0 {
        let database = settings.database.to_string();
        verify_status(&mut wire, &[b"SELECT", database.as_bytes()], b"OK").await?;
    }
    Ok((engine, version.chars().take(64).collect(), wire))
}

fn connector(settings: &RedisSettings) -> Result<Option<native_tls::TlsConnector>> {
    settings
        .tls
        .then(|| tls::verified_connector(settings.ca_path.as_deref(), "Redis"))
        .transpose()
}

async fn verify_status(wire: &mut Wire, args: &[&[u8]], status: &[u8]) -> Result<()> {
    let reply = wire
        .command(args)
        .await
        .and_then(resp::Reply::bytes)
        .map_err(|error| error.message())?;
    if reply != status {
        return Err("Redis 연결 설정의 응답을 확인할 수 없습니다.".into());
    }
    Ok(())
}

async fn info(wire: &mut Wire, section: &[u8]) -> Result<String> {
    let reply = wire
        .command(&[b"INFO", section])
        .await
        .and_then(resp::Reply::bytes)
        .map_err(|error| error.message())?;
    String::from_utf8(reply).map_err(|_| "Redis 서버 정보를 읽을 수 없습니다.".into())
}

fn info_field<'a>(info: &'a str, field: &str) -> Option<&'a str> {
    info.lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(key, value)| (key == field).then_some(value))
}
pub use edit::{
    EditStatus as RedisEditStatus, RedisEditInput, RedisEditPreview, RedisEditReport,
    RedisKeyDeletePreview,
};
