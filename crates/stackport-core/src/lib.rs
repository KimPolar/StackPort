//! Local workspace metadata and the first database adapter.
//!
//! The metadata database and user databases are deliberately separate. User
//! databases are opened read-only and arbitrary SQL is subject to an SQLite
//! authorizer in addition to the operating mode of the connection.

use rusqlite::{
    backup::{Backup, StepResult},
    hooks::{AuthAction, AuthContext, Authorization},
    params,
    types::ValueRef,
    Connection, OpenFlags, OptionalExtension,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
const SCHEMA_VERSION: i64 = 1;
pub const PAGE_SIZE: usize = 100;
const CELL_MAX_CHARS: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Profile {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub path: String,
    pub environment: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseObject {
    pub name: String,
    pub kind: String,
    pub ddl: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Cell {
    pub kind: &'static str,
    pub display: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryPage {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupReport {
    pub path: String,
    pub size_bytes: u64,
    pub integrity: &'static str,
}

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("메타데이터 폴더를 만들 수 없습니다: {e}"))?;
        }
        let store = Self {
            path: path.to_owned(),
        };
        let mut db = store.connect()?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(db_error)?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "더 최신 버전의 작업 공간 형식입니다 (버전 {version})."
            ));
        }
        if version == 0 {
            let tx = db.transaction().map_err(db_error)?;
            tx.execute_batch(
                "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
                 CREATE TABLE profiles (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL,
                    environment TEXT NOT NULL CHECK(environment IN ('DEV', 'STAGING', 'PROD'))
                 );
                 PRAGMA user_version = 1;",
            )
            .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        }
        Ok(store)
    }

    fn connect(&self) -> Result<Connection> {
        let db = Connection::open(&self.path).map_err(db_error)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
        db.pragma_update(None, "foreign_keys", true)
            .map_err(db_error)?;
        Ok(db)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let db = self.connect()?;
        let mut stmt = db
            .prepare("SELECT id, name FROM projects ORDER BY name COLLATE NOCASE, id")
            .map_err(db_error)?;
        let items = stmt
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                })
            })
            .map_err(db_error)?;
        items
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)
    }

    pub fn create_project(&self, name: &str) -> Result<Project> {
        let name = valid_name(name)?;
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
        };
        self.connect()?
            .execute(
                "INSERT INTO projects (id, name) VALUES (?1, ?2)",
                params![project.id, project.name],
            )
            .map_err(db_error)?;
        Ok(project)
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Result<()> {
        let changed = self
            .connect()?
            .execute(
                "UPDATE projects SET name = ?1 WHERE id = ?2",
                params![valid_name(name)?, id],
            )
            .map_err(db_error)?;
        require_changed(changed, "프로젝트를 찾을 수 없습니다.")
    }

    pub fn delete_project(&self, id: &str) -> Result<()> {
        let changed = self
            .connect()?
            .execute("DELETE FROM projects WHERE id = ?1", [id])
            .map_err(db_error)?;
        require_changed(changed, "프로젝트를 찾을 수 없습니다.")
    }

    pub fn list_profiles(&self, project_id: &str) -> Result<Vec<Profile>> {
        let db = self.connect()?;
        let mut stmt = db.prepare("SELECT id, project_id, name, path, environment FROM profiles WHERE project_id = ?1 ORDER BY name COLLATE NOCASE, id").map_err(db_error)?;
        let items = stmt
            .query_map([project_id], profile_from_row)
            .map_err(db_error)?;
        items
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)
    }

    pub fn create_sqlite_profile(
        &self,
        project_id: &str,
        name: &str,
        path: &str,
        environment: &str,
    ) -> Result<Profile> {
        let name = valid_name(name)?;
        if !matches!(environment, "DEV" | "STAGING" | "PROD") {
            return Err("유효한 환경을 선택하세요.".into());
        }
        let path = std::fs::canonicalize(path.trim())
            .map_err(|e| format!("파일을 찾을 수 없습니다: {e}"))?;
        if !path.is_file() {
            return Err("데이터베이스 파일을 선택하세요.".into());
        }
        // Check that this is a readable SQLite file before persisting its definition.
        let db = open_user_db(&path)?;
        db.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
            .map_err(db_error)?;
        let profile = Profile {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            name: name.into(),
            path: path.to_string_lossy().into_owned(),
            environment: environment.into(),
        };
        self.connect()?.execute("INSERT INTO profiles (id, project_id, name, path, environment) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![profile.id, profile.project_id, profile.name, profile.path, profile.environment]).map_err(db_error)?;
        Ok(profile)
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        let changed = self
            .connect()?
            .execute("DELETE FROM profiles WHERE id = ?1", [id])
            .map_err(db_error)?;
        require_changed(changed, "연결을 찾을 수 없습니다.")
    }

    fn profile(&self, id: &str) -> Result<Profile> {
        self.connect()?
            .query_row(
                "SELECT id, project_id, name, path, environment FROM profiles WHERE id = ?1",
                [id],
                profile_from_row,
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "연결을 찾을 수 없습니다.".into())
    }

    pub fn objects(&self, profile_id: &str) -> Result<Vec<DatabaseObject>> {
        let db = open_user_db(Path::new(&self.profile(profile_id)?.path))?;
        let mut stmt = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name COLLATE NOCASE").map_err(db_error)?;
        let items = stmt
            .query_map([], |r| {
                Ok(DatabaseObject {
                    name: r.get(0)?,
                    kind: r.get(1)?,
                    ddl: r.get(2)?,
                })
            })
            .map_err(db_error)?;
        items
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)
    }

    /// Create a verified SQLite snapshot without modifying or replacing either
    /// the source database or an existing destination.
    pub fn backup_sqlite(&self, profile_id: &str, destination: &str) -> Result<BackupReport> {
        let profile = self.profile(profile_id)?;
        let destination = Path::new(destination.trim());
        if !destination.is_absolute() || destination.file_name().is_none() {
            return Err("새 백업 파일의 절대 경로를 지정하세요.".into());
        }
        let parent = destination
            .parent()
            .ok_or("백업 폴더를 찾을 수 없습니다.")?;
        if !parent.is_dir() {
            return Err("백업 폴더가 없거나 폴더에 접근할 수 없습니다.".into());
        }
        if destination.exists() {
            return Err("같은 이름의 파일이 이미 있습니다. 새 경로를 선택하세요.".into());
        }

        let source = open_user_db(Path::new(&profile.path))?;
        let temporary = tempfile::Builder::new()
            .prefix(".stackport-backup-")
            .tempfile_in(parent)
            .map_err(|e| format!("백업 임시 파일을 만들 수 없습니다: {e}"))?;
        {
            let mut target = Connection::open(temporary.path()).map_err(db_error)?;
            target
                .busy_timeout(Duration::from_secs(5))
                .map_err(db_error)?;
            {
                let backup = Backup::new(&source, &mut target).map_err(db_error)?;
                let mut last_remaining = None;
                let mut last_progress = Instant::now();
                loop {
                    let state = backup.step(128).map_err(db_error)?;
                    if state == StepResult::Done {
                        break;
                    }
                    let remaining = backup.progress().remaining;
                    if last_remaining != Some(remaining) {
                        last_remaining = Some(remaining);
                        last_progress = Instant::now();
                    } else if last_progress.elapsed() > Duration::from_secs(15) {
                        return Err(
                            "백업 진행이 중단되었습니다. 원본의 잠금 상태를 확인하세요.".into()
                        );
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            // A standalone backup must not depend on an adjacent WAL file.
            target
                .pragma_update(None, "journal_mode", "DELETE")
                .map_err(db_error)?;
            let mut check = target.prepare("PRAGMA integrity_check").map_err(db_error)?;
            let results = check
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(db_error)?;
            if results != ["ok"] {
                return Err(
                    "백업 무결성 검사에 실패했습니다. 백업 파일을 게시하지 않았습니다.".into(),
                );
            }
        }
        temporary
            .as_file()
            .sync_all()
            .map_err(|e| format!("백업을 디스크에 기록할 수 없습니다: {e}"))?;
        let size_bytes = temporary
            .as_file()
            .metadata()
            .map_err(|e| format!("백업 크기를 확인할 수 없습니다: {e}"))?
            .len();
        temporary.persist_noclobber(destination).map_err(|e| {
            format!(
                "백업을 저장할 수 없습니다. 기존 파일은 덮어쓰지 않습니다: {}",
                e.error
            )
        })?;
        Ok(BackupReport {
            path: destination.to_string_lossy().into_owned(),
            size_bytes,
            integrity: "ok",
        })
    }

    pub fn query(&self, profile_id: &str, sql: &str, page: u32) -> Result<QueryPage> {
        let db = open_user_db(Path::new(&self.profile(profile_id)?.path))?;
        let sql = sql.trim().trim_end_matches(';').trim_end();
        if sql.is_empty() {
            return Err("조회할 SQL을 입력하세요.".into());
        }
        // Prepare once before pagination so authorizer failures are reported
        // as read-only restrictions rather than a subquery syntax error.
        let original = db.prepare(sql).map_err(db_error)?;
        if !original.readonly() || original.column_count() == 0 {
            return Err(
                "이 연결에서는 결과를 반환하는 읽기 전용 쿼리만 실행할 수 있습니다.".into(),
            );
        }
        if original.parameter_count() != 0 {
            return Err("쿼리 매개변수는 아직 지원하지 않습니다.".into());
        }
        drop(original);
        // The subquery enforces a single result-producing statement and allows
        // bounded page retrieval without retaining earlier pages in memory.
        let offset = i64::from(page) * PAGE_SIZE as i64;
        let bounded_sql = format!(
            "SELECT * FROM (\n{sql}\n) LIMIT {} OFFSET {offset}",
            PAGE_SIZE + 1
        );
        let mut stmt = db.prepare(&bounded_sql).map_err(db_error)?;
        if !stmt.readonly() {
            return Err("이 연결에서는 읽기 전용 쿼리만 실행할 수 있습니다.".into());
        }
        if stmt.parameter_count() != 0 {
            return Err("쿼리 매개변수는 아직 지원하지 않습니다.".into());
        }
        let columns = stmt
            .column_names()
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let mut cursor = stmt.query([]).map_err(db_error)?;
        let mut rows = Vec::with_capacity(PAGE_SIZE + 1);
        while let Some(row) = cursor.next().map_err(db_error)? {
            let mut cells = Vec::with_capacity(row.as_ref().column_count());
            for index in 0..row.as_ref().column_count() {
                cells.push(display_value(row.get_ref(index).map_err(db_error)?));
            }
            rows.push(cells);
        }
        let has_more = rows.len() > PAGE_SIZE;
        if has_more {
            rows.pop();
        }
        Ok(QueryPage {
            columns,
            rows,
            page,
            has_more,
        })
    }
}

fn profile_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        path: r.get(3)?,
        environment: r.get(4)?,
    })
}

