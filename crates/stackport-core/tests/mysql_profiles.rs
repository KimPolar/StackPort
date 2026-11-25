use rusqlite::Connection;
use stackport_core::{MysqlSettings, Store};

#[path = "support/legacy_presets.rs"]
mod legacy_presets;

#[test]
fn migrates_v14_and_keeps_mysql_profiles_project_scoped() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("MySQL 검증").unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    legacy_presets::restore_legacy_preset_schema(&db, false);
    db.execute_batch("DROP TABLE sql_parameter_sets; DROP TABLE native_db_profiles; DROP TABLE mysql_profiles; ALTER TABLE sql_templates DROP COLUMN dialect; PRAGMA user_version=14;")
        .unwrap();
    drop(db);

    let store = Store::open(&path).unwrap();
    let settings = MysqlSettings {
        name: "업무용 DB".into(),
        host: "localhost".into(),
        port: 3306,
        database: Some("inventory".into()),
        username: "catalog_reader".into(),
        environment: "PROD".into(),
        tls: true,
        ca_path: None,
        client_certificate_path: None,
        client_key_path: None,
    };
    let profile = store
        .create_mysql_profile(&project.id, settings.clone())
        .unwrap();
    let db = Connection::open(&path).unwrap();
    let stored: String = db
        .query_row(
            "SELECT settings_json FROM mysql_profiles WHERE id = ?1",
            [&profile.id],
            |row| row.get(0),
        )
        .unwrap();
    let mut legacy: serde_json::Value = serde_json::from_str(&stored).unwrap();
    let object = legacy.as_object_mut().unwrap();
    object.remove("client_certificate_path");
    object.remove("client_key_path");
    db.execute(
        "UPDATE mysql_profiles SET settings_json = ?1 WHERE id = ?2",
        [legacy.to_string(), profile.id.clone()],
    )
    .unwrap();
    drop(db);
    assert_eq!(
        store
            .mysql_profile(&profile.id, profile.revision)
            .unwrap()
            .settings,
        settings
    );
    let mut identity = MysqlSettings {
        name: "인증서 연결".into(),
        client_certificate_path: Some(
            directory
                .path()
                .join("client.pem")
                .to_string_lossy()
                .into_owned(),
        ),
        ..settings.clone()
    };
    assert!(store
        .create_mysql_profile(&project.id, identity.clone())
        .is_err());
    identity.client_key_path = Some(
        directory
            .path()
            .join("client.key")
            .to_string_lossy()
            .into_owned(),
    );
    let client_profile = store
        .create_mysql_profile(&project.id, identity.clone())
        .unwrap();
    assert_eq!(client_profile.settings, identity);
    assert!(store
        .update_mysql_profile(
            &client_profile.id,
            client_profile.revision,
            MysqlSettings {
                tls: false,
                ..identity
            }
        )
        .is_err());
    store
        .delete_mysql_profile(&client_profile.id, client_profile.revision)
        .unwrap();
    assert!(store
        .create_mysql_profile(&project.id, settings.clone())
        .is_err());
    let duplicate = store.duplicate_project(&project.id, "복제").unwrap();
    let copied = store.list_mysql_profiles(&duplicate.id).unwrap();
    assert_eq!(copied.len(), 1);
    assert_eq!(copied[0].settings, settings);
    assert_ne!(copied[0].id, profile.id);
    let changed = store
        .update_mysql_profile(
            &profile.id,
            profile.revision,
            MysqlSettings {
                port: 3307,
                ..settings
            },
        )
        .unwrap();
    assert!(store.mysql_profile(&profile.id, profile.revision).is_err());
    assert!(store
        .delete_mysql_profile(&profile.id, profile.revision)
        .is_err());
    store
        .delete_mysql_profile(&profile.id, changed.revision)
        .unwrap();
    assert!(store.list_mysql_profiles(&project.id).unwrap().is_empty());
    assert_eq!(store.list_mysql_profiles(&duplicate.id).unwrap().len(), 1);
}
