use rusqlite::Connection;
use stackport_core::{
    FavoriteScope, FavoriteTarget, PostgresProfileInput, SshProfileInput, Store,
    TableQueryPresetWrite, TableQueryTarget,
};
use std::sync::{Arc, Barrier};

#[path = "support/legacy_presets.rs"]
mod legacy_presets;

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
    let pg_objects = ["first", "second"].map(|schema_name| FavoriteTarget::PostgresObject {
        profile_id: postgres.id.clone(),
        schema_name: schema_name.into(),
        object_name: "daily".into(),
    });
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
    for target in [&table, &view, &pg, &host, &pg_objects[0], &pg_objects[1]] {
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
    assert_eq!(original.len(), 8);
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
    assert_eq!(copied_targets.len(), 6);
    for name in ["data", "report"] {
        assert!(copied_targets.contains(&FavoriteTarget::SqliteObject {
            profile_id: sqlite_copy.id.clone(),
            object_name: name.into(),
        }));
    }
    assert!(copied_targets.contains(&FavoriteTarget::Postgres {
        profile_id: pg_copy.id.clone()
    }));
    for schema_name in ["first", "second"] {
        assert!(copied_targets.contains(&FavoriteTarget::PostgresObject {
            profile_id: pg_copy.id.clone(),
            schema_name: schema_name.into(),
            object_name: "daily".into(),
        }));
    }
    assert!(copied_targets.contains(&FavoriteTarget::Ssh {
        profile_id: ssh_copy.id.clone()
    }));

    data.execute_batch("DROP VIEW report;").unwrap();
    store
        .set_workspace_favorite(&project.id, shared, &view, false)
        .unwrap();
    assert_eq!(
        store.list_workspace_favorites(&project.id).unwrap().len(),
        7
    );
    store.delete_profile(&sqlite.id).unwrap();
    assert_eq!(
        store.list_workspace_favorites(&project.id).unwrap().len(),
        4
    );
    store
        .delete_postgres_profile(&postgres.id, postgres.revision)
        .unwrap();
    store.delete_ssh_profile(&ssh.id, ssh.revision).unwrap();
    assert!(store
        .list_workspace_favorites(&project.id)
        .unwrap()
        .is_empty());
    assert_eq!(store.list_workspace_favorites(&copy.id).unwrap().len(), 6);
}

#[test]
fn version_twelve_favorites_keep_their_scope_and_identity() {
    let directory = tempfile::tempdir().unwrap();
    let metadata = directory.path().join("workspace.sqlite");
    let data = directory.path().join("data.sqlite");
    Connection::open(&data)
        .unwrap()
        .execute_batch("CREATE VIEW report AS SELECT 42 AS value;")
        .unwrap();
    let store = Store::open(&metadata).unwrap();
    let project = store.create_project("existing").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "data", data.to_str().unwrap(), "DEV")
        .unwrap();
    let target = FavoriteTarget::SqliteObject {
        profile_id: profile.id,
        object_name: "report".into(),
    };
    store
        .set_workspace_favorite(&project.id, FavoriteScope::Project, &target, true)
        .unwrap();
    drop(store);
    let db = Connection::open(&metadata).unwrap();
    legacy_presets::restore_legacy_preset_schema(&db, false);
    db.execute_batch(
        "CREATE TABLE favorites_before_upgrade AS
           SELECT project_id, scope, kind, sqlite_id, postgres_id, ssh_id, object_name
           FROM workspace_favorites ORDER BY rowid;
         DROP TABLE backup_artifacts; DROP TABLE backup_runs; DROP TABLE backup_plans; DROP TABLE sql_parameter_sets; DROP TABLE native_db_profiles; DROP TABLE mysql_profiles; DROP TABLE redis_profiles; DROP TABLE workspace_favorites;
         ALTER TABLE favorites_before_upgrade RENAME TO workspace_favorites;
         CREATE INDEX workspace_favorite_sqlite_ref ON workspace_favorites(sqlite_id);
         CREATE INDEX workspace_favorite_postgres_ref ON workspace_favorites(postgres_id);
         CREATE INDEX workspace_favorite_ssh_ref ON workspace_favorites(ssh_id);
         ALTER TABLE sql_templates DROP COLUMN dialect;
         PRAGMA user_version=12;",
    )
    .unwrap();
    drop(db);

    let migrated = Store::open(&metadata).unwrap();
    let saved = migrated.list_workspace_favorites(&project.id).unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].scope, FavoriteScope::Project);
    assert_eq!(saved[0].target, target);
    let backup = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.to_string_lossy().contains(".v12-"))
        .unwrap();
    let backup = Connection::open(backup).unwrap();
    assert_eq!(
        backup
            .pragma_query_value(None, "integrity_check", |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        backup
            .query_row("SELECT object_name FROM workspace_favorites", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "report"
    );
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
    legacy_presets::restore_legacy_preset_schema(&db, false);
    db.execute_batch("DROP TABLE backup_artifacts; DROP TABLE backup_runs; DROP TABLE backup_plans; DROP TABLE sql_parameter_sets; DROP TABLE native_db_profiles; DROP TABLE mysql_profiles; DROP TABLE redis_profiles; DROP TABLE workspace_favorites; ALTER TABLE sql_templates DROP COLUMN dialect; PRAGMA user_version=11;")
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
