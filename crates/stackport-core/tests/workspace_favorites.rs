use rusqlite::Connection;
use stackport_core::{
    FavoriteScope, FavoriteTarget, PostgresProfileInput, SshProfileInput, Store,
    TableQueryPresetWrite, TableQueryTarget,
};
use std::sync::{Arc, Barrier};

#[test]
fn scoped_favorites_survive_restart_copy_and_profile_deletion() {
    let directory = tempfile::tempdir().unwrap();
    let metadata = directory.path().join("workspace.sqlite");
    let database = directory.path().join("project.sqlite");
    let data = Connection::open(&database).unwrap();
    data.execute_batch("CREATE TABLE data (n INTEGER); CREATE VIEW report AS SELECT n FROM data;")
        .unwrap();
    let store = Store::open(&metadata).unwrap();
    let project = store.create_project("original").unwrap();
    let other = store.create_project("other").unwrap();
    let sqlite = store
        .create_sqlite_profile(&project.id, "sqlite", database.to_str().unwrap(), "DEV")
        .unwrap();
    let postgres = store
        .create_postgres_profile(
            &project.id,
            PostgresProfileInput {
                name: "postgres".into(),
                host: "db.example.test".into(),
                port: 5432,
                database: "db".into(),
                username: "reader".into(),
                environment: "PROD".into(),
                ca_path: None,
            },
        )
        .unwrap();
    let ssh = store
        .create_ssh_profile(
            &project.id,
            SshProfileInput {
                name: "ssh".into(),
                host: "ssh.example.test".into(),
                port: 22,
                username: "operator".into(),
                environment: "STAGING".into(),
            },
        )
        .unwrap();
    let connection = FavoriteTarget::Sqlite {
        profile_id: sqlite.id.clone(),
    };
    let table = FavoriteTarget::SqliteObject {
        profile_id: sqlite.id.clone(),
        object_name: "data".into(),
    };
    let view = FavoriteTarget::SqliteObject {
        profile_id: sqlite.id.clone(),
        object_name: "report".into(),
    };
    let pg = FavoriteTarget::Postgres {
        profile_id: postgres.id.clone(),
    };
    let host = FavoriteTarget::Ssh {
        profile_id: ssh.id.clone(),
    };
    let personal = FavoriteScope::Personal;
    let shared = FavoriteScope::Project;
    assert!(store
        .set_workspace_favorite(&other.id, personal, &table, true)
        .is_err());
    assert!(store
        .set_workspace_favorite(
            &project.id,
            personal,
            &FavoriteTarget::SqliteObject {
                profile_id: sqlite.id.clone(),
                object_name: "unknown".into(),
            },
            true
        )
        .is_err());
    for target in [&connection, &table] {
        store
            .set_workspace_favorite(&project.id, personal, target, true)
            .unwrap();
    }
    for target in [&table, &view, &pg, &host] {
        store
            .set_workspace_favorite(&project.id, shared, target, true)
            .unwrap();
    }
    let barrier = Arc::new(Barrier::new(2));
    std::thread::scope(|threads| {
        for _ in 0..2 {
            threads.spawn(|| {
                barrier.wait();
                store
                    .set_workspace_favorite(&project.id, personal, &table, true)
                    .unwrap();
            });
        }
    });
    store.archive_project(&project.id).unwrap();
    assert!(store.list_workspace_favorites(&project.id).is_err());
    assert!(store
        .set_workspace_favorite(&project.id, shared, &view, false)
        .is_err());
    store.unarchive_project(&project.id).unwrap();
    drop(store);

    let store = Store::open(&metadata).unwrap();
    let original = store.list_workspace_favorites(&project.id).unwrap();
    assert_eq!(original.len(), 6);
    assert_eq!(
        original
            .iter()
            .filter(|item| item.scope == personal)
            .count(),
        2
    );
    let copy = store.duplicate_project(&project.id, "copy").unwrap();
    let sqlite_copy = &store.list_profiles(&copy.id).unwrap()[0];
    let pg_copy = &store.list_postgres_profiles(&copy.id).unwrap()[0];
    let ssh_copy = &store.list_ssh_profiles(&copy.id).unwrap()[0];
    let copied = store.list_workspace_favorites(&copy.id).unwrap();
    assert!(copied.iter().all(|item| item.scope == shared));
    let copied_targets: Vec<_> = copied.into_iter().map(|item| item.target).collect();
    assert_eq!(copied_targets.len(), 4);
    for name in ["data", "report"] {
        assert!(copied_targets.contains(&FavoriteTarget::SqliteObject {
            profile_id: sqlite_copy.id.clone(),
            object_name: name.into(),
        }));
    }
    assert!(copied_targets.contains(&FavoriteTarget::Postgres {
        profile_id: pg_copy.id.clone()
    }));
    assert!(copied_targets.contains(&FavoriteTarget::Ssh {
        profile_id: ssh_copy.id.clone()
    }));

    data.execute_batch("DROP VIEW report;").unwrap();
    store
        .set_workspace_favorite(&project.id, shared, &view, false)
        .unwrap();
    assert_eq!(
        store.list_workspace_favorites(&project.id).unwrap().len(),
        5
    );
    store.delete_profile(&sqlite.id).unwrap();
    assert_eq!(
        store.list_workspace_favorites(&project.id).unwrap().len(),
        2
    );
    store
        .delete_postgres_profile(&postgres.id, postgres.revision)
        .unwrap();
    store.delete_ssh_profile(&ssh.id, ssh.revision).unwrap();
    assert!(store
        .list_workspace_favorites(&project.id)
        .unwrap()
        .is_empty());
    assert_eq!(store.list_workspace_favorites(&copy.id).unwrap().len(), 4);
}

