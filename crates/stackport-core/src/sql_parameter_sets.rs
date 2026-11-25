use super::{
    db_error, insert_audit, native_table_filter, require_changed,
    sql_templates::require_active_project, valid_name, AuditRecord, Result, Store,
};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub(super) const SCHEMA: &str = "
CREATE TABLE sql_parameter_sets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    is_default INTEGER NOT NULL CHECK(is_default IN (0, 1)),
    values_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    UNIQUE(project_id, scope, name)
);
CREATE UNIQUE INDEX sql_parameter_sets_default
    ON sql_parameter_sets(project_id, scope) WHERE is_default = 1;";
const STALE: &str = "매개변수 세트가 변경되었거나 삭제되었습니다. 목록을 새로 고침하세요.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlParameterSetScope {
    project_id: String,
    engine: Engine,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Engine {
    Sqlite,
    Postgres,
    PostgresScript,
    Mysql,
    MysqlScript,
    SqlServer,
    Oracle,
    Snowflake,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ValueKind {
    Text,
    Integer,
    Real,
    Blob,
    Decimal,
    Boolean,
    Null,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredValue {
    kind: ValueKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SavedValue {
    Value { value: StoredValue },
    Secret { value_kind: ValueKind },
}

#[derive(Serialize)]
pub struct SqlParameterSetSummary {
    id: String,
    name: String,
    is_default: bool,
    revision: i64,
}

#[derive(Serialize)]
pub struct SqlParameterSet {
    #[serde(flatten)]
    summary: SqlParameterSetSummary,
    values: Vec<SavedValue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlParameterSetInput {
    name: String,
    is_default: bool,
    values: Vec<SavedValue>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SqlParameterSetWrite {
    Create {
        input: SqlParameterSetInput,
    },
    Update {
        id: String,
        revision: i64,
        input: SqlParameterSetInput,
    },
}

#[derive(Serialize)]
pub struct SqlParameterPlan<T> {
    pub parameters: T,
    pub parameter_scope: String,
}

impl<T: Serialize> SqlParameterPlan<T> {
    pub(crate) fn new<'a>(
        parameters: T,
        sql_parts: impl IntoIterator<Item = &'a [u8]>,
    ) -> Result<Self> {
        let signature =
            serde_json::to_vec(&parameters).map_err(|_| "매개변수 목록을 확인할 수 없습니다.")?;
        let sql_key = fingerprint(sql_parts);
        Ok(Self {
            parameters,
            parameter_scope: fingerprint([sql_key.as_bytes(), &signature]),
        })
    }
}

impl Engine {
    fn mysql(&self) -> bool {
        matches!(self, Self::Mysql | Self::MysqlScript)
    }

    fn postgres(&self) -> bool {
        matches!(self, Self::Postgres | Self::PostgresScript)
    }

    fn accepts(&self, kind: ValueKind) -> bool {
        match kind {
            ValueKind::Text | ValueKind::Null => true,
            ValueKind::Integer | ValueKind::Real => !self.postgres(),
            ValueKind::Blob => !self.postgres() && !self.mysql(),
            ValueKind::Decimal => matches!(self, Self::SqlServer | Self::Oracle | Self::Snowflake),
            ValueKind::Boolean => matches!(self, Self::SqlServer | Self::Snowflake),
        }
    }

    fn validate(&self, field: &StoredValue) -> Result<usize> {
        let invalid = "저장할 매개변수 값과 형식을 확인하세요.";
        if matches!(field.kind, ValueKind::Null) {
            return if field.value.is_none() {
                Ok(0)
            } else {
                Err(invalid.into())
            };
        }
        let value = field.value.as_deref().ok_or(invalid)?;
        let limit = if self.mysql() { 64 * 1024 } else { 16 * 1024 };
        if value.len() > limit {
            return Err(format!(
                "매개변수 값은 {} KiB까지 저장할 수 있습니다.",
                limit / 1024
            ));
        }
        let parsed = if self.mysql() { value } else { value.trim() };
        let valid = match field.kind {
            ValueKind::Text => !self.postgres() || !value.contains('\0'),
            ValueKind::Integer => {
                parsed.parse::<i64>().is_ok() || self.mysql() && parsed.parse::<u64>().is_ok()
            }
            ValueKind::Real => native_table_filter::finite_float(parsed).is_ok(),
            ValueKind::Decimal => {
                native_table_filter::decimal_shape(parsed).is_ok()
                    && (!matches!(self, Self::Oracle)
                        || parsed.parse::<oracledb::OracleNumber>().is_ok())
            }
            ValueKind::Boolean => matches!(parsed, "true" | "false" | "1" | "0"),
            ValueKind::Blob => {
                parsed.len().is_multiple_of(2)
                    && parsed.bytes().all(|byte| byte.is_ascii_hexdigit())
            }
            ValueKind::Null => false,
        };
        if !valid {
            return Err(invalid.into());
        }
        Ok(value.len())
    }
}

impl SqlParameterSetScope {
    fn storage_key(&self) -> Result<String> {
        if self.key.len() != 64 || !self.key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("매개변수 세트가 적용될 SQL 범위를 확인하세요.".into());
        }
        let engine = match self.engine {
            Engine::Sqlite => "sqlite",
            Engine::Postgres => "postgres",
            Engine::PostgresScript => "postgres_script",
            Engine::Mysql => "mysql",
            Engine::MysqlScript => "mysql_script",
            Engine::SqlServer => "sql_server",
            Engine::Oracle => "oracle",
            Engine::Snowflake => "snowflake",
        };
        Ok(format!("{engine}:{}", self.key.to_ascii_lowercase()))
    }

    fn validate_values(&self, values: &[SavedValue]) -> Result<()> {
        let limit = if self.engine.postgres() || matches!(self.engine, Engine::Sqlite) {
            32
        } else {
            64
        };
        if values.is_empty() || values.len() > limit {
            return Err("매개변수 세트의 값 개수를 확인하세요.".into());
        }
        let mut bytes = 0usize;
        for field in values {
            match field {
                SavedValue::Value { value } if self.engine.accepts(value.kind) => {
                    bytes += self.engine.validate(value)?
                }
                SavedValue::Secret { value_kind }
                    if self.engine.accepts(*value_kind)
                        && !matches!(value_kind, ValueKind::Null) => {}
                _ => {
                    return Err("현재 데이터베이스에서 지원하는 매개변수 형식을 선택하세요.".into())
                }
            }
        }
        if self.engine.mysql() && bytes > 64 * 1024 {
            return Err("MySQL 매개변수는 합계 64 KiB까지 저장할 수 있습니다.".into());
        }
        Ok(())
    }
}

impl Store {
    pub fn list_sql_parameter_sets(
        &self,
        scope: &SqlParameterSetScope,
    ) -> Result<Vec<SqlParameterSetSummary>> {
        let key = scope.storage_key()?;
        let db = self.connect()?;
        require_active_project(&db, &scope.project_id)?;
        let mut statement = db.prepare(
            "SELECT id, name, is_default, revision FROM sql_parameter_sets WHERE project_id = ?1 AND scope = ?2
             ORDER BY is_default DESC, name COLLATE NOCASE, id",
        ).map_err(db_error)?;
        let rows = statement
            .query_map(params![scope.project_id, key], read_summary)
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    }

    pub fn read_sql_parameter_set(
        &self,
        scope: &SqlParameterSetScope,
        id: &str,
        revision: i64,
    ) -> Result<SqlParameterSet> {
        let key = scope.storage_key()?;
        let db = self.connect()?;
        require_active_project(&db, &scope.project_id)?;
        let (summary, values) = db
            .query_row(
                "SELECT id, name, is_default, revision, values_json FROM sql_parameter_sets
             WHERE project_id = ?1 AND scope = ?2 AND id = ?3 AND revision = ?4",
                params![scope.project_id, key, id, revision],
                |row| Ok((read_summary(row)?, row.get::<_, String>(4)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or(STALE)?;
        let values: Vec<SavedValue> = serde_json::from_str(&values)
            .map_err(|_| "저장된 매개변수 세트를 읽을 수 없습니다.")?;
        scope.validate_values(&values)?;
        Ok(SqlParameterSet { summary, values })
    }

    pub fn save_sql_parameter_set(
        &self,
        scope: &SqlParameterSetScope,
        write: SqlParameterSetWrite,
    ) -> Result<SqlParameterSetSummary> {
        let (id, revision, input) = match write {
            SqlParameterSetWrite::Create { input } => {
                (Uuid::new_v4().simple().to_string(), None, input)
            }
            SqlParameterSetWrite::Update {
                id,
                revision,
                input,
            } => (id, Some(revision), input),
        };
        let key = scope.storage_key()?;
        let name = valid_name(&input.name)?;
        if name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("세트 이름에는 제어 문자 없이 최대 80자를 입력하세요.".into());
        }
        scope.validate_values(&input.values)?;
        let values = serde_json::to_string(&input.values)
            .map_err(|_| "매개변수 세트를 저장할 수 없습니다.")?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        require_active_project(&tx, &scope.project_id)?;
        if input.is_default {
            tx.execute(
                "UPDATE sql_parameter_sets SET is_default = 0, revision = revision + 1
                 WHERE project_id = ?1 AND scope = ?2 AND is_default = 1 AND id <> ?3",
                params![scope.project_id, key, id],
            )
            .map_err(db_error)?;
        }
        let operation = if let Some(revision) = revision {
            let changed = tx.execute(
                "UPDATE sql_parameter_sets SET name = ?5, values_json = ?6, is_default = ?7, revision = revision + 1
                 WHERE project_id = ?1 AND scope = ?2 AND id = ?3 AND revision = ?4",
                params![scope.project_id, key, id, revision, name, values, input.is_default],
            ).map_err(write_error)?;
            require_changed(changed, STALE)?;
            "sql_parameter_set.update"
        } else {
            let count: i64 = tx
                .query_row(
                    "SELECT count(*) FROM sql_parameter_sets WHERE project_id = ?1",
                    [&scope.project_id],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            if count >= 128 {
                return Err("프로젝트마다 매개변수 세트를 최대 128개 저장할 수 있습니다.".into());
            }
            tx.execute(
                "INSERT INTO sql_parameter_sets(id, project_id, scope, name, values_json, is_default) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, scope.project_id, key, name, values, input.is_default],
            ).map_err(write_error)?;
            "sql_parameter_set.create"
        };
        record(&tx, &scope.project_id, operation)?;
        tx.commit().map_err(db_error)?;
        Ok(SqlParameterSetSummary {
            id,
            name: name.into(),
            is_default: input.is_default,
            revision: revision.unwrap_or(0) + 1,
        })
    }

    pub fn delete_sql_parameter_set(
        &self,
        scope: &SqlParameterSetScope,
        id: &str,
        revision: i64,
    ) -> Result<()> {
        let key = scope.storage_key()?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        require_active_project(&tx, &scope.project_id)?;
        let changed = tx.execute(
            "DELETE FROM sql_parameter_sets WHERE project_id = ?1 AND scope = ?2 AND id = ?3 AND revision = ?4",
            params![scope.project_id, key, id, revision],
        ).map_err(db_error)?;
        require_changed(changed, STALE)?;
        record(&tx, &scope.project_id, "sql_parameter_set.delete")?;
        tx.commit().map_err(db_error)
    }
}

pub(super) fn copy_project_sets(db: &Connection, source: &str, destination: &str) -> Result<usize> {
    db.execute(
        "INSERT INTO sql_parameter_sets(id, project_id, scope, name, is_default, values_json)
         SELECT lower(hex(randomblob(16))), ?2, scope, name, is_default, values_json
         FROM sql_parameter_sets WHERE project_id = ?1",
        params![source, destination],
    )
    .map_err(db_error)
}

pub(crate) fn fingerprint<'a>(parts: impl IntoIterator<Item = &'a [u8]>) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    format!("{:x}", hash.finalize())
}

fn read_summary(row: &Row<'_>) -> rusqlite::Result<SqlParameterSetSummary> {
    Ok(SqlParameterSetSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        is_default: row.get(2)?,
        revision: row.get(3)?,
    })
}

fn write_error(error: rusqlite::Error) -> String {
    if matches!(&error, rusqlite::Error::SqliteFailure(code, _) if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
    {
        return "같은 SQL 범위에 동일한 이름의 매개변수 세트가 있습니다.".into();
    }
    db_error(error)
}

fn record(db: &Connection, project_id: &str, operation: &'static str) -> Result<()> {
    insert_audit(
        db,
        AuditRecord {
            correlation_id: &Uuid::new_v4().to_string(),
            operation,
            project_id: Some(project_id),
            profile_id: None,
            environment: None,
            object_name: None,
            outcome: "succeeded",
            affected_count: Some(1),
        },
    )
}
