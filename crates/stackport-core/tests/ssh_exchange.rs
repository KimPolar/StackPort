use rusqlite::Connection;
use serde_json::{json, Value};
use stackport_core::{SshProfileInput, Store};
use std::{fs, path::Path};

fn input(name: &str, environment: &str) -> SshProfileInput {
    SshProfileInput {
        name: name.into(),
        host: "server.example.com".into(),
        port: 22,
        username: "alice".into(),
        environment: environment.into(),
    }
}

#[test]
fn selected_profiles_round_trip_without_credentials_or_trust() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let source = store.create_project("source").unwrap();
    let destination = store.create_project("destination").unwrap();
    let one = store
        .create_ssh_profile(&source.id, input("selected", "PROD"))
        .unwrap();
    store
        .create_ssh_profile(&source.id, input("excluded", "DEV"))
        .unwrap();
    let file = dir.path().join("selected.json");
    let report = store
        .export_ssh_profiles(&source.id, vec![one.clone()], file.to_str().unwrap())
        .unwrap();
    assert_eq!(report.count, 1);
    assert!(report.audit_warning.is_none());
    let value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(value["format"], "stackport.ssh-profiles");
    assert_eq!(value["version"], 1);
    assert_eq!(value["profiles"].as_array().unwrap().len(), 1);
    assert_eq!(value["profiles"][0]["name"], "selected");
    assert_eq!(value["profiles"][0].as_object().unwrap().len(), 5);
    let preview = store
        .preview_ssh_profile_import(file.to_str().unwrap())
        .unwrap();
    assert_eq!(preview.profiles[0].environment, "PROD");
    let imported = store
        .import_ssh_profiles(
            &destination.id,
            file.to_str().unwrap(),
            &preview.digest,
            vec![0],
        )
        .unwrap();
    assert_eq!(imported.len(), 1);
    assert_ne!(imported[0].id, one.id);
    assert_eq!(imported[0].project_id, destination.id);
    assert_eq!(imported[0].environment, "PROD");
    assert_eq!(store.list_ssh_profiles(&destination.id).unwrap(), imported);
    let history = store.list_audit_events(None).unwrap();
    for action in ["ssh_profile.export", "ssh_profile.import"] {
        assert!(history
            .events
            .iter()
            .any(|event| event.operation == action && event.outcome == "succeeded"));
    }
}

#[test]
fn import_requires_the_reviewed_file_and_valid_unique_selection() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("test").unwrap();
    let source = store
        .create_ssh_profile(&project.id, input("source", "DEV"))
        .unwrap();
    let file = dir.path().join("exchange.json");
    store
        .export_ssh_profiles(&project.id, vec![source], file.to_str().unwrap())
        .unwrap();
    let preview = store
        .preview_ssh_profile_import(file.to_str().unwrap())
        .unwrap();
    for selection in [vec![], vec![1], vec![0, 0]] {
        assert!(store
            .import_ssh_profiles(
                &project.id,
                file.to_str().unwrap(),
                &preview.digest,
                selection
            )
            .is_err());
    }
    let mut value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    value["profiles"][0]["host"] = json!("changed.example.com");
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(store
        .import_ssh_profiles(
            &project.id,
            file.to_str().unwrap(),
            &preview.digest,
            vec![0]
        )
        .unwrap_err()
        .contains("변경"));
    assert_eq!(store.list_ssh_profiles(&project.id).unwrap().len(), 1);

    value["profiles"][0]["password"] = json!("not-accepted");
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(store
        .preview_ssh_profile_import(file.to_str().unwrap())
        .is_err());
    value["profiles"][0]
        .as_object_mut()
        .unwrap()
        .remove("password");
    value["profiles"][0]["environment"] = json!("INVALID");
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(store
        .preview_ssh_profile_import(file.to_str().unwrap())
        .is_err());
    value["profiles"][0]["environment"] = json!("DEV");
    value["version"] = json!(2);
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(store
        .preview_ssh_profile_import(file.to_str().unwrap())
        .is_err());
    fs::write(&file, vec![b' '; 1_048_577]).unwrap();
    assert!(store
        .preview_ssh_profile_import(file.to_str().unwrap())
        .is_err());
}

