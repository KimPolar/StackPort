//! Local workspace metadata and the first database adapter.
//!
//! The metadata database and user databases are deliberately separate. General
//! queries use read-only connections and an SQLite authorizer. Controlled cell
//! updates use a separate previewed, audited transaction.

mod result_export;
pub use result_export::{CsvOptions, ExportQuery, ExportReport};
pub use result_export::{ExportQuery as CsvQuery, ExportReport as CsvReport};
mod edit;
pub use edit::{EditField, EditInput, EditKey, EditPreview, EditResult, EditSession};
mod network;
pub use network::{NetworkDiagnostics, NetworkManager};
mod network_tools;
pub use network_tools::{RouteDiagnostic, RouteFamily, RouteTool};
mod web_check;
pub use web_check::{WebDiagnostic, WebMethod, WebResponse, WebSample};
mod ports;
pub use ports::{local_ports, LocalPort, PortEndpoint, PortSnapshot};
mod project_lifecycle;
pub use project_lifecycle::ArchivedProject;
mod query;
pub use query::{QueryOutcome, SqlParameterValue};
mod rdp;
pub use rdp::{RdpAvailability, RdpManager, RdpRequest, RdpSession};
mod restore;
pub use restore::{RestorePreview, RestoreReport};
mod table_query;
pub use table_query::TableQuery;
mod schema_diagram;
pub use schema_diagram::{DiagramColumn, DiagramTable};
mod schema_document;
pub use schema_document::{SchemaDocumentFormat, SchemaDocumentReport};
mod ssh;
pub use ssh::{SshAuthentication, SshHostInfo, SshKeyInfo, SshManager, SshTrustEvent, SshTrustPage};
mod ssh_profiles;
pub use ssh_profiles::{SshProfile, SshProfileInput};
mod ssh_exchange;
pub use ssh_exchange::{SshProfileExportReport, SshProfileImportPreview};
mod sftp;
pub use sftp::{
    list_local_directory, list_local_tree, preview_local_file, save_merged_text, BrowseDirectory, ComparedFile, FileContentComparison, FilePreview, FolderTree, RemotePath,
    SftpAuthentication, SftpDeletePreview, SftpEditDocument, SftpEditSave, SftpEntrySource,
    SftpManager, SftpMutationReport, SftpOpened,
    SftpPermissionChange,
    SftpTransferProgress, SftpTransferReport,
    SavedSyncProfile, SyncPlan, SyncProfileInput, SyncProgress, SyncReport,
    SyncDeleteInput, SyncDeletePreview,
};
mod terminal;
pub use terminal::{TerminalExit, TerminalInfo, TerminalManager, TerminalRead};
mod terminal_output;
pub use terminal_output::{save_terminal_output, TerminalOutputFormat};
mod local_file;
mod sql_file;
pub use sql_file::{open_sql_file, save_sql_file, SqlDocument};
mod sql_statement;
mod sql_completion;
pub use sql_completion::SqlCompletionCatalog;
mod sql_diagnostics;
pub use sql_diagnostics::SqlDiagnostics;
mod sql_refactor;
mod sql_templates;
pub use sql_templates::{SqlTemplate, SqlTemplateInput, SqlTemplateSummary, SqlTemplateWrite};
pub use sql_statement::sqlite_statement_at;
mod text_draft;
pub use text_draft::{save_text_draft, TextLineEnding};
mod workspace_copy;
pub use workspace_copy::{WorkspaceCopyPreview, WorkspaceCopyReport};
mod workspace_resume;
pub use workspace_resume::{
    ResumeDirection, ResumeLayout, ResumeTool, WorkspaceResume, WorkspaceResumeRecord,
    WorkspaceResumeWrite,
};
#[cfg(windows)]
mod windows_system;

