use super::{
    cell_projection, grid, primary_columns, query, quoted, read_cells, read_columns, read_message,
    require_identifier, sql::open_request_connection, Conn, MysqlCell, MysqlColumn, MysqlManager,
    OptsBuilder, Params, Queryable, ReadError, ReadResult, Row, Session, Value, COLUMN_LIMIT,
};
use crate::{
    insert_audit,
    table_query::{FilterOperand, FilterValue},
    AuditRecord, Result,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use tokio::{task::spawn_blocking, time::timeout};
use uuid::Uuid;

const STALE: &str = "MySQL 행 또는 테이블 구조가 바뀌었습니다. 데이터를 새로 읽고 다시 편집하세요.";
const UNAVAILABLE: &str = "표시된 기본 키가 있고 트랜잭션을 지원하는 InnoDB 테이블을 선택하세요.";
const EXPIRED: &str = "MySQL 편집 미리보기가 만료됐습니다. 변경을 다시 확인하세요.";
const TIME_LIMIT: Duration = Duration::from_secs(15);
const MAX_BYTES: usize = 64 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MysqlRowStamp {
    keys: Vec<String>,
    schema: String,
    row: String,
}

#[derive(Serialize)]
pub(super) struct PageEdit {
    pub rows: Vec<Option<MysqlRowStamp>>,
    keys: Vec<String>,
    columns: Vec<String>,
}

pub(super) struct Target {
    schema: String,
    keys: Vec<(usize, String)>,
    editable: Vec<(usize, String)>,
}

impl Target {
    pub fn page(&self) -> PageEdit {
        PageEdit {
            rows: Vec::new(),
            keys: self.keys.iter().map(|(_, name)| name.clone()).collect(),
            columns: self.editable.iter().map(|(_, name)| name.clone()).collect(),
        }
    }

    pub fn stamp(
        &self,
        cells: &[Option<MysqlCell>],
        hash: Option<Value>,
    ) -> ReadResult<Option<MysqlRowStamp>> {
        let row = digest(hash).ok_or(ReadError::Shape)?;
        let keys: Option<Vec<_>> = self
            .keys
            .iter()
            .map(|(index, _)| {
                let cell = cells.get(*index)?.as_ref()?;
                (!cell.truncated).then(|| cell.text.clone())
            })
            .collect();
        Ok(keys.map(|keys| MysqlRowStamp {
            keys,
            schema: self.schema.clone(),
            row,
        }))
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum InputValue {
    Text { value: String },
    Null,
    Default,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MysqlEditChange {
    column: String,
    value: InputValue,
}

#[derive(Serialize)]
pub struct MysqlEditPreview {
    token: String,
    changes: Vec<PreviewCell>,
}

#[derive(Serialize)]
struct PreviewCell {
    column: String,
    before: Option<MysqlCell>,
    after: InputValue,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MysqlEditOutcome {
    Applied {
        affected_rows: u64,
        audit_warning: bool,
    },
    Unknown,
}

pub(super) struct PendingEdit {
    token: Uuid,
    created: Instant,
    database: String,
    table: String,
    stamp: MysqlRowStamp,
    changes: Vec<MysqlEditChange>,
}

impl MysqlManager {
    pub async fn preview_grid_edit(
        &self,
        id: &str,
        database: String,
        table: String,
        stamp: MysqlRowStamp,
        changes: Vec<MysqlEditChange>,
    ) -> Result<MysqlEditPreview> {
        require_identifier(&database)?;
        require_identifier(&table)?;
        let session = self.edit_session(id)?;
        let mut pending = timeout(TIME_LIMIT, session.pending_edit.lock())
            .await
            .map_err(|_| "앞선 MySQL 편집을 기다려 주세요.")?;
        *pending = None;
        let mut conn =
            open_request_connection(&session, OptsBuilder::from_opts(session.options.clone()))
                .await?;
        let (target, columns, before) = timeout(TIME_LIMIT, async {
            let (target, columns) = load_target(&mut conn, &database, &table, &stamp).await?;
            validate_changes(&target, &columns, &changes)?;
            let before = current_row(
                &mut conn, &target, &columns, &database, &table, &stamp, false,
            )
            .await?;
            Ok::<_, String>((target, columns, before))
        })
        .await
        .map_err(|_| "MySQL 편집 미리보기 시간이 초과되었습니다.")??;
        self.session(id)?;
        let token = Uuid::new_v4();
        let values = changes
            .iter()
            .map(|change| {
                let index = target
                    .editable
                    .iter()
                    .find(|(_, name)| name == &change.column)
                    .map(|(index, _)| *index)
                    .ok_or(STALE)?;
                Ok(PreviewCell {
                    column: columns[index].name.clone(),
                    before: before[index].clone(),
                    after: match &change.value {
                        InputValue::Text { value } => InputValue::Text {
                            value: value.clone(),
                        },
                        InputValue::Null => InputValue::Null,
                        InputValue::Default => InputValue::Default,
                    },
                })
            })
            .collect::<Result<_>>()?;
        *pending = Some(PendingEdit {
            token,
            created: Instant::now(),
            database,
            table,
            stamp,
            changes,
        });
        Ok(MysqlEditPreview {
            token: token.to_string(),
            changes: values,
        })
    }

    pub async fn discard_grid_edit(&self, id: &str, token: &str) -> Result<()> {
        let token: Uuid = token.parse().map_err(|_| EXPIRED)?;
        if let Ok(session) = self.edit_session(id) {
            let mut pending = session.pending_edit.lock().await;
            if pending.as_ref().is_some_and(|edit| edit.token == token) {
                *pending = None;
            }
        }
        Ok(())
    }

    pub async fn apply_grid_edit(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
    ) -> Result<MysqlEditOutcome> {
        let token: Uuid = token.parse().map_err(|_| EXPIRED)?;
        let session = self.edit_session(id)?;
        if session.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let mut slot = timeout(TIME_LIMIT, session.pending_edit.lock())
            .await
            .map_err(|_| "앞선 MySQL 편집을 기다려 주세요.")?;
        if slot.as_ref().is_none_or(|edit| {
            edit.token != token || edit.created.elapsed() > Duration::from_secs(300)
        }) {
            return Err(EXPIRED.into());
        }
        let edit = slot.take().ok_or(EXPIRED)?;
        self.session(id)?;
        self.audit_edit(&session, &edit, "started", None).await?;
        let updated = timeout(TIME_LIMIT, async {
            let mut conn =
                open_request_connection(&session, OptsBuilder::from_opts(session.options.clone()))
                    .await?;
            let affected = update(&mut conn, &edit).await?;
            self.session(id)?;
            Ok::<_, String>((conn, affected))
        })
        .await;
        let (mut conn, affected) = match updated {
            Ok(Ok(result)) => result,
            result => {
                let _ = self.audit_edit(&session, &edit, "failed", None).await;
                return match result {
                    Ok(Err(error)) => Err(error),
                    _ => Err(
                        "MySQL 변경을 기록하기 전에 시간이 초과되어 적용을 중단했습니다.".into(),
                    ),
                };
            }
        };
        if !matches!(
            timeout(TIME_LIMIT, conn.query_drop("COMMIT")).await,
            Ok(Ok(()))
        ) {
            let _ = self.audit_edit(&session, &edit, "unknown", None).await;
            return Ok(MysqlEditOutcome::Unknown);
        }
        let audit_warning = self
            .audit_edit(&session, &edit, "succeeded", Some(affected as i64))
            .await
            .is_err();
        Ok(MysqlEditOutcome::Applied {
            affected_rows: affected,
            audit_warning,
        })
    }

    fn edit_session(&self, id: &str) -> Result<std::sync::Arc<Session>> {
        let session = self.session(id)?;
        if !session.grid_edit {
            return Err("연결할 때 MySQL 그리드 편집을 허용하세요.".into());
        }
        Ok(session)
    }

    async fn audit_edit(
        &self,
        session: &Session,
        edit: &PendingEdit,
        outcome: &'static str,
        affected_count: Option<i64>,
    ) -> Result<()> {
        let store = self.store.clone();
        let correlation_id = edit.token.to_string();
        let object = format!("{}.{}", edit.database, edit.table);
        let (project, profile, environment) = (
            session.project_id.clone(),
            session.profile_id.clone(),
            session.environment.clone(),
        );
        spawn_blocking(move || {
            insert_audit(
                &store.connect()?,
                AuditRecord {
                    correlation_id: &correlation_id,
                    operation: "mysql.grid.update",
                    project_id: Some(&project),
                    profile_id: Some(&profile),
                    environment: Some(&environment),
                    object_name: Some(&object),
                    outcome,
                    affected_count,
                },
            )
        })
        .await
        .map_err(|_| "MySQL 편집 작업 기록을 저장할 수 없습니다.")?
    }
}

pub(super) async fn read_target(
    connection: &mut Conn,
    database: &str,
    table: &str,
    columns: &[MysqlColumn],
) -> ReadResult<Option<Target>> {
    if columns.len() > COLUMN_LIMIT
        || ["mysql", "sys", "performance_schema", "information_schema"]
            .iter()
            .any(|name| name.eq_ignore_ascii_case(database))
    {
        return Ok(None);
    }
    let facts: Vec<(String, Option<String>, Option<String>)> = query(connection,
        "SELECT TABLE_TYPE, ENGINE, CAST(CREATE_TIME AS CHAR) FROM information_schema.TABLES
         WHERE CAST(TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY) AND CAST(TABLE_NAME AS BINARY) = CAST(? AS BINARY)",
        (database, table)).await?;
    let [(kind, Some(engine), time)] = facts.as_slice() else {
        return Ok(None);
    };
    if kind != "BASE TABLE" || !engine.eq_ignore_ascii_case("InnoDB") {
        return Ok(None);
    }
    let key_names = primary_columns(connection, database, table).await?;
    let keys: Option<Vec<_>> = key_names
        .iter()
        .map(|name| {
            let index = columns
                .iter()
                .position(|column| &column.name == name && key_kind(&column.data_type))?;
            Some((index, name.clone()))
        })
        .collect();
    let Some(keys) = keys.filter(|keys| !keys.is_empty()) else {
        return Ok(None);
    };
    let editable: Vec<_> = columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            let extra = column.extra.to_ascii_lowercase();
            (column.key != "PRI"
                && !key_names.contains(&column.name)
                && editable_kind(&column.data_type)
                && ![
                    "virtual generated",
                    "stored generated",
                    "persistent",
                    "auto_increment",
                ]
                .iter()
                .any(|flag| extra.contains(flag)))
            .then(|| (index, column.name.clone()))
        })
        .collect();
    if editable.is_empty() {
        return Ok(None);
    }
    let metadata: Vec<_> = columns
        .iter()
        .map(|column| {
            (
                &column.name,
                &column.column_type,
                &column.data_type,
                column.nullable,
                &column.key,
                &column.extra,
                &column.default_value,
                &column.collation,
            )
        })
        .collect();
    let bytes = serde_json::to_vec(&(database, table, time, &key_names, metadata))
        .map_err(|_| ReadError::Shape)?;
    let schema = format!("{:x}", Sha256::digest(bytes));
    Ok(Some(Target {
        keys,
        editable,
        schema,
    }))
}

pub(super) fn row_digest(columns: &[MysqlColumn]) -> String {
    let parts = columns
        .iter()
        .map(|column| {
            let name = quoted(&column.name);
            format!("COALESCE(SHA2(CAST(sp_source.{name} AS BINARY), 256), 'NULL')")
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("SHA2(CONCAT_WS(':', {parts}), 256)")
}

fn digest(value: Option<Value>) -> Option<String> {
    let Value::Bytes(bytes) = value? else {
        return None;
    };
    (bytes.len() == 64 && bytes.iter().all(u8::is_ascii_hexdigit))
        .then(|| String::from_utf8_lossy(&bytes).into_owned())
}

fn key_kind(kind: &str) -> bool {
    matches!(
        kind,
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "bigint"
            | "decimal"
            | "numeric"
            | "char"
            | "varchar"
            | "binary"
            | "varbinary"
            | "date"
            | "datetime"
            | "timestamp"
            | "time"
            | "year"
    )
}

fn editable_kind(kind: &str) -> bool {
    (key_kind(kind) && !matches!(kind, "binary" | "varbinary"))
        || matches!(
            kind,
            "tinytext"
                | "text"
                | "mediumtext"
                | "longtext"
                | "float"
                | "double"
                | "json"
                | "enum"
                | "set"
        )
}

async fn load_target(
    conn: &mut Conn,
    database: &str,
    table: &str,
    stamp: &MysqlRowStamp,
) -> Result<(Target, Vec<MysqlColumn>)> {
    let columns = read_columns(conn, database, table)
        .await
        .map_err(|error| read_message(&error).to_owned())?;
    let target = read_target(conn, database, table, &columns)
        .await
        .map_err(|error| read_message(&error).to_owned())?
        .ok_or(UNAVAILABLE)?;
    if target.schema != stamp.schema
        || target.keys.len() != stamp.keys.len()
        || stamp.row.len() != 64
        || !stamp.row.bytes().all(|value| value.is_ascii_hexdigit())
        || stamp
            .keys
            .iter()
            .any(|key| key.len() > super::CELL_BYTES * 2)
    {
        return Err(STALE.into());
    }
    Ok((target, columns))
}

fn validate_changes(
    target: &Target,
    columns: &[MysqlColumn],
    changes: &[MysqlEditChange],
) -> Result<()> {
    if changes.is_empty() || changes.len() > COLUMN_LIMIT {
        return Err("변경할 MySQL 열을 선택하세요.".into());
    }
    let mut names = HashSet::new();
    let mut bytes = 0usize;
    for change in changes {
        let (index, _) = target
            .editable
            .iter()
            .find(|(_, name)| name == &change.column)
            .ok_or("이 MySQL 열은 편집할 수 없습니다.")?;
        if !names.insert(&change.column) {
            return Err("같은 MySQL 열은 한 번만 변경하세요.".into());
        }
        let column = &columns[*index];
        match &change.value {
            InputValue::Null if !column.nullable => {
                return Err("NULL을 허용하는 열을 선택하세요.".into())
            }
            InputValue::Text { value } => {
                bytes = bytes.saturating_add(value.len());
                if bytes > MAX_BYTES {
                    return Err("MySQL 변경 값의 합계는 64 KiB 이하여야 합니다.".into());
                }
                if column.data_type == "json"
                    && serde_json::from_str::<serde_json::Value>(value).is_err()
                {
                    return Err("MySQL JSON 값의 형식을 확인하세요.".into());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn key_predicate(
    target: &Target,
    columns: &[MysqlColumn],
    stamp: &MysqlRowStamp,
) -> Result<(String, Vec<Value>)> {
    let mut params = Vec::new();
    let mut predicates = Vec::new();
    for ((index, name), value) in target.keys.iter().zip(&stamp.keys) {
        let column = &columns[*index];
        let placeholder = if matches!(column.data_type.as_str(), "binary" | "varbinary") {
            if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(STALE.into());
            }
            params.push(Value::Bytes(value.as_bytes().to_vec()));
            "UNHEX(?)".into()
        } else {
            grid::filter_binding(
                column,
                &FilterValue::Text(value.clone()),
                FilterOperand::Comparison,
                &mut params,
            )?
        };
        predicates.push(format!("{} = {placeholder}", quoted(name)));
    }
    Ok((predicates.join(" AND "), params))
}

async fn current_row(
    conn: &mut Conn,
    target: &Target,
    columns: &[MysqlColumn],
    database: &str,
    table: &str,
    stamp: &MysqlRowStamp,
    lock: bool,
) -> Result<Vec<Option<MysqlCell>>> {
    let (predicate, params) = key_predicate(target, columns, stamp)?;
    let lock = if lock { " FOR UPDATE" } else { "" };
    let sql = format!(
        "SELECT {}, {} FROM {}.{} AS sp_source WHERE {predicate}{lock}",
        cell_projection(columns),
        row_digest(columns),
        quoted(database),
        quoted(table)
    );
    let rows = conn
        .exec::<Row, _, _>(sql, params)
        .await
        .map_err(edit_error)?;
    let [row] = rows.as_slice() else {
        return Err(STALE.into());
    };
    let mut values = row.clone().unwrap();
    if digest(values.pop()).as_deref() != Some(stamp.row.as_str()) {
        return Err(STALE.into());
    }
    read_cells(&values, columns).map_err(|error| read_message(&error).to_owned())
}

async fn update(conn: &mut Conn, edit: &PendingEdit) -> Result<u64> {
    conn.query_drop("SET SESSION innodb_lock_wait_timeout = 5")
        .await
        .map_err(edit_error)?;
    conn.query_drop("SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES')")
        .await.map_err(edit_error)?;
    conn.query_drop("START TRANSACTION READ WRITE")
        .await
        .map_err(edit_error)?;
    let (target, columns) = load_target(conn, &edit.database, &edit.table, &edit.stamp).await?;
    current_row(
        conn,
        &target,
        &columns,
        &edit.database,
        &edit.table,
        &edit.stamp,
        true,
    )
    .await?;
    // Check the table definition again while the transaction holds the row and metadata locks.
    let (target, columns) = load_target(conn, &edit.database, &edit.table, &edit.stamp).await?;
    validate_changes(&target, &columns, &edit.changes)?;
    let mut values = Vec::new();
    let assignments: Vec<_> = edit
        .changes
        .iter()
        .map(|change| {
            let name = quoted(&change.column);
            match &change.value {
                InputValue::Text { value } => {
                    values.push(Value::Bytes(value.as_bytes().to_vec()));
                    format!("{name} = ?")
                }
                InputValue::Null => format!("{name} = NULL"),
                InputValue::Default => format!("{name} = DEFAULT"),
            }
        })
        .collect();
    let (predicate, keys) = key_predicate(&target, &columns, &edit.stamp)?;
    values.extend(keys);
    let sql = format!(
        "UPDATE {}.{} SET {} WHERE {predicate}",
        quoted(&edit.database),
        quoted(&edit.table),
        assignments.join(", ")
    );
    let result = conn
        .exec_iter(sql, Params::Positional(values))
        .await
        .map_err(edit_error)?;
    let (affected, warnings) = (result.affected_rows(), result.warnings());
    result.drop_result().await.map_err(edit_error)?;
    if warnings > 0 || affected > 1 {
        return Err(
            "MySQL 서버에서 값 변환 또는 변경 범위 경고를 반환해 모든 변경을 취소했습니다.".into(),
        );
    }
    Ok(affected)
}

fn edit_error(error: mysql_async::Error) -> String {
    let message = match &error {
        mysql_async::Error::Server(error) => match error.code {
            1048 | 1264 | 1265 | 1292 | 1366 | 1406 => {
                "MySQL 열의 값 형식, 범위 또는 길이를 확인하세요. 모든 변경을 취소했습니다."
            }
            1062 | 1451 | 1452 | 3819 | 4025 => {
                "MySQL 고유 키, 외래 키 또는 CHECK 제약을 확인하세요. 모든 변경을 취소했습니다."
            }
            1205 | 1213 => {
                "다른 세션이 MySQL 행을 사용 중입니다. 데이터를 새로 읽고 다시 편집하세요."
            }
            _ => super::server_code_message(error.code),
        },
        _ => super::server_message(&error),
    };
    message.into()
}
