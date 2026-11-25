use super::{db_error, insert_audit, require_changed, valid_name, AuditRecord, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) const SCHEMA: &str = "CREATE TABLE sql_templates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    folder TEXT NOT NULL COLLATE NOCASE,
    sql TEXT NOT NULL,
    favorite INTEGER NOT NULL CHECK(favorite IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    UNIQUE(project_id, folder, name)
);";
pub(crate) const DIALECT_SCHEMA: &str = "ALTER TABLE sql_templates ADD COLUMN dialect TEXT NOT NULL DEFAULT 'common'
    CHECK(dialect IN ('common', 'sqlite', 'postgres', 'mysql', 'tsql', 'oracle', 'snowflake'));";
const MAX_TEMPLATES: i64 = 128;
const MAX_SQL_BYTES: usize = 256 * 1024;
const STALE: &str = "템플릿이 변경되었거나 삭제되었습니다. 새로 고침 후 다시 시도하세요.";

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlTemplateDialect {
    #[default]
    Common,
    Sqlite,
    Postgres,
    Mysql,
    Tsql,
    Oracle,
    Snowflake,
}

impl SqlTemplateDialect {
    fn as_str(self) -> &'static str {
        match self {
            Self::Common => "common",
            Self::Sqlite => "sqlite",
            Self::Postgres => "postgres",
            Self::Mysql => "mysql",
            Self::Tsql => "tsql",
            Self::Oracle => "oracle",
            Self::Snowflake => "snowflake",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SqlTemplateSummary {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub favorite: bool,
    pub revision: i64,
    pub dialect: String,
}

#[derive(Debug, Serialize)]
pub struct SqlTemplate {
    #[serde(flatten)]
    pub summary: SqlTemplateSummary,
    pub sql: String,
}

#[derive(Deserialize)]
pub struct SqlTemplateInput {
    pub name: String,
    pub folder: String,
    pub sql: String,
    pub favorite: bool,
    #[serde(default)]
    pub dialect: SqlTemplateDialect,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SqlTemplateWrite {
    Create {
        template: SqlTemplateInput,
    },
    Update {
        id: String,
        revision: i64,
        template: SqlTemplateInput,
    },
    Favorite {
        id: String,
        revision: i64,
        favorite: bool,
    },
}

impl Store {
    pub fn list_sql_templates(&self, project_id: &str) -> Result<Vec<SqlTemplateSummary>> {
        let db = self.connect()?;
        require_active_project(&db, project_id)?;
        let mut statement = db.prepare(
            "SELECT id, name, folder, favorite, revision, dialect FROM sql_templates WHERE project_id = ?1
             ORDER BY favorite DESC, folder COLLATE NOCASE, name COLLATE NOCASE, id",
        ).map_err(db_error)?;
        let rows = statement
            .query_map([project_id], read_summary)
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    }

    pub fn read_sql_template(&self, project_id: &str, id: &str) -> Result<SqlTemplate> {
        let db = self.connect()?;
        require_active_project(&db, project_id)?;
        load(&db, project_id, id)
    }

    pub fn save_sql_template(
        &self,
        project_id: &str,
        write: SqlTemplateWrite,
    ) -> Result<SqlTemplate> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        require_active_project(&tx, project_id)?;
        let (id, operation) = match write {
            SqlTemplateWrite::Create { template } => {
                let (name, folder) = validate(&template)?;
                let count: i64 = tx
                    .query_row(
                        "SELECT count(*) FROM sql_templates WHERE project_id = ?1",
                        [project_id],
                        |row| row.get(0),
                    )
                    .map_err(db_error)?;
                if count >= MAX_TEMPLATES {
                    return Err("프로젝트마다 SQL 템플릿을 최대 128개 저장할 수 있습니다.".into());
                }
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO sql_templates(id, project_id, name, folder, sql, favorite, dialect)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, project_id, name, folder, template.sql, template.favorite, template.dialect.as_str()],
                ).map_err(write_error)?;
                (id, "sql_template.create")
            }
            SqlTemplateWrite::Update {
                id,
                revision,
                template,
            } => {
                let (name, folder) = validate(&template)?;
                let changed = tx.execute(
                    "UPDATE sql_templates SET name = ?4, folder = ?5, sql = ?6, favorite = ?7, dialect = ?8, revision = revision + 1
                     WHERE project_id = ?1 AND id = ?2 AND revision = ?3",
                    params![project_id, id, revision, name, folder, template.sql, template.favorite, template.dialect.as_str()],
                ).map_err(write_error)?;
                require_changed(changed, STALE)?;
                (id, "sql_template.update")
            }
            SqlTemplateWrite::Favorite {
                id,
                revision,
                favorite,
            } => {
                let changed = tx
                    .execute(
                        "UPDATE sql_templates SET favorite = ?4, revision = revision + 1
                     WHERE project_id = ?1 AND id = ?2 AND revision = ?3",
                        params![project_id, id, revision, favorite],
                    )
                    .map_err(db_error)?;
                require_changed(changed, STALE)?;
                (id, "sql_template.favorite")
            }
        };
        let template = load(&tx, project_id, &id)?;
        record(&tx, project_id, operation)?;
        tx.commit().map_err(db_error)?;
        Ok(template)
    }

