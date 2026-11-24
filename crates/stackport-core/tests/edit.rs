use rusqlite::Connection;
use stackport_core::{EditCellChange, EditInput, EditKey, RowChange, RowInsertField, Store};
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

#[test]
fn several_cells_share_one_approved_update_and_rollback_together() {
    let (dir, store, profile) = setup("PROD");
    let db = Connection::open(dir.path().join("data.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE multi_cells (id INTEGER PRIMARY KEY, note TEXT NOT NULL,
        amount INTEGER NOT NULL, other TEXT, CHECK(note <> 'paired' OR amount = 8));
        INSERT INTO multi_cells VALUES (1, 'old', 3, 'original');",
    )
    .unwrap();
    let start = || {
        store
            .begin_cell_edit(&profile, "multi_cells", key())
            .unwrap()
    };
    let change = |column: &str, kind, value| EditCellChange {
        column: column.into(),
        input: input(kind, value),
    };
    let stored = || {
        db.query_row("SELECT note, amount, other FROM multi_cells", [], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
    };
    let condition = start();
    let preview = store
        .preview_row_edit(&condition.token, vec![change("note", "text", "paired")])
        .unwrap();
    assert!(store
        .apply_row_edit(&condition.token, &preview.approval, "PROD")
        .is_err());
    assert_eq!(stored(), ("old".into(), 3, "original".into()));

    let edit = start();
    assert_eq!(edit.max_changes, 16);
    let fields = || {
        vec![
            change("note", "text", "paired"),
            change("amount", "integer", "8"),
            change("other", "text", "original"),
        ]
    };
    let previous = store.preview_row_edit(&edit.token, fields()).unwrap();
    assert_eq!(
        previous
            .changes
            .iter()
            .map(|field| field.column.as_str())
            .collect::<Vec<_>>(),
        ["note", "amount"]
    );
    assert_eq!(previous.changes[1].before.display, "3");
    assert_eq!(previous.changes[1].after.display, "8");
    assert!(store
        .preview_row_edit(
            &edit.token,
            vec![change("note", "text", "one"), change("note", "text", "two")]
        )
        .is_err());
    assert!(store
        .apply_row_edit(&edit.token, &previous.approval, "PROD")
        .is_err());
    let current = store.preview_row_edit(&edit.token, fields()).unwrap();
    assert!(store.apply_cell_edit(&edit.token, "PROD").is_err());
    assert!(store
        .apply_row_edit(&edit.token, &current.approval, "prod")
        .is_err());
    assert_eq!(stored(), ("old".into(), 3, "original".into()));
    let applied = store
        .apply_row_edit(&edit.token, &current.approval, "PROD")
        .unwrap();
    assert_eq!(
        applied
            .cells
            .iter()
            .map(|saved| (saved.column.as_str(), saved.actual.display.as_str()))
            .collect::<Vec<_>>(),
        [("note", "paired"), ("amount", "8")]
    );
    assert!(store
        .apply_row_edit(&edit.token, &current.approval, "PROD")
        .is_err());
    assert_eq!(stored(), ("paired".into(), 8, "original".into()));

    let affine = start();
    let proposal = store
        .preview_row_edit(
            &affine.token,
            vec![
                change("note", "text", "should roll back"),
                change("amount", "text", "8"),
            ],
        )
        .unwrap();
    let error = store
        .apply_row_edit(&affine.token, &proposal.approval, "PROD")
        .unwrap_err();
    assert!(
        error.contains("amount") && error.contains("롤백"),
        "{error}"
    );
    assert_eq!(stored(), ("paired".into(), 8, "original".into()));

    let stale = start();
    let proposal = store
        .preview_row_edit(
            &stale.token,
            vec![
                change("note", "text", "stale"),
                change("amount", "integer", "9"),
            ],
        )
        .unwrap();
    db.execute("UPDATE multi_cells SET other='changed elsewhere'", [])
        .unwrap();
    assert!(store
        .apply_row_edit(&stale.token, &proposal.approval, "PROD")
        .unwrap_err()
        .contains("행이 변경"));
    assert_eq!(stored(), ("paired".into(), 8, "changed elsewhere".into()));
    let fresh = start();
    assert!(store
        .preview_row_edit(
            &fresh.token,
            (0..17)
                .map(|_| change("note", "text", "over limit"))
                .collect()
        )
        .is_err());
    let proposal = store
        .preview_row_edit(&fresh.token, vec![change("note", "text", "cancelled")])
        .unwrap();
    store.cancel_cell_edit(&fresh.token).unwrap();
    assert!(store
        .apply_row_edit(&fresh.token, &proposal.approval, "PROD")
        .is_err());
    assert_eq!(stored(), ("paired".into(), 8, "changed elsewhere".into()));

    let history = store.list_audit_events(None).unwrap().events;
    assert!(history
        .iter()
        .any(|event| event.operation == "sqlite.row.update"
            && event.outcome == "succeeded"
            && event.policy == "sqlite-row-update-prod-confirmed"
            && event.affected_count == Some(1)));
    assert!(!serde_json::to_string(&history)
        .unwrap()
        .contains("should roll back"));
}

#[test]
fn row_insert_preserves_defaults_and_explicit_values_and_cannot_replace_a_row() {
    let (dir, store, profile) = setup("PROD");
    let db = Connection::open(dir.path().join("data.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE ON CONFLICT REPLACE,
         label TEXT NOT NULL, empty_value TEXT DEFAULT 'nonempty', optional TEXT DEFAULT 'nonnull',
         amount INTEGER DEFAULT 7, created TEXT DEFAULT (date('2026-01-02')));",
    ).unwrap();
    let session = store.begin_row_change(&profile, "additions", RowChange::Insert).unwrap();
    assert!(session.columns[0].auto_key);
    assert!(session.columns[2].required);
    assert!(store.preview_row_insert(&session.token, vec![]).is_err());
    let inputs = || vec![
        RowInsertField { column: "code".into(), input: input("text", "private code") },
        RowInsertField { column: "label".into(), input: input("text", "private label") },
        RowInsertField { column: "empty_value".into(), input: input("text", "") },
        RowInsertField { column: "optional".into(), input: input("null", "") },
        RowInsertField { column: "amount".into(), input: input("integer", "0") },
    ];
    let old = store.preview_row_insert(&session.token, inputs()).unwrap();
    let approved = store.preview_row_insert(&session.token, inputs()).unwrap();
    assert!(store.apply_row_change(&session.token, &old.approval, "PROD").is_err());
    assert!(store.apply_row_change(&session.token, &approved.approval, "prod").is_err());
    let count = |table| db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get::<_, i64>(0)).unwrap();
    assert_eq!(count("additions"), 0);
    let added = store.apply_row_change(&session.token, &approved.approval, "PROD").unwrap();
    assert_eq!(added.fields.len(), 7);
    assert!(store.apply_row_change(&session.token, &approved.approval, "PROD").is_err());
    let stored = db.query_row("SELECT id, empty_value, optional, amount, created FROM additions", [], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?))
    }).unwrap();
    assert_eq!(stored, (1, "".into(), None, 0, "2026-01-02".into()));
    let duplicate = store.begin_row_change(&profile, "additions", RowChange::Insert).unwrap();
    let approval = store.preview_row_insert(&duplicate.token, inputs()).unwrap();
    assert!(store.apply_row_change(&duplicate.token, &approval.approval, "PROD").is_err());
    assert_eq!(count("additions"), 1);
    assert_eq!(db.query_row("SELECT id FROM additions", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    let events = store.list_audit_events(None).unwrap().events;
    assert!(events.iter().any(|event| event.operation == "sqlite.row.insert" && event.outcome == "succeeded"
        && event.affected_count == Some(1) && event.policy == "sqlite-row-change-prod-confirmed"));
    let serialized = serde_json::to_string(&events).unwrap();
    assert!(!serialized.contains("private code") && !serialized.contains("private label"));
}

#[test]
fn row_delete_rejects_stale_rows_cascades_and_deferred_fk_violations() {
    let (dir, store, profile) = setup("DEV");
    let db = Connection::open(dir.path().join("data.sqlite")).unwrap();
    let open = || store.begin_row_change(&profile, "records", RowChange::Delete { keys: key() });
    let cancelled = open().unwrap();
    store.cancel_row_change(&cancelled.token).unwrap();
    assert!(store.apply_row_change(&cancelled.token, &cancelled.preview.unwrap().approval, "").is_err());
    let stale = open().unwrap();
    db.execute("UPDATE records SET payload=x'0102' WHERE id=1", []).unwrap();
    let error = store.apply_row_change(&stale.token, &stale.preview.unwrap().approval, "").err().unwrap();
    assert!(error.contains("행이 변경"), "{error}");

    db.execute_batch("CREATE TABLE cascade_child (parent INTEGER REFERENCES ReCoRdS(id) ON DELETE CASCADE);
        INSERT INTO cascade_child VALUES (1);").unwrap();
    let error = open().err().unwrap();
    assert!(error.contains("연쇄 변경"), "{error}");
    db.execute_batch("DROP TABLE cascade_child;
        CREATE TABLE restrict_child (parent INTEGER REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED);
        INSERT INTO restrict_child VALUES (1);").unwrap();
    let referenced = open().unwrap();
    assert!(store.apply_row_change(&referenced.token, &referenced.preview.unwrap().approval, "").is_err());
    assert_eq!(value(&dir.path().join("data.sqlite"), "note"), "before");
    db.execute("DELETE FROM restrict_child", []).unwrap();

    let ready = open().unwrap();
    let report = store.apply_row_change(&ready.token, &ready.preview.unwrap().approval, "").unwrap();
    assert!(report.fields.is_empty());
    assert_eq!(db.query_row("SELECT count(*) FROM records", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
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