#[test]
fn version_eleven_keeps_query_presets_and_gets_a_verified_backup() {
    let directory = tempfile::tempdir().unwrap();
    let metadata = directory.path().join("workspace.sqlite");
    let store = Store::open(&metadata).unwrap();
    let project = store.create_project("existing").unwrap();
    let data = directory.path().join("data.sqlite");
    Connection::open(&data)
        .unwrap()
        .execute_batch("CREATE TABLE data (n INTEGER);")
        .unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "data", data.to_str().unwrap(), "DEV")
        .unwrap();
    let target = TableQueryTarget::Sqlite {
        profile_id: profile.id,
        object: "data".into(),
    };
    store.write_table_query_preset(&target, TableQueryPresetWrite::Create {
        name: "Existing sort".into(),
        clauses: serde_json::from_str(r#"{"conjunction":"all","filters":[],"sort":[{"column":"n","direction":"asc","nulls":"last"}]}"#).unwrap(),
    }).unwrap();
    let preset = store
        .list_table_query_presets(&target)
        .unwrap()
        .pop()
        .unwrap();
    drop(store);
    let db = Connection::open(&metadata).unwrap();
    db.execute_batch("DROP TABLE workspace_favorites; PRAGMA user_version=11;")
        .unwrap();
    drop(db);

    let migrated = Store::open(&metadata).unwrap();
    assert_eq!(migrated.list_projects().unwrap(), [project.clone()]);
    assert_eq!(
        migrated.list_table_query_presets(&target).unwrap()[0].id,
        preset.id
    );
    assert!(migrated
        .list_workspace_favorites(&project.id)
        .unwrap()
        .is_empty());
    let mut backups = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.to_string_lossy().contains(".v11-"));
    let backup = backups.next().unwrap();
    assert!(backups.next().is_none());
    let backup = Connection::open(backup).unwrap();
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        11
    );
    assert_eq!(
        backup
            .pragma_query_value(None, "integrity_check", |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    let saved: String = backup
        .query_row("SELECT id FROM table_query_presets", [], |row| row.get(0))
        .unwrap();
    assert_eq!(saved, preset.id);
}
