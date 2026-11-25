use crate::{
    db_error, insert_audit, require_changed, valid_name, AuditRecord, Result, Store,
    TableQueryClauses,
};
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Params, Row, ToSql,
    TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) const SCHEMA: &str = "CREATE TABLE table_query_presets (
    id TEXT PRIMARY KEY,
    sqlite_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
    postgres_id TEXT REFERENCES postgres_profiles(id) ON DELETE CASCADE,
    mysql_id TEXT REFERENCES mysql_profiles(id) ON DELETE CASCADE,
    target_key TEXT NOT NULL,
    schema_name TEXT NOT NULL,
    object_name TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    clauses TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    CHECK ((sqlite_id IS NOT NULL) + (postgres_id IS NOT NULL) + (mysql_id IS NOT NULL) = 1),
    UNIQUE (sqlite_id, target_key, schema_name, object_name, name),
    UNIQUE (postgres_id, target_key, schema_name, object_name, name),
    UNIQUE (mysql_id, target_key, schema_name, object_name, name)
);";

pub(crate) fn migrate_v15(db: &Connection) -> Result<()> {
    db.execute_batch("ALTER TABLE table_query_presets RENAME TO table_query_presets_v15;")
        .map_err(db_error)?;
    db.execute_batch(SCHEMA).map_err(db_error)?;
    db.execute_batch(
        "INSERT INTO table_query_presets
           (id, sqlite_id, postgres_id, target_key, schema_name, object_name, name, clauses, revision)
         SELECT id, sqlite_id, postgres_id, target_key, schema_name, object_name, name, clauses, revision
           FROM table_query_presets_v15;
         DROP TABLE table_query_presets_v15;",
    )
    .map_err(db_error)
}

const SCOPE: &str = "sqlite_id IS ?1 AND postgres_id IS ?2 AND mysql_id IS ?3 AND target_key = ?4 AND schema_name = ?5 AND object_name = ?6";
const SELECTED: &str = "id = ?7 AND revision = ?8";
const STALE: &str = "저장된 조건이 변경되었거나 삭제되었습니다. 목록을 다시 확인하세요.";
const MAX_PRESETS: i64 = 50;
const MAX_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(tag = "engine", rename_all = "snake_case", deny_unknown_fields)]
pub enum TableQueryTarget {
    Sqlite {
        profile_id: String,
        object: String,
    },
    Postgres {
        profile_id: String,
        revision: i64,
        schema: String,
        object: String,
    },
    Mysql {
        profile_id: String,
        revision: i64,
        schema: String,
        object: String,
    },
}

#[derive(Serialize)]
pub struct TableQueryPreset {
    pub id: String,
    pub name: String,
    pub revision: i64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TableQueryPresetWrite {
    Create {
        name: String,
        clauses: TableQueryClauses,
    },
    Replace {
        id: String,
        revision: i64,
        clauses: TableQueryClauses,
    },
    Delete {
        id: String,
        revision: i64,
    },
}

struct Scope<'a> {
    project_id: String,
    environment: String,
    target_key: String,
    sqlite_id: Option<&'a str>,
    postgres_id: Option<&'a str>,
    mysql_id: Option<&'a str>,
    schema: &'a str,
    object: &'a str,
}

impl TableQueryTarget {
    fn scope(&self, db: &Connection) -> Result<Scope<'_>> {
        let (sqlite_id, postgres_id, mysql_id, schema, object) = match self {
            Self::Sqlite { profile_id, object } => (
                Some(profile_id.as_str()),
                None,
                None,
                "main",
                object.as_str(),
            ),
            Self::Postgres {
                profile_id,
                schema,
                object,
                ..
            } => (
                None,
                Some(profile_id.as_str()),
                None,
                schema.as_str(),
                object.as_str(),
            ),
            Self::Mysql {
                profile_id,
                schema,
                object,
                ..
            } => {
                if ![schema, object]
                    .iter()
                    .all(|name| crate::mysql::valid_identifier(name))
                {
                    return Err("조회 조건을 저장할 데이터베이스나 객체 이름을 확인하세요.".into());
                }
                (
                    None,
                    None,
                    Some(profile_id.as_str()),
                    schema.as_str(),
                    object.as_str(),
                )
            }
        };
        if [schema, object]
            .iter()
            .any(|name| name.len() > 16 * 1024 || name.contains('\0'))
        {
            return Err("조회 조건을 저장할 객체 이름을 확인하세요.".into());
        }
        let read = |row: &Row<'_>| Ok((row.get(0)?, row.get(1)?, row.get(2)?));
        let (project_id, environment, target_key) = match self {
            Self::Sqlite { profile_id, .. } => db.query_row(
                "SELECT project_id, environment, path FROM profiles WHERE id = ?1
                 AND NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id = profiles.project_id)",
                [profile_id],
                read,
            ),
            Self::Postgres { profile_id, revision, .. } => db.query_row(
                "SELECT project_id, environment, json_array(host, port, database_name, username)
                 FROM postgres_profiles WHERE id = ?1 AND revision = ?2
                 AND NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id = postgres_profiles.project_id)",
                params![profile_id, revision],
                read,
            ),
            Self::Mysql { profile_id, revision, .. } => db.query_row(
                "SELECT project_id, json_extract(settings_json, '$.environment'),
                        json_array(json_extract(settings_json, '$.host'), json_extract(settings_json, '$.port'),
                                   json_extract(settings_json, '$.username'))
                 FROM mysql_profiles WHERE id = ?1 AND revision = ?2
                 AND NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id = mysql_profiles.project_id)",
                params![profile_id, revision],
                read,
            ),
        }.optional().map_err(db_error)?.ok_or("활성 연결을 찾을 수 없습니다. 연결을 다시 여세요.")?;
        Ok(Scope {
            project_id,
            environment,
            target_key,
            sqlite_id,
            postgres_id,
            mysql_id,
            schema,
            object,
        })
    }
}

