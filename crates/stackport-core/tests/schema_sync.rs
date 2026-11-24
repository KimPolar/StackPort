use rusqlite::Connection;
use stackport_core::Store;
use std::path::Path;

fn exists(db: &Connection, name: &str) -> bool {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1)",
        [name],
        |row| row.get(0),
    )
    .unwrap()
}

fn path(path: &Path) -> &str {
    path.to_str().unwrap()
}

#[test]
fn applies_a_reviewed_batch_with_backup_and_rolls_back_invalid_or_stale_changes() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.sqlite");
    let target = root.path().join("target.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(
        "CREATE TABLE base (value TEXT);
         CREATE TABLE added (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT UNIQUE);
         CREATE INDEX added_expr ON added(lower(value));
         CREATE TRIGGER added_note AFTER INSERT ON added BEGIN SELECT NEW.id; END;
         CREATE VIEW added_view AS SELECT value FROM added;
         CREATE VIEW refresh AS SELECT value FROM base WHERE value = 'other';
         CREATE TABLE dependency (id INTEGER PRIMARY KEY);
         CREATE TABLE requires_parent (id INTEGER REFERENCES dependency(id));",
    )
    .unwrap();
    drop(db);
    let db = Connection::open(&target).unwrap();
    db.execute_batch(
        "CREATE TABLE base (value TEXT);
         INSERT INTO base VALUES ('retain');
         CREATE VIEW refresh AS SELECT value FROM base WHERE value = 'retain';",
    )
    .unwrap();
    drop(db);
    let store = Store::open(root.path().join("manager.sqlite")).unwrap();
    let project = store.create_project("sync").unwrap();
    let left = store
        .create_sqlite_profile(&project.id, "reference", path(&source), "DEV")
        .unwrap();
    let right = store
        .create_sqlite_profile(&project.id, "target", path(&target), "PROD")
        .unwrap();
    let review = store
        .preview_schema_sync(
            &left.id,
            &right.id,
            &["added_view".into(), "refresh".into(), "added".into()],
        )
        .unwrap();
    assert!(review.requires_production_confirmation);
    assert!(
        review.sql.find("CREATE TABLE added").unwrap()
            < review.sql.find("CREATE VIEW added_view").unwrap()
    );
    let backup = root.path().join("before.sqlite");
    assert!(store
        .apply_schema_sync(&review.token, path(&backup), false, "PROD")
        .is_err());
    assert!(store
        .apply_schema_sync(&review.token, path(&backup), true, "DEV")
        .is_err());
    assert!(!backup.exists());
    let report = store
        .apply_schema_sync(&review.token, path(&backup), true, "PROD")
        .unwrap();
    assert_eq!(report.objects, 3);
    let db = Connection::open(&target).unwrap();
    assert!(exists(&db, "added_view"));
    assert!(exists(&db, "added_expr"));
    assert!(exists(&db, "added_note"));
    assert_eq!(
        db.query_row("SELECT count(*) FROM refresh", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT value FROM base", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "retain"
    );
    let snapshot = Connection::open(&backup).unwrap();
    assert!(!exists(&snapshot, "added"));
    assert_eq!(
        snapshot
            .query_row("SELECT count(*) FROM refresh", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(store
        .apply_schema_sync(&review.token, path(&backup), true, "PROD")
        .is_err());

    let stale = store
        .preview_schema_sync(&left.id, &right.id, &["requires_parent".into()])
        .unwrap();
    db.execute_batch("CREATE TABLE external_change (x);")
        .unwrap();
    let rejected = root.path().join("stale.sqlite");
    assert!(store
        .apply_schema_sync(&stale.token, path(&rejected), true, "PROD")
        .unwrap_err()
        .contains("대상 구조"));
    assert!(!rejected.exists());

    let invalid = store
        .preview_schema_sync(&left.id, &right.id, &["requires_parent".into()])
        .unwrap();
    let failed_backup = root.path().join("failed.sqlite");
    let error = store
        .apply_schema_sync(&invalid.token, path(&failed_backup), true, "PROD")
        .unwrap_err();
    assert!(error.contains("되돌렸습니다"), "{error}");
    assert!(failed_backup.exists());
    assert!(!exists(&db, "requires_parent"));
    assert!(!exists(
        &Connection::open(&source).unwrap(),
        "external_change"
    ));
    let audit = store.list_audit_events(None).unwrap();
    assert!(audit
        .events
        .iter()
        .any(|event| event.operation == "sqlite.schema.sync"
            && event.outcome == "succeeded"
            && event.affected_count == Some(3)));
}
