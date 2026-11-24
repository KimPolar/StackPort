use super::search::{self, PostgresSearchInput, PostgresSearchPage};
use super::{
    catalog::{self, PostgresStructure, PostgresStructureSection},
    edit::{
        self, grid as grid_update, row as row_edit, PostgresCellChange, PostgresEditField, PostgresEditInput,
        PostgresEditOutcome, PostgresEditPreview, PostgresEditSession, PostgresRowEditPreview,
        PostgresRowStamp,
    },
    export::EXPORT_TIMEOUT,
    grid_layout::PostgresGridLayout,
    monitor::{self, PostgresActivityInput, PostgresActivitySnapshot},
    parameters::Value,
    sql, sql_range,
    statement_stats::{self, PostgresStatementStats, PostgresStatementStatsInput},
    value::{
        self, PostgresValuePage, PostgresValueRepresentation, PostgresValueRow, PostgresValueSave,
        PostgresValueTarget, ValueKind,
    },
    PostgresProfile, PostgresSqlInput, PostgresSqlMode, PostgresSqlOutcome,
};
use crate::{
    edit::{RowChangePreview, RowChangeSession, RowPastePreview},
    insert_audit, quote_identifier,
    ssh_tunnel::DatabaseTunnel,
    table_query::bounded_filter_text,
    AuditRecord, LocalTunnelEndpoint, Result, SshTunnelManager, Store, TableQueryClauses,
};
use native_tls::{Certificate, Protocol, TlsConnector};
use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    future::pending,
    io::Read,
    net::Ipv4Addr,
    sync::{atomic::AtomicU64, Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{watch, Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
    time::timeout,
};
use tokio_postgres::{config::SslMode, Client, Config, IsolationLevel, Row};
use uuid::Uuid;
use zeroize::Zeroizing;

const CONNECTION_LIMIT: usize = 8;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const QUERY_TIMEOUT: Duration = Duration::from_secs(12);
const CATALOG_SIZE: usize = 100;
pub(super) const ROW_SIZE: usize = 100;
pub(super) const COLUMN_SIZE: usize = 24;
pub(super) const VALUE_LENGTH: usize = 512;
const CA_SIZE: u64 = 256 * 1024;
const TUNNEL_CLOSE_GRACE: Duration = Duration::from_millis(1500);

#[derive(Deserialize)]
#[serde(transparent)]
pub struct PostgresPassword(#[serde(deserialize_with = "secret")] Zeroizing<String>);

pub(super) fn secret<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(Zeroizing::new)
}

#[derive(Serialize)]
pub struct PostgresSessionInfo {
    id: String,
    version: String,
    database: String,
    username: String,
    encoding: String,
    timezone: String,
    tunnel: Option<String>,
    tunnel_id: Option<String>,
    grid_edit: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PostgresDisconnect {
    Closed,
    TunnelStopped,
    TunneledConnectionClosed,
}

impl PostgresDisconnect {
    fn message(self) -> &'static str {
        match self {
            Self::Closed => "PostgreSQL 연결이 닫혔습니다. 다시 연결하세요.",
            Self::TunnelStopped => "SSH 터널이 중단되어 PostgreSQL 연결이 닫혔습니다.",
            Self::TunneledConnectionClosed => "SSH 터널을 통한 PostgreSQL 연결이 끊겼습니다.",
        }
    }
}

#[derive(Serialize)]
struct Schema {
    id: i64,
    name: String,
    accessible: bool,
}

#[derive(Serialize)]
pub struct PostgresSchemaPage {
    schemas: Vec<Schema>,
    has_next: bool,
}

#[derive(Serialize)]
struct Object {
    id: i64,
    name: String,
    kind: &'static str,
    readable: bool,
}

#[derive(Serialize)]
pub struct PostgresObjectPage {
    objects: Vec<Object>,
    has_next: bool,
}

#[derive(Clone, Serialize)]
struct Column {
    name: String,
    data_type: String,
    not_null: bool,
    primary_key_position: Option<i32>,
    editable: bool,
    value_kind: Option<ValueKind>,
}

#[derive(Serialize)]
pub struct Cell {
    pub(super) value: Option<String>,
    pub(super) truncated: bool,
}

#[derive(Serialize)]
pub struct PostgresPage {
    schema: String,
    name: String,
    kind: &'static str,
    columns: Vec<Column>,
    rows: Vec<Vec<Cell>>,
    total_columns: usize,
    visible_columns: usize,
    pinned_columns: usize,
    has_next_columns: bool,
    has_next: bool,
    primary_key_order: bool,
    primary_key_columns: Vec<String>,
    column_names: Vec<String>,
    source: String,
    parameter_types: Vec<u32>,
    row_stamps: Option<Vec<Option<PostgresRowStamp>>>,
    value_rows: Option<Vec<PostgresValueRow>>,
    edit_reason: Option<&'static str>,
    row_update: bool,
    row_insert: bool,
    row_paste: bool,
    row_delete: bool,
    row_delete_reason: Option<&'static str>,
}

pub struct PostgresManager {
    store: Store,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    permits: Arc<Semaphore>,
}

struct Session {
    profile: PostgresProfile,
    client: AsyncMutex<Client>,
    connection: JoinHandle<()>,
    connection_ended: watch::Receiver<bool>,
    tunnel: Option<DatabaseTunnel>,
    monitor_of: Option<String>,
    tls: TlsConnector,
    running_sql: Mutex<Option<sql::RunningSql>>,
    grid_edit: bool,
    edit: AsyncMutex<Option<edit::Plan>>,
    grid_update: AsyncMutex<Option<grid_update::Plan>>,
    row_edit: AsyncMutex<Option<row_edit::Plan>>,
    _permit: OwnedSemaphorePermit,
}

struct MonitorOwner {
    id: String,
    connection_ended: watch::Receiver<bool>,
}

impl Session {
    fn closed_reason(&self) -> Option<PostgresDisconnect> {
        if self.tunnel.as_ref().is_some_and(|route| !route.running()) {
            return Some(PostgresDisconnect::TunnelStopped);
        }
        (self.connection.is_finished() || *self.connection_ended.borrow()).then_some(
            if self.tunnel.is_some() {
                PostgresDisconnect::TunneledConnectionClosed
            } else {
                PostgresDisconnect::Closed
            },
        )
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.connection.abort();
    }
}

impl PostgresManager {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            sessions: Mutex::default(),
            permits: Arc::new(Semaphore::new(CONNECTION_LIMIT)),
        }
    }

    pub async fn open(
        &self,
        tunnels: &SshTunnelManager,
        profile: PostgresProfile,
        password: PostgresPassword,
        confirmation: &str,
        tunnel_id: Option<&str>,
        grid_edit: bool,
    ) -> Result<PostgresSessionInfo> {
        let tls = self.authorize(&profile, &password, confirmation).await?;
        let settings = &profile.settings;
        let tunnel = tunnel_id
            .map(|id| {
                tunnels.database_tunnel(id, &profile.project_id, &settings.host, settings.port)
            })
            .transpose()?;
        self.connect(profile, password, tls, tunnel, grid_edit, None)
            .await
    }

    pub async fn open_monitor(
        &self,
        id: &str,
        password: PostgresPassword,
        confirmation: &str,
    ) -> Result<PostgresSessionInfo> {
        let workspace = self.session(id)?;
        if workspace.monitor_of.is_some() {
            return Err("데이터베이스 작업 공간에서 서버 모니터를 여세요.".into());
        }
        let profile = workspace.profile.clone();
        let tunnel = workspace.tunnel.clone();
        let owner = MonitorOwner {
            id: id.to_owned(),
            connection_ended: workspace.connection_ended.clone(),
        };
        drop(workspace);
        let tls = self.authorize(&profile, &password, confirmation).await?;
        self.connect(profile, password, tls, tunnel, false, Some(owner))
            .await
    }

    async fn authorize(
        &self,
        profile: &PostgresProfile,
        password: &PostgresPassword,
        confirmation: &str,
    ) -> Result<TlsConnector> {
        if password.0.len() > 4096 || password.0.contains('\0') {
            return Err("PostgreSQL 암호를 확인하세요.".into());
        }
        if profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let store = self.store.clone();
        let expected = profile.clone();
        tokio::task::spawn_blocking(move || {
            if store.postgres_profile(&expected.id)? != expected {
                return Err("PostgreSQL 연결이 변경되었습니다. 새로고침하세요.".into());
            }
            tls_connector(expected.settings.ca_path.as_deref())
        })
        .await
        .map_err(|_| "PostgreSQL 연결 설정을 확인할 수 없습니다.")?
    }

    async fn connect(
        &self,
        profile: PostgresProfile,
        password: PostgresPassword,
        tls: TlsConnector,
        tunnel: Option<DatabaseTunnel>,
        grid_edit: bool,
        owner: Option<MonitorOwner>,
    ) -> Result<PostgresSessionInfo> {
        let settings = &profile.settings;
        let application = if owner.is_some() {
            "StackPort Monitor"
        } else {
            "StackPort"
        };
        let mut config = Config::new();
        config.host(&settings.host).user(&settings.username).dbname(&settings.database).password(password.0.as_bytes())
            .application_name(application).ssl_mode(SslMode::Require).connect_timeout(Duration::from_secs(5))
            .options("-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000 -c idle_session_timeout=600000 -c search_path=pg_catalog -c standard_conforming_strings=on");
        let endpoint = tunnel.as_ref().map(DatabaseTunnel::endpoint);
        if let Some(endpoint) = &endpoint {
            // Keep the original host for SNI and certificate validation.
            config
                .hostaddr(Ipv4Addr::LOCALHOST.into())
                .port(endpoint.port);
        } else {
            config.port(settings.port);
        }
        self.sessions
            .lock()
            .map_err(|_| "PostgreSQL 연결 목록을 읽을 수 없습니다.")?
            .retain(|_, session| session.closed_reason().is_none());
        let permit = Arc::clone(&self.permits)
            .try_acquire_owned()
            .map_err(|_| "열린 PostgreSQL 연결이 너무 많습니다. 사용하지 않는 연결을 닫으세요.")?;
        let connector = timeout(
            CONNECT_TIMEOUT,
            config.connect(MakeTlsConnector::new(tls.clone())),
        );
        let opened = if let Some(route) = &tunnel {
            tokio::select! {
                biased;
                _ = route.ended() => return Err(PostgresDisconnect::TunnelStopped.message().into()),
                result = connector => result,
            }
        } else {
            connector.await
        };
        if tunnel.as_ref().is_some_and(|route| !route.running()) {
            return Err(PostgresDisconnect::TunnelStopped.message().into());
        }
        let (client, connection) = opened
            .map_err(|_| "PostgreSQL 연결 시간이 초과되었습니다.")?
            .map_err(connect_error)?;
        drop(config);
        drop(password);
        let (ended, connection_ended) = watch::channel(false);
        let link = tunnel.clone();
        let owner_ended = owner.as_ref().map(|owner| owner.connection_ended.clone());
        let session = Arc::new(Session {
            profile,
            client: AsyncMutex::new(client),
            connection: tokio::spawn(async move {
                tokio::select! {
                    _ = connection => {}
                    _ = async { match link { Some(route) => route.ended().await, None => pending().await } } => {}
                    _ = async {
                        match owner_ended {
                            Some(mut owner) => { let _ = owner.wait_for(|closed| *closed).await; }
                            None => pending().await,
                        }
                    } => {}
                }
                ended.send_replace(true);
            }),
            connection_ended,
            tunnel,
            monitor_of: owner.map(|owner| owner.id),
            tls,
            running_sql: Mutex::default(),
            grid_edit,
            edit: AsyncMutex::default(),
            grid_update: AsyncMutex::default(),
            row_edit: AsyncMutex::default(),
            _permit: permit,
        });
        let id = Uuid::new_v4().to_string();
        let info = timeout(QUERY_TIMEOUT, server_info(&session, id.clone(), endpoint))
            .await
            .map_err(|_| "PostgreSQL 서버 응답 시간이 초과되었습니다.")?;
        if let Some(reason) = session.closed_reason() {
            return Err(reason.message().into());
        }
        let info = info?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "PostgreSQL 연결 목록을 읽을 수 없습니다.")?;
        if let Some(owner) = &session.monitor_of {
            if !sessions
                .get(owner)
                .is_some_and(|workspace| workspace.closed_reason().is_none())
            {
                return Err(PostgresDisconnect::Closed.message().into());
            }
            if sessions.values().any(|other| {
                other.monitor_of.as_ref() == Some(owner) && other.closed_reason().is_none()
            }) {
                return Err("이 데이터베이스 연결의 서버 모니터가 이미 열려 있습니다.".into());
            }
        }
        sessions.insert(id, session);
        Ok(info)
    }

    pub fn close(&self, id: &str) -> Result<()> {
        if let Some(session) = self
            .sessions
            .lock()
            .map_err(|_| "PostgreSQL 연결 목록을 읽을 수 없습니다.")?
            .remove(id)
        {
            sql::RunningSql::stop_session(&session.running_sql);
            session.connection.abort();
        }
        Ok(())
    }

    fn session(&self, id: &str) -> Result<Arc<Session>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "PostgreSQL 연결 목록을 읽을 수 없습니다.")?;
        let session = sessions
            .get(id)
            .ok_or(PostgresDisconnect::Closed.message())?;
        if let Some(reason) = session.closed_reason() {
            return Err(reason.message().into());
        }
        Ok(Arc::clone(session))
    }

    pub async fn wait_disconnect(&self, id: &str) -> Result<PostgresDisconnect> {
        let (mut ended, route) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "PostgreSQL 연결 목록을 읽을 수 없습니다.")?;
            let Some(session) = sessions.get(id) else {
                return Ok(PostgresDisconnect::Closed);
            };
            (session.connection_ended.clone(), session.tunnel.clone())
        };
        let _ = ended.wait_for(|closed| *closed).await;
        if let Some(route) = route {
            // The database socket can close just before the SSH worker finishes.
            if route.running() {
                let _ = timeout(TUNNEL_CLOSE_GRACE, route.ended()).await;
            }
            if !route.running() {
                return Ok(PostgresDisconnect::TunnelStopped);
            }
            return Ok(PostgresDisconnect::TunneledConnectionClosed);
        }
        Ok(PostgresDisconnect::Closed)
    }

    pub async fn schemas(&self, id: &str, page: u32) -> Result<PostgresSchemaPage> {
        let session = self.session(id)?;
        timeout(QUERY_TIMEOUT, async {
            let client = session.client.lock().await;
            let rows = client.query(
                "SELECT oid::bigint, nspname::text, pg_catalog.has_schema_privilege(oid, 'USAGE')
                 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
                 ORDER BY nspname, oid LIMIT 101 OFFSET $1", &[&offset(page, CATALOG_SIZE)],
            ).await.map_err(pg_error)?;
            let has_next = rows.len() > CATALOG_SIZE;
            let schemas = rows.iter().take(CATALOG_SIZE).map(|row| Ok(Schema { id: field(row, 0)?, name: field(row, 1)?, accessible: field(row, 2)? })).collect::<Result<_>>()?;
            Ok(PostgresSchemaPage { schemas, has_next })
        }).await.map_err(|_| "스키마 목록을 읽는 시간이 초과되었습니다.")?
    }

    pub async fn objects(
        &self,
        id: &str,
        schema: i64,
        search: &str,
        page: u32,
    ) -> Result<PostgresObjectPage> {
        if search.len() > 1024 || search.contains('\0') || schema <= 0 {
            return Err("찾을 스키마와 검색어를 확인하세요.".into());
        }
        let session = self.session(id)?;
        timeout(QUERY_TIMEOUT, async {
            let client = session.client.lock().await;
            let rows = client.query(
                "SELECT c.oid::bigint, c.relname::text, c.relkind::text, pg_catalog.has_table_privilege(c.oid, 'SELECT')
                 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.oid::bigint = $1 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
                   AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND c.relkind IN ('r','p','v','m')
                   AND pg_catalog.strpos(pg_catalog.lower(c.relname::text), pg_catalog.lower($2)) > 0
                 ORDER BY c.relname, c.oid LIMIT 101 OFFSET $3", &[&schema, &search, &offset(page, CATALOG_SIZE)],
            ).await.map_err(pg_error)?;
            let has_next = rows.len() > CATALOG_SIZE;
            let objects = rows.iter().take(CATALOG_SIZE).map(|row| Ok(Object { id: field(row, 0)?, name: field(row, 1)?, kind: kind(field::<String>(row, 2)?.as_str())?, readable: field(row, 3)? })).collect::<Result<_>>()?;
            Ok(PostgresObjectPage { objects, has_next })
        }).await.map_err(|_| "객체 목록을 읽는 시간이 초과되었습니다.")?
    }

    pub async fn search_objects(
        &self,
        id: &str,
        input: PostgresSearchInput,
    ) -> Result<PostgresSearchPage> {
        input.validate()?;
        let session = self.session(id)?;
        timeout(QUERY_TIMEOUT, async {
            let client = session.client.lock().await;
            search::objects(&client, input).await
        })
        .await
        .map_err(|_| "PostgreSQL 객체 검색 시간이 초과되었습니다.")?
    }

    pub async fn server_activity(
        &self,
        id: &str,
        input: PostgresActivityInput,
    ) -> Result<PostgresActivitySnapshot> {
        input.validate()?;
        let session = self.monitor_session(id)?;
        timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            monitor::activity(&mut client, input).await
        })
        .await
        .map_err(|_| "PostgreSQL 서버 활동을 읽는 시간이 초과되었습니다.")?
    }

    pub async fn statement_stats(
        &self,
        id: &str,
        input: PostgresStatementStatsInput,
    ) -> Result<PostgresStatementStats> {
        let session = self.monitor_session(id)?;
        timeout(QUERY_TIMEOUT, async {
            let client = session.client.lock().await;
            statement_stats::stats(&client, input).await
        })
        .await
        .map_err(|_| "PostgreSQL 누적 쿼리 통계를 읽는 시간이 초과되었습니다.")?
    }

    fn monitor_session(&self, id: &str) -> Result<Arc<Session>> {
        let session = self.session(id)?;
        let owner = session
            .monitor_of
            .as_deref()
            .ok_or("서버 모니터 연결을 먼저 여세요.")?;
        self.session(owner)?;
        Ok(session)
    }

    pub async fn page(
        &self,
        id: &str,
        object: i64,
        row_page: u32,
        column_page: u32,
        query: Option<TableQueryClauses>,
        layout: Option<PostgresGridLayout>,
    ) -> Result<PostgresPage> {
        let session = self.session(id)?;
        timeout(
            QUERY_TIMEOUT,
            browse(
                &session,
                object,
                row_page,
                column_page,
                query.unwrap_or_default(),
                layout.unwrap_or_default(),
            ),
        )
        .await
        .map_err(|_| "데이터 페이지를 읽는 시간이 초과되었습니다.")?
    }

    pub async fn value_page(
        &self,
        id: &str,
        target: PostgresValueTarget,
        page: u32,
    ) -> Result<PostgresValuePage> {
        let session = self.session(id)?;
        timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            let tx = client
                .build_transaction()
                .read_only(true)
                .isolation_level(IsolationLevel::RepeatableRead)
                .start()
                .await
                .map_err(pg_error)?;
            let value = value::preview(&tx, &target, page).await?;
            tx.commit().await.map_err(pg_error)?;
            Ok(value)
        })
        .await
        .map_err(|_| "셀 값을 읽는 시간이 초과되었습니다.")?
    }

    pub async fn value_representation(
        &self,
        id: &str,
        target: PostgresValueTarget,
    ) -> Result<PostgresValueRepresentation> {
        let session = self.session(id)?;
        timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            let tx = client
                .build_transaction()
                .read_only(true)
                .isolation_level(IsolationLevel::RepeatableRead)
                .start()
                .await
                .map_err(pg_error)?;
            let value = value::representation(&tx, &target).await?;
            tx.commit().await.map_err(pg_error)?;
            Ok(value)
        })
        .await
        .map_err(|_| "셀 미리보기를 읽는 시간이 초과되었습니다.")?
    }

    pub async fn save_value(
        &self,
        id: &str,
        target: PostgresValueTarget,
        destination: String,
    ) -> Result<PostgresValueSave> {
        let session = self.session(id)?;
        let (file, size_bytes) = timeout(EXPORT_TIMEOUT, async {
            let mut client = session.client.lock().await;
            let tx = client
                .build_transaction()
                .read_only(true)
                .isolation_level(IsolationLevel::RepeatableRead)
                .start()
                .await
                .map_err(pg_error)?;
            let staged = value::stage(&tx, &target, destination).await?;
            tx.commit().await.map_err(pg_error)?;
            Ok::<_, String>(staged)
        })
        .await
        .map_err(|_| "셀 값을 저장하는 시간이 초과되었습니다.")??;
        let store = self.store.clone();
        let profile = session.profile.clone();
        tokio::task::spawn_blocking(move || {
            file.publish()?;
            let correlation = Uuid::new_v4().to_string();
            let audit = AuditRecord {
                correlation_id: &correlation,
                operation: "postgres.export.cell",
                project_id: Some(&profile.project_id),
                profile_id: Some(&profile.id),
                environment: Some(&profile.settings.environment),
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(1),
            };
            let audit_warning = store
                .connect()
                .and_then(|db| insert_audit(&db, audit))
                .is_err();
            Ok(PostgresValueSave {
                size_bytes,
                audit_warning,
            })
        })
        .await
        .map_err(|_| "셀 파일 저장 결과를 확인할 수 없습니다.")?
    }

    pub async fn execute_sql(
        &self,
        id: &str,
        request: &str,
        input: PostgresSqlInput,
    ) -> Result<PostgresSqlOutcome> {
        let request = Uuid::parse_str(request).map_err(|_| "SQL 실행 요청 ID를 확인하세요.")?;
        let PostgresSqlInput {
            source,
            scope,
            mode,
            bindings,
            export,
        } = input;
        let span = sql_range::statement(&source, scope)?;
        if let Some(values) = &bindings {
            values.validate()?;
        }
        if export.is_some() && mode != PostgresSqlMode::Query {
            return Err("PostgreSQL 조회 결과를 내보낼 SQL을 선택하세요.".into());
        }
        let session = self.session(id)?;
        let (cancel, signal) = watch::channel(false);
        let progress = export.as_ref().map(|_| Arc::new(AtomicU64::new(0)));
        let running =
            sql::RunningSql::register(&session.running_sql, request, cancel, progress.clone())?;
        let deadline = if export.is_some() {
            EXPORT_TIMEOUT
        } else {
            QUERY_TIMEOUT
        };
        let operation = async {
            let mut client = session.client.lock().await;
            let query = sql::Request {
                source: &source,
                span,
                bindings: bindings.as_ref(),
                mode,
                export: export
                    .as_ref()
                    .zip(progress)
                    .map(|(options, progress)| sql::ExportRequest { options, progress }),
            };
            let (outcome, reusable) =
                sql::query(&mut client, query, signal, session.tls.clone()).await;
            if !reusable {
                session.connection.abort();
            }
            outcome
        };
        match timeout(deadline, operation).await {
            Ok(outcome) => Ok(outcome
                .publish(&running, &self.store, &session.profile, request)
                .await),
            Err(_) => {
                session.connection.abort();
                Ok(PostgresSqlOutcome::interrupted(true, false, true))
            }
        }
    }

    pub async fn structure(
        &self,
        id: &str,
        object: i64,
        section: PostgresStructureSection,
        page: u32,
    ) -> Result<PostgresStructure> {
        let session = self.session(id)?;
        timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            let tx = client
                .build_transaction()
                .read_only(true)
                .isolation_level(IsolationLevel::RepeatableRead)
                .start()
                .await
                .map_err(pg_error)?;
            let result = catalog::structure(&tx, object, section, page).await?;
            tx.commit().await.map_err(pg_error)?;
            Ok(result)
        })
        .await
        .map_err(|_| "PostgreSQL 객체 구조를 읽는 시간이 초과되었습니다.")?
    }

    pub async fn begin_edit(
        &self,
        id: &str,
        object: i64,
        stamp: PostgresRowStamp,
        column: &str,
    ) -> Result<PostgresEditSession> {
        let session = self.edit_session(id)?;
        let mut pending = session.edit.lock().await;
        let (plan, response) = timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            edit::begin(&mut client, object, stamp, column).await
        })
        .await
        .map_err(|_| "편집할 행을 읽는 시간이 초과되었습니다.")??;
        let token = plan.token;
        *pending = Some(plan);
        let session = Arc::downgrade(&session);
        tokio::spawn(async move {
            tokio::time::sleep(edit::LIFETIME).await;
            if let Some(session) = session.upgrade() {
                let mut pending = session.edit.lock().await;
                if pending.as_ref().is_some_and(|plan| plan.token == token) {
                    pending.take();
                }
            }
        });
        Ok(response)
    }

    pub async fn preview_edit(
        &self,
        id: &str,
        token: &str,
        input: PostgresEditInput,
    ) -> Result<PostgresEditPreview> {
        self.preview_changes(id, token, |plan| {
            vec![PostgresCellChange {
                column: plan.first_column(),
                input,
            }]
        })
        .await?
        .single()
    }

    pub async fn open_edit_field(
        &self,
        id: &str,
        token: &str,
        column: &str,
    ) -> Result<PostgresEditField> {
        let session = self.edit_session(id)?;
        let mut pending = session.edit.lock().await;
        let token = edit_token(token)?;
        timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            let plan = checked_edit(&mut pending, token)?;
            edit::open_field(&mut client, plan, column).await
        })
        .await
        .map_err(|_| "편집할 열을 읽는 시간이 초과되었습니다.")?
    }

    pub async fn preview_row_edit(
        &self,
        id: &str,
        token: &str,
        changes: Vec<PostgresCellChange>,
    ) -> Result<PostgresRowEditPreview> {
        self.preview_changes(id, token, |_| changes).await
    }

    async fn preview_changes(
        &self,
        id: &str,
        token: &str,
        inputs: impl FnOnce(&edit::Plan) -> Vec<PostgresCellChange>,
    ) -> Result<PostgresRowEditPreview> {
        let session = self.edit_session(id)?;
        let mut pending = session.edit.lock().await;
        let plan = checked_edit(&mut pending, edit_token(token)?)?;
        plan.clear_preview();
        timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            if plan.created.elapsed() >= edit::LIFETIME {
                return Err(edit::EXPIRED.into());
            }
            let changes = inputs(plan);
            edit::preview(&mut client, plan, changes).await
        })
        .await
        .map_err(|_| "변경 미리보기 시간이 초과되었습니다.")?
    }

    pub async fn apply_edit(
        &self,
        id: &str,
        token: &str,
        approval: &str,
        confirmation: &str,
    ) -> Result<PostgresEditOutcome> {
        let session = self.edit_session(id)?;
        let token = edit_token(token)?;
        if session.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let mut pending = session.edit.lock().await;
        if !checked_edit(&mut pending, token)?.approved(edit_token(approval)?) {
            return Err("현재 변경 내용을 다시 미리 보세요.".into());
        }
        let mut client = timeout(QUERY_TIMEOUT, session.client.lock())
            .await
            .map_err(|_| "연결에서 실행 중인 작업이 끝난 뒤 다시 시도하세요.")?;
        checked_edit(&mut pending, token)?;
        let plan = pending.take().ok_or(edit::EXPIRED)?;
        let outcome = edit::apply(&mut client, &self.store, &session.profile, plan).await?;
        if matches!(outcome, PostgresEditOutcome::Unknown) {
            session.connection.abort();
        }
        Ok(outcome)
    }

    pub async fn cancel_edit(&self, id: &str, token: &str) -> Result<()> {
        let session = self.edit_session(id)?;
        let token = edit_token(token)?;
        let mut pending = session.edit.lock().await;
        if pending.as_ref().is_some_and(|plan| plan.token == token) {
            pending.take();
        }
        Ok(())
    }

    pub async fn begin_grid_edit(
        &self,
        id: &str,
        object: i64,
        stamps: Vec<PostgresRowStamp>,
    ) -> Result<grid_update::PostgresGridEditSession> {
        let session = self.edit_session(id)?;
        let mut pending = session.grid_update.lock().await;
        let (plan, response) = timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            grid_update::begin(&mut client, object, stamps).await
        })
        .await
        .map_err(|_| "편집할 행을 읽는 시간이 초과되었습니다.")??;
        let token = plan.token;
        *pending = Some(plan);
        let session = Arc::downgrade(&session);
        tokio::spawn(async move {
            tokio::time::sleep(edit::LIFETIME).await;
            if let Some(session) = session.upgrade() {
                let mut pending = session.grid_update.lock().await;
                if pending.as_ref().is_some_and(|plan| plan.token == token) {
                    pending.take();
                }
            }
        });
        Ok(response)
    }

    pub async fn open_grid_edit_column(
        &self,
        id: &str,
        token: &str,
        column: &str,
    ) -> Result<Vec<Option<PostgresEditField>>> {
        let session = self.edit_session(id)?;
        let mut pending = session.grid_update.lock().await;
        let token = edit_token(token)?;
        timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            let plan = checked_grid_edit(&mut pending, token)?;
            grid_update::open_column(&mut client, plan, column).await
        })
        .await
        .map_err(|_| "편집할 열을 읽는 시간이 초과되었습니다.")?
    }

    pub async fn preview_grid_edit(
        &self,
        id: &str,
        token: &str,
        changes: Vec<grid_update::PostgresGridEditChange>,
    ) -> Result<grid_update::PostgresGridEditPreview> {
        let session = self.edit_session(id)?;
        let mut pending = session.grid_update.lock().await;
        let token = edit_token(token)?;
        checked_grid_edit(&mut pending, token)?.clear_preview();
        timeout(grid_update::TIME_LIMIT, async {
            let mut client = session.client.lock().await;
            let plan = checked_grid_edit(&mut pending, token)?;
            grid_update::preview(&mut client, plan, changes).await
        })
        .await
        .map_err(|_| "변경 미리보기 시간이 초과되었습니다.")?
    }

    pub async fn apply_grid_edit(
        &self,
        id: &str,
        token: &str,
        approval: &str,
        confirmation: &str,
    ) -> Result<grid_update::PostgresGridEditOutcome> {
        let session = self.edit_session(id)?;
        let token = edit_token(token)?;
        if session.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let mut pending = session.grid_update.lock().await;
        if !checked_grid_edit(&mut pending, token)?.approved(edit_token(approval)?) {
            return Err("현재 변경 내용을 다시 미리 보세요.".into());
        }
        let mut client = timeout(QUERY_TIMEOUT, session.client.lock())
            .await
            .map_err(|_| "연결에서 실행 중인 작업이 끝난 뒤 다시 시도하세요.")?;
        checked_grid_edit(&mut pending, token)?;
        let plan = pending.take().ok_or(edit::EXPIRED)?;
        let outcome = grid_update::apply(&mut client, &self.store, &session.profile, plan).await?;
        if matches!(outcome, grid_update::PostgresGridEditOutcome::Unknown) {
            session.connection.abort();
        }
        Ok(outcome)
    }

    pub async fn cancel_grid_edit(&self, id: &str, token: &str) -> Result<()> {
        let session = self.edit_session(id)?;
        let token = edit_token(token)?;
        let mut pending = session.grid_update.lock().await;
        if pending.as_ref().is_some_and(|plan| plan.token == token) {
            pending.take();
        }
        Ok(())
    }

    pub async fn begin_row_change(
        &self,
        id: &str,
        object: i64,
        change: row_edit::PostgresRowChange,
    ) -> Result<RowChangeSession> {
        let session = self.edit_session(id)?;
        let mut pending = session.row_edit.lock().await;
        let (plan, response) = timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            row_edit::begin(&mut client, object, change).await
        })
        .await
        .map_err(|_| "행 작업 정보를 읽는 시간이 초과되었습니다.")??;
        let token = plan.token;
        *pending = Some(plan);
        let session = Arc::downgrade(&session);
        tokio::spawn(async move {
            tokio::time::sleep(edit::LIFETIME).await;
            if let Some(session) = session.upgrade() {
                let mut pending = session.row_edit.lock().await;
                if pending.as_ref().is_some_and(|plan| plan.token == token) {
                    pending.take();
                }
            }
        });
        Ok(response)
    }

    pub async fn preview_row_insert(
        &self,
        id: &str,
        token: &str,
        changes: Vec<PostgresCellChange>,
    ) -> Result<RowChangePreview> {
        let session = self.edit_session(id)?;
        let mut pending = session.row_edit.lock().await;
        let token = edit_token(token)?;
        checked_row_change(&mut pending, token)?.clear_insert_preview()?;
        timeout(QUERY_TIMEOUT, async {
            let mut client = session.client.lock().await;
            let plan = checked_row_change(&mut pending, token)?;
            row_edit::preview(&mut client, plan, changes).await
        })
        .await
        .map_err(|_| "행 추가 미리보기 시간이 초과되었습니다.")?
    }

    pub async fn apply_row_change(
        &self,
        id: &str,
        token: &str,
        approval: &str,
        confirmation: &str,
    ) -> Result<row_edit::PostgresRowChangeOutcome> {
        self.apply_row_plan(id, token, approval, confirmation, false)
            .await
    }

    pub async fn preview_row_paste(
        &self,
        id: &str,
        token: &str,
        columns: Vec<String>,
        rows: Vec<Vec<PostgresCellChange>>,
    ) -> Result<RowPastePreview> {
        let session = self.edit_session(id)?;
        let mut pending = session.row_edit.lock().await;
        let token = edit_token(token)?;
        let plan = checked_row_change(&mut pending, token)?;
        plan.clear_paste_preview()?;
        let deadline = plan.batch_preview_timeout(QUERY_TIMEOUT);
        timeout(deadline, async {
            let mut client = session.client.lock().await;
            let plan = checked_row_change(&mut pending, token)?;
            row_edit::paste::preview(&mut client, plan, columns, rows).await
        })
        .await
        .map_err(|_| "여러 행의 미리보기 시간이 초과되었습니다.")?
    }

    pub async fn apply_row_paste(
        &self,
        id: &str,
        token: &str,
        approval: &str,
        confirmation: &str,
    ) -> Result<row_edit::PostgresRowChangeOutcome> {
        self.apply_row_plan(id, token, approval, confirmation, true)
            .await
    }

    async fn apply_row_plan(
        &self,
        id: &str,
        token: &str,
        approval: &str,
        confirmation: &str,
        paste: bool,
    ) -> Result<row_edit::PostgresRowChangeOutcome> {
        let session = self.edit_session(id)?;
        let token = edit_token(token)?;
        if session.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let mut pending = session.row_edit.lock().await;
        let plan = checked_row_change(&mut pending, token)?;
        if plan.is_paste() != paste || !plan.approved(edit_token(approval)?) {
            return Err("현재 행 작업을 다시 미리 보세요.".into());
        }
        let mut client = timeout(QUERY_TIMEOUT, session.client.lock())
            .await
            .map_err(|_| "연결에서 실행 중인 작업이 끝난 뒤 다시 시도하세요.")?;
        checked_row_change(&mut pending, token)?;
        let plan = pending.take().ok_or(edit::EXPIRED)?;
        let outcome = row_edit::apply(&mut client, &self.store, &session.profile, plan).await?;
        if matches!(outcome, row_edit::PostgresRowChangeOutcome::Unknown) {
            session.connection.abort();
        }
        Ok(outcome)
    }

    pub async fn cancel_row_change(&self, id: &str, token: &str) -> Result<()> {
        let session = self.edit_session(id)?;
        let token = edit_token(token)?;
        let mut pending = session.row_edit.lock().await;
        if pending.as_ref().is_some_and(|plan| plan.token == token) {
            pending.take();
        }
        Ok(())
    }

    fn edit_session(&self, id: &str) -> Result<Arc<Session>> {
        let session = self.session(id)?;
        if !session.grid_edit {
            return Err("연결할 때 데이터 그리드 편집을 허용하세요.".into());
        }
        Ok(session)
    }

    pub fn export_progress(&self, id: &str, request: &str) -> Result<Option<u64>> {
        let request = Uuid::parse_str(request).map_err(|_| "SQL 실행 요청 ID를 확인하세요.")?;
        match self.session(id) {
            Ok(session) => sql::RunningSql::export_progress(&session.running_sql, request),
            Err(_) => Ok(None),
        }
    }

    pub fn cancel_sql(&self, id: &str, request: &str) -> Result<bool> {
        let request = Uuid::parse_str(request).map_err(|_| "SQL 실행 요청 ID를 확인하세요.")?;
        let session = self.session(id)?;
        sql::RunningSql::cancel(&session.running_sql, request)
    }
}