#[test]
fn export_never_overwrites_and_rejects_stale_or_cross_project_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("test").unwrap();
    let other = store.create_project("other").unwrap();
    let profile = store
        .create_ssh_profile(&project.id, input("source", "DEV"))
        .unwrap();
    let file = dir.path().join("existing.json");
    fs::write(&file, "preserve").unwrap();
    assert!(store
        .export_ssh_profiles(&project.id, vec![profile.clone()], file.to_str().unwrap())
        .is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "preserve");
    let new_file = dir.path().join("new.json");
    assert!(store
        .export_ssh_profiles(&other.id, vec![profile.clone()], new_file.to_str().unwrap())
        .is_err());
    assert!(store
        .export_ssh_profiles(
            &project.id,
            vec![profile.clone(), profile.clone()],
            new_file.to_str().unwrap()
        )
        .is_err());
    store
        .update_ssh_profile(&profile.id, profile.revision, input("updated", "PROD"))
        .unwrap();
    assert!(store
        .export_ssh_profiles(&project.id, vec![profile], new_file.to_str().unwrap())
        .is_err());
    assert!(!Path::new(&new_file).exists());
}

#[test]
fn failed_import_audit_rolls_back_all_selected_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let source = store.create_project("source").unwrap();
    let destination = store.create_project("destination").unwrap();
    let first = store
        .create_ssh_profile(&source.id, input("first", "DEV"))
        .unwrap();
    let second = store
        .create_ssh_profile(&source.id, input("second", "PROD"))
        .unwrap();
    let file = dir.path().join("exchange.json");
    store
        .export_ssh_profiles(&source.id, vec![first, second], file.to_str().unwrap())
        .unwrap();
    let preview = store
        .preview_ssh_profile_import(file.to_str().unwrap())
        .unwrap();
    let select_destination = store.create_project("select one").unwrap();
    let selected = store
        .import_ssh_profiles(
            &select_destination.id,
            file.to_str().unwrap(),
            &preview.digest,
            vec![1],
        )
        .unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].name, "second");
    let db = Connection::open(path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_import BEFORE INSERT ON audit_events WHEN NEW.operation = 'ssh_profile.import' BEGIN SELECT RAISE(ABORT, 'audit failed'); END;").unwrap();
    assert!(store
        .import_ssh_profiles(
            &destination.id,
            file.to_str().unwrap(),
            &preview.digest,
            vec![0, 1]
        )
        .is_err());
    assert!(store.list_ssh_profiles(&destination.id).unwrap().is_empty());
}

#[test]
fn export_reports_completion_audit_failure_after_preserving_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("test").unwrap();
    let profile = store
        .create_ssh_profile(&project.id, input("source", "DEV"))
        .unwrap();
    let db = Connection::open(path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_export_end BEFORE INSERT ON audit_events WHEN NEW.operation = 'ssh_profile.export' AND NEW.outcome <> 'started' BEGIN SELECT RAISE(ABORT, 'audit failed'); END;").unwrap();
    let file = dir.path().join("export.json");
    let report = store
        .export_ssh_profiles(&project.id, vec![profile.clone()], file.to_str().unwrap())
        .unwrap();
    assert!(report.audit_warning.is_some());
    assert!(store
        .preview_ssh_profile_import(file.to_str().unwrap())
        .is_ok());
    db.execute_batch("DROP TRIGGER reject_export_end; CREATE TRIGGER reject_export_start BEFORE INSERT ON audit_events WHEN NEW.operation = 'ssh_profile.export' BEGIN SELECT RAISE(ABORT, 'audit failed'); END;").unwrap();
    let blocked = dir.path().join("blocked.json");
    assert!(store
        .export_ssh_profiles(&project.id, vec![profile], blocked.to_str().unwrap())
        .is_err());
    assert!(!blocked.exists());
}
