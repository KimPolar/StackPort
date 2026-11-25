mod edit;
mod export;
mod grid;
mod monitor;
mod plan;
pub(crate) mod profiles;
mod sql;
mod structure;
mod tls;

pub use edit::{MysqlEditChange, MysqlEditOutcome, MysqlEditPreview, MysqlRowStamp};
pub use export::{MysqlExportOptions, MysqlExportOutcome, MysqlExportSource};
pub use monitor::{MysqlActivityInput, MysqlActivitySnapshot};
pub use plan::MysqlPlan;
pub(crate) use profiles::{copy_profiles, SCHEMA};
pub use profiles::{MysqlProfile, MysqlSettings};
pub use sql::{MysqlSqlParameter, MysqlSqlResult};
pub use structure::{MysqlStructure, MysqlStructureSection};

use crate::{
    ssh_tunnel::DatabaseTunnel, table_query::TableQueryDialect, LocalTunnelEndpoint, Result,
    SshTunnelManager, Store, TableQueryClauses,
};
use mysql_async::{
    from_row_opt,
    prelude::{FromRow, Queryable},
    Conn, DriverError, Error, IoError, Opts, OptsBuilder, Params, Row, TlsError, Value,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{watch, Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore},
    time::timeout,
};
use uuid::Uuid;
use zeroize::Zeroizing;

const CONNECT: Duration = Duration::from_secs(12);
const READ: Duration = Duration::from_secs(12);
const CATALOG_LIMIT: usize = 100;
const ROW_LIMIT: usize = 50;
const COLUMN_LIMIT: usize = 128;
const CELL_BYTES: usize = 512;
const DISCONNECTED: &str = "MySQL 연결이 닫혔습니다. 다시 연결하세요.";
const TUNNEL_STOPPED: &str =
    "SSH 터널이 중단되어 MySQL 연결이 닫혔습니다. 터널을 시작한 뒤 다시 연결하세요.";

