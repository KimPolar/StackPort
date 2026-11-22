use rusqlite::Connection;
use stackport_core::Store;
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
        2
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
        "v2 must not make another migration backup"
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
