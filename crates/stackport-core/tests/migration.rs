use rusqlite::Connection;
use stackport_core::{ResumeLayout, ResumeTool, Store, WorkspaceResume};
use std::path::{Path, PathBuf};

fn create_v1(path: &Path, conflict: bool) {
    let db = Connection::open(path).unwrap();
    db.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE profiles (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL, path TEXT NOT NULL, environment TEXT NOT NULL);
        INSERT INTO projects VALUES ('project-1', '보존할 프로젝트');
        INSERT INTO profiles VALUES ('profile-1', 'project-1', '연결', 'C:/example.sqlite', 'DEV');
        PRAGMA user_version=1;").unwrap();
    if conflict {
        db.execute_batch("CREATE VIEW audit_events AS SELECT 1 AS value;")
            .unwrap();
    }
}

fn backups(directory: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.file_name().unwrap().to_string_lossy().contains(".v1-"))
        .collect()
}

fn create_v2(path: &Path, conflict: bool) {
    create_v1(path, false);
    let db = Connection::open(path).unwrap();
    db.execute_batch("CREATE TABLE audit_events (id TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), actor TEXT NOT NULL DEFAULT 'local', operation TEXT NOT NULL, project_id TEXT, profile_id TEXT, environment TEXT, object_name TEXT, outcome TEXT NOT NULL, policy TEXT NOT NULL DEFAULT 'local-workspace', affected_count INTEGER); INSERT INTO audit_events(id, correlation_id, operation, outcome) VALUES ('old-event', 'old-operation', 'project.create', 'succeeded'); PRAGMA user_version=2;").unwrap();
    if conflict {
        db.execute_batch("CREATE VIEW ssh_profiles AS SELECT 1 AS value;")
            .unwrap();
    }
}

fn v2_backups(directory: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.file_name().unwrap().to_string_lossy().contains(".v2-"))
        .collect()
}

fn create_v3(path: &Path, conflict: bool) {
    create_v2(path, false);
    let db = Connection::open(path).unwrap();
    db.execute_batch(
        "CREATE TABLE ssh_profiles (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL,
            environment TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
         INSERT INTO ssh_profiles VALUES ('ssh-1', 'project-1', 'saved SSH', 'server.example.com', 22, 'alice', 'PROD', 9);
         PRAGMA user_version=3;",
    ).unwrap();
    if conflict {
        db.execute_batch("CREATE VIEW project_archives AS SELECT 1 AS value;")
            .unwrap();
    }
}

fn v3_backup(directory: &Path) -> PathBuf {
    let mut backups = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.file_name().unwrap().to_string_lossy().contains(".v3-"));
    let backup = backups.next().expect("a pre-migration v3 backup");
    assert!(backups.next().is_none());
    backup
}

#[test]
fn migration_keeps_a_verified_v1_backup_and_preserves_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    create_v1(&path, false);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.list_projects().unwrap()[0].name, "보존할 프로젝트");
    assert_eq!(store.list_profiles("project-1").unwrap()[0].id, "profile-1");
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        18
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM audit_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let saved = backups(dir.path());
    assert_eq!(saved.len(), 1);
    let backup = Connection::open(&saved[0]).unwrap();
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        backup
            .query_row("SELECT name FROM projects", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "보존할 프로젝트"
    );
    assert_eq!(
        backup
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(db);
    Store::open(&path).unwrap();
    assert_eq!(
        backups(dir.path()).len(),
        1,
        "a current workspace must not make another migration backup"
    );
}

