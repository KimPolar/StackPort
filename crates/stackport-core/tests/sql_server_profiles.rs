use stackport_core::{
    sql_server::{Authentication, Encryption, ProfileSettings},
    Store,
};

#[test]
fn saves_sql_server_profiles_without_credentials_and_copies_them() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("SQL Server 테스트").unwrap();
    let mut settings = ProfileSettings {
        name: "  보고서  ".into(),
        host: " LOCALHOST ".into(),
        port: 1433,
        database: "보고서 ] DB".into(),
        authentication: Authentication::SqlLogin,
        username: Some("reader".into()),
        encryption: Encryption::Strict,
        ca_path: None,
        environment: "PROD".into(),
    };
    let initial = store
        .create_sql_server_profile(&project.id, settings.clone())
        .unwrap();
    assert_eq!(initial.settings.name, "보고서");
    assert_eq!(initial.settings.host, "localhost");
    assert!(store
        .create_sql_server_profile(&project.id, settings.clone())
        .is_err());
    settings.authentication = Authentication::Windows;
    assert!(store
        .update_sql_server_profile(&initial.id, initial.revision, settings.clone())
        .is_err());
    settings.username = None;
    settings.port = 0;
    assert!(store
        .update_sql_server_profile(&initial.id, initial.revision, settings.clone())
        .is_err());
    settings.port = 1433;
    let edited = store
        .update_sql_server_profile(&initial.id, initial.revision, settings)
        .unwrap();
    assert!(store
        .sql_server_profile(&initial.id, initial.revision)
        .is_err());
    let duplicate = store
        .duplicate_project(&project.id, "복제한 SQL Server 테스트")
        .unwrap();
    let copied = store.list_sql_server_profiles(&duplicate.id).unwrap();
    assert_eq!(copied.len(), 1);
    assert_eq!(copied[0].settings, edited.settings);
    assert_ne!(copied[0].id, edited.id);
    store
        .delete_sql_server_profile(&edited.id, edited.revision)
        .unwrap();
    assert!(store
        .list_sql_server_profiles(&project.id)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.list_sql_server_profiles(&duplicate.id).unwrap().len(),
        1
    );
}