#[derive(Deserialize)]
#[serde(transparent)]
pub struct MysqlPassword(#[serde(deserialize_with = "deserialize_secret")] Zeroizing<String>);

fn deserialize_secret<'de, D: Deserializer<'de>>(
    input: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(input).map(Zeroizing::new)
}

#[derive(Serialize)]
pub struct MysqlSessionInfo {
    id: String,
    engine: &'static str,
    version: String,
    database: Option<String>,
    tunnel: Option<LocalTunnelEndpoint>,
    grid_edit: bool,
}

#[derive(Serialize)]
pub struct MysqlCatalogPage<T> {
    items: Vec<T>,
    has_next: bool,
}

impl<T> MysqlCatalogPage<T> {
    fn new(mut items: Vec<T>) -> Self {
        let has_next = items.len() > CATALOG_LIMIT;
        items.truncate(CATALOG_LIMIT);
        Self { items, has_next }
    }
}

#[derive(Serialize)]
pub struct MysqlObject {
    name: String,
    kind: String,
    engine: Option<String>,
}

#[derive(Serialize)]
pub struct MysqlColumn {
    name: String,
    data_type: String,
    column_type: String,
    nullable: bool,
    key: String,
    #[serde(skip)]
    extra: String,
    #[serde(skip)]
    default_value: Option<String>,
    #[serde(skip)]
    collation: Option<String>,
}

#[derive(Clone, Serialize)]
struct MysqlCell {
    text: String,
    encoding: &'static str,
    bytes: u64,
    truncated: bool,
}

#[derive(Serialize)]
pub struct MysqlTable {
    columns: Vec<MysqlColumn>,
    rows: Vec<Vec<Option<MysqlCell>>>,
    more_columns: bool,
    more_rows: bool,
    stable_order: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    filter_columns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    query_sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edit: Option<edit::PageEdit>,
}

#[derive(Default, Deserialize)]
pub struct MysqlGridQuery {
    page: u32,
    clauses: TableQueryClauses,
}

struct Session {
    connection: AsyncMutex<Option<Conn>>,
    options: Opts,
    sql_mode: sql::SqlMode,
    running_sql: Mutex<Option<sql::RunningSql>>,
    monitor: AsyncMutex<Option<monitor::MonitorConnection>>,
    grid_edit: bool,
    pending_edit: AsyncMutex<Option<edit::PendingEdit>>,
    engine: &'static str,
    profile_id: String,
    project_id: String,
    environment: String,
    tunnel: Option<DatabaseTunnel>,
    closed: watch::Sender<bool>,
    _permit: OwnedSemaphorePermit,
}

pub struct MysqlManager {
    store: Store,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    capacity: Arc<Semaphore>,
}

enum ReadError {
    Server(Error),
    Shape,
    Missing,
    InvalidQuery(String),
}

impl From<Error> for ReadError {
    fn from(error: Error) -> Self {
        Self::Server(error)
    }
}

type ReadResult<T> = std::result::Result<T, ReadError>;
type Work<'a, T> = Pin<Box<dyn Future<Output = ReadResult<T>> + Send + 'a>>;

impl MysqlManager {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            sessions: Arc::default(),
            capacity: Arc::new(Semaphore::new(8)),
        }
    }

    pub async fn open(
        &self,
        id: String,
        revision: i64,
        password: MysqlPassword,
        confirmation: &str,
        route: Option<(&SshTunnelManager, &str)>,
        grid_edit: bool,
    ) -> Result<MysqlSessionInfo> {
        if password.0.len() > 4096 {
            return Err("MySQL 암호가 너무 깁니다.".into());
        }
        let store = self.store.clone();
        let production_confirmed = confirmation == "PROD";
        let (profile, tls) = tokio::task::spawn_blocking(move || {
            let profile = store.mysql_profile(&id, revision)?;
            let settings = &profile.settings;
            if settings.environment == "PROD" && !production_confirmed {
                return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
            }
            let tls = settings.tls.then(|| tls::options(settings)).transpose()?;
            Ok::<_, String>((profile, tls))
        })
        .await
        .map_err(|_| "MySQL 연결 설정을 읽을 수 없습니다.")??;
        let settings = profile.settings;
        let tunnel = route
            .map(|(tunnels, id)| {
                tunnels.database_tunnel(id, &profile.project_id, &settings.host, settings.port)
            })
            .transpose()?;
        let endpoint = tunnel.as_ref().map(DatabaseTunnel::endpoint);
        let permit = Arc::clone(&self.capacity)
            .try_acquire_owned()
            .map_err(|_| "열린 MySQL 계열 연결이 너무 많습니다.")?;
        let (host, port, tls) = match &endpoint {
            Some(endpoint) => (
                "127.0.0.1".to_owned(),
                endpoint.port,
                // Authenticate the configured database server when dialing the local listener.
                tls.map(|tls| tls.with_danger_tls_hostname_override(Some(settings.host))),
            ),
            None => (settings.host, settings.port, tls),
        };
        let options = OptsBuilder::default()
            .ip_or_hostname(host)
            .tcp_port(port)
            .user(Some(settings.username))
            .pass(Some(password.0.as_str()))
            .db_name(settings.database.clone())
            .prefer_socket(false)
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .ssl_opts(tls)
            .max_allowed_packet(Some(4 * 1024 * 1024))
            .init(vec![
                "SET NAMES utf8mb4",
                "SET SESSION TRANSACTION READ ONLY",
            ]);
        drop(password);
        let (connection, version, mode) = through_tunnel(tunnel.as_ref(), async {
            timeout(CONNECT, async {
                let mut connection = Conn::new(options).await?;
                let row = connection
                    .query_first::<Row, _>("SELECT VERSION(), @@SESSION.sql_mode")
                    .await?
                    .ok_or(ReadError::Shape)?;
                let (version, mode): (String, String) =
                    from_row_opt(row).map_err(|_| ReadError::Shape)?;
                Ok::<_, ReadError>((connection, version, sql::SqlMode::parse(&mode)))
            })
            .await
            .map_err(|_| "MySQL 연결 시간이 초과되었습니다.")?
            .map_err(|error| read_message(&error).to_owned())
        })
        .await?;
        let engine = if version.to_ascii_lowercase().contains("mariadb") {
            "MariaDB"
        } else {
            "MySQL"
        };
        let id = Uuid::new_v4().to_string();
        let (closed, mut closed_listener) = watch::channel(false);
        self.sessions
            .lock()
            .map_err(|_| "MySQL 연결 목록을 읽을 수 없습니다.")?
            .insert(
                id.clone(),
                Arc::new(Session {
                    options: connection.opts().clone(),
                    sql_mode: mode,
                    running_sql: Mutex::default(),
                    monitor: AsyncMutex::new(None),
                    grid_edit,
                    pending_edit: AsyncMutex::new(None),
                    engine,
                    connection: AsyncMutex::new(Some(connection)),
                    profile_id: profile.id,
                    project_id: profile.project_id,
                    environment: settings.environment,
                    tunnel: tunnel.clone(),
                    closed,
                    _permit: permit,
                }),
            );
        if let Some(tunnel) = tunnel {
            let sessions = Arc::downgrade(&self.sessions);
            let session_id = id.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = tunnel.ended() => {
                        if let Some(sessions) = sessions.upgrade() {
                            let _ = close_session(&sessions, &session_id);
                        }
                    }
                    _ = closed_listener.wait_for(|closed| *closed) => {}
                }
            });
        }
        Ok(MysqlSessionInfo {
            id,
            engine,
            version: version.chars().take(128).collect(),
            database: settings.database,
            tunnel: endpoint,
            grid_edit,
        })
    }

    pub fn close(&self, id: &str) -> Result<()> {
        close_session(&self.sessions, id)
    }

    pub async fn wait_tunnel_end(&self, id: &str) -> Result<bool> {
        let (tunnel, mut closed) = {
            let session = self.session(id)?;
            (session.tunnel.clone(), session.closed.subscribe())
        };
        let Some(tunnel) = tunnel else {
            return Ok(false);
        };
        tokio::select! {
            biased;
            _ = tunnel.ended() => Ok(true),
            _ = closed.wait_for(|closed| *closed) => Ok(false),
        }
    }

    pub async fn databases(
        &self,
        id: &str,
        search: String,
        page: u32,
    ) -> Result<MysqlCatalogPage<String>> {
        let offset = catalog_offset(&search, page)?;
        self.read(id, |connection| Box::pin(async move {
            let rows: Vec<(String,)> = query(connection, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
                WHERE LOCATE(?, SCHEMA_NAME) > 0 ORDER BY CAST(SCHEMA_NAME AS BINARY) LIMIT 101 OFFSET ?", (search, offset)).await?;
            Ok(MysqlCatalogPage::new(rows.into_iter().map(|(name,)| name).collect()))
        })).await
    }

    pub async fn objects(
        &self,
        id: &str,
        database: String,
        search: String,
        page: u32,
    ) -> Result<MysqlCatalogPage<MysqlObject>> {
        require_identifier(&database)?;
        let offset = catalog_offset(&search, page)?;
        self.read(id, |connection| Box::pin(async move {
            let rows: Vec<(String, String, Option<String>)> = query(connection, "SELECT TABLE_NAME, TABLE_TYPE, ENGINE FROM information_schema.TABLES
                WHERE CAST(TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY) AND TABLE_TYPE IN ('BASE TABLE','VIEW','SYSTEM VIEW','SYSTEM VERSIONED')
                  AND LOCATE(?, TABLE_NAME) > 0 ORDER BY CAST(TABLE_NAME AS BINARY) LIMIT 101 OFFSET ?", (database, search, offset)).await?;
            Ok(MysqlCatalogPage::new(rows.into_iter().map(|(name, kind, engine)| MysqlObject { name, kind, engine }).collect()))
        })).await
    }

    pub async fn table(
        &self,
        id: &str,
        database: String,
        name: String,
        include_rows: bool,
        grid: Option<MysqlGridQuery>,
    ) -> Result<MysqlTable> {
        require_identifier(&database)?;
        require_identifier(&name)?;
        let grid_edit = include_rows && self.session(id)?.grid_edit;
        self.read(id, |connection| {
            Box::pin(async move {
                read_table(
                    connection,
                    &database,
                    &name,
                    include_rows.then(|| grid.unwrap_or_default()),
                    grid_edit,
                )
                .await
            })
        })
        .await
    }

    async fn read<T>(
        &self,
        id: &str,
        query: impl for<'a> FnOnce(&'a mut Conn) -> Work<'a, T>,
    ) -> Result<T> {
        let session = self.session(id)?;
        let mut slot = timeout(READ, session.connection.lock())
            .await
            .map_err(|_| "앞선 MySQL 조회가 끝날 때까지 기다려 주세요.")?;
        let Some(mut connection) = slot.take() else {
            return Err(DISCONNECTED.into());
        };
        let read = through_tunnel(session.tunnel.as_ref(), async {
            Ok(timeout(READ, query(&mut connection)).await)
        })
        .await?;
        match read {
            Ok(Ok(value)) => {
                *slot = Some(connection);
                Ok(value)
            }
            Ok(Err(error)) => {
                let message = read_message(&error);
                if matches!(&error, ReadError::Server(error) if error.is_fatal())
                    || matches!(error, ReadError::Shape)
                {
                    self.close(id)?;
                    Err(format!("{message} {DISCONNECTED}"))
                } else {
                    *slot = Some(connection);
                    Err(message.into())
                }
            }
            Err(_) => {
                self.close(id)?;
                Err(format!("MySQL 조회 시간이 초과되었습니다. {DISCONNECTED}"))
            }
        }
    }

    fn session(&self, id: &str) -> Result<Arc<Session>> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "MySQL 연결 목록을 읽을 수 없습니다.")?
            .get(id)
            .cloned()
            .ok_or(DISCONNECTED)?;
        if session
            .tunnel
            .as_ref()
            .is_some_and(|tunnel| !tunnel.running())
        {
            return Err(TUNNEL_STOPPED.into());
        }
        Ok(session)
    }
}