impl Scope<'_> {
    fn values<'a>(&'a self, extra: &'a [&'a dyn ToSql]) -> impl Params + 'a {
        let address: [&dyn ToSql; 6] = [
            &self.sqlite_id,
            &self.postgres_id,
            &self.mysql_id,
            &self.target_key,
            &self.schema,
            &self.object,
        ];
        params_from_iter(address.into_iter().chain(extra.iter().copied()))
    }

    fn encode(&self, clauses: &TableQueryClauses) -> Result<String> {
        clauses.validate_preset(self.sqlite_id.is_some())?;
        let json = serde_json::to_string(clauses)
            .map_err(|_| "조회 조건을 저장 형식으로 변환할 수 없습니다.")?;
        if json.len() > MAX_BYTES {
            return Err("조회 조건의 크기는 512 KiB 이하여야 합니다.".into());
        }
        Ok(json)
    }
}

impl Store {
    pub fn list_table_query_presets(
        &self,
        target: &TableQueryTarget,
    ) -> Result<Vec<TableQueryPreset>> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        let scope = target.scope(&tx)?;
        let mut query = tx.prepare(&format!(
            "SELECT id, name, revision FROM table_query_presets WHERE {SCOPE} ORDER BY name COLLATE NOCASE, id LIMIT {MAX_PRESETS}"
        )).map_err(db_error)?;
        let rows = query
            .query_map(scope.values(&[]), |row| {
                Ok(TableQueryPreset {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    revision: row.get(2)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    }

    pub fn read_table_query_preset(
        &self,
        target: &TableQueryTarget,
        id: &str,
        revision: i64,
    ) -> Result<TableQueryClauses> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        let scope = target.scope(&tx)?;
        let json: String = tx
            .query_row(
                &format!("SELECT clauses FROM table_query_presets WHERE {SCOPE} AND {SELECTED}"),
                scope.values(&[&id, &revision]),
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or(STALE)?;
        if json.len() > MAX_BYTES {
            return Err("저장된 조회 조건의 크기를 확인하세요.".into());
        }
        let clauses: TableQueryClauses =
            serde_json::from_str(&json).map_err(|_| "저장된 조회 조건을 읽을 수 없습니다.")?;
        clauses.validate_preset(scope.sqlite_id.is_some())?;
        Ok(clauses)
    }

    pub fn write_table_query_preset(
        &self,
        target: &TableQueryTarget,
        write: TableQueryPresetWrite,
    ) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let scope = target.scope(&tx)?;
        let operation = match write {
            TableQueryPresetWrite::Create { name, clauses } => {
                let name = valid_name(&name)?;
                if name.encode_utf16().count() > 80 || name.chars().any(char::is_control) {
                    return Err("조건 이름은 제어 문자 없이 80자 이하로 입력하세요.".into());
                }
                let count: i64 = tx
                    .query_row(
                        &format!("SELECT count(*) FROM table_query_presets WHERE {SCOPE}"),
                        scope.values(&[]),
                        |row| row.get(0),
                    )
                    .map_err(db_error)?;
                if count >= MAX_PRESETS {
                    return Err("객체별로 조회 조건을 최대 50개 저장할 수 있습니다.".into());
                }
                let json = scope.encode(&clauses)?;
                let id = Uuid::new_v4().to_string();
                let changed = tx.execute(
                    "INSERT INTO table_query_presets(sqlite_id, postgres_id, mysql_id, target_key, schema_name, object_name, id, name, clauses, revision)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1) ON CONFLICT DO NOTHING",
                    scope.values(&[&id, &name, &json]),
                ).map_err(db_error)?;
                require_changed(changed, "이 객체에 같은 이름의 조회 조건이 있습니다.")?;
                "table_query_preset.create"
            }
            TableQueryPresetWrite::Replace {
                id,
                revision,
                clauses,
            } => {
                let json = scope.encode(&clauses)?;
                let next = revision.checked_add(1).ok_or(STALE)?;
                let changed = tx.execute(
                    &format!("UPDATE table_query_presets SET clauses = ?9, revision = ?10 WHERE {SCOPE} AND {SELECTED}"),
                    scope.values(&[&id, &revision, &json, &next]),
                ).map_err(db_error)?;
                require_changed(changed, STALE)?;
                "table_query_preset.replace"
            }
            TableQueryPresetWrite::Delete { id, revision } => {
                let changed = tx
                    .execute(
                        &format!("DELETE FROM table_query_presets WHERE {SCOPE} AND {SELECTED}"),
                        scope.values(&[&id, &revision]),
                    )
                    .map_err(db_error)?;
                require_changed(changed, STALE)?;
                "table_query_preset.delete"
            }
        };
        insert_audit(
            &tx,
            AuditRecord {
                correlation_id: &Uuid::new_v4().to_string(),
                operation,
                project_id: Some(&scope.project_id),
                profile_id: scope.sqlite_id.or(scope.postgres_id).or(scope.mysql_id),
                environment: Some(&scope.environment),
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(1),
            },
        )?;
        tx.commit().map_err(db_error)
    }
}