fn checked_edit(pending: &mut Option<edit::Plan>, token: Uuid) -> Result<&mut edit::Plan> {
    pending
        .as_mut()
        .filter(|plan| plan.token == token && plan.created.elapsed() < edit::LIFETIME)
        .ok_or_else(|| edit::EXPIRED.into())
}

fn checked_grid_edit(
    pending: &mut Option<grid_update::Plan>,
    token: Uuid,
) -> Result<&mut grid_update::Plan> {
    pending.as_mut()
        .filter(|plan| plan.token == token && plan.created.elapsed() < edit::LIFETIME)
        .ok_or_else(|| edit::EXPIRED.into())
}

fn checked_row_change(
    pending: &mut Option<row_edit::Plan>,
    token: Uuid,
) -> Result<&mut row_edit::Plan> {
    pending
        .as_mut()
        .filter(|plan| plan.active(token))
        .ok_or_else(|| edit::EXPIRED.into())
}

fn edit_token(token: &str) -> Result<Uuid> {
    Uuid::parse_str(token).map_err(|_| edit::EXPIRED.into())
}

async fn server_info(
    session: &Session,
    id: String,
    endpoint: Option<LocalTunnelEndpoint>,
) -> Result<PostgresSessionInfo> {
    let client = session.client.lock().await;
    let row = client.query_one(
        "SELECT pg_catalog.current_setting('server_version'), current_database()::text, current_user::text,
                pg_catalog.current_setting('server_encoding'), pg_catalog.current_setting('TimeZone'), pg_catalog.current_setting('transaction_read_only')", &[],
    ).await.map_err(pg_error)?;
    if field::<String>(&row, 5)? != "on" {
        return Err("서버에서 읽기 전용 설정을 확인할 수 없습니다.".into());
    }
    Ok(PostgresSessionInfo {
        id,
        version: field(&row, 0)?,
        database: field(&row, 1)?,
        username: field(&row, 2)?,
        encoding: field(&row, 3)?,
        timezone: field(&row, 4)?,
        tunnel_id: endpoint.as_ref().map(|route| route.id.clone()),
        tunnel: endpoint.map(|route| route.name),
        grid_edit: session.grid_edit,
    })
}

