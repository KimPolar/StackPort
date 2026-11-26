use rusqlite::Connection;
use stackport_core::{RedisSettings, Store};

#[path = "support/legacy_presets.rs"]
mod legacy_presets;

#[test]
fn upgrades_v13_and_copies_redis_profiles_with_the_project() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("Redis 프로젝트").unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    legacy_presets::restore_legacy_preset_schema(&db, false);
    db.execute_batch("DROP TABLE backup_artifacts; DROP TABLE backup_runs; DROP TABLE backup_plans; DROP TABLE sql_parameter_sets; DROP TABLE native_db_profiles; DROP TABLE mysql_profiles; DROP TABLE redis_profiles; ALTER TABLE sql_templates DROP COLUMN dialect; PRAGMA user_version=13;")
        .unwrap();
    drop(db);

    let store = Store::open(&path).unwrap();
    let settings = RedisSettings {
        name: "캐시".into(),
        host: "localhost".into(),
        port: 6379,
        database: 2,
        username: "reader".into(),
        environment: "DEV".into(),
        tls: true,
        ca_path: None,
    };
    let profile = store
        .create_redis_profile(&project.id, settings.clone())
        .unwrap();
    let duplicate = store.duplicate_project(&project.id, "복제").unwrap();
    let copied = store.list_redis_profiles(&duplicate.id).unwrap();
    assert_eq!(copied.len(), 1);
    assert_eq!(copied[0].settings, settings);
    assert_ne!(copied[0].id, profile.id);
    let changed = store
        .update_redis_profile(
            &profile.id,
            profile.revision,
            RedisSettings {
                database: 4,
                ..settings
            },
        )
        .unwrap();
    assert!(store
        .delete_redis_profile(&profile.id, profile.revision)
        .is_err());
    store
        .delete_redis_profile(&changed.id, changed.revision)
        .unwrap();
    assert!(store.list_redis_profiles(&project.id).unwrap().is_empty());
}
