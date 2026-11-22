use rusqlite::Connection;
use stackport_core::{EditInput, EditKey, Store};
use std::path::Path;
use tempfile::TempDir;

fn setup(environment: &str) -> (TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("data.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(
        "CREATE TABLE records (id INTEGER PRIMARY KEY, unique_name TEXT UNIQUE,
        note TEXT NOT NULL, count INTEGER, other TEXT, payload BLOB);
        INSERT INTO records VALUES (1, 'key', 'before', 3, 'other', x'00ff');",
    )
    .unwrap();
    drop(db);
    let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("test").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "db", source.to_str().unwrap(), environment)
        .unwrap();
    (dir, store, profile.id)
}

fn key() -> Vec<EditKey> {
    vec![EditKey {
        name: "id".into(),
        kind: "integer".into(),
        value: "1".into(),
    }]
}
fn input(kind: &str, value: &str) -> EditInput {
    EditInput {
        kind: kind.into(),
        value: value.into(),
    }
}
fn value(path: &Path, column: &str) -> String {
    Connection::open(path)
        .unwrap()
        .query_row(
            &format!("SELECT {column} FROM records WHERE id=1"),
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn preview_is_read_only_apply_is_single_use_and_prod_requires_confirmation() {
    let (dir, store, profile) = setup("PROD");
    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    assert!(
        !session
            .fields
            .iter()
            .find(|field| field.name == "id")
            .unwrap()
            .editable
    );
    assert!(
        !session
            .fields
            .iter()
            .find(|field| field.name == "unique_name")
            .unwrap()
            .editable
    );
    assert!(
        !session
            .fields
            .iter()
            .find(|field| field.name == "payload")
            .unwrap()
            .editable
    );
    assert!(store.apply_cell_edit(&session.token, "PROD").is_err());
    assert!(store
        .preview_cell_edit(&session.token, "unique_name", input("text", "not allowed"))
        .is_err());
    let preview = store
        .preview_cell_edit(&session.token, "note", input("text", "after"))
        .unwrap();
    assert_eq!(preview.before.display, "before");
    assert_eq!(preview.after.display, "after");
    assert_eq!(value(&dir.path().join("data.sqlite"), "note"), "before");
    assert!(store.apply_cell_edit(&session.token, "prod").is_err());
    assert_eq!(value(&dir.path().join("data.sqlite"), "note"), "before");
    let result = store.apply_cell_edit(&session.token, "PROD").unwrap();
    assert_eq!(result.actual.display, "after");
    assert!(result.audit_warning.is_none());
    assert!(store.apply_cell_edit(&session.token, "PROD").is_err());
    assert_eq!(value(&dir.path().join("data.sqlite"), "note"), "after");
    let events = store.list_audit_events(None).unwrap().events;
    assert_eq!(events[0].operation, "sqlite.cell.update");
    assert_eq!(events[0].outcome, "succeeded");
    assert_eq!(events[0].policy, "sqlite-cell-update-prod-confirmed");
    assert_eq!(events[0].object_name.as_deref(), Some("records · note"));
    let serialized = serde_json::to_string(&events).unwrap();
    assert!(!serialized.contains("before") && !serialized.contains("after"));
}

#[test]
fn changes_to_any_field_are_detected_before_preview_and_before_apply() {
    let (dir, store, profile) = setup("DEV");
    let source = dir.path().join("data.sqlite");
    let first = store.begin_cell_edit(&profile, "records", key()).unwrap();
    Connection::open(&source)
        .unwrap()
        .execute("UPDATE records SET other='concurrent' WHERE id=1", [])
        .unwrap();
    assert!(store
        .preview_cell_edit(&first.token, "note", input("text", "bad"))
        .is_err());
    let second = store.begin_cell_edit(&profile, "records", key()).unwrap();
    store
        .preview_cell_edit(&second.token, "note", input("text", "bad"))
        .unwrap();
    Connection::open(&source)
        .unwrap()
        .execute("UPDATE records SET payload=x'0102' WHERE id=1", [])
        .unwrap();
    assert!(store.apply_cell_edit(&second.token, "").is_err());
    assert_eq!(value(&source, "note"), "before");
    assert_eq!(
        store.list_audit_events(None).unwrap().events[0].outcome,
        "failed"
    );
}

#[test]
fn failed_repreview_invalidates_the_previous_proposal() {
    let (dir, store, profile) = setup("DEV");
    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    store
        .preview_cell_edit(&session.token, "note", input("text", "first proposal"))
        .unwrap();
    assert!(store
        .preview_cell_edit(&session.token, "count", input("integer", "not an integer"))
        .is_err());
    assert!(store.apply_cell_edit(&session.token, "").is_err());
    assert_eq!(value(&dir.path().join("data.sqlite"), "note"), "before");
}

#[test]
fn quoted_identifiers_and_composite_keys_are_bound_without_injection() {
    let (dir, store, profile) = setup("DEV");
    let source = dir.path().join("data.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("CREATE TABLE \"odd\"\"table\" (\"key part\" TEXT NOT NULL, second INTEGER NOT NULL, \"v\"\"alue\" TEXT, PRIMARY KEY(\"key part\", second)) WITHOUT ROWID;").unwrap();
    db.execute(
        "INSERT INTO \"odd\"\"table\" VALUES (?1, 7, 'before')",
        ["x' OR 1=1 --"],
    )
    .unwrap();
    db.execute(
        "INSERT INTO \"odd\"\"table\" VALUES ('other', 7, 'keep')",
        [],
    )
    .unwrap();
    drop(db);
    let keys = vec![
        EditKey {
            name: "second".into(),
            kind: "integer".into(),
            value: "7".into(),
        },
        EditKey {
            name: "key part".into(),
            kind: "text".into(),
            value: "x' OR 1=1 --".into(),
        },
    ];
    let session = store.begin_cell_edit(&profile, "odd\"table", keys).unwrap();
    store
        .preview_cell_edit(&session.token, "v\"alue", input("text", "after"))
        .unwrap();
    store.apply_cell_edit(&session.token, "").unwrap();
    let db = Connection::open(source).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT \"v\"\"alue\" FROM \"odd\"\"table\" WHERE \"key part\"=?1",
            ["x' OR 1=1 --"],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "after"
    );
    assert_eq!(
        db.query_row(
            "SELECT \"v\"\"alue\" FROM \"odd\"\"table\" WHERE \"key part\"='other'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "keep"
    );
}

#[test]
fn workspace_metadata_cannot_be_edited_through_a_profile() {
    let (dir, store, _) = setup("DEV");
    let project = store.create_project("metadata").unwrap();
    let path = dir.path().join("workspace.sqlite");
    let profile = store
        .create_sqlite_profile(&project.id, "self", path.to_str().unwrap(), "DEV")
        .unwrap();
    let keys = vec![EditKey {
        name: "id".into(),
        kind: "text".into(),
        value: project.id,
    }];
    assert!(store
        .begin_cell_edit(&profile.id, "projects", keys)
        .is_err());
}

#[test]
fn unknown_environment_cannot_bypass_production_confirmation() {
    let (dir, store, profile) = setup("PROD");
    let db = Connection::open(dir.path().join("workspace.sqlite")).unwrap();
    db.execute_batch("PRAGMA ignore_check_constraints=ON;")
        .unwrap();
    db.execute(
        "UPDATE profiles SET environment='unknown' WHERE id=?1",
        [&profile],
    )
    .unwrap();
    drop(db);
    assert!(store.begin_cell_edit(&profile, "records", key()).is_err());
    assert_eq!(value(&dir.path().join("data.sqlite"), "note"), "before");
}

#[test]
fn unique_parent_key_is_not_editable_when_children_cascade() {
    let (dir, store, profile) = setup("DEV");
    let source = dir.path().join("data.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE child (id INTEGER PRIMARY KEY, parent TEXT REFERENCES records(unique_name) ON UPDATE CASCADE); INSERT INTO child VALUES (1,'key');").unwrap();
    drop(db);
    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    assert!(store
        .preview_cell_edit(&session.token, "unique_name", input("text", "changed"))
        .is_err());
    store
        .preview_cell_edit(&session.token, "note", input("text", "safe"))
        .unwrap();
    store.apply_cell_edit(&session.token, "").unwrap();
    let db = Connection::open(source).unwrap();
    assert_eq!(
        db.query_row("SELECT parent FROM child", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "key"
    );
}

#[test]
fn constraint_and_affinity_failures_rollback_the_transaction() {
    let (dir, store, profile) = setup("DEV");
    let source = dir.path().join("data.sqlite");
    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    store
        .preview_cell_edit(&session.token, "note", input("null", ""))
        .unwrap();
    assert!(store.apply_cell_edit(&session.token, "").is_err());
    assert_eq!(value(&source, "note"), "before");
    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    store
        .preview_cell_edit(&session.token, "count", input("text", "123"))
        .unwrap();
    assert!(store.apply_cell_edit(&session.token, "").is_err());
    let db = Connection::open(&source).unwrap();
    assert_eq!(
        db.query_row("SELECT count FROM records", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        3
    );
    drop(db);
    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    store
        .preview_cell_edit(&session.token, "count", input("integer", "123"))
        .unwrap();
    store.apply_cell_edit(&session.token, "").unwrap();
    assert_eq!(
        Connection::open(&source)
            .unwrap()
            .query_row("SELECT count FROM records", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        123
    );
}

#[test]
fn unsafe_schema_and_ambiguous_keys_remain_read_only() {
    let (dir, store, profile) = setup("DEV");
    let source = dir.path().join("data.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("CREATE TABLE no_key (name TEXT); INSERT INTO no_key VALUES ('a');
        CREATE TABLE generated (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER AS (a + 1)); INSERT INTO generated (id,a) VALUES(1, 1);
        CREATE TABLE has_trigger (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO has_trigger VALUES (1,'a');
        CREATE TRIGGER changed AFTER UPDATE ON has_trigger BEGIN UPDATE records SET other='bad'; END;
        CREATE TABLE nullable_key (id TEXT PRIMARY KEY, value TEXT); INSERT INTO nullable_key VALUES (NULL,'a');
        CREATE VIEW read_view AS SELECT * FROM records;").unwrap();
    drop(db);
    for table in ["no_key", "generated", "has_trigger", "read_view"] {
        assert!(
            store.begin_cell_edit(&profile, table, key()).is_err(),
            "{table}"
        );
    }
    let nullable = vec![EditKey {
        name: "id".into(),
        kind: "null".into(),
        value: "".into(),
    }];
    assert!(store
        .begin_cell_edit(&profile, "nullable_key", nullable)
        .is_err());
    assert!(store.begin_cell_edit(&profile, "records", vec![]).is_err());
    assert!(store
        .begin_cell_edit(
            &profile,
            "records",
            vec![EditKey {
                name: "id\" OR 1=1 --".into(),
                kind: "integer".into(),
                value: "1".into()
            }]
        )
        .is_err());
    assert_eq!(value(&source, "other"), "other");
}

#[test]
fn schema_or_file_replacement_after_preview_prevents_writes() {
    let (dir, store, profile) = setup("DEV");
    let source = dir.path().join("data.sqlite");
    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    store
        .preview_cell_edit(&session.token, "note", input("text", "bad"))
        .unwrap();
    Connection::open(&source)
        .unwrap()
        .execute_batch("ALTER TABLE records ADD COLUMN added TEXT")
        .unwrap();
    assert!(store.apply_cell_edit(&session.token, "").is_err());
    assert_eq!(value(&source, "note"), "before");

    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    store
        .preview_cell_edit(&session.token, "note", input("text", "bad"))
        .unwrap();
    let old_path = dir.path().join("old.sqlite");
    std::fs::rename(&source, &old_path).unwrap();
    std::fs::copy(&old_path, &source).unwrap();
    assert!(store.apply_cell_edit(&session.token, "").is_err());
    assert_eq!(value(&source, "note"), "before");
    assert_eq!(value(&old_path, "note"), "before");
}

#[test]
fn audit_start_failure_prevents_the_change_and_completion_failure_is_explicit() {
    let (dir, store, profile) = setup("DEV");
    let source = dir.path().join("data.sqlite");
    let metadata = dir.path().join("workspace.sqlite");
    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    store
        .preview_cell_edit(&session.token, "note", input("text", "blocked"))
        .unwrap();
    let db = Connection::open(&metadata).unwrap();
    db.execute_batch("CREATE TRIGGER reject_start BEFORE INSERT ON audit_events WHEN NEW.operation='sqlite.cell.update' AND NEW.outcome='started' BEGIN SELECT RAISE(ABORT, 'unavailable'); END;").unwrap();
    drop(db);
    assert!(store.apply_cell_edit(&session.token, "").is_err());
    assert_eq!(value(&source, "note"), "before");
    let db = Connection::open(&metadata).unwrap();
    db.execute_batch("DROP TRIGGER reject_start; CREATE TRIGGER reject_done BEFORE INSERT ON audit_events WHEN NEW.operation='sqlite.cell.update' AND NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT, 'unavailable'); END;").unwrap();
    drop(db);
    let session = store.begin_cell_edit(&profile, "records", key()).unwrap();
    store
        .preview_cell_edit(&session.token, "note", input("text", "saved"))
        .unwrap();
    let result = store.apply_cell_edit(&session.token, "").unwrap();
    assert!(result.audit_warning.is_some());
    assert_eq!(value(&source, "note"), "saved");
}

#[cfg(windows)]
#[test]
fn read_only_file_cannot_be_modified() {
    let (dir, store, profile) = setup("DEV");
    let source = dir.path().join("data.sqlite");
    let mut permissions = std::fs::metadata(&source).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&source, permissions.clone()).unwrap();
    let result = (|| {
        let session = store.begin_cell_edit(&profile, "records", key())?;
        store.preview_cell_edit(&session.token, "note", input("text", "blocked"))?;
        store.apply_cell_edit(&session.token, "")
    })();
    permissions.set_readonly(false);
    std::fs::set_permissions(&source, permissions).unwrap();
    assert!(result.is_err());
    assert_eq!(value(&source, "note"), "before");
}
