use rusqlite::Connection;
use stackport_core::{SshProfileInput, Store};

fn input(name: &str) -> SshProfileInput {
    SshProfileInput {
        name: name.into(),
        host: " Example.COM ".into(),
        port: 2222,
        username: "alice".into(),
        environment: "DEV".into(),
    }
}

#[test]
fn profiles_are_project_scoped_persistent_and_conflict_checked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let first = store.create_project("first").unwrap();
    let second = store.create_project("second").unwrap();
    let profile = store
        .create_ssh_profile(&first.id, input(" 서버 "))
        .unwrap();
    assert_eq!(profile.name, "서버");
    assert_eq!(profile.host, "example.com");
    assert_eq!(profile.revision, 1);
    assert!(store.list_ssh_profiles(&second.id).unwrap().is_empty());
    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.ssh_profile(&profile.id).unwrap(), profile);
    let mut changed = input("운영 서버");
    changed.environment = "PROD".into();
    let updated = reopened
        .update_ssh_profile(&profile.id, profile.revision, changed)
        .unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.environment, "PROD");
    assert!(store
        .update_ssh_profile(&profile.id, profile.revision, input("stale"))
        .is_err());
    assert!(store
        .delete_ssh_profile(&profile.id, profile.revision)
        .is_err());
    assert_eq!(store.ssh_profile(&profile.id).unwrap(), updated);
    store
        .delete_ssh_profile(&profile.id, updated.revision)
        .unwrap();
    assert!(store.ssh_profile(&profile.id).is_err());
    let history = store.list_audit_events(None).unwrap();
    let actions: Vec<_> = history
        .events
        .iter()
        .map(|event| event.operation.as_str())
        .collect();
    assert!(actions.contains(&"ssh_profile.create"));
    assert!(actions.contains(&"ssh_profile.update"));
    assert!(actions.contains(&"ssh_profile.delete"));
}

#[test]
fn validation_and_audit_failures_preserve_profile_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("test").unwrap();
    let mut bad = input("bad");
    bad.host = "-oProxyCommand=bad".into();
    assert!(store.create_ssh_profile(&project.id, bad).is_err());
    assert!(store.create_ssh_profile("missing", input("bad")).is_err());
    let profile = store
        .create_ssh_profile(&project.id, input("keep"))
        .unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_ssh_audit BEFORE INSERT ON audit_events WHEN NEW.operation LIKE 'ssh_profile.%' BEGIN SELECT RAISE(ABORT, 'audit failed'); END;").unwrap();
    assert!(store
        .create_ssh_profile(&project.id, input("blocked"))
        .is_err());
    assert!(store
        .update_ssh_profile(&profile.id, profile.revision, input("changed"))
        .is_err());
    assert!(store
        .delete_ssh_profile(&profile.id, profile.revision)
        .is_err());
    assert_eq!(
        store.list_ssh_profiles(&project.id).unwrap(),
        [profile.clone()]
    );
    db.execute_batch("DROP TRIGGER reject_ssh_audit; PRAGMA ignore_check_constraints=ON; UPDATE ssh_profiles SET environment='INVALID';").unwrap();
    assert!(store.ssh_profile(&profile.id).is_err());
    assert!(store.list_ssh_profiles(&project.id).is_err());
}

#[test]
fn deleting_a_project_removes_ssh_definitions_but_keeps_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("test").unwrap();
    let profile = store
        .create_ssh_profile(&project.id, input("host"))
        .unwrap();
    store.delete_project(&project.id).unwrap();
    assert!(store.ssh_profile(&profile.id).is_err());
    let history = store.list_audit_events(None).unwrap();
    let deletion = history
        .events
        .iter()
        .find(|event| event.operation == "project.delete")
        .unwrap();
    assert_eq!(deletion.affected_count, Some(2));
    assert!(history
        .events
        .iter()
        .any(|event| event.operation == "ssh_profile.create"));
}