fn close_session(sessions: &Mutex<HashMap<String, Arc<Session>>>, id: &str) -> Result<()> {
    let session = sessions
        .lock()
        .map_err(|_| "MySQL 연결 목록을 읽을 수 없습니다.")?
        .remove(id);
    if let Some(session) = session {
        session.closed.send_replace(true);
        sql::stop_active(&session, None)?;
    }
    Ok(())
}

async fn through_tunnel<T>(
    route: Option<&DatabaseTunnel>,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    let Some(route) = route else {
        return work.await;
    };
    if !route.running() {
        return Err(TUNNEL_STOPPED.into());
    }
    let result = tokio::select! {
        biased;
        _ = route.ended() => return Err(TUNNEL_STOPPED.into()),
        result = work => result,
    };
    if !route.running() {
        return Err(TUNNEL_STOPPED.into());
    }
    result
}

fn read_message(error: &ReadError) -> &str {
    match error {
        ReadError::Shape => "MySQL 서버의 응답 형식을 읽을 수 없습니다.",
        ReadError::Missing => "테이블 또는 뷰가 사라졌거나 현재 계정에 읽기 권한이 없습니다.",
        ReadError::InvalidQuery(message) => message,
        ReadError::Server(error) => server_message(error),
    }
}

fn server_message(error: &Error) -> &'static str {
    const CERTIFICATE: &str =
        "MySQL TLS 인증서의 호스트 이름, 신뢰 체인과 클라이언트 인증 설정을 확인하세요.";
    match error {
        Error::Driver(DriverError::NoKeyFound) => {
            "MySQL 클라이언트 개인 키의 PEM 형식과 암호화 여부를 확인하세요."
        }
        Error::Io(IoError::Tls(TlsError::Tls(rustls::Error::InconsistentKeys(_)))) => {
            "MySQL 클라이언트 인증서와 개인 키가 서로 일치하는지 확인하세요."
        }
        Error::Io(IoError::Tls(_)) => CERTIFICATE,
        Error::Io(IoError::Io(error))
            if error
                .get_ref()
                .is_some_and(|cause| cause.is::<rustls::Error>()) =>
        {
            CERTIFICATE
        }
        Error::Server(error) => server_code_message(error.code),
        _ => "MySQL 서버와 통신할 수 없습니다. 주소, 포트와 TLS 설정을 확인하세요.",
    }
}

