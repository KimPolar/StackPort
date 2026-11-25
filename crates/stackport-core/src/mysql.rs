mod profiles;

pub(crate) use profiles::{copy_profiles, SCHEMA};
pub use profiles::{MysqlProfile, MysqlSettings};

use crate::{Result, Store};
use mysql_async::{
    from_row_opt,
    prelude::{FromRow, Queryable},
    Conn, Error, IoError, OptsBuilder, Row, SslOpts, Value,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    future::Future,
    io::Read,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore},
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
}

#[derive(Serialize)]
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
}

struct Session {
    connection: AsyncMutex<Option<Conn>>,
    _permit: OwnedSemaphorePermit,
}

pub struct MysqlManager {
    store: Store,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    capacity: Arc<Semaphore>,
}

enum ReadError {
    Server(Error),
    Shape,
    Missing,
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
            sessions: Mutex::default(),
            capacity: Arc::new(Semaphore::new(8)),
        }
    }

    pub async fn open(
        &self,
        id: String,
        revision: i64,
        password: MysqlPassword,
        confirmation: &str,
    ) -> Result<MysqlSessionInfo> {
        if password.0.len() > 4096 {
            return Err("MySQL 암호가 너무 깁니다.".into());
        }
        let store = self.store.clone();
        let production_confirmed = confirmation == "PROD";
        let (settings, tls) = tokio::task::spawn_blocking(move || {
            let settings = store.mysql_profile(&id, revision)?.settings;
            if settings.environment == "PROD" && !production_confirmed {
                return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
            }
            let tls = settings.tls.then(|| ssl_options(&settings)).transpose()?;
            Ok::<_, String>((settings, tls))
        })
        .await
        .map_err(|_| "MySQL 연결 설정을 읽을 수 없습니다.")??;
        let permit = Arc::clone(&self.capacity)
            .try_acquire_owned()
            .map_err(|_| "열린 MySQL 계열 연결이 너무 많습니다.")?;
        let options = OptsBuilder::default()
            .ip_or_hostname(settings.host)
            .tcp_port(settings.port)
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
        let (connection, version) = timeout(CONNECT, async {
            let mut connection = Conn::new(options).await?;
            let row = connection
                .query_first::<Row, _>("SELECT VERSION()")
                .await?
                .ok_or(ReadError::Shape)?;
            let (version,): (String,) = from_row_opt(row).map_err(|_| ReadError::Shape)?;
            Ok::<_, ReadError>((connection, version))
        })
        .await
        .map_err(|_| "MySQL 연결 시간이 초과되었습니다.")?
        .map_err(|error| read_message(&error))?;
        let engine = if version.to_ascii_lowercase().contains("mariadb") {
            "MariaDB"
        } else {
            "MySQL"
        };
        let id = Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .map_err(|_| "MySQL 연결 목록을 읽을 수 없습니다.")?
            .insert(
                id.clone(),
                Arc::new(Session {
                    connection: AsyncMutex::new(Some(connection)),
                    _permit: permit,
                }),
            );
        Ok(MysqlSessionInfo {
            id,
            engine,
            version: version.chars().take(128).collect(),
            database: settings.database,
        })
    }

    pub fn close(&self, id: &str) -> Result<()> {
        self.sessions
            .lock()
            .map_err(|_| "MySQL 연결 목록을 읽을 수 없습니다.")?
            .remove(id);
        Ok(())
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
    ) -> Result<MysqlTable> {
        require_identifier(&database)?;
        require_identifier(&name)?;
        self.read(id, |connection| {
            Box::pin(async move { read_table(connection, &database, &name, include_rows).await })
        })
        .await
    }

    async fn read<T>(
        &self,
        id: &str,
        query: impl for<'a> FnOnce(&'a mut Conn) -> Work<'a, T>,
    ) -> Result<T> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "MySQL 연결 목록을 읽을 수 없습니다.")?
            .get(id)
            .cloned()
            .ok_or(DISCONNECTED)?;
        let mut slot = timeout(READ, session.connection.lock())
            .await
            .map_err(|_| "앞선 MySQL 조회가 끝날 때까지 기다려 주세요.")?;
        let Some(mut connection) = slot.take() else {
            return Err(DISCONNECTED.into());
        };
        match timeout(READ, query(&mut connection)).await {
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
}

