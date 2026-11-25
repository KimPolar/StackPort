use rusqlite::Connection;
use stackport_core::{MysqlSettings, Store};

#[test]
fn migrates_v14_and_keeps_mysql_profiles_project_scoped() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("MySQL 검증").unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE mysql_profiles; PRAGMA user_version=14;")
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
    };
    let profile = store
        .create_mysql_profile(&project.id, settings.clone())
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