fn valid_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() {
        Err("이름을 입력하세요.".into())
    } else {
        Ok(name)
    }
}

fn require_changed(changed: usize, message: &str) -> Result<()> {
    if changed == 0 {
        Err(message.into())
    } else {
        Ok(())
    }
}

fn db_error(error: rusqlite::Error) -> String {
    match error {
        rusqlite::Error::SqlInputError { ref error, .. }
            if error.code == rusqlite::ErrorCode::AuthorizationForStatementDenied
                || error.code == rusqlite::ErrorCode::ReadOnly =>
        {
            "이 연결에서는 읽기 전용 쿼리만 실행할 수 있습니다.".into()
        }
        rusqlite::Error::SqlInputError { msg, .. } => format!("SQL 오류: {msg}"),
        rusqlite::Error::SqliteFailure(ref code, _)
            if code.code == rusqlite::ErrorCode::AuthorizationForStatementDenied
                || code.code == rusqlite::ErrorCode::ReadOnly =>
        {
            "이 연결에서는 읽기 전용 쿼리만 실행할 수 있습니다.".into()
        }
        other => format!("SQLite 오류: {other}"),
    }
}

fn open_user_db(path: &Path) -> Result<Connection> {
    // URI mode is deliberately not enabled; a filename cannot inject SQLite flags.
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(db_error)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
    db.pragma_update(None, "query_only", true)
        .map_err(db_error)?;
    db.pragma_update(None, "trusted_schema", false)
        .map_err(db_error)?;
    let started = Instant::now();
    db.progress_handler(
        10_000,
        Some(move || started.elapsed() > Duration::from_secs(10)),
    );
    db.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Select | AuthAction::Read { .. } | AuthAction::Recursive => {
            Authorization::Allow
        }
        AuthAction::Function { function_name }
            if !function_name.eq_ignore_ascii_case("load_extension") =>
        {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }));
    Ok(db)
}

fn display_value(value: ValueRef<'_>) -> Cell {
    let (kind, text) = match value {
        ValueRef::Null => ("null", "NULL".to_owned()),
        ValueRef::Integer(value) => ("integer", value.to_string()),
        ValueRef::Real(value) => ("real", value.to_string()),
        ValueRef::Text(value) => {
            // Avoid copying an entire large value just to render its preview.
            let text = String::from_utf8_lossy(value);
            let mut chars = text.chars();
            let display = chars.by_ref().take(CELL_MAX_CHARS).collect();
            return Cell {
                kind: "text",
                display,
                truncated: chars.next().is_some(),
            };
        }
        ValueRef::Blob(value) => ("blob", format!("[BLOB · {} bytes]", value.len())),
    };
    Cell {
        kind,
        display: text,
        truncated: false,
    }
}
