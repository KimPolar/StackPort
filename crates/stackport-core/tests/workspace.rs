use rusqlite::Connection;
use stackport_core::{SshProfileInput, Store, PAGE_SIZE};
use tempfile::TempDir;

fn fixture() -> (TempDir, Store, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(
        "CREATE TABLE \"weird\"\"table\" (id INTEGER PRIMARY KEY, text TEXT, data BLOB);
                      CREATE VIEW things AS SELECT id, text FROM \"weird\"\"table\";",
    )
    .unwrap();
    for i in 0..(PAGE_SIZE * 2 + 1) {
        db.execute(
            "INSERT INTO \"weird\"\"table\" VALUES (?1, ?2, x'00ff')",
            (i, format!("한글 {i}")),
        )
        .unwrap();
    }
    drop(db);
    let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project(" 운영 ").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "local", source.to_str().unwrap(), "DEV")
        .unwrap();
    (dir, store, project.id, profile.id)
}

#[test]
fn project_and_profiles_survive_reopen_and_delete_cascades() {
    let (dir, store, project_id, profile_id) = fixture();
    assert_eq!(store.list_projects().unwrap()[0].name, "운영");
    store.rename_project(&project_id, "개발").unwrap();
    let reopened = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(reopened.list_projects().unwrap()[0].name, "개발");
    assert_eq!(
        reopened.list_profiles(&project_id).unwrap()[0].id,
        profile_id
    );
    reopened.delete_project(&project_id).unwrap();
    assert!(reopened.list_profiles(&project_id).unwrap().is_empty());
    assert!(reopened.query(&profile_id, "SELECT 1", 0).is_err());
}

#[test]
fn duplicate_project_keeps_targets_but_gives_connections_new_ids() {
    let (dir, store, source, sqlite_id) = fixture();
    let ssh = store
        .create_ssh_profile(
            &source,
            SshProfileInput {
                name: "production".into(),
                host: "server.example.com".into(),
                port: 2222,
                username: "alice".into(),
                environment: "PROD".into(),
            },
        )
        .unwrap();
    let ssh = store
        .update_ssh_profile(
            &ssh.id,
            1,
            SshProfileInput {
                name: "production updated".into(),
                host: ssh.host,
                port: ssh.port,
                username: ssh.username,
                environment: ssh.environment,
            },
        )
        .unwrap();
    let new_project = store.duplicate_project(&source, " copy ").unwrap();
    assert_ne!(new_project.id, source);
    assert_eq!(new_project.name, "copy");
    let reopened = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let sqlite_copy = reopened
        .list_profiles(&new_project.id)
        .unwrap()
        .pop()
        .unwrap();
    let sqlite_original = reopened.list_profiles(&source).unwrap().pop().unwrap();
    assert_eq!(sqlite_original.id, sqlite_id);
    assert_ne!(sqlite_copy.id, sqlite_original.id);
    assert_eq!(sqlite_copy.project_id, new_project.id);
    assert_eq!(sqlite_copy.path, sqlite_original.path);
    assert_eq!(sqlite_copy.environment, sqlite_original.environment);
    let ssh_copy = reopened
        .list_ssh_profiles(&new_project.id)
        .unwrap()
        .pop()
        .unwrap();
    assert_ne!(ssh_copy.id, ssh.id);
    assert_eq!(ssh_copy.project_id, new_project.id);
    assert_eq!(
        (
            ssh_copy.host,
            ssh_copy.port,
            ssh_copy.username,
            ssh_copy.environment,
            ssh_copy.revision
        ),
        (ssh.host, ssh.port, ssh.username, ssh.environment, 1)
    );
    let event = &reopened.list_audit_events(None).unwrap().events[0];
    assert_eq!(event.operation, "project.duplicate");
    assert_eq!(event.affected_count, Some(3));
    assert_eq!(event.project_id.as_deref(), Some(new_project.id.as_str()));
    reopened.delete_project(&new_project.id).unwrap();
    assert_eq!(reopened.list_ssh_profiles(&source).unwrap().len(), 1);
    assert_eq!(
        reopened
            .query(&sqlite_id, "SELECT count(*) FROM things", 0)
            .unwrap()
            .rows[0][0]
            .display,
        "201"
    );
}