use rusqlite::{
    backup::{Backup, StepResult},
    hooks::{AuthAction, AuthContext, Authorization},
    params,
    types::ValueRef,
    Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
const SCHEMA_VERSION: i64 = 7;
pub const PAGE_SIZE: usize = 100;
const CELL_MAX_CHARS: usize = 4096;
const AUDIT_SCHEMA: &str = "CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    correlation_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actor TEXT NOT NULL DEFAULT 'local',
    operation TEXT NOT NULL,
    project_id TEXT,
    profile_id TEXT,
    environment TEXT,
    object_name TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('started', 'succeeded', 'failed')),
    policy TEXT NOT NULL DEFAULT 'local-workspace',
    affected_count INTEGER
);";
const SSH_PROFILE_SCHEMA: &str = "CREATE TABLE ssh_profiles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
    username TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment IN ('DEV', 'STAGING', 'PROD')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
);";
const PROJECT_ARCHIVE_SCHEMA: &str = "CREATE TABLE project_archives (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);";

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
pub struct ColumnInfo {
    pub position: i64,
    pub name: String,
    pub declared_type: String,
    pub not_null: bool,
    pub default_value: Option<String>,
    pub primary_key_position: i64,
    pub hidden: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexColumn {
    pub position: i64,
    pub name: Option<String>,
    pub descending: bool,
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    pub origin: String,
    pub partial: bool,
    pub columns: Vec<IndexColumn>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForeignKeyInfo {
    pub id: i64,
    pub sequence: i64,
    pub target_table: String,
    pub from_column: String,
    pub to_column: Option<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObjectDetails {
    pub object: DatabaseObject,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Cell {
    pub kind: &'static str,
    pub display: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryMetrics {
    pub elapsed_micros: u64,
    pub rows_read: usize,
    pub fullscan_steps: Option<u32>,
    pub sort_operations: Option<u32>,
    pub autoindex_rows: Option<u32>,
    pub vm_steps: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryPage {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
    pub page: u32,
    pub has_more: bool,
    pub metrics: QueryMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_sql: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupReport {
    pub path: String,
    pub size_bytes: u64,
    pub integrity: &'static str,
    pub audit_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditEvent {
    pub sequence: i64,
    pub id: String,
    pub correlation_id: String,
    pub occurred_at: String,
    pub actor: String,
    pub operation: String,
    pub project_id: Option<String>,
    pub profile_id: Option<String>,
    pub environment: Option<String>,
    pub object_name: Option<String>,
    pub outcome: String,
    pub policy: String,
    pub affected_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditPage {
    pub events: Vec<AuditEvent>,
    pub next_cursor: Option<i64>,
}

struct AuditRecord<'a> {
    correlation_id: &'a str,
    operation: &'static str,
    project_id: Option<&'a str>,
    profile_id: Option<&'a str>,
    environment: Option<&'a str>,
    object_name: Option<&'a str>,
    outcome: &'static str,
    affected_count: Option<i64>,
}

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
    edits: Arc<edit::EditManager>,
    queries: Arc<query::QueryManager>,
    restore: Arc<restore::RestoreManager>,
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
            edits: Arc::new(edit::EditManager::default()),
            queries: Arc::new(query::QueryManager::default()),
            restore: Arc::new(restore::RestoreManager::default()),
        };
        let mut db = store.connect()?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(db_error)?;
        if !(0..=SCHEMA_VERSION).contains(&version) {
            return Err(format!(
                "지원하지 않는 작업 공간 형식입니다 (버전 {version})."
            ));
        }
        // An older workspace is copied before changing its schema. The
        // backup has a unique name and can never overwrite an earlier copy.
        if (1..SCHEMA_VERSION).contains(&version) {
            let absolute = std::fs::canonicalize(&store.path)
                .map_err(|e| format!("작업 공간 경로를 확인할 수 없습니다: {e}"))?;
            let directory = absolute
                .parent()
                .ok_or("작업 공간 폴더를 찾을 수 없습니다.")?;
            let filename = absolute
                .file_name()
                .ok_or("작업 공간 파일 이름이 없습니다.")?
                .to_string_lossy();
            let backup = directory.join(format!(
                "{filename}.v{version}-{}.backup.sqlite",
                Uuid::new_v4()
            ));
            if let Err(error) = snapshot_sqlite(&db, &backup, Some(version)) {
                // Another instance may have completed the migration while this
                // instance was creating its snapshot. Do not publish a newer
                // database under a misleading older backup name.
                let current: i64 = db
                    .pragma_query_value(None, "user_version", |r| r.get(0))
                    .map_err(db_error)?;
                if current == SCHEMA_VERSION {
                    return Ok(store);
                }
                return Err(format!(
                    "이관 전 백업에 실패하여 원본을 변경하지 않았습니다: {error}"
                ));
            }
        }
        if version == 0 {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let current: i64 = tx
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .map_err(db_error)?;
            if current == 0 {
                let objects: i64 = tx.query_row("SELECT count(*) FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_' COLLATE NOCASE", [], |r| r.get(0)).map_err(db_error)?;
                if objects != 0 {
                    return Err(
                        "초기화되지 않은 비어 있지 않은 작업 공간 파일입니다. 원본을 보존했습니다."
                            .into(),
                    );
                }
                tx.execute_batch(
                    "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
                 CREATE TABLE profiles (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL,
                    environment TEXT NOT NULL CHECK(environment IN ('DEV', 'STAGING', 'PROD'))
                 );",
                )
                .map_err(db_error)?;
                tx.execute_batch(AUDIT_SCHEMA).map_err(db_error)?;
                tx.execute_batch(SSH_PROFILE_SCHEMA).map_err(db_error)?;
                tx.execute_batch(PROJECT_ARCHIVE_SCHEMA).map_err(db_error)?;
                tx.execute_batch(workspace_resume::SCHEMA).map_err(db_error)?;
                tx.execute_batch(sftp::SYNC_PROFILE_SCHEMA).map_err(db_error)?;
                tx.execute_batch(sql_templates::SCHEMA).map_err(db_error)?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)
                    .map_err(db_error)?;
            } else if current != SCHEMA_VERSION {
                return Err(format!(
                    "다른 프로세스가 작업 공간 형식을 변경했습니다 (버전 {current})."
                ));
            }
            tx.commit().map_err(db_error)?;
        } else if (1..SCHEMA_VERSION).contains(&version) {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let current: i64 = tx
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .map_err(db_error)?;
            if current == version {
                if current == 1 {
                    tx.execute_batch(AUDIT_SCHEMA).map_err(db_error)?;
                }
                if current < 3 {
                    tx.execute_batch(SSH_PROFILE_SCHEMA).map_err(db_error)?;
                }
                if current < 4 {
                    tx.execute_batch(PROJECT_ARCHIVE_SCHEMA).map_err(db_error)?;
                }
                if current < 5 {
                    tx.execute_batch(workspace_resume::SCHEMA).map_err(db_error)?;
                }
                if current < 6 {
                    tx.execute_batch(sftp::SYNC_PROFILE_SCHEMA).map_err(db_error)?;
                }
                tx.execute_batch(sql_templates::SCHEMA).map_err(db_error)?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)
                    .map_err(db_error)?;
            } else if current != SCHEMA_VERSION {
                return Err(format!(
                    "다른 프로세스가 작업 공간 형식을 변경했습니다 (버전 {current})."
                ));
            }
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
            .prepare("SELECT id, name FROM projects
                      WHERE NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id = projects.id)
                      ORDER BY name COLLATE NOCASE, id")
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
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        tx.execute(
            "INSERT INTO projects (id, name) VALUES (?1, ?2)",
            params![project.id, project.name],
        )
        .map_err(db_error)?;
        insert_audit(
            &tx,
            AuditRecord {
                correlation_id: &Uuid::new_v4().to_string(),
                operation: "project.create",
                project_id: Some(&project.id),
                profile_id: None,
                environment: None,
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(1),
            },
        )?;
        tx.commit().map_err(db_error)?;
        Ok(project)
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        let changed = tx
            .execute(
                "UPDATE projects SET name = ?1 WHERE id = ?2",
                params![valid_name(name)?, id],
            )
            .map_err(db_error)?;
        require_changed(changed, "프로젝트를 찾을 수 없습니다.")?;
        insert_audit(
            &tx,
            AuditRecord {
                correlation_id: &Uuid::new_v4().to_string(),
                operation: "project.rename",
                project_id: Some(id),
                profile_id: None,
                environment: None,
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(1),
            },
        )?;
        tx.commit().map_err(db_error)
    }

    pub fn delete_project(&self, id: &str) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        let profiles: i64 = tx
            .query_row(
                "SELECT count(*) FROM profiles WHERE project_id = ?1",
                [id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let ssh_profiles: i64 = tx
            .query_row(
                "SELECT count(*) FROM ssh_profiles WHERE project_id = ?1",
                [id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let changed = tx
            .execute("DELETE FROM projects WHERE id = ?1", [id])
            .map_err(db_error)?;
        require_changed(changed, "프로젝트를 찾을 수 없습니다.")?;
        insert_audit(
            &tx,
            AuditRecord {
                correlation_id: &Uuid::new_v4().to_string(),
                operation: "project.delete",
                project_id: Some(id),
                profile_id: None,
                environment: None,
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(profiles + ssh_profiles + 1),
            },
        )?;
        tx.commit().map_err(db_error)
    }

    pub fn list_profiles(&self, project_id: &str) -> Result<Vec<Profile>> {
        Self::list_profiles_on(&self.connect()?, project_id)
    }

    fn list_profiles_on(db: &Connection, project_id: &str) -> Result<Vec<Profile>> {
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
        let mut metadata = self.connect()?;
        let tx = metadata.transaction().map_err(db_error)?;
        tx.execute("INSERT INTO profiles (id, project_id, name, path, environment) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![profile.id, profile.project_id, profile.name, profile.path, profile.environment]).map_err(db_error)?;
        insert_audit(
            &tx,
            AuditRecord {
                correlation_id: &Uuid::new_v4().to_string(),
                operation: "sqlite_profile.create",
                project_id: Some(&profile.project_id),
                profile_id: Some(&profile.id),
                environment: Some(&profile.environment),
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(1),
            },
        )?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        let profile = tx
            .query_row(
                "SELECT id, project_id, name, path, environment FROM profiles WHERE id = ?1",
                [id],
                profile_from_row,
            )
            .optional()
            .map_err(db_error)?
            .ok_or("연결을 찾을 수 없습니다.")?;
        let changed = tx
            .execute("DELETE FROM profiles WHERE id = ?1", [id])
            .map_err(db_error)?;
        require_changed(changed, "연결을 찾을 수 없습니다.")?;
        insert_audit(
            &tx,
            AuditRecord {
                correlation_id: &Uuid::new_v4().to_string(),
                operation: "sqlite_profile.delete",
                project_id: Some(&profile.project_id),
                profile_id: Some(id),
                environment: Some(&profile.environment),
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(1),
            },
        )?;
        tx.commit().map_err(db_error)
    }

    pub fn list_audit_events(&self, before: Option<i64>) -> Result<AuditPage> {
        if before.is_some_and(|cursor| cursor <= 0) {
            return Err("유효하지 않은 기록 위치입니다.".into());
        }
        let db = self.connect()?;
        let mut statement = db.prepare("SELECT rowid, id, correlation_id, occurred_at, actor, operation, project_id, profile_id, environment, object_name, outcome, policy, affected_count FROM audit_events WHERE (?1 IS NULL OR rowid < ?1) ORDER BY rowid DESC LIMIT ?2").map_err(db_error)?;
        let mut events = statement
            .query_map(params![before, (PAGE_SIZE + 1) as i64], |row| {
                Ok(AuditEvent {
                    sequence: row.get(0)?,
                    id: row.get(1)?,
                    correlation_id: row.get(2)?,
                    occurred_at: row.get(3)?,
                    actor: row.get(4)?,
                    operation: row.get(5)?,
                    project_id: row.get(6)?,
                    profile_id: row.get(7)?,
                    environment: row.get(8)?,
                    object_name: row.get(9)?,
                    outcome: row.get(10)?,
                    policy: row.get(11)?,
                    affected_count: row.get(12)?,
                })
            })
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        let next_cursor = if events.len() > PAGE_SIZE {
            events.pop();
            events.last().map(|event| event.sequence)
        } else {
            None
        };
        Ok(AuditPage {
            events,
            next_cursor,
        })
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
        let mut stmt = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND substr(name, 1, 7) <> 'sqlite_' COLLATE NOCASE ORDER BY type, name COLLATE NOCASE").map_err(db_error)?;
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

    /// Read schema metadata using fixed, parameterized introspection queries.
    /// General user queries never receive these PRAGMA permissions.
    pub fn describe_object(&self, profile_id: &str, name: &str) -> Result<ObjectDetails> {
        let db = open_schema_db(Path::new(&self.profile(profile_id)?.path))?;
        Self::describe_object_on(&db, name)
    }

    fn schema_object_names(db: &Connection, include_views: bool, name: Option<&str>, limit: usize) -> Result<Vec<String>> {
        let mut statement = db.prepare(
            "SELECT name FROM pragma_table_list
             WHERE schema = 'main' AND (type IN ('table', 'virtual') OR (?1 AND type = 'view'))
               AND substr(name, 1, 7) <> 'sqlite_' COLLATE NOCASE
               AND (?2 IS NULL OR name = ?2 COLLATE NOCASE)
             ORDER BY name COLLATE NOCASE LIMIT ?3",
        ).map_err(db_error)?;
        let names = statement
            .query_map(rusqlite::params![include_views, name, limit], |row| row.get(0))
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        Ok(names)
    }

    fn describe_object_on(db: &Connection, name: &str) -> Result<ObjectDetails> {
        let object = Self::read_object(db, name)?;
        let name = object.name.as_str();
        let columns = Self::object_columns(db, name)?;

        let mut statement = db
            .prepare(
                "SELECT name, \"unique\", origin, partial FROM pragma_index_list(?1) ORDER BY name",
            )
            .map_err(db_error)?;
        let mut indexes = statement
            .query_map([name], |row| {
                Ok(IndexInfo {
                    name: row.get(0)?,
                    unique: row.get(1)?,
                    origin: row.get(2)?,
                    partial: row.get(3)?,
                    columns: Vec::new(),
                })
            })
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        for index in &mut indexes {
            let mut fields = db.prepare(
                "SELECT seqno, name, \"desc\", coll FROM pragma_index_xinfo(?1) WHERE \"key\" = 1 ORDER BY seqno",
            ).map_err(db_error)?;
            index.columns = fields
                .query_map([&index.name], |row| {
                    Ok(IndexColumn {
                        position: row.get(0)?,
                        name: row.get(1)?,
                        descending: row.get(2)?,
                        collation: row.get(3)?,
                    })
                })
                .map_err(db_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(db_error)?;
        }

        let foreign_keys = Self::object_foreign_keys(db, name, i64::MAX)?;
        Ok(ObjectDetails {
            object,
            columns,
            indexes,
            foreign_keys,
        })
    }

    fn object_foreign_keys(db: &Connection, name: &str, limit: i64) -> Result<Vec<ForeignKeyInfo>> {
        let mut statement = db.prepare_cached(
            "SELECT id, seq, \"table\", \"from\", \"to\", on_update, on_delete
             FROM pragma_foreign_key_list(?1, 'main') ORDER BY id, seq LIMIT ?2",
        ).map_err(db_error)?;
        let keys = statement
            .query_map(rusqlite::params![name, limit], |row| {
                Ok(ForeignKeyInfo {
                    id: row.get(0)?,
                    sequence: row.get(1)?,
                    target_table: row.get(2)?,
                    from_column: row.get(3)?,
                    to_column: row.get(4)?,
                    on_update: row.get(5)?,
                    on_delete: row.get(6)?,
                })
            })
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        Ok(keys)
    }

    fn read_object(db: &Connection, name: &str) -> Result<DatabaseObject> {
        db.query_row(
            "SELECT name, type, sql FROM sqlite_schema WHERE name = ?1 COLLATE NOCASE AND type IN ('table', 'view') AND substr(name, 1, 7) <> 'sqlite_' COLLATE NOCASE",
            [name],
            |row| Ok(DatabaseObject { name: row.get(0)?, kind: row.get(1)?, ddl: row.get(2)? }),
        ).optional().map_err(db_error)?.ok_or_else(|| "테이블 또는 뷰를 찾을 수 없습니다.".into())
    }

    fn object_columns(db: &Connection, name: &str) -> Result<Vec<ColumnInfo>> {
        let mut statement = db.prepare(
            "SELECT cid, name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?1) ORDER BY cid",
        ).map_err(db_error)?;
        let columns = statement
            .query_map([name], |row| {
                Ok(ColumnInfo {
                    position: row.get(0)?,
                    name: row.get(1)?,
                    declared_type: row.get(2)?,
                    not_null: row.get(3)?,
                    default_value: row.get(4)?,
                    primary_key_position: row.get(5)?,
                    hidden: row.get(6)?,
                })
            })
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        Ok(columns)
    }

    /// Create a verified SQLite snapshot without modifying or replacing either
    /// the source database or an existing destination.
    pub fn backup_sqlite(&self, profile_id: &str, destination: &str) -> Result<BackupReport> {
        let profile = self.profile(profile_id)?;
        let correlation_id = Uuid::new_v4().to_string();
        let audit = |outcome, affected_count| AuditRecord {
            correlation_id: &correlation_id,
            operation: "sqlite.backup",
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(&profile.environment),
            object_name: None,
            outcome,
            affected_count,
        };
        insert_audit(&self.connect()?, audit("started", None))?;
        let result = open_user_db(Path::new(&profile.path))
            .and_then(|source| snapshot_sqlite(&source, Path::new(destination.trim()), None));
        let outcome = if result.is_ok() {
            "succeeded"
        } else {
            "failed"
        };
        let audit_result = self
            .connect()
            .and_then(|db| insert_audit(&db, audit(outcome, result.as_ref().ok().map(|_| 1))));
        match (result, audit_result) {
            (Ok(mut report), Err(_)) => {
                report.audit_warning =
                    Some("백업은 생성됐지만 완료 감사 기록을 저장하지 못했습니다.".into());
                Ok(report)
            }
            (Err(error), Err(_)) => Err(format!("{error} 완료 감사 기록도 저장하지 못했습니다.")),
            (result, Ok(())) => result,
        }
    }
}

fn insert_audit(db: &Connection, record: AuditRecord<'_>) -> Result<()> {
    let policy = match record.operation {
        "sqlite.backup" => "sqlite-snapshot-no-overwrite",
        "sqlite.restore" => "sqlite-verified-restore-no-overwrite",
        "sqlite.export.csv" => "sqlite-readonly-csv-no-overwrite",
        "sqlite.export.json" => "sqlite-readonly-json-no-overwrite",
        "sqlite.schema.export" => "sqlite-readonly-schema-no-overwrite",
        "project.duplicate" => "local-project-metadata-only",
        "workspace.copy" => "local-verified-copy-no-overwrite",
        "sftp.download" | "sftp.download.cancel" => "sftp-pinned-host-local-no-overwrite",
        "sftp.upload" | "sftp.upload.cancel" => "sftp-pinned-host-verified-remote-no-overwrite",
        "sftp.mkdir" => "sftp-pinned-host-new-directory",
        "sftp.sync" | "sftp.sync.cancel" => "sftp-pinned-host-sync-verified-plan",
        "sftp.sync.delete" | "sftp.sync.delete.cancel" => "sftp-pinned-host-sync-mirror-delete-confirmed",
        "sftp.rename" => "sftp-pinned-host-rename-no-overwrite",
        "sftp.chmod" | "sftp.chown" => "sftp-pinned-host-attributes-verified",
        "sftp.move" => "sftp-pinned-host-move-no-overwrite",
        "sftp.copy" | "sftp.copy.cancel" => "sftp-pinned-host-verified-copy-no-overwrite",
        "sftp.delete" if record.environment == Some("PROD") => "sftp-delete-preview-prod-required",
        "sftp.delete" => "sftp-delete-preview-single-item",
        "sftp.edit" | "sftp.edit.cancel" => "sftp-edit-hash-verified-posix-replace",
        "sftp.edit.copy" | "sftp.edit.copy.cancel" => "sftp-edit-copy-no-overwrite",
        "sqlite.cell.update" if record.environment == Some("PROD") => {
            "sqlite-cell-update-prod-confirmed"
        }
        "sqlite.cell.update" => "sqlite-cell-update-confirmed",
        _ => "local-workspace",
    };
    db.execute("INSERT INTO audit_events (id, correlation_id, operation, project_id, profile_id, environment, object_name, outcome, policy, affected_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![Uuid::new_v4().to_string(), record.correlation_id, record.operation, record.project_id, record.profile_id, record.environment, record.object_name, record.outcome, policy, record.affected_count]).map_err(db_error)?;
    Ok(())
}

fn snapshot_sqlite(
    source: &Connection,
    destination: &Path,
    expected_version: Option<i64>,
) -> Result<BackupReport> {
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
            let backup = Backup::new(source, &mut target).map_err(db_error)?;
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
                    return Err("백업 진행이 중단되었습니다. 원본의 잠금 상태를 확인하세요.".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        target
            .pragma_update(None, "journal_mode", "DELETE")
            .map_err(db_error)?;
        if let Some(expected) = expected_version {
            let actual: i64 = target
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .map_err(db_error)?;
            if actual != expected {
                return Err(format!(
                    "백업 중 작업 공간 버전이 변경되었습니다 (버전 {actual})."
                ));
            }
        }
        let mut check = target.prepare("PRAGMA integrity_check").map_err(db_error)?;
        let results = check
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        if results != ["ok"] {
            return Err("백업 무결성 검사에 실패했습니다. 백업 파일을 게시하지 않았습니다.".into());
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
        audit_warning: None,
    })
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

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
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
    open_user_db_with_schema_access(path, false)
}

fn open_schema_db(path: &Path) -> Result<Connection> {
    open_user_db_with_schema_access(path, true)
}

fn open_user_db_with_schema_access(path: &Path, allow_schema_pragmas: bool) -> Result<Connection> {
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
    if allow_schema_pragmas {
        // Keep all schema queries on one read snapshot even if another process
        // changes the database while the details are being assembled.
        db.execute_batch("BEGIN DEFERRED").map_err(db_error)?;
    }
    let started = Instant::now();
    db.progress_handler(
        10_000,
        Some(move || started.elapsed() > Duration::from_secs(10)),
    );
    set_read_authorizer(&db, allow_schema_pragmas);
    Ok(db)
}

fn set_read_authorizer(db: &Connection, allow_schema_pragmas: bool) {
    db.authorizer(Some(move |ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Select | AuthAction::Read { .. } | AuthAction::Recursive => {
            Authorization::Allow
        }
        AuthAction::Pragma { pragma_name, .. }
            if allow_schema_pragmas
                && matches!(
                    pragma_name,
                    "table_xinfo"
                        | "function_list"
                        | "index_list"
                        | "index_xinfo"
                        | "foreign_key_list"
                        | "table_list"
                        | "schema_version"
                ) =>
        {
            Authorization::Allow
        }
        AuthAction::Function { function_name }
            if !function_name.eq_ignore_ascii_case("load_extension") =>
        {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }));
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