    pub fn delete_sql_template(&self, project_id: &str, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        require_active_project(&tx, project_id)?;
        let changed = tx
            .execute(
                "DELETE FROM sql_templates WHERE project_id = ?1 AND id = ?2 AND revision = ?3",
                params![project_id, id, revision],
            )
            .map_err(db_error)?;
        require_changed(changed, STALE)?;
        record(&tx, project_id, "sql_template.delete")?;
        tx.commit().map_err(db_error)
    }
}

pub(crate) fn copy_project_templates(
    db: &Connection,
    source: &str,
    destination: &str,
) -> Result<usize> {
    let mut statement = db
        .prepare("SELECT name, folder, sql, favorite, dialect FROM sql_templates WHERE project_id = ?1")
        .map_err(db_error)?;
    let rows = statement
        .query_map([source], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    drop(statement);
    let mut count = 0;
    for (name, folder, sql, favorite, dialect) in rows {
        count += db.execute(
            "INSERT INTO sql_templates(id, project_id, name, folder, sql, favorite, dialect)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![Uuid::new_v4().to_string(), destination, name, folder, sql, favorite, dialect],
        ).map_err(db_error)?;
    }
    Ok(count)
}

pub(super) fn require_active_project(db: &Connection, project_id: &str) -> Result<()> {
    let active: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1 AND
         NOT EXISTS(SELECT 1 FROM project_archives WHERE project_id = ?1))",
            [project_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !active {
        return Err("활성 프로젝트를 찾을 수 없습니다.".into());
    }
    Ok(())
}

fn validate(template: &SqlTemplateInput) -> Result<(&str, &str)> {
    let name = valid_name(&template.name)?;
    if name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err("템플릿 이름에는 제어 문자 없이 최대 100자를 입력하세요.".into());
    }
    let folder = template.folder.trim();
    if folder.chars().count() > 100 || folder.chars().any(char::is_control) {
        return Err("폴더 이름에는 제어 문자 없이 최대 100자를 입력하세요.".into());
    }
    if template.sql.trim().is_empty()
        || template.sql.len() > MAX_SQL_BYTES
        || template.sql.contains('\0')
    {
        return Err("NUL 문자 없이 UTF-8 256 KiB 이하의 SQL을 입력하세요.".into());
    }
    Ok((name, folder))
}

fn read_summary(row: &Row<'_>) -> rusqlite::Result<SqlTemplateSummary> {
    Ok(SqlTemplateSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        folder: row.get(2)?,
        favorite: row.get(3)?,
        revision: row.get(4)?,
        dialect: row.get(5)?,
    })
}

fn load(db: &Connection, project_id: &str, id: &str) -> Result<SqlTemplate> {
    db.query_row(
        "SELECT id, name, folder, favorite, revision, dialect, sql FROM sql_templates WHERE project_id = ?1 AND id = ?2",
        params![project_id, id], |row| Ok(SqlTemplate { summary: read_summary(row)?, sql: row.get(6)? }),
    ).optional().map_err(db_error)?.ok_or_else(|| STALE.into())
}

fn write_error(error: rusqlite::Error) -> String {
    if matches!(&error, rusqlite::Error::SqliteFailure(code, _) if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
    {
        return "같은 폴더에 동일한 이름의 템플릿이 있습니다.".into();
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