async fn browse(
    session: &Session,
    object: i64,
    row_page: u32,
    column_page: u32,
    query: TableQueryClauses,
    layout: PostgresGridLayout,
) -> Result<PostgresPage> {
    let mut client = session.client.lock().await;
    let tx = client
        .build_transaction()
        .read_only(true)
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(pg_error)?;
    let catalog::Relation { schema, name, kind } = catalog::relation(&tx, object).await?;
    let (edit_table, edit_reason) = if session.grid_edit {
        match edit::access(&tx, object, kind).await? {
            edit::Access::Allowed(table) => {
                let reason = table.update_reason();
                (Some(table), reason)
            }
            edit::Access::Blocked(reason) => (None, Some(reason)),
        }
    } else {
        (None, None)
    };
    let row_update = edit_table.is_some() && edit_reason.is_none();
    let row_insert = edit_table
        .as_ref()
        .is_some_and(edit::EditTable::allow_insert);
    let row_paste = edit_table
        .as_ref()
        .is_some_and(edit::EditTable::allow_paste);
    let row_delete = edit_table
        .as_ref()
        .is_some_and(edit::EditTable::allow_delete);
    let row_delete_reason = edit_table.as_ref().and_then(edit::EditTable::delete_reason);
    let stamp_table = edit_table
        .as_ref()
        .filter(|_| edit_reason.is_none() || row_delete);
    let details = tx.query(
        "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, pk.position, a.atttypid::bigint
         FROM pg_catalog.pg_attribute a
         LEFT JOIN LATERAL (
           SELECT k.ordinality::integer AS position FROM pg_catalog.pg_index i
           CROSS JOIN pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ordinality)
           WHERE i.indrelid = a.attrelid AND i.indisprimary AND k.ordinality <= i.indnkeyatts AND k.attnum = a.attnum
         ) pk ON true
         WHERE a.attrelid::bigint = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum", &[&object],
    ).await.map_err(pg_error)?;
    let all_columns: Vec<Column> = details
        .iter()
        .map(|row| {
            let name: String = field(row, 0)?;
            Ok(Column {
                editable: edit_table
                    .as_ref()
                    .is_some_and(|table| table.editable(&name)),
                name,
                data_type: field(row, 1)?,
                not_null: field(row, 2)?,
                primary_key_position: field(row, 3)?,
                value_kind: ValueKind::for_type(field(row, 4)?),
            })
        })
        .collect::<Result<_>>()?;
    let total_columns = all_columns.len();
    let primary_key_columns = primary_key_columns(&all_columns);
    let primary_key_order = !primary_key_columns.is_empty();
    let column_names: Vec<_> = all_columns
        .iter()
        .map(|column| column.name.clone())
        .collect();
    let table = quote_identifier(&name);
    let mut values = Vec::new();
    let suffix = query.suffix(
        &table,
        column_names.iter().map(String::as_str),
        primary_key_columns.iter().map(String::as_str),
        |value| {
            let value = value.text();
            bounded_filter_text(value)?;
            values.push(Value::Text {
                value: Zeroizing::new(value.to_owned()),
            });
            Ok(format!("${}", values.len()))
        },
        |column, parameter| {
            format!("pg_catalog.strpos({column}::pg_catalog.text, {parameter}) > 0")
        },
    )?;
    let from = format!("\nFROM {}.{table}{suffix}", quote_identifier(&schema));
    let column_view = layout.page(&column_names, column_page, COLUMN_SIZE)?;
    let columns: Vec<_> = column_view
        .indices
        .iter()
        .map(|&index| all_columns[index].clone())
        .collect();
    let mut projection = if columns.is_empty() {
        "NULL::pg_catalog.text".into()
    } else {
        columns
            .iter()
            .map(|column| {
                let field = format!("{table}.{}", quote_identifier(&column.name));
                column.value_kind.map_or_else(
                    || value::grid_text(&field),
                    |kind| kind.grid_preview(&field),
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let include_value_rows = columns.iter().any(|column| column.value_kind.is_some())
        && value::supports_row(&tx, object, kind).await?;
    if include_value_rows {
        projection.push_str(", ");
        projection.push_str(PostgresValueRow::PROJECTION);
    }
    if let Some(table) = stamp_table {
        projection.push_str(", ");
        projection.push_str(&table.row_projection());
    }
    let row_offset = offset(row_page, ROW_SIZE);
    let sql = format!("SELECT {projection}{from}\nLIMIT 101 OFFSET {row_offset}");
    let statement =
        tx.prepare(&sql)
            .await
            .map_err(|error| match error.code().map(|code| code.code()) {
                Some("42883" | "42P18" | "42804") => {
                    "선택한 열에서 해당 필터 또는 정렬을 사용할 수 없습니다.".into()
                }
                _ => pg_error(error),
            })?;
    let portal = tx
        .bind_raw(&statement, values.iter())
        .await
        .map_err(|error| match error.code().map(|code| code.code()) {
            Some(code) if code.starts_with("22") => "필터 값의 형식이나 범위를 확인하세요.".into(),
            _ => pg_error(error),
        })?;
    let result = tx.query_portal(&portal, 0).await.map_err(pg_error)?;
    let parameter_types = statement.params().iter().map(|ty| ty.oid()).collect();
    let has_next = result.len() > ROW_SIZE;
    let rows = preview_rows(&result, columns.len())?;
    let value_rows = if include_value_rows {
        Some(
            result
                .iter()
                .take(ROW_SIZE)
                .map(|row| PostgresValueRow::from_row(row, columns.len()))
                .collect::<Result<_>>()?,
        )
    } else {
        None
    };
    let edit_offset = columns.len()
        + if include_value_rows {
            PostgresValueRow::FIELD_COUNT
        } else {
            0
        };
    let row_stamps = if let Some(table) = stamp_table {
        Some(
            result
                .iter()
                .take(ROW_SIZE)
                .map(|row| table.stamp(row, edit_offset))
                .collect::<Result<_>>()?,
        )
    } else {
        None
    };
    tx.commit().await.map_err(pg_error)?;
    Ok(PostgresPage {
        schema,
        name,
        kind,
        columns,
        rows,
        total_columns,
        visible_columns: column_view.visible_count,
        pinned_columns: column_view.pinned_count,
        has_next_columns: column_view.has_next,
        has_next,
        primary_key_order,
        primary_key_columns,
        column_names,
        source: format!("SELECT *{from}"),
        parameter_types,
        row_stamps,
        value_rows,
        edit_reason,
        row_update,
        row_insert,
        row_paste,
        row_delete,
        row_delete_reason,
    })
}

pub(super) fn preview_rows(result: &[Row], columns: usize) -> Result<Vec<Vec<Cell>>> {
    result
        .iter()
        .take(ROW_SIZE)
        .map(|row| {
            (0..columns)
                .map(|index| {
                    let mut value: Option<String> = field(row, index)?;
                    let mut truncated = false;
                    if let Some(text) = value.as_mut() {
                        if let Some((last, _)) = text.char_indices().nth(VALUE_LENGTH) {
                            text.truncate(last);
                            truncated = true;
                        }
                    }
                    Ok(Cell { value, truncated })
                })
                .collect::<Result<Vec<_>>>()
        })
        .collect()
}

fn primary_key_columns(columns: &[Column]) -> Vec<String> {
    let mut keys: Vec<_> = columns
        .iter()
        .filter_map(|c| {
            c.primary_key_position
                .map(|position| (position, c.name.clone()))
        })
        .collect();
    keys.sort_unstable_by_key(|(position, _)| *position);
    keys.into_iter().map(|(_, name)| name).collect()
}

pub(super) fn kind(code: &str) -> Result<&'static str> {
    match code {
        "r" => Ok("table"),
        "p" => Ok("partitioned"),
        "v" => Ok("view"),
        "m" => Ok("materialized"),
        _ => Err("PostgreSQL 객체 유형을 읽을 수 없습니다.".into()),
    }
}

fn offset(page: u32, size: usize) -> i64 {
    i64::from(page) * size as i64
}

pub(super) fn field<T: for<'a> tokio_postgres::types::FromSql<'a>>(
    row: &Row,
    index: usize,
) -> Result<T> {
    row.try_get(index).map_err(pg_error)
}

fn tls_connector(ca_path: Option<&str>) -> Result<TlsConnector> {
    let mut builder = TlsConnector::builder();
    builder.min_protocol_version(Some(Protocol::Tlsv12));
    if let Some(path) = ca_path {
        let mut pem = Vec::new();
        File::open(path)
            .and_then(|file| file.take(CA_SIZE + 1).read_to_end(&mut pem))
            .map_err(|_| "PostgreSQL CA 인증서를 읽을 수 없습니다.")?;
        if pem.len() as u64 > CA_SIZE {
            return Err("CA 인증서 크기는 256 KiB 이하여야 합니다.".into());
        }
        let ca =
            Certificate::from_pem(&pem).map_err(|_| "올바른 PEM 형식의 CA 인증서를 선택하세요.")?;
        builder.add_root_certificate(ca);
    }
    builder
        .build()
        .map_err(|_| "PostgreSQL TLS 검증을 초기화할 수 없습니다.".into())
}

fn connect_error(error: tokio_postgres::Error) -> String {
    match error.code().map(|code| code.code()) {
        Some("28P01" | "28000") => "서버가 PostgreSQL 암호 또는 접속 권한을 거부했습니다.".into(),
        Some("3D000") => "서버에서 지정한 PostgreSQL 데이터베이스를 찾을 수 없습니다.".into(),
        Some(code) => format!("PostgreSQL 연결 설정이 거부되었습니다 (SQLSTATE {code})."),
        None => "PostgreSQL에 연결할 수 없습니다. 네트워크와 TLS 인증서의 호스트 이름·신뢰 체인을 확인하세요.".into(),
    }
}

pub(super) fn pg_error(error: tokio_postgres::Error) -> String {
    match error.code().map(|code| code.code()) {
        Some("42501") => "PostgreSQL이 조회 권한을 거부했습니다.".into(),
        Some("57014") => "PostgreSQL 조회가 중단되었거나 제한 시간을 초과했습니다.".into(),
        Some(code) => format!("PostgreSQL 조회에 실패했습니다 (SQLSTATE {code})."),
        None => "PostgreSQL 응답을 읽을 수 없습니다. 연결 상태를 확인하세요.".into(),
    }
}