#[test]
fn project_duplicate_rolls_back_connections_when_audit_fails() {
    let (dir, store, source, _sqlite) = fixture();
    let workspace = Connection::open(dir.path().join("workspace.sqlite")).unwrap();
    workspace
        .execute_batch(
            "CREATE TRIGGER reject_duplicate_audit BEFORE INSERT ON audit_events
         WHEN NEW.operation='project.duplicate'
         BEGIN SELECT raise(ABORT, 'duplicate audit fixture'); END;",
        )
        .unwrap();
    assert!(store.duplicate_project("missing", "copy").is_err());
    assert!(store.duplicate_project(&source, " ").is_err());
    assert!(store.duplicate_project(&source, "copy").is_err());
    assert_eq!(store.list_projects().unwrap().len(), 1);
    assert_eq!(
        workspace
            .query_row("SELECT count(*) FROM profiles", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn project_archive_survives_reopen_and_restores_the_same_project() {
    let (dir, store, source, sqlite_id) = fixture();
    store.archive_project(&source).unwrap();
    assert!(store.archive_project(&source).is_err());
    let path = dir.path().join("workspace.sqlite");
    let reopened = Store::open(&path).unwrap();
    assert!(reopened.list_projects().unwrap().is_empty());
    let archived = reopened.list_archived_projects().unwrap();
    assert_eq!(
        (archived[0].id.as_str(), archived[0].name.as_str()),
        (source.as_str(), "운영")
    );
    assert!(archived[0].archived_at.ends_with('Z'));

    let metadata = Connection::open(path).unwrap();
    metadata
        .execute_batch(
            "CREATE TRIGGER reject_unarchive BEFORE INSERT ON audit_events
         WHEN NEW.operation = 'project.unarchive'
         BEGIN SELECT raise(ABORT, 'unarchive fixture'); END;",
        )
        .unwrap();
    assert!(reopened.unarchive_project(&source).is_err());
    assert_eq!(reopened.list_archived_projects().unwrap().len(), 1);
    metadata
        .execute_batch("DROP TRIGGER reject_unarchive")
        .unwrap();
    reopened.unarchive_project(&source).unwrap();
    assert_eq!(reopened.list_projects().unwrap()[0].id, source);
    assert_eq!(reopened.list_profiles(&source).unwrap()[0].id, sqlite_id);
    assert!(reopened.list_archived_projects().unwrap().is_empty());
    assert!(reopened.unarchive_project(&source).is_err());
    let events = reopened.list_audit_events(None).unwrap();
    assert_eq!(events.events[0].operation, "project.unarchive");
    assert_eq!(events.events[1].operation, "project.archive");
}

#[test]
fn sqlite_objects_and_bounded_pages_use_real_data() {
    let (_dir, store, _project_id, profile_id) = fixture();
    let objects = store.objects(&profile_id).unwrap();
    assert!(objects
        .iter()
        .any(|o| o.name == "weird\"table" && o.kind == "table"));
    assert!(objects
        .iter()
        .any(|o| o.name == "things" && o.kind == "view"));
    let first = store
        .query(
            &profile_id,
            "SELECT * FROM \"weird\"\"table\" ORDER BY id;",
            0,
        )
        .unwrap();
    assert_eq!(first.columns, ["id", "text", "data"]);
    assert_eq!(first.rows.len(), PAGE_SIZE);
    assert!(first.has_more);
    assert_eq!(first.rows[0][1].display, "한글 0");
    assert_eq!(first.rows[0][2].kind, "blob");
    let last = store
        .query(
            &profile_id,
            "SELECT * FROM \"weird\"\"table\" ORDER BY id",
            2,
        )
        .unwrap();
    assert_eq!(last.rows.len(), 1);
    assert!(!last.has_more);
}

#[test]
fn large_values_are_previewed_without_losing_unicode_boundaries() {
    let (_dir, store, _project_id, profile_id) = fixture();
    let page = store
        .query(
            &profile_id,
            "SELECT replace(hex(zeroblob(3000)), '00', '한') AS big",
            0,
        )
        .unwrap();
    assert_eq!(page.rows[0][0].display.chars().count(), 3000);
    assert!(!page.rows[0][0].truncated);
    let page = store
        .query(
            &profile_id,
            "SELECT replace(hex(zeroblob(5000)), '00', '한') AS big",
            0,
        )
        .unwrap();
    assert_eq!(page.rows[0][0].display.chars().count(), 4096);
    assert!(page.rows[0][0].truncated);
}

#[test]
fn user_database_cannot_be_modified_or_attached() {
    let (dir, store, _project_id, profile_id) = fixture();
    for sql in [
        "DELETE FROM \"weird\"\"table\"",
        "DROP TABLE \"weird\"\"table\"",
        "PRAGMA user_version = 99",
        "ATTACH DATABASE 'elsewhere.db' AS other",
        "SELECT 1; DELETE FROM \"weird\"\"table\"",
        "SELECT load_extension('x')",
        "SELECT ?1",
    ] {
        assert!(
            store.query(&profile_id, sql, 0).is_err(),
            "unexpectedly accepted: {sql}"
        );
    }
    let db = Connection::open(dir.path().join("source.sqlite")).unwrap();
    let count: usize = db
        .query_row("SELECT count(*) FROM \"weird\"\"table\"", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, PAGE_SIZE * 2 + 1);
    assert!(!dir.path().join("elsewhere.db").exists());
}

#[test]
fn sql_errors_do_not_echo_the_entire_query() {
    let (_dir, store, _project_id, profile_id) = fixture();
    let error = store
        .query(
            &profile_id,
            "SELECT 'sensitive-literal' FROM nonexistent",
            0,
        )
        .unwrap_err();
    assert!(!error.contains("sensitive-literal"));
    let error = store
        .query(&profile_id, "DELETE FROM \"weird\"\"table\"", 0)
        .unwrap_err();
    assert!(error.contains("읽기 전용"), "{error}");
}

#[test]
fn invalid_inputs_do_not_create_a_profile_or_database() {
    let (dir, store, project_id, _profile_id) = fixture();
    let missing = dir.path().join("missing.sqlite");
    assert!(store.create_project("  ").is_err());
    assert!(store
        .create_sqlite_profile(&project_id, "missing", missing.to_str().unwrap(), "DEV")
        .is_err());
    assert!(!missing.exists());
    let invalid = dir.path().join("not-db.txt");
    std::fs::write(&invalid, "not a database").unwrap();
    assert!(store
        .create_sqlite_profile(&project_id, "bad", invalid.to_str().unwrap(), "DEV")
        .is_err());
    assert_eq!(store.list_profiles(&project_id).unwrap().len(), 1);
}

#[test]
fn unknown_newer_workspace_version_is_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("future.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE future (value TEXT); INSERT INTO future VALUES ('keep'); PRAGMA user_version=999;").unwrap();
    drop(db);
    assert!(Store::open(&path).is_err());
    let db = Connection::open(path).unwrap();
    let value: String = db
        .query_row("SELECT value FROM future", [], |r| r.get(0))
        .unwrap();
    assert_eq!(value, "keep");
}
