use rusqlite::Connection;
use stackport_core::{PostgresProfileInput, SshProfileInput, SshTunnelInput, SshTunnelKind, Store};

fn settings() -> PostgresProfileInput {
    PostgresProfileInput {
        name: "  Reporting  ".into(),
        host: " DATABASE.INVALID ".into(),
        port: 5432,
        database: "reports".into(),
        username: "read_only".into(),
        environment: "PROD".into(),
        ca_path: None,
    }
}

#[test]
fn postgres_profiles_are_project_scoped_versioned_and_copied() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("original").unwrap();
    let other = store.create_project("other").unwrap();
    let original = store
        .create_postgres_profile(&project.id, settings())
        .unwrap();
    assert!(store.list_postgres_profiles(&other.id).unwrap().is_empty());
    assert_eq!(original.settings.name, "Reporting");
    assert_eq!(original.settings.host, "database.invalid");
    assert!(store
        .create_postgres_profile(
            &project.id,
            PostgresProfileInput {
                name: "reporting".into(),
                ..settings()
            }
        )
        .is_err());
    assert!(store
        .create_postgres_profile(
            &project.id,
            PostgresProfileInput {
                port: 0,
                ..settings()
            }
        )
        .is_err());

    let updated = store
        .update_postgres_profile(
            &original.id,
            original.revision,
            PostgresProfileInput {
                port: 6543,
                ..original.settings.clone()
            },
        )
        .unwrap();
    assert_eq!(updated.revision, 2);
    assert!(store
        .update_postgres_profile(&original.id, original.revision, settings())
        .is_err());
    assert!(store
        .delete_postgres_profile(&original.id, original.revision)
        .is_err());
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.list_postgres_profiles(&project.id).unwrap(),
        [updated.clone()]
    );
    let copy = reopened.duplicate_project(&project.id, "copy").unwrap();
    let copied = &reopened.list_postgres_profiles(&copy.id).unwrap()[0];
    assert_ne!(copied.id, original.id);
    assert_eq!(copied.revision, 1);
    assert_eq!(copied.settings, updated.settings);
    reopened
        .delete_postgres_profile(&updated.id, updated.revision)
        .unwrap();
    reopened.delete_project(&copy.id).unwrap();
    assert!(reopened.postgres_profile(&copied.id).is_err());
    let audit = reopened.list_audit_events(None).unwrap();
    assert!(audit
        .events
        .iter()
        .any(|event| event.operation == "postgres_profile.delete"));
    let mut input = serde_json::to_value(settings()).unwrap();
    input["password"] = "fixture-only".into();
    assert!(serde_json::from_value::<PostgresProfileInput>(input).is_err());
}

#[test]
fn migration_from_nine_preserves_saved_tunnels_and_the_pre_migration_backup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("old").unwrap();
    let gateway = store
        .create_ssh_profile(
            &project.id,
            SshProfileInput {
                name: "Gateway".into(),
                host: "gateway.invalid".into(),
                port: 22,
                username: "operator".into(),
                environment: "DEV".into(),
            },
        )
        .unwrap();
    let tunnel = store
        .create_ssh_tunnel(
            &project.id,
            SshTunnelInput {
                name: "Forward".into(),
                ssh_profile_id: gateway.id,
                kind: SshTunnelKind::Local,
                listen_port: 0,
                target_host: Some("database.invalid".into()),
                target_port: Some(5432),
            },
        )
        .unwrap();
    Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE postgres_profiles; PRAGMA user_version=9;")
        .unwrap();

    let upgraded = Store::open(&path).unwrap();
    assert_eq!(upgraded.ssh_tunnel(&tunnel.id).unwrap(), tunnel);
    assert_eq!(
        upgraded
            .create_postgres_profile(&project.id, settings())
            .unwrap()
            .revision,
        1
    );
    let backup = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|item| item.unwrap().path())
        .find(|path| path.file_name().unwrap().to_string_lossy().contains(".v9-"))
        .expect("verified v9 backup");
    let db = Connection::open(backup).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        9
    );
    assert!(db.prepare("SELECT id FROM postgres_profiles").is_err());
    assert_eq!(
        db.query_row("SELECT id FROM ssh_tunnels", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        tunnel.id
    );
}
