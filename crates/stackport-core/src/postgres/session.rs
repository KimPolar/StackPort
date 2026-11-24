use super::{
    catalog::{self, PostgresStructure, PostgresStructureSection},
    export::EXPORT_TIMEOUT,
    sql, sql_range, PostgresProfile, PostgresSqlInput, PostgresSqlMode, PostgresSqlOutcome,
};
use crate::{quote_identifier, Result, SshTunnelManager, Store};
use native_tls::{Certificate, Protocol, TlsConnector};
use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashMap,
    fs::File,
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

#[derive(Serialize)]
struct Column {
    name: String,
    data_type: String,
    not_null: bool,
    primary_key_position: Option<i32>,
}

#[derive(Serialize)]
pub struct Cell {
    value: Option<String>,
    truncated: bool,
}

#[derive(Serialize)]
pub struct PostgresPage {
    schema: String,
    name: String,
    kind: &'static str,
    columns: Vec<Column>,
    rows: Vec<Vec<Cell>>,
    total_columns: usize,
    has_next: bool,
    primary_key_order: bool,
    primary_key_columns: Vec<String>,
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
    tls: TlsConnector,
    running_sql: Mutex<Option<sql::RunningSql>>,
    _permit: OwnedSemaphorePermit,
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
    ) -> Result<PostgresSessionInfo> {
        if password.0.len() > 4096 || password.0.contains('\0') {
            return Err("PostgreSQL 암호를 확인하세요.".into());
        }
        let settings = &profile.settings;
        if settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let store = self.store.clone();
        let expected = profile.clone();
        let tls = tokio::task::spawn_blocking(move || {
            if store.postgres_profile(&expected.id)? != expected {
                return Err("PostgreSQL 연결이 변경되었습니다. 새로고침하세요.".into());
            }
            tls_connector(expected.settings.ca_path.as_deref())
        })
        .await
        .map_err(|_| "PostgreSQL 연결 설정을 확인할 수 없습니다.")??;

        let mut config = Config::new();
        config.host(&settings.host).user(&settings.username).dbname(&settings.database).password(password.0.as_bytes())
            .application_name("StackPort").ssl_mode(SslMode::Require).connect_timeout(Duration::from_secs(5))
            .options("-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000 -c idle_session_timeout=600000 -c search_path=pg_catalog -c standard_conforming_strings=on");
        let tunnel = if let Some(id) = tunnel_id {
            let endpoint = tunnels
                .local_database_routes(&profile.project_id, &settings.host, settings.port)?
                .into_iter()
                .find(|route| route.id == id)
                .ok_or("이 PostgreSQL 대상에 연결된 실행 중인 로컬 SSH 터널을 선택하세요.")?;
            // Keep the original host for SNI and certificate validation.
            config
                .hostaddr(Ipv4Addr::LOCALHOST.into())
                .port(endpoint.port);
            Some(endpoint.name)
        } else {
            config.port(settings.port);
            None
        };
        self.sessions
            .lock()
            .map_err(|_| "PostgreSQL 연결 목록을 읽을 수 없습니다.")?
            .retain(|_, session| !session.connection.is_finished());
        let permit = Arc::clone(&self.permits)
            .try_acquire_owned()
            .map_err(|_| "열린 PostgreSQL 연결이 너무 많습니다. 사용하지 않는 연결을 닫으세요.")?;
        let (client, connection) = timeout(
            CONNECT_TIMEOUT,
            config.connect(MakeTlsConnector::new(tls.clone())),
        )
        .await
        .map_err(|_| "PostgreSQL 연결 시간이 초과되었습니다.")?
        .map_err(connect_error)?;
        drop(config);
        drop(password);
        let session = Arc::new(Session {
            profile,
            client: AsyncMutex::new(client),
            connection: tokio::spawn(async move {
                let _ = connection.await;
            }),
            tls,
            running_sql: Mutex::default(),
            _permit: permit,
        });
        let id = Uuid::new_v4().to_string();
        let info = timeout(QUERY_TIMEOUT, server_info(&session, id.clone(), tunnel))
            .await
            .map_err(|_| "PostgreSQL 서버 응답 시간이 초과되었습니다.")??;
        self.sessions
            .lock()
            .map_err(|_| "PostgreSQL 연결 목록을 읽을 수 없습니다.")?
            .insert(id, session);
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
        sessions
            .get(id)
            .filter(|session| !session.connection.is_finished())
            .cloned()
            .ok_or_else(|| "PostgreSQL 연결이 닫혔습니다. 다시 연결하세요.".into())
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

    pub async fn page(
        &self,
        id: &str,
        object: i64,
        row_page: u32,
        column_page: u32,
    ) -> Result<PostgresPage> {
        let session = self.session(id)?;
        timeout(
            QUERY_TIMEOUT,
            browse(&session, object, row_page, column_page),
        )
        .await
        .map_err(|_| "데이터 페이지를 읽는 시간이 초과되었습니다.")?
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

async fn server_info(
    session: &Session,
    id: String,
    tunnel: Option<String>,
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
        tunnel,
    })
}

async fn browse(
    session: &Session,
    object: i64,
    row_page: u32,
    column_page: u32,
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
    let details = tx.query(
        "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, pk.position
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
            Ok(Column {
                name: field(row, 0)?,
                data_type: field(row, 1)?,
                not_null: field(row, 2)?,
                primary_key_position: field(row, 3)?,
            })
        })
        .collect::<Result<_>>()?;
    let total_columns = all_columns.len();
    let primary_key_columns = primary_key_columns(&all_columns);
    let primary_key_order = !primary_key_columns.is_empty();
    let order = if primary_key_order {
        format!(
            " ORDER BY {}",
            primary_key_columns
                .iter()
                .map(|name| quote_identifier(name))
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        String::new()
    };
    let start = usize::try_from(offset(column_page, COLUMN_SIZE)).unwrap_or(usize::MAX);
    if start >= total_columns && column_page != 0 {
        return Err("열 페이지를 다시 선택하세요.".into());
    }
    let columns: Vec<_> = all_columns
        .into_iter()
        .skip(start)
        .take(COLUMN_SIZE)
        .collect();
    let projection = if columns.is_empty() {
        "NULL::pg_catalog.text".into()
    } else {
        columns
            .iter()
            .map(|column| {
                format!(
                    "pg_catalog.left({}::pg_catalog.text, {})",
                    quote_identifier(&column.name),
                    VALUE_LENGTH + 1
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let sql = format!(
        "SELECT {projection} FROM {}.{}{order} LIMIT 101 OFFSET $1",
        quote_identifier(&schema),
        quote_identifier(&name)
    );
    let result = tx
        .query(&sql, &[&offset(row_page, ROW_SIZE)])
        .await
        .map_err(pg_error)?;
    let has_next = result.len() > ROW_SIZE;
    let rows = preview_rows(&result, columns.len())?;
    tx.commit().await.map_err(pg_error)?;
    Ok(PostgresPage {
        schema,
        name,
        kind,
        columns,
        rows,
        total_columns,
        has_next,
        primary_key_order,
        primary_key_columns,
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
