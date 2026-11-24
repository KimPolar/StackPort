use rusqlite::Connection;
use sha2::{Digest, Sha256};
use stackport_core::Store;
use std::{fs, path::Path};

fn path(path: &Path) -> &str {
    path.to_str().unwrap()
}

#[test]
fn restores_reviewed_backup_and_verifies_it_independently() {
    let directory = tempfile::tempdir().unwrap();
    let original = directory.path().join("original.sqlite");
    let db = Connection::open(&original).unwrap();
    db.execute_batch(
        r#"PRAGMA journal_mode=WAL;
           PRAGMA user_version=42;
           CREATE TABLE "odd""name" (id INTEGER PRIMARY KEY, label TEXT);
           CREATE INDEX labels ON "odd""name"(label);
           CREATE VIEW rows_view AS SELECT label FROM "odd""name";
           INSERT INTO "odd""name" (label) VALUES ('prior A'), ('prior B');"#,
    )
    .unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("restore").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "source", path(&original), "DEV")
        .unwrap();
    let backup = directory.path().join("snapshot.sqlite");
    let restore = directory.path().join("restored.sqlite");
    store.backup_sqlite(&profile.id, path(&backup)).unwrap();
    db.execute(
        r#"INSERT INTO "odd""name" (label) VALUES ('subsequent')"#,
        [],
    )
    .unwrap();
    let backup_bytes = fs::read(&backup).unwrap();
    let expected_hash = format!("{:x}", Sha256::digest(&backup_bytes));

    let preview = store
        .preview_sqlite_restore(&project.id, path(&backup), path(&restore))
        .unwrap();
    assert!(!restore.exists());
    assert_eq!(
        (
            preview.user_version,
            preview.objects,
            preview.tables,
            preview.rows
        ),
        (42, 3, 1, 2)
    );
    assert_eq!(preview.sha256, expected_hash);
    assert!(store.restore_sqlite(&preview.token, false).is_err());
    let report = store.restore_sqlite(&preview.token, true).unwrap();
    assert_eq!(
        (report.objects, report.tables, report.rows, report.integrity),
        (3, 1, 2, "ok")
    );
    assert_eq!(report.sha256, expected_hash);
    assert_eq!(fs::read(&restore).unwrap(), backup_bytes);
    assert_eq!(fs::read(&backup).unwrap(), backup_bytes);
    assert!(store.restore_sqlite(&preview.token, true).is_err());

    let restored_db = Connection::open(&restore).unwrap();
    assert_eq!(
        restored_db
            .query_row("SELECT count(*) FROM rows_view", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM rows_view", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert!(restored_db
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE name = 'labels'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .is_ok());
    let events = store.list_audit_events(None).unwrap().events;
    let restores: Vec<_> = events
        .iter()
        .filter(|e| e.operation == "sqlite.restore")
        .collect();
    assert_eq!(
        restores
            .iter()
            .map(|e| e.outcome.as_str())
            .collect::<Vec<_>>(),
        ["succeeded", "started"]
    );
    let serialized = serde_json::to_string(&restores).unwrap();
    for private in [
        "original.sqlite",
        "snapshot.sqlite",
        "restored.sqlite",
        "prior A",
        &expected_hash,
    ] {
        assert!(!serialized.contains(private));
    }
}

#[test]
fn rejects_changed_source_existing_destinations_and_sidecars() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("backup.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("CREATE TABLE people (id INTEGER); INSERT INTO people VALUES (1);")
        .unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("restore").unwrap();
    let destination = directory.path().join("restore.sqlite");
    let preview = || store.preview_sqlite_restore(&project.id, path(&source), path(&destination));

    let reviewed = preview().unwrap();
    db.execute("UPDATE people SET id=2", []).unwrap();
    assert!(store
        .restore_sqlite(&reviewed.token, true)
        .unwrap_err()
        .contains("바뀌었습니다"));
    assert!(!destination.exists());
    let reviewed = preview().unwrap();
    fs::write(&destination, b"keep this file").unwrap();
    assert!(store
        .restore_sqlite(&reviewed.token, true)
        .unwrap_err()
        .contains("이미 있습니다"));
    assert_eq!(fs::read(&destination).unwrap(), b"keep this file");
    fs::remove_file(&destination).unwrap();

    let sidecar = directory.path().join("restore.sqlite-wal");
    fs::write(&sidecar, b"preserve this sidecar").unwrap();
    assert!(preview().unwrap_err().contains("보조 파일"));
    fs::remove_file(sidecar).unwrap();

    db.execute_batch("PRAGMA journal_mode=WAL; INSERT INTO people VALUES (3);")
        .unwrap();
    assert!(preview().unwrap_err().contains("보조 파일"));
    let invalid = directory.path().join("invalid.sqlite");
    fs::write(&invalid, vec![b'x'; 500]).unwrap();
    assert!(store
        .preview_sqlite_restore(&project.id, path(&invalid), path(&destination))
        .unwrap_err()
        .contains("백업"));
    assert!(!destination.exists());
    assert!(!fs::read_dir(directory.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".stackport-restore-")));
}
