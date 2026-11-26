//! Local organization for saved database connections.
use crate::{db_error, insert_audit, require_changed, AuditRecord, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

const TABLES: &[&str] = &[
    "profiles",
    "postgres_profiles",
    "mysql_profiles",
    "redis_profiles",
    "native_db_profiles",
];
const COLUMNS: &str = "id, parent_id, name, revision";
const DUPLICATE_NAME: &str = "같은 위치에 이미 같은 이름의 폴더가 있습니다.";
const CHANGED: &str = "폴더 또는 연결 위치가 변경되었습니다. 새로고침하고 다시 시도하세요.";

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS database_folders (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            parent_id TEXT,
            name TEXT COLLATE NOCASE NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
            UNIQUE(project_id, id),
            FOREIGN KEY(project_id, parent_id) REFERENCES database_folders(project_id, id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS database_folder_sibling_name
            ON database_folders(project_id, coalesce(parent_id, ''), name COLLATE NOCASE);",
    ).map_err(db_error)?;
    for table in TABLES {
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name='folder_id')",
                [table],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN folder_id TEXT REFERENCES database_folders(id) ON DELETE SET NULL;"))
                .map_err(db_error)?;
        }
        db.execute_batch(&format!("CREATE INDEX IF NOT EXISTS {table}_folder ON {table}(folder_id) WHERE folder_id IS NOT NULL;"))
            .map_err(db_error)?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseFolderEngine {
    Sqlite,
    Postgres,
    Mysql,
    Redis,
    #[serde(rename = "mongodb")]
    Mongo,
    SqlServer,
    Oracle,
    Snowflake,
}

impl DatabaseFolderEngine {
    fn table(self) -> (&'static str, &'static str, Option<&'static str>) {
        match self {
            Self::Sqlite => ("profiles", "NULL", None),
            Self::Postgres => ("postgres_profiles", "NULL", None),
            Self::Mysql => ("mysql_profiles", "NULL", None),
            Self::Redis => ("redis_profiles", "NULL", None),
            Self::Mongo => ("native_db_profiles", "engine", Some("mongodb")),
            Self::SqlServer => ("native_db_profiles", "engine", Some("sql_server")),
            Self::Oracle => ("native_db_profiles", "engine", Some("oracle")),
            Self::Snowflake => ("native_db_profiles", "engine", Some("snowflake")),
        }
    }

    fn read_name(name: &str) -> rusqlite::Result<Self> {
        match name {
            "sqlite" => Ok(Self::Sqlite),
            "postgres" => Ok(Self::Postgres),
            "mysql" => Ok(Self::Mysql),
            "redis" => Ok(Self::Redis),
            "mongodb" => Ok(Self::Mongo),
            "sql_server" => Ok(Self::SqlServer),
            "oracle" => Ok(Self::Oracle),
            "snowflake" => Ok(Self::Snowflake),
            _ => Err(rusqlite::Error::InvalidQuery),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DatabaseFolder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub revision: i64,
}

#[derive(Serialize)]
pub struct DatabasePlacement {
    pub engine: DatabaseFolderEngine,
    pub profile_id: String,
    pub folder_id: String,
}

#[derive(Serialize)]
pub struct DatabaseFolderState {
    pub folders: Vec<DatabaseFolder>,
    pub placements: Vec<DatabasePlacement>,
}

impl Store {
    pub fn database_folders(&self, project: &str) -> Result<DatabaseFolderState> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        active_project(&tx, project)?;
        let folders = read_folders(&tx, project)?;
        let placements = {
            let mut query = tx.prepare(
                "SELECT 'sqlite', id, folder_id FROM profiles WHERE project_id=?1 AND folder_id IS NOT NULL
                 UNION ALL SELECT 'postgres', id, folder_id FROM postgres_profiles WHERE project_id=?1 AND folder_id IS NOT NULL
                 UNION ALL SELECT 'mysql', id, folder_id FROM mysql_profiles WHERE project_id=?1 AND folder_id IS NOT NULL
                 UNION ALL SELECT 'redis', id, folder_id FROM redis_profiles WHERE project_id=?1 AND folder_id IS NOT NULL
                 UNION ALL SELECT engine, id, folder_id FROM native_db_profiles WHERE project_id=?1 AND folder_id IS NOT NULL",
            ).map_err(db_error)?;
            let rows = query
                .query_map([project], |row| {
                    Ok(DatabasePlacement {
                        engine: DatabaseFolderEngine::read_name(row.get_ref(0)?.as_str()?)?,
                        profile_id: row.get(1)?,
                        folder_id: row.get(2)?,
                    })
                })
                .map_err(db_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(db_error)?
        };
        tx.commit().map_err(db_error)?;
        Ok(DatabaseFolderState {
            folders,
            placements,
        })
    }

    pub fn create_database_folder(
        &self,
        project: &str,
        parent: Option<&str>,
        name: &str,
    ) -> Result<DatabaseFolder> {
        let name = folder_name(name)?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        active_project(&tx, project)?;
        check_parent(&tx, project, parent, None)?;
        let folder = insert_folder(&tx, project, parent, name)?;
        audit(&tx, project, None, "database_folder.create")?;
        tx.commit().map_err(db_error)?;
        Ok(folder)
    }

    pub fn update_database_folder(
        &self,
        project: &str,
        id: &str,
        revision: i64,
        parent: Option<&str>,
        name: &str,
    ) -> Result<DatabaseFolder> {
        let name = folder_name(name)?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        active_project(&tx, project)?;
        let current = current_folder(&tx, project, id, revision)?;
        check_parent(&tx, project, parent, Some(id))?;
        if current.name == name && current.parent_id.as_deref() == parent {
            return Ok(current);
        }
        let next = revision
            .checked_add(1)
            .ok_or("폴더 변경 버전이 너무 큽니다.")?;
        let changed = tx.execute(
            "UPDATE OR IGNORE database_folders SET name=?2, parent_id=?3, revision=?4 WHERE id=?1",
            params![id, name, parent, next],
        ).map_err(db_error)?;
        require_changed(changed, DUPLICATE_NAME)?;
        audit(&tx, project, None, "database_folder.update")?;
        tx.commit().map_err(db_error)?;
        Ok(DatabaseFolder {
            id: id.into(),
            parent_id: parent.map(str::to_owned),
            name: name.into(),
            revision: next,
        })
    }

    pub fn move_database_connection(
        &self,
        project: &str,
        engine: DatabaseFolderEngine,
        profile: &str,
        previous: Option<&str>,
        folder: Option<&str>,
    ) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        active_project(&tx, project)?;
        check_parent(&tx, project, folder, None)?;
        let (table, discriminator, engine_name) = engine.table();
        let changed = tx.execute(&format!(
            "UPDATE {table} SET folder_id=?1 WHERE project_id=?2 AND id=?3 AND folder_id IS ?4 AND {discriminator} IS ?5"
        ), params![folder, project, profile, previous, engine_name]).map_err(db_error)?;
        require_changed(changed, CHANGED)?;
        if previous != folder {
            audit(
                &tx,
                project,
                Some(profile),
                "database_folder.place_connection",
            )?;
        }
        tx.commit().map_err(db_error)
    }

    pub fn delete_database_folder(&self, project: &str, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        active_project(&tx, project)?;
        let folder = current_folder(&tx, project, id, revision)?;
        for table in TABLES {
            tx.execute(&format!(
                "WITH RECURSIVE subtree(id) AS (
                    SELECT ?1 UNION SELECT f.id FROM database_folders f JOIN subtree p ON f.parent_id=p.id
                 ) UPDATE {table} SET folder_id=?2 WHERE project_id=?3 AND folder_id IN (SELECT id FROM subtree)"
            ), params![folder.id, folder.parent_id, project]).map_err(db_error)?;
        }
        tx.execute("DELETE FROM database_folders WHERE id=?1", [&folder.id])
            .map_err(db_error)?;
        audit(&tx, project, None, "database_folder.delete")?;
        tx.commit().map_err(db_error)
    }
}

pub(crate) fn copy_database_folders(
    db: &Connection,
    source: &str,
    destination: &str,
    sqlite_profiles: &[(String, String)],
) -> Result<usize> {
    let mut query = db.prepare(&format!(
        "WITH RECURSIVE folders(id, depth) AS (
            SELECT id, 0 FROM database_folders WHERE project_id=?1 AND parent_id IS NULL
            UNION ALL SELECT f.id, p.depth+1 FROM database_folders f JOIN folders p ON f.parent_id=p.id
         ) SELECT {COLUMNS} FROM database_folders WHERE id IN (SELECT id FROM folders)
         ORDER BY (SELECT depth FROM folders WHERE folders.id=database_folders.id), name, id"
    )).map_err(db_error)?;
    let rows = query
        .query_map([source], folder_from_row)
        .map_err(db_error)?;
    let folders = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)?;
    let mut mapping = HashMap::<String, String>::new();
    for folder in folders {
        let parent = folder
            .parent_id
            .as_ref()
            .map(|id| {
                mapping
                    .get(id)
                    .map(String::as_str)
                    .ok_or("상위 폴더를 복제할 수 없습니다.")
            })
            .transpose()?;
        let copy = insert_folder(db, destination, parent, &folder.name)?;
        mapping.insert(folder.id, copy.id);
    }
    for (old, new) in &mapping {
        for table in &TABLES[1..] {
            let same_engine = if *table == "native_db_profiles" {
                "AND source.engine=target.engine"
            } else {
                ""
            };
            db.execute(&format!(
                "UPDATE {table} AS target SET folder_id=?1 WHERE target.project_id=?2 AND EXISTS (
                    SELECT 1 FROM {table} AS source WHERE source.project_id=?3 AND source.folder_id=?4
                        AND source.name=target.name {same_engine}
                )"
            ), params![new, destination, source, old]).map_err(db_error)?;
        }
    }
    for (old, new) in sqlite_profiles {
        let folder_id: Option<String> = db
            .query_row("SELECT folder_id FROM profiles WHERE id=?1", [old], |row| {
                row.get(0)
            })
            .map_err(db_error)?;
        if let Some(folder) = folder_id {
            let destination_folder = mapping
                .get(&folder)
                .ok_or("연결 폴더를 복제할 수 없습니다.")?;
            db.execute(
                "UPDATE profiles SET folder_id=?2 WHERE id=?1",
                params![new, destination_folder],
            )
            .map_err(db_error)?;
        }
    }
    Ok(mapping.len())
}

