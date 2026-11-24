use rusqlite::Connection;
use stackport_core::{SshProfile, SshProfileInput, SshTunnelInput, SshTunnelKind, Store};

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
        kind: SshTunnelKind::Local,
        listen_port: 0,
        target_host: Some(" DATA.INVALID ".into()),
        target_port: Some(5432),
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
                target_port: Some(0),
                ..input.clone()
            }
        )
        .is_err());
    let saved = store.create_ssh_tunnel(&project.id, input.clone()).unwrap();
    assert_eq!(saved.settings.name, "Reporting");
    assert_eq!(saved.settings.target_host.as_deref(), Some("data.invalid"));
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
                listen_port: 7889,
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
    assert_eq!(copied.settings.listen_port, edited.settings.listen_port);
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
fn version_eight_tunnel_becomes_local_and_retains_its_revision_and_addresses() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("existing").unwrap();
    let profile = gateway(&store, &project.id);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE redis_profiles; DROP TABLE workspace_favorites; DROP TABLE table_query_presets; DROP TABLE postgres_profiles; DROP TABLE ssh_tunnels; CREATE TABLE ssh_tunnels (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ssh_profile_id TEXT NOT NULL REFERENCES ssh_profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE, local_port INTEGER NOT NULL CHECK(local_port BETWEEN 0 AND 65535),
        target_host TEXT NOT NULL, target_port INTEGER NOT NULL CHECK(target_port BETWEEN 1 AND 65535),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), UNIQUE(project_id, name)
    ); PRAGMA user_version=8;").unwrap();
    db.execute(
        "INSERT INTO ssh_tunnels VALUES ('legacy', ?1, ?2, 'Legacy', 6082, 'old.invalid', 8443, 6)",
        [&project.id, &profile.id],
    )
    .unwrap();
    drop(db);

    let migrated = Store::open(&path).unwrap();
    let legacy = migrated.ssh_tunnel("legacy").unwrap();
    assert_eq!(legacy.revision, 6);
    assert_eq!(legacy.settings.kind, SshTunnelKind::Local);
    assert_eq!(legacy.settings.listen_port, 6082);
    assert_eq!(legacy.settings.target_host.as_deref(), Some("old.invalid"));
    assert_eq!(legacy.settings.target_port, Some(8443));
    let remote = migrated
        .create_ssh_tunnel(
            &project.id,
            SshTunnelInput {
                kind: SshTunnelKind::Remote,
                ..tunnel(&profile)
            },
        )
        .unwrap();
    assert_eq!(remote.settings.kind, SshTunnelKind::Remote);
    let dynamic = SshTunnelInput {
        name: "Dynamic".into(),
        kind: SshTunnelKind::Dynamic,
        ..tunnel(&profile)
    };
    assert!(migrated
        .create_ssh_tunnel(&project.id, dynamic.clone())
        .is_err());
    let dynamic = migrated
        .create_ssh_tunnel(
            &project.id,
            SshTunnelInput {
                target_host: None,
                target_port: None,
                ..dynamic
            },
        )
        .unwrap();
    assert_eq!(
        migrated
            .ssh_tunnel(&dynamic.id)
            .unwrap()
            .settings
            .target_port,
        None
    );
    let backup = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|item| item.file_name().unwrap().to_string_lossy().contains(".v8-"))
        .unwrap();
    let old_port: u16 = Connection::open(backup)
        .unwrap()
        .query_row(
            "SELECT local_port FROM ssh_tunnels WHERE id='legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old_port, 6082);
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
        .execute_batch("DROP TABLE redis_profiles; DROP TABLE workspace_favorites; DROP TABLE table_query_presets; DROP TABLE postgres_profiles; DROP TABLE ssh_tunnels; PRAGMA user_version=7;")
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