fn server_code_message(code: u16) -> &'static str {
    match code {
        1045 | 1698 => "MySQL 사용자 이름과 암호를 확인하세요.",
        1049 => "시작 데이터베이스를 찾을 수 없습니다.",
        1044 | 1142 | 1143 | 1227 => "현재 MySQL 계정에 조회 권한이 없습니다.",
        1146 => "테이블 또는 뷰가 사라졌습니다.",
        _ => "MySQL 서버가 요청을 거부했습니다. 연결 설정과 계정 권한을 확인하세요.",
    }
}

fn catalog_offset(search: &str, page: u32) -> Result<u64> {
    if search.len() > 1024 || search.contains('\0') {
        return Err("MySQL 검색은 1,024바이트 이하로 입력하세요.".into());
    }
    Ok(u64::from(page) * CATALOG_LIMIT as u64)
}

pub(super) fn valid_identifier(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= 64 && !name.contains('\0')
}

fn require_identifier(name: &str) -> Result<()> {
    if !valid_identifier(name) {
        return Err("MySQL 데이터베이스나 객체 이름을 확인하세요.".into());
    }
    Ok(())
}

pub(crate) fn quoted(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

async fn query<T: FromRow, P: Into<mysql_async::Params> + Send>(
    connection: &mut Conn,
    sql: &str,
    params: P,
) -> ReadResult<Vec<T>> {
    let rows = connection.exec::<Row, _, _>(sql, params).await?;
    rows.into_iter()
        .map(|row| from_row_opt(row).map_err(|_| ReadError::Shape))
        .collect()
}

async fn read_table(
    connection: &mut Conn,
    database: &str,
    name: &str,
    grid: Option<MysqlGridQuery>,
    grid_edit: bool,
) -> ReadResult<MysqlTable> {
    let mut columns = read_columns(connection, database, name).await?;
    let more_columns = columns.len() > COLUMN_LIMIT;
    let (mut rows, query_sql, stable_order, filter_columns, edit) = if let Some(grid) = grid {
        let target = if grid_edit {
            edit::read_target(connection, database, name, &columns).await?
        } else {
            None
        };
        let sampled =
            sample_rows(connection, database, name, &columns, grid, target.as_ref()).await?;
        (
            sampled.rows,
            Some(sampled.sql),
            sampled.stable_order,
            Vec::new(),
            sampled.edit,
        )
    } else {
        (
            Vec::new(),
            None,
            false,
            columns.iter().map(|column| column.name.clone()).collect(),
            None,
        )
    };
    columns.truncate(COLUMN_LIMIT);
    let more_rows = rows.len() > ROW_LIMIT;
    rows.truncate(ROW_LIMIT);
    Ok(MysqlTable {
        columns,
        rows,
        more_columns,
        more_rows,
        stable_order,
        filter_columns,
        query_sql,
        edit,
    })
}

async fn read_columns(
    connection: &mut Conn,
    database: &str,
    name: &str,
) -> ReadResult<Vec<MysqlColumn>> {
    type ColumnRow = (
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    );
    let columns: Vec<ColumnRow> = query(
        connection,
        "SELECT COLUMN_NAME, DATA_TYPE, IF(ORDINAL_POSITION <= 128, COLUMN_TYPE, ''), IS_NULLABLE, COLUMN_KEY,
          EXTRA, COLUMN_DEFAULT, COLLATION_NAME
        FROM information_schema.COLUMNS WHERE CAST(TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY)
          AND CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY) ORDER BY ORDINAL_POSITION",
        (database, name),
    )
    .await?;
    if columns.is_empty() {
        return Err(ReadError::Missing);
    }
    Ok(columns
        .into_iter()
        .map(
            |(name, data_type, column_type, nullable, key, extra, default_value, collation)| {
                MysqlColumn {
                    name,
                    data_type,
                    column_type,
                    nullable: nullable == "YES",
                    key,
                    extra,
                    default_value,
                    collation,
                }
            },
        )
        .collect())
}

