use rusqlite::Connection;
use stackport_core::{SshProfile, SshProfileInput, SshTunnelInput, Store};

fn gateway(store: &Store, project: &str) -> SshProfile {
    store
        .create_ssh_profile(
            project,
            SshProfileInput {
                name: "Gateway".into(),
                host: "gateway.invalid".into(),
                port: 22,
                username: "operator".into(),
                environment: "PROD".into(),
            },
        )
        .unwrap()
}

fn tunnel(profile: &SshProfile) -> SshTunnelInput {
    SshTunnelInput {
        name: "  Reporting  ".into(),
        ssh_profile_id: profile.id.clone(),
        local_port: 0,
        target_host: " DATA.INVALID ".into(),
        target_port: 5432,
    }
}

#[test]
fn project_tunnel_settings_are_versioned_copied_with_new_ssh_id_and_cascade() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("one").unwrap();
    let other = store.create_project("two").unwrap();
    let profile = gateway(&store, &project.id);
    let input = tunnel(&profile);
    assert!(store.create_ssh_tunnel(&other.id, input.clone()).is_err());
    assert!(store
        .create_ssh_tunnel(
            &project.id,
            SshTunnelInput {
                target_port: 0,
                ..input.clone()
            }
        )
        .is_err());
    let saved = store.create_ssh_tunnel(&project.id, input.clone()).unwrap();
    assert_eq!(saved.settings.name, "Reporting");
    assert_eq!(saved.settings.target_host, "data.invalid");
    assert!(store
        .create_ssh_tunnel(
            &project.id,
            SshTunnelInput {
                name: "reporting".into(),
                ..input.clone()
            }
        )
        .is_err());
    let edited = store
        .update_ssh_tunnel(
            &saved.id,
            saved.revision,
            SshTunnelInput {
                local_port: 7889,
                ..input.clone()
            },
        )
        .unwrap();
    assert_eq!(edited.revision, 2);
    assert!(store
        .update_ssh_tunnel(&saved.id, saved.revision, input.clone())
        .is_err());
    assert!(store.delete_ssh_tunnel(&saved.id, saved.revision).is_err());
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.list_ssh_tunnels(&project.id).unwrap(),
        [edited.clone()]
    );
    let cloned = store.duplicate_project(&project.id, "copy").unwrap();
    let clone_profiles = store.list_ssh_profiles(&cloned.id).unwrap();
    let copied = &store.list_ssh_tunnels(&cloned.id).unwrap()[0];
    assert_eq!(copied.settings.local_port, edited.settings.local_port);
    assert_eq!(copied.settings.ssh_profile_id, clone_profiles[0].id);
    assert_ne!(copied.settings.ssh_profile_id, profile.id);
    assert_ne!(copied.id, saved.id);
    assert_eq!(copied.revision, 1);
    store
        .delete_ssh_profile(&profile.id, profile.revision)
        .unwrap();
    assert!(store.list_ssh_tunnels(&project.id).unwrap().is_empty());
    assert_eq!(store.ssh_tunnel(&copied.id).unwrap(), *copied);
    store
        .delete_ssh_tunnel(&copied.id, copied.revision)
        .unwrap();
    assert!(store.list_ssh_tunnels(&cloned.id).unwrap().is_empty());
}

#[test]
fn version_seven_migration_preserves_the_ssh_profile_and_previous_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("existing").unwrap();
    let profile = gateway(&store, &project.id);
    Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE ssh_tunnels; PRAGMA user_version=7;")
        .unwrap();

    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.ssh_profile(&profile.id).unwrap(), profile);
    assert!(reopened.list_ssh_tunnels(&project.id).unwrap().is_empty());
    reopened
        .create_ssh_tunnel(&project.id, tunnel(&profile))
        .unwrap();
    let backup = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|item| item.file_name().unwrap().to_string_lossy().contains(".v7-"))
        .unwrap();
    let backup = Connection::open(backup).unwrap();
    let version: i64 = backup
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 7);
    let schema: bool = backup
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'sql_templates')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(schema);
}
