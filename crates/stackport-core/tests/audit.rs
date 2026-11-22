use rusqlite::Connection;
use stackport_core::Store;

#[test]
fn workspace_changes_and_backups_record_metadata_without_data_or_sql() {
    let dir = tempfile::tempdir().unwrap();
    let metadata = dir.path().join("workspace.sqlite");
    let source = dir.path().join("source.sqlite");
    let backup = dir.path().join("backup.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(
        "CREATE TABLE records (value TEXT); INSERT INTO records VALUES ('private-row-value')",
    )
    .unwrap();
    drop(db);
    let store = Store::open(&metadata).unwrap();
    let project = store.create_project("project secret-like name").unwrap();
    store.rename_project(&project.id, "renamed").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "connection", source.to_str().unwrap(), "PROD")
        .unwrap();
    let report = store
        .backup_sqlite(&profile.id, backup.to_str().unwrap())
        .unwrap();
    assert!(report.audit_warning.is_none());
    assert!(store
        .backup_sqlite(&profile.id, backup.to_str().unwrap())
        .is_err());
    store.delete_project(&project.id).unwrap();

    let events = store.list_audit_events(None).unwrap().events;
    assert_eq!(events.len(), 8);
    assert_eq!(events[0].operation, "project.delete");
    assert_eq!(events[0].affected_count, Some(2));
    assert_eq!(events[1].outcome, "failed");
    assert_eq!(events[2].outcome, "started");
    assert_eq!(events[1].correlation_id, events[2].correlation_id);
    assert_eq!(events[3].outcome, "succeeded");
    assert_eq!(events[4].outcome, "started");
    assert_eq!(events[3].correlation_id, events[4].correlation_id);
    assert_eq!(events[3].environment.as_deref(), Some("PROD"));
    assert!(events.iter().all(|event| event.actor == "local"));
    let json = serde_json::to_string(&events).unwrap();
    assert!(!json.contains("private-row-value"));
    assert!(!json.contains("project secret-like name"));
    assert!(!json.contains("source.sqlite"));
}

#[test]
fn audit_failure_rolls_back_metadata_change() {
    let dir = tempfile::tempdir().unwrap();
    let metadata = dir.path().join("workspace.sqlite");
    let store = Store::open(&metadata).unwrap();
    let db = Connection::open(&metadata).unwrap();
    db.execute_batch("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;").unwrap();
    drop(db);
    assert!(store.create_project("must roll back").is_err());
    assert!(store.list_projects().unwrap().is_empty());
}

#[test]
fn backup_completion_audit_failure_is_reported_after_success() {
    let dir = tempfile::tempdir().unwrap();
    let metadata = dir.path().join("workspace.sqlite");
    let source = dir.path().join("source.sqlite");
    Connection::open(&source)
        .unwrap()
        .execute_batch("CREATE TABLE records (id INTEGER)")
        .unwrap();
    let store = Store::open(&metadata).unwrap();
    let project = store.create_project("test").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "db", source.to_str().unwrap(), "DEV")
        .unwrap();
    let db = Connection::open(&metadata).unwrap();
    db.execute_batch("CREATE TRIGGER reject_completed_backup BEFORE INSERT ON audit_events WHEN NEW.operation='sqlite.backup' AND NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;").unwrap();
    drop(db);
    let target = dir.path().join("backup.sqlite");
    let result = store
        .backup_sqlite(&profile.id, target.to_str().unwrap())
        .unwrap();
    assert!(target.exists());
    assert!(result.audit_warning.is_some());
    let events = store.list_audit_events(None).unwrap().events;
    assert_eq!(events[0].outcome, "started");
}

#[test]
fn history_cursor_remains_stable_when_new_events_arrive() {
    let dir = tempfile::tempdir().unwrap();
    let metadata = dir.path().join("workspace.sqlite");
    let store = Store::open(&metadata).unwrap();
    let mut db = Connection::open(&metadata).unwrap();
    let tx = db.transaction().unwrap();
    for index in 0..150 {
        tx.execute("INSERT INTO audit_events (id, correlation_id, operation, outcome) VALUES (?1, ?1, 'fixture', 'succeeded')", [format!("event-{index}")]).unwrap();
    }
    tx.commit().unwrap();
    let first = store.list_audit_events(None).unwrap();
    assert_eq!(first.events.len(), 100);
    store.create_project("new event").unwrap();
    let second = store.list_audit_events(first.next_cursor).unwrap();
    assert_eq!(second.events.len(), 50);
    assert!(second.next_cursor.is_none());
    assert!(first
        .events
        .iter()
        .all(|a| second.events.iter().all(|b| a.id != b.id)));
    assert!(store.list_audit_events(Some(0)).is_err());
}