fn is_binary(data_type: &str) -> bool {
    matches!(
        data_type,
        "bit"
            | "binary"
            | "varbinary"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
    )
}

async fn table_source(
    connection: &mut Conn,
    database: &str,
    name: &str,
    columns: &[MysqlColumn],
    clauses: &TableQueryClauses,
) -> ReadResult<(String, Vec<Value>, bool)> {
    let keys = primary_columns(connection, database, name).await?;
    // Some server settings hide generated primary keys from column metadata.
    let stable_order = !keys.is_empty()
        && keys
            .iter()
            .all(|key| columns.iter().any(|column| &column.name == key));
    let by_name: HashMap<_, _> = columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let mut parameters = Vec::new();
    let suffix = clauses
        .suffix(
            TableQueryDialect::Mysql,
            "sp_source",
            by_name.keys().copied(),
            keys.iter().filter(|_| stable_order).map(String::as_str),
            |name, value, operand| {
                grid::filter_binding(by_name[name], value, operand, &mut parameters)
            },
        )
        .map_err(ReadError::InvalidQuery)?;
    let source = format!(
        "FROM {}.{} AS sp_source{suffix}",
        quoted(database),
        quoted(name)
    );
    Ok((source, parameters, stable_order))
}

async fn primary_columns(
    connection: &mut Conn,
    database: &str,
    name: &str,
) -> ReadResult<Vec<String>> {
    let keys: Vec<(String,)> = query(
        connection,
        "SELECT COLUMN_NAME FROM information_schema.STATISTICS
        WHERE CAST(TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY)
          AND CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY)
          AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX",
        (database, name),
    )
    .await?;
    Ok(keys.into_iter().map(|(name,)| name).collect())
}

