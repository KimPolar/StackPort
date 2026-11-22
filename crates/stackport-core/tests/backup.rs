use rusqlite::Connection;
use stackport_core::Store;

#[test]
fn sqlite_backup_contains_wal_data_and_can_be_opened_independently() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let destination = directory.path().join("backup.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT);
        CREATE INDEX item_value ON items(value);
        INSERT INTO items (value) VALUES ('first'), ('둘째');",
    )
    .unwrap();
    assert!(directory.path().join("source.sqlite-wal").exists());

    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("backup test").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "source", source.to_str().unwrap(), "DEV")
        .unwrap();
    let report = store
        .backup_sqlite(&profile.id, destination.to_str().unwrap())
        .unwrap();
    assert_eq!(report.integrity, "ok");
    assert!(report.size_bytes > 0);
    assert!(!directory.path().join("backup.sqlite-wal").exists());

    // The backup is a standalone database and stays unchanged after the source
    // advances, including writes that have not yet been checkpointed from WAL.
    db.execute("INSERT INTO items(value) VALUES ('later')", [])
        .unwrap();
    let backup = Connection::open(&destination).unwrap();
    let values = backup
        .prepare("SELECT value FROM items ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(values, ["first", "둘째"]);
    let check: String = backup
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(check, "ok");
    let index: i64 = backup
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='item_value'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(index, 1);
}

#[test]
fn backup_never_overwrites_an_existing_file_or_the_source() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    Connection::open(&source)
        .unwrap()
        .execute_batch("CREATE TABLE keep (id INTEGER)")
        .unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("test").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "source", source.to_str().unwrap(), "DEV")
        .unwrap();
    let existing = directory.path().join("existing.sqlite");
    std::fs::write(&existing, b"do not replace").unwrap();
    assert!(store
        .backup_sqlite(&profile.id, existing.to_str().unwrap())
        .is_err());
    assert_eq!(std::fs::read(&existing).unwrap(), b"do not replace");
    assert!(store
        .backup_sqlite(&profile.id, source.to_str().unwrap())
        .is_err());
    assert!(store.backup_sqlite(&profile.id, "relative.sqlite").is_err());
    let source_db = Connection::open(&source).unwrap();
    assert_eq!(
        source_db
            .query_row("SELECT count(*) FROM keep", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn failed_backup_does_not_publish_a_partial_database() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    Connection::open(&source)
        .unwrap()
        .execute_batch("CREATE TABLE items (id INTEGER)")
        .unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("test").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "source", source.to_str().unwrap(), "DEV")
        .unwrap();
    std::fs::write(&source, b"not a database").unwrap();
    let target = directory.path().join("backup.sqlite");
    assert!(store
        .backup_sqlite(&profile.id, target.to_str().unwrap())
        .is_err());
    assert!(!target.exists());
    assert!(!std::fs::read_dir(directory.path())
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".stackport-backup-")));
}