fn read_folders(db: &Connection, project: &str) -> Result<Vec<DatabaseFolder>> {
    let mut query = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM database_folders WHERE project_id=?1 ORDER BY name, id"
        ))
        .map_err(db_error)?;
    let rows = query
        .query_map([project], folder_from_row)
        .map_err(db_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
}

fn folder_from_row(row: &Row<'_>) -> rusqlite::Result<DatabaseFolder> {
    Ok(DatabaseFolder {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        revision: row.get(3)?,
    })
}

fn insert_folder(
    db: &Connection,
    project: &str,
    parent: Option<&str>,
    name: &str,
) -> Result<DatabaseFolder> {
    let id = Uuid::new_v4().to_string();
    let changed = db.execute(
        "INSERT OR IGNORE INTO database_folders (id, project_id, parent_id, name) VALUES (?1, ?2, ?3, ?4)",
        params![id, project, parent, name],
    ).map_err(db_error)?;
    require_changed(changed, DUPLICATE_NAME)?;
    Ok(DatabaseFolder {
        id,
        parent_id: parent.map(str::to_owned),
        name: name.into(),
        revision: 1,
    })
}

fn current_folder(
    db: &Connection,
    project: &str,
    id: &str,
    revision: i64,
) -> Result<DatabaseFolder> {
    let folder = db
        .query_row(
            &format!("SELECT {COLUMNS} FROM database_folders WHERE project_id=?1 AND id=?2"),
            params![project, id],
            folder_from_row,
        )
        .optional()
        .map_err(db_error)?;
    folder
        .filter(|folder| folder.revision == revision)
        .ok_or_else(|| CHANGED.into())
}