fn ssl_options(settings: &MysqlSettings) -> Result<SslOpts> {
    let default = SslOpts::default();
    let Some(path) = &settings.ca_path else {
        return Ok(default);
    };
    const LIMIT: u64 = 256 * 1024;
    let mut ca = Vec::new();
    File::open(path)
        .and_then(|file| file.take(LIMIT + 1).read_to_end(&mut ca))
        .map_err(|_| "MySQL CA 인증서를 읽을 수 없습니다.")?;
    if ca.len() as u64 > LIMIT {
        return Err("CA 인증서 크기는 256 KiB 이하여야 합니다.".into());
    }
    Ok(default.with_root_certs(vec![ca.into()]))
}

fn read_message(error: &ReadError) -> &'static str {
    match error {
        ReadError::Shape => "MySQL 서버의 응답 형식을 읽을 수 없습니다.",
        ReadError::Missing => "테이블 또는 뷰가 사라졌거나 현재 계정에 읽기 권한이 없습니다.",
        ReadError::Server(Error::Io(IoError::Tls(_))) => {
            "MySQL TLS 인증서의 호스트 이름과 신뢰 체인을 확인하세요."
        }
        ReadError::Server(Error::Server(error)) => match error.code {
            1045 | 1698 => "MySQL 사용자 이름과 암호를 확인하세요.",
            1049 => "시작 데이터베이스를 찾을 수 없습니다.",
            1044 | 1142 | 1143 | 1227 => "현재 MySQL 계정에 조회 권한이 없습니다.",
            1146 => "테이블 또는 뷰가 사라졌습니다.",
            _ => "MySQL 서버가 요청을 거부했습니다. 연결 설정과 계정 권한을 확인하세요.",
        },
        ReadError::Server(_) => {
            "MySQL 서버와 통신할 수 없습니다. 주소, 포트와 TLS 설정을 확인하세요."
        }
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

fn quoted(name: &str) -> String {
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
    with_rows: bool,
) -> ReadResult<MysqlTable> {
    type ColumnRow = (String, String, String, String, String);
    let mut columns: Vec<ColumnRow> = query(
        connection,
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
        FROM information_schema.COLUMNS WHERE CAST(TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY)
          AND CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY) ORDER BY ORDINAL_POSITION LIMIT 129",
        (database, name),
    )
    .await?;
    if columns.is_empty() {
        return Err(ReadError::Missing);
    }
    let more_columns = columns.len() > COLUMN_LIMIT;
    columns.truncate(COLUMN_LIMIT);
    let columns = columns
        .into_iter()
        .map(
            |(name, data_type, column_type, nullable, key)| MysqlColumn {
                name,
                data_type,
                column_type,
                nullable: nullable == "YES",
                key,
            },
        )
        .collect::<Vec<_>>();
    let mut rows = if with_rows {
        sample_rows(connection, database, name, &columns).await?
    } else {
        Vec::new()
    };
    let more_rows = rows.len() > ROW_LIMIT;
    rows.truncate(ROW_LIMIT);
    Ok(MysqlTable {
        columns,
        rows,
        more_columns,
        more_rows,
    })
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

async fn sample_rows(
    connection: &mut Conn,
    database: &str,
    name: &str,
    columns: &[MysqlColumn],
) -> ReadResult<Vec<Vec<Option<MysqlCell>>>> {
    let expressions = columns
        .iter()
        .map(|column| {
            let identifier = quoted(&column.name);
            let bytes = if is_binary(&column.data_type) {
                format!("CAST({identifier} AS BINARY)")
            } else {
                format!("CAST(CONVERT({identifier} USING utf8mb4) AS BINARY)")
            };
            format!("LEFT({bytes}, {CELL_BYTES}), OCTET_LENGTH({bytes})")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {expressions} FROM {}.{} LIMIT 51",
        quoted(database),
        quoted(name)
    );
    let rows = connection.exec::<Row, _, _>(sql, ()).await?;
    rows.into_iter()
        .map(|row| {
            let values = row.unwrap();
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
