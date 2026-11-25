use stackport_core::{
    oracle::{ProfileSettings, Target, Transport},
    Store,
};

#[test]
fn oracle_profiles_validate_targets_and_survive_project_duplication() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("Oracle 검증").unwrap();
    let mut settings = ProfileSettings {
        name: "문서".into(),
        host: " LOCALHOST ".into(),
        port: 2484,
        target: Target::ServiceName,
        service: "  FREEPDB1.db.example  ".into(),
        username: "Reader".into(),
        transport: Transport::Tcps,
        ca_path: None,
        environment: "PROD".into(),
    };
    let saved = store
        .create_oracle_profile(&project.id, settings.clone())
        .unwrap();
    assert_eq!(saved.settings.host, "localhost");
    assert_eq!(saved.settings.service, "FREEPDB1.db.example");
    assert!(store
        .create_oracle_profile(&project.id, settings.clone())
        .is_err());
    settings.service = "FREEPDB1)(SERVER=SHARED".into();
    assert!(store
        .update_oracle_profile(&saved.id, saved.revision, settings.clone())
        .is_err());
    settings.service = "FREE".into();
    settings.target = Target::Sid;
    settings.transport = Transport::Tcp;
    settings.port = 1521;
    settings.ca_path = Some(root.path().join("ca.pem").to_string_lossy().into_owned());
    assert!(store
        .update_oracle_profile(&saved.id, saved.revision, settings.clone())
        .is_err());
    settings.ca_path = None;
    let updated = store
        .update_oracle_profile(&saved.id, saved.revision, settings)
        .unwrap();
    assert!(store.oracle_profile(&saved.id, saved.revision).is_err());
    let duplicate = store.duplicate_project(&project.id, "Oracle 복제").unwrap();
    let copied = store.list_oracle_profiles(&duplicate.id).unwrap();
    assert_eq!(copied.len(), 1);
    assert_ne!(copied[0].id, updated.id);
    assert_eq!(copied[0].settings, updated.settings);
    store
        .delete_oracle_profile(&updated.id, updated.revision)
        .unwrap();
    assert!(store.list_oracle_profiles(&project.id).unwrap().is_empty());
}