fn check_parent(
    db: &Connection,
    project: &str,
    parent: Option<&str>,
    moving: Option<&str>,
) -> Result<()> {
    let Some(parent) = parent else {
        return Ok(());
    };
    let (exists, cycle): (bool, bool) = db.query_row(
        "WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT id, parent_id FROM database_folders WHERE id=?1 AND project_id=?2
            UNION SELECT f.id, f.parent_id FROM database_folders f JOIN ancestors a ON f.id=a.parent_id
        ) SELECT EXISTS(SELECT 1 FROM ancestors), EXISTS(SELECT 1 FROM ancestors WHERE id=?3)",
        params![parent, project, moving], |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(db_error)?;
    if !exists {
        return Err("선택한 프로젝트에서 대상 폴더를 찾을 수 없습니다.".into());
    }
    if cycle {
        return Err("폴더를 자신 또는 그 하위 폴더로 옮길 수 없습니다.".into());
    }
    Ok(())
}

fn active_project(db: &Connection, project: &str) -> Result<()> {
    let active: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id=?1))",
        [project], |row| row.get(0),
    ).map_err(db_error)?;
    active
        .then_some(())
        .ok_or_else(|| "활성 프로젝트를 선택하세요.".into())
}

fn folder_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > 100
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
    {
        return Err(
            "폴더 이름을 1~100자로 입력하세요. 경로 구분 문자와 제어 문자는 사용할 수 없습니다."
                .into(),
        );
    }
    Ok(name)
}

fn audit(
    db: &Connection,
    project: &str,
    profile: Option<&str>,
    operation: &'static str,
) -> Result<()> {
    insert_audit(
        db,
        AuditRecord {
            correlation_id: &Uuid::new_v4().to_string(),
            operation,
            project_id: Some(project),
            profile_id: profile,
            environment: None,
            object_name: None,
            outcome: "succeeded",
            affected_count: Some(1),
        },
    )
}
