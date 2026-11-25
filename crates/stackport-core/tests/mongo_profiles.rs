use rusqlite::Connection;
use stackport_core::{MongoSettings, Store};

#[test]
fn preserves_version_sixteen_projects_and_validates_mongodb_profiles() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("기존 연결").unwrap();
    drop(store);
    let old = Connection::open(&path).unwrap();
    old.execute_batch("DROP TABLE native_db_profiles; PRAGMA user_version=16;")
        .unwrap();
    drop(old);
    let store = Store::open(&path).unwrap();
    let mut settings = MongoSettings {
        name: "문서 연결".into(),
        uri: "mongodb://localhost:27017/records?authSource=admin&directConnection=true".into(),
        username: Some("reader".into()),
        auth_database: None,
        environment: "PROD".into(),
        tls: true,
        ca_path: None,
    };
    let initial = store
        .create_mongo_profile(&project.id, settings.clone())
        .unwrap();
    assert_eq!(initial.settings, settings);
    assert!(store
        .create_mongo_profile(&project.id, settings.clone())
        .is_err());
    for uri in [
        "mongodb://u:s@localhost",
        "mongodb://localhost/?tlsAllowInvalidCertificates=true",
        "mongodb://localhost/?proxyHost=elsewhere",
    ] {
        assert!(store
            .update_mongo_profile(
                &initial.id,
                initial.revision,
                MongoSettings {
                    uri: uri.into(),
                    ..settings.clone()
                }
            )
            .is_err());
    }
    settings.uri = "mongodb+srv://cluster.example.org/records?retryWrites=true&w=majority".into();
    assert!(store
        .update_mongo_profile(
            &initial.id,
            initial.revision,
            MongoSettings {
                tls: false,
                ..settings.clone()
            }
        )
        .is_err());
    let updated = store
        .update_mongo_profile(&initial.id, initial.revision, settings.clone())
        .unwrap();
    assert!(store.mongo_profile(&initial.id, initial.revision).is_err());
    let duplicate = store.duplicate_project(&project.id, "복제한 연결").unwrap();
    let copied = store.list_mongo_profiles(&duplicate.id).unwrap();
    assert_eq!(copied.len(), 1);
    assert_ne!(copied[0].id, initial.id);
    assert_eq!(copied[0].settings, settings);
    assert_eq!(copied[0].revision, 1);
    store
        .delete_mongo_profile(&updated.id, updated.revision)
        .unwrap();
    assert!(store.list_mongo_profiles(&project.id).unwrap().is_empty());
}
