use rusqlite::Connection;
use stackport_core::{DatabaseFolderEngine as Engine, PostgresProfileInput, Store};

#[test]
fn folders_scope_moves_and_preserve_same_named_profiles_in_project_copies() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace.sqlite");
    let store = Store::open(&workspace).unwrap();
    let project = store.create_project("개발").unwrap().id;
    let other = store.create_project("별도 작업").unwrap().id;
    let root = store
        .create_database_folder(&project, None, "Deploy")
        .unwrap();
    assert!(store
        .create_database_folder(&project, None, "deploy")
        .is_err());
    let qa = store
        .create_database_folder(&project, Some(&root.id), "QA")
        .unwrap();
    let ops = store
        .create_database_folder(&project, None, "운영")
        .unwrap();
    let another_qa = store
        .create_database_folder(&project, Some(&ops.id), "QA")
        .unwrap();
    let unrelated = store
        .create_database_folder(&other, None, "다른 폴더")
        .unwrap();
    assert!(store
        .create_database_folder(&project, Some(&unrelated.id), "실패")
        .is_err());
    assert!(store
        .update_database_folder(&project, &root.id, root.revision, Some(&qa.id), "Deploy")
        .is_err());
    assert!(store
        .update_database_folder(&project, &qa.id, qa.revision, Some(&ops.id), "QA")
        .is_err());

    let create_sqlite = |name| {
        let file = temp.path().join(name);
        Connection::open(&file)
            .unwrap()
            .execute_batch("CREATE TABLE fixture(value INTEGER);")
            .unwrap();
        store
            .create_sqlite_profile(&project, "공통 이름", file.to_str().unwrap(), "DEV")
            .unwrap()
    };
    let first = create_sqlite("first.sqlite");
    let second = create_sqlite("second.sqlite");
    let postgres = store
        .create_postgres_profile(
            &project,
            PostgresProfileInput {
                name: "백엔드".into(),
                host: "localhost".into(),
                port: 5432,
                database: "postgres".into(),
                username: "fixture".into(),
                environment: "DEV".into(),
                ca_path: None,
            },
        )
        .unwrap();
    assert!(store
        .move_database_connection(
            &project,
            Engine::Sqlite,
            &first.id,
            None,
            Some(&unrelated.id)
        )
        .is_err());
    assert!(store
        .move_database_connection(&other, Engine::Sqlite, &first.id, None, Some(&unrelated.id))
        .is_err());
    assert!(store
        .move_database_connection(&project, Engine::Mysql, &postgres.id, None, Some(&qa.id))
        .is_err());
    store
        .move_database_connection(&project, Engine::Sqlite, &first.id, None, Some(&qa.id))
        .unwrap();
    store
        .move_database_connection(
            &project,
            Engine::Sqlite,
            &second.id,
            None,
            Some(&another_qa.id),
        )
        .unwrap();
    store
        .move_database_connection(&project, Engine::Postgres, &postgres.id, None, Some(&qa.id))
        .unwrap();
    assert!(store
        .move_database_connection(&project, Engine::Sqlite, &first.id, None, None)
        .is_err());
    assert_eq!(
        store.postgres_profile(&postgres.id).unwrap().revision,
        postgres.revision
    );

    let renamed = store
        .update_database_folder(&project, &qa.id, qa.revision, Some(&ops.id), "검증")
        .unwrap();
    assert_eq!(renamed.revision, qa.revision + 1);
    assert!(store
        .delete_database_folder(&project, &qa.id, qa.revision)
        .is_err());
    let duplicate = store.duplicate_project(&project, "개발 복제").unwrap();
    let copied = store.database_folders(&duplicate.id).unwrap();
    assert_eq!(copied.folders.len(), 4);
    assert_eq!(copied.placements.len(), 3);
    for (path, expected_folder) in [(first.path, "검증"), (second.path, "QA")] {
        let profile = store
            .list_profiles(&duplicate.id)
            .unwrap()
            .into_iter()
            .find(|profile| profile.path == path)
            .unwrap();
        let placement = copied
            .placements
            .iter()
            .find(|placement| placement.profile_id == profile.id)
            .unwrap();
        let folder = copied
            .folders
            .iter()
            .find(|folder| folder.id == placement.folder_id)
            .unwrap();
        assert_eq!(folder.name, expected_folder);
    }
    assert!(copied
        .folders
        .iter()
        .all(|folder| folder.id != root.id && folder.id != ops.id));

    store
        .delete_database_folder(&project, &renamed.id, renamed.revision)
        .unwrap();
    let state = Store::open(&workspace)
        .unwrap()
        .database_folders(&project)
        .unwrap();
    assert!(state
        .placements
        .iter()
        .any(|item| item.profile_id == first.id && item.folder_id == ops.id));
    assert!(state
        .placements
        .iter()
        .any(|item| item.profile_id == postgres.id && item.folder_id == ops.id));
    store
        .delete_database_folder(&project, &ops.id, ops.revision)
        .unwrap();
    let state = store.database_folders(&project).unwrap();
    assert_eq!(state.folders.len(), 1);
    assert!(state.placements.is_empty());
    assert_eq!(store.list_profiles(&project).unwrap().len(), 2);
    assert_eq!(
        store
            .database_folders(&duplicate.id)
            .unwrap()
            .placements
            .len(),
        3
    );
}

#[test]
fn migration_from_v33_leaves_existing_profiles_at_the_root() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("테스트").unwrap();
    let source = temp.path().join("source.sqlite");
    Connection::open(&source)
        .unwrap()
        .execute_batch("CREATE TABLE fixture(value INTEGER);")
        .unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "원래 연결", source.to_str().unwrap(), "DEV")
        .unwrap();
    let db = Connection::open(&path).unwrap();
    for table in [
        "profiles",
        "postgres_profiles",
        "mysql_profiles",
        "redis_profiles",
        "native_db_profiles",
    ] {
        db.execute_batch(&format!(
            "DROP INDEX {table}_folder; ALTER TABLE {table} DROP COLUMN folder_id;"
        ))
        .unwrap();
    }
    db.execute_batch("DROP TABLE database_folders; PRAGMA user_version=33;")
        .unwrap();
    drop(db);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.list_profiles(&project.id).unwrap()[0].id,
        profile.id
    );
    let folders = reopened.database_folders(&project.id).unwrap();
    assert!(folders.folders.is_empty() && folders.placements.is_empty());
}