struct SampleRows {
    rows: Vec<Vec<Option<MysqlCell>>>,
    sql: String,
    stable_order: bool,
    edit: Option<edit::PageEdit>,
}

async fn sample_rows(
    connection: &mut Conn,
    database: &str,
    name: &str,
    columns: &[MysqlColumn],
    grid: MysqlGridQuery,
    target: Option<&edit::Target>,
) -> ReadResult<SampleRows> {
    let (source, mut parameters, stable_order) =
        table_source(connection, database, name, columns, &grid.clauses).await?;
    let columns = &columns[..columns.len().min(COLUMN_LIMIT)];
    let mut expressions = cell_projection(columns);
    if target.is_some() {
        expressions.push_str(",\n       ");
        expressions.push_str(&edit::row_digest(columns));
    }
    let sql = format!("SELECT {expressions}\n{source}\nLIMIT 51 OFFSET ?");
    parameters.push(Value::UInt(u64::from(grid.page) * ROW_LIMIT as u64));
    let result = connection
        .exec::<Row, _, _>(&sql, Params::Positional(parameters))
        .await?;
    let mut rows = Vec::with_capacity(result.len());
    let mut edits = target.map(edit::Target::page);
    for row in result {
        let mut values = row.unwrap();
        let digest = if target.is_some() { values.pop() } else { None };
        let cells = read_cells(&values, columns)?;
        if let (Some(target), Some(edits)) = (target, edits.as_mut()) {
            if rows.len() < ROW_LIMIT {
                edits.rows.push(target.stamp(&cells, digest)?);
            }
        }
        rows.push(cells);
    }
    Ok(SampleRows {
        rows,
        sql,
        stable_order,
        edit: edits,
    })
}

fn cell_projection(columns: &[MysqlColumn]) -> String {
    columns
        .iter()
        .map(|column| {
            let identifier = format!("sp_source.{}", quoted(&column.name));
            let bytes = if is_binary(&column.data_type) {
                format!("CAST({identifier} AS BINARY)")
            } else {
                format!("CAST(CONVERT({identifier} USING utf8mb4) AS BINARY)")
            };
            format!("LEFT({bytes}, {CELL_BYTES}), OCTET_LENGTH({bytes})")
        })
        .collect::<Vec<_>>()
        .join(",\n       ")
}

fn read_cells(values: &[Value], columns: &[MysqlColumn]) -> ReadResult<Vec<Option<MysqlCell>>> {
    if values.len() != columns.len() * 2 {
        return Err(ReadError::Shape);
    }
    values
        .chunks_exact(2)
        .zip(columns)
        .map(|(pair, column)| match pair {
            [Value::NULL, Value::NULL] => Ok(None),
            [Value::Bytes(data), Value::UInt(size)] => {
                Ok(Some(cell(data, *size, is_binary(&column.data_type))))
            }
            [Value::Bytes(data), Value::Int(size)] if *size >= 0 => {
                Ok(Some(cell(data, *size as u64, is_binary(&column.data_type))))
            }
            _ => Err(ReadError::Shape),
        })
        .collect()
}

fn cell(data: &[u8], bytes: u64, binary: bool) -> MysqlCell {
    if !binary {
        let text = match std::str::from_utf8(data) {
            Ok(text) => Some(text),
            Err(error) if error.error_len().is_none() && (data.len() as u64) < bytes => {
                std::str::from_utf8(&data[..error.valid_up_to()]).ok()
            }
            Err(_) => None,
        };
        if let Some(text) = text {
            return MysqlCell {
                text: text.into(),
                encoding: "utf8",
                bytes,
                truncated: (text.len() as u64) < bytes,
            };
        }
    }
    MysqlCell {
        text: data.iter().map(|byte| format!("{byte:02x}")).collect(),
        encoding: "hex",
        bytes,
        truncated: (data.len() as u64) < bytes,
    }
}