#[test]
fn version_two_migration_preserves_a_verified_backup_and_existing_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    create_v2(&path, false);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.list_profiles("project-1").unwrap()[0].id, "profile-1");
    assert_eq!(
        store.list_audit_events(None).unwrap().events[0].id,
        "old-event"
    );
    assert!(store.list_ssh_profiles("project-1").unwrap().is_empty());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        18
    );
    let saved = v2_backups(dir.path());
    assert_eq!(saved.len(), 1);
    let backup = Connection::open(&saved[0]).unwrap();
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        backup
            .query_row("SELECT id FROM audit_events", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "old-event"
    );
    assert_eq!(
        backup
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        backup
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='ssh_profiles'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn version_three_migration_preserves_ssh_and_adds_project_archives() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    create_v3(&path, false);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.list_projects().unwrap()[0].id, "project-1");
    let ssh = store.ssh_profile("ssh-1").unwrap();
    assert_eq!((ssh.revision, ssh.environment.as_str()), (9, "PROD"));
    assert_eq!(
        store.list_audit_events(None).unwrap().events[0].id,
        "old-event"
    );
    store.archive_project("project-1").unwrap();
    assert!(store.list_projects().unwrap().is_empty());
    assert_eq!(store.list_archived_projects().unwrap()[0].id, "project-1");
    let backup = Connection::open(v3_backup(directory.path())).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        backup
            .query_row(
                "SELECT revision FROM ssh_profiles WHERE id='ssh-1'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        9
    );
    assert_eq!(
        backup
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn failed_archive_migration_preserves_version_three_and_its_backup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    create_v3(&path, true);
    assert!(Store::open(&path).is_err());
    for file in [path, v3_backup(directory.path())] {
        let db = Connection::open(file).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            db.query_row(
                "SELECT revision FROM ssh_profiles WHERE id='ssh-1'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            9
        );
        assert_eq!(
            db.query_row(
                "SELECT type FROM sqlite_schema WHERE name='project_archives'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "view"
        );
    }
}

#[test]
fn version_four_migration_backs_up_the_previous_format_before_adding_resume() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    create_v3(&path, false);
    Connection::open(&path).unwrap().execute_batch(
        "CREATE TABLE project_archives (project_id TEXT PRIMARY KEY REFERENCES projects(id), archived_at TEXT NOT NULL);
         INSERT INTO project_archives VALUES ('project-1', '2026-11-20T00:00:00Z');
         PRAGMA user_version=4;",
    ).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.workspace_resume().unwrap().revision, 0);
    assert_eq!(store.list_archived_projects().unwrap()[0].id, "project-1");
    let backup_path = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.file_name().unwrap().to_string_lossy().contains(".v4-"))
        .unwrap();
    let backup = Connection::open(backup_path).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        4
    );
    assert_eq!(
        backup
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        backup
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='workspace_resume'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn version_five_migration_preserves_workspace_resume_and_creates_sftp_profiles() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("existing").unwrap();
    store.save_workspace_resume(0, WorkspaceResume {
        project_id: Some(project.id.clone()), profile_id: None, explorer_open: true,
        layout: ResumeLayout::Tool { tool: ResumeTool::Files },
    }).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE table_query_presets; DROP TABLE native_db_profiles; DROP TABLE mysql_profiles; DROP TABLE redis_profiles; DROP TABLE workspace_favorites; DROP TABLE postgres_profiles; DROP TABLE ssh_tunnels; DROP TABLE sql_templates; DROP TABLE sftp_sync_profiles; PRAGMA user_version=5;").unwrap();
    drop(db);

    let migrated = Store::open(&path).unwrap();
    let resume = migrated.workspace_resume().unwrap();
    assert_eq!(resume.revision, 1);
    assert_eq!(resume.state.unwrap().project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(migrated.list_projects().unwrap(), vec![project]);
    let db = Connection::open(&path).unwrap();
    assert_eq!(db.query_row("SELECT count(*) FROM sftp_sync_profiles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    let backup_path = std::fs::read_dir(directory.path()).unwrap().map(|entry| entry.unwrap().path())
        .find(|path| path.file_name().unwrap().to_string_lossy().contains(".v5-")).unwrap();
    let backup = Connection::open(backup_path).unwrap();
    assert_eq!(backup.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 5);
}

#[test]
fn version_six_migration_preserves_existing_tables_before_adding_templates() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("기존 프로젝트").unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE table_query_presets; DROP TABLE native_db_profiles; DROP TABLE mysql_profiles; DROP TABLE redis_profiles; DROP TABLE workspace_favorites; DROP TABLE postgres_profiles; DROP TABLE ssh_tunnels; DROP TABLE sql_templates; PRAGMA user_version=6;").unwrap();
    drop(db);
    let migrated = Store::open(&path).unwrap();
    assert_eq!(migrated.list_projects().unwrap(), vec![project.clone()]);
    assert!(migrated.list_sql_templates(&project.id).unwrap().is_empty());
    let backup_path = std::fs::read_dir(directory.path()).unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.file_name().unwrap().to_string_lossy().contains(".v6-")).unwrap();
    let backup = Connection::open(backup_path).unwrap();
    assert_eq!(backup.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 6);
    assert_eq!(backup.query_row("SELECT count(*) FROM sqlite_schema WHERE name = 'sftp_sync_profiles'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(backup.query_row("SELECT count(*) FROM sqlite_schema WHERE name = 'sql_templates'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn failed_version_two_migration_leaves_original_and_backup_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    create_v2(&path, true);
    assert!(Store::open(&path).is_err());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        db.query_row(
            "SELECT type FROM sqlite_schema WHERE name='ssh_profiles'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "view"
    );
    assert_eq!(
        db.query_row("SELECT id FROM audit_events", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "old-event"
    );
    let saved = v2_backups(dir.path());
    assert_eq!(saved.len(), 1);
    let backup = Connection::open(&saved[0]).unwrap();
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn failed_migration_preserves_original_and_verified_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    create_v1(&path, true);
    assert!(Store::open(&path).is_err());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row("SELECT name FROM projects", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "보존할 프로젝트"
    );
    assert_eq!(
        db.query_row(
            "SELECT type FROM sqlite_schema WHERE name='audit_events'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "view"
    );
    let saved = backups(dir.path());
    assert_eq!(saved.len(), 1);
    let backup = Connection::open(&saved[0]).unwrap();
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn nonempty_unversioned_database_is_not_initialized() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('keep')",
        )
        .unwrap();
    assert!(Store::open(&path).is_err());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM foreign_data", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn concurrent_initialization_does_not_clobber_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Store::open(path).map(|_| ())
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap().unwrap();
    }
    Store::open(path)
        .unwrap()
        .create_project("after race")
        .unwrap();
}

#[test]
fn concurrent_migrations_only_publish_version_one_backups() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    create_v1(&path, false);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Store::open(path).map(|_| ())
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap().unwrap();
    }
    let saved = backups(dir.path());
    assert!(!saved.is_empty());
    for path in saved {
        let backup = Connection::open(path).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    assert_eq!(
        Store::open(path).unwrap().list_projects().unwrap()[0].id,
        "project-1"
    );
}

#[test]
fn concurrent_version_two_migrations_keep_only_version_two_backups() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    create_v2(&path, false);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Store::open(path).map(|_| ())
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap().unwrap();
    }
    let saved = v2_backups(dir.path());
    assert!(!saved.is_empty());
    for path in saved {
        let backup = Connection::open(path).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    assert_eq!(
        Store::open(path)
            .unwrap()
            .list_audit_events(None)
            .unwrap()
            .events[0]
            .id,
        "old-event"
    );
}
