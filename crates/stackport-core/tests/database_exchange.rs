use serde_json::Value;
use stackport_core::{
    database_exchange::{Engine, ImportSelection, Source},
    oracle, snowflake, sql_server, MongoSettings, MysqlSettings, PostgresProfileInput,
    RedisSettings, Store,
};
use std::fs;

#[test]
fn exchanges_all_database_families_and_requires_local_files_again() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("workspace.sqlite")).unwrap();
    let source = store.create_project("기존 환경").unwrap();
    let destination = store.create_project("새 환경").unwrap();
    let file = root.path().join("customer-data.sqlite");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute("CREATE TABLE example (id INTEGER PRIMARY KEY)", [])
        .unwrap();
    let file = file.to_str().unwrap();
    let old_local = |name| Some(root.path().join(name).to_string_lossy().into_owned());
    let pg = postgres("리포트", old_local("original-postgres-ca.pem"));
    store
        .create_sqlite_profile(&source.id, "SQLite 테스트", file, "DEV")
        .unwrap();
    store
        .create_postgres_profile(&source.id, pg.clone())
        .unwrap();
    let my = MysqlSettings {
        name: "계정".into(),
        host: "mysql.example.test".into(),
        port: 3307,
        database: Some("demo".into()),
        username: "reader".into(),
        environment: "PROD".into(),
        tls: true,
        ca_path: old_local("original-mysql-ca.pem"),
        client_certificate_path: old_local("original-client.pem"),
        client_key_path: old_local("original-private.key"),
    };
    store.create_mysql_profile(&source.id, my.clone()).unwrap();
    let redis = RedisSettings {
        name: "캐시".into(),
        host: "redis.example.test".into(),
        port: 6380,
        database: 3,
        username: "".into(),
        environment: "DEV".into(),
        tls: false,
        ca_path: None,
    };
    store
        .create_redis_profile(&source.id, redis.clone())
        .unwrap();
    let mongo = MongoSettings {
        name: "문서".into(),
        uri: "mongodb+srv://cluster.example.test/?readPreference=nearest".into(),
        username: Some("reader".into()),
        auth_database: Some("admin".into()),
        environment: "STAGING".into(),
        tls: true,
        ca_path: None,
    };
    store
        .create_mongo_profile(&source.id, mongo.clone())
        .unwrap();
    let mssql = sql_server::ProfileSettings {
        name: "Windows 인증".into(),
        host: "sql.example.test".into(),
        port: 1433,
        database: "report".into(),
        username: None,
        authentication: sql_server::Authentication::Windows,
        encryption: sql_server::Encryption::Strict,
        ca_path: None,
        environment: "DEV".into(),
    };
    store
        .create_sql_server_profile(&source.id, mssql.clone())
        .unwrap();
    let ora = oracle::ProfileSettings {
        name: "SID 연결".into(),
        host: "oracle.example.test".into(),
        port: 2484,
        target: oracle::Target::Sid,
        service: "DEMO".into(),
        username: "reader".into(),
        transport: oracle::Transport::Tcps,
        ca_path: None,
        environment: "DEV".into(),
    };
    store
        .create_oracle_profile(&source.id, ora.clone())
        .unwrap();
    let snow = snowflake::ProfileSettings {
        name: "웨어하우스".into(),
        host: "organization-account.snowflakecomputing.com".into(),
        database: "TEST_DB".into(),
        warehouse: Some("COMPUTE_WH".into()),
        role: Some("DATA_READER".into()),
        auth: snowflake::Auth::Oauth,
        environment: "STAGING".into(),
    };
    store
        .create_snowflake_profile(&source.id, snow.clone())
        .unwrap();
    store
        .create_postgres_profile(&source.id, postgres("선택 제외", None))
        .unwrap();

    let selected: Vec<_> = store
        .list_database_exchange_candidates(&source.id)
        .unwrap()
        .into_iter()
        .filter(|item| item.name != "선택 제외")
        .map(|item| item.source)
        .collect();
    assert_eq!(selected.len(), 8);
    let destination_file = root.path().join("connections.json");
    let destination_file = destination_file.to_str().unwrap();
    assert_eq!(
        store
            .export_database_profiles(&source.id, selected, destination_file)
            .unwrap()
            .count,
        8
    );
    let text = fs::read_to_string(destination_file).unwrap();
    assert!(!text.contains("original-"));
    assert!(!text.contains("선택 제외"));
    assert!(!text.contains("project_id"));
    assert!(!text.contains("revision"));
    assert!(!text.contains("ca_path"));
    assert!(!text.contains("client_key_path"));
    let doc: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(doc["version"], 1);
    assert_eq!(doc["format"], "stackport.database-profiles");
    let sqlite_file = doc["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["connection"]["engine"] == "sqlite")
        .unwrap();
    assert_eq!(
        sqlite_file["connection"]["settings"]["file_name"],
        "customer-data.sqlite"
    );

    let preview = store
        .preview_database_profile_import(destination_file)
        .unwrap();
    let selected = || {
        preview
            .profiles
            .iter()
            .enumerate()
            .map(|(index, profile)| {
                let mut selection = selection(index);
                if profile.engine == Engine::Sqlite {
                    selection.sqlite_path = Some(file.into());
                    selection.name = Some("이름 변경한 SQLite".into());
                }
                if profile.requires_ca {
                    selection.ca_path = old_local(match profile.engine {
                        Engine::Mysql => "selected-mysql-ca.pem",
                        Engine::Postgres => "selected-postgres-ca.pem",
                        _ => panic!("Unexpected custom CA engine"),
                    });
                }
                if profile.requires_client_identity {
                    assert_eq!(profile.engine, Engine::Mysql);
                    selection.client_certificate_path = old_local("selected-client.pem");
                    selection.client_key_path = old_local("selected-private.key");
                }
                selection
            })
            .collect::<Vec<_>>()
    };
    let mut incomplete = selected();
    let mysql = preview
        .profiles
        .iter()
        .position(|item| item.engine == Engine::Mysql)
        .unwrap();
    incomplete[mysql].client_key_path = None;
    assert!(store
        .import_database_profiles(
            &destination.id,
            destination_file,
            &preview.digest,
            incomplete
        )
        .is_err());
    assert!(store
        .list_database_exchange_candidates(&destination.id)
        .unwrap()
        .is_empty());

    assert_eq!(
        store
            .import_database_profiles(
                &destination.id,
                destination_file,
                &preview.digest,
                selected()
            )
            .unwrap(),
        8
    );
    assert_eq!(
        store.list_profiles(&destination.id).unwrap()[0].name,
        "이름 변경한 SQLite"
    );
    let pg_created = store
        .list_postgres_profiles(&destination.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        pg_created.settings,
        PostgresProfileInput {
            ca_path: old_local("selected-postgres-ca.pem"),
            ..pg
        }
    );
    let my_created = store
        .list_mysql_profiles(&destination.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        my_created.settings,
        MysqlSettings {
            ca_path: old_local("selected-mysql-ca.pem"),
            client_certificate_path: old_local("selected-client.pem"),
            client_key_path: old_local("selected-private.key"),
            ..my
        }
    );
    assert_eq!(
        store.list_redis_profiles(&destination.id).unwrap()[0].settings,
        redis
    );
    assert_eq!(
        store.list_mongo_profiles(&destination.id).unwrap()[0].settings,
        mongo
    );
    assert_eq!(
        store.list_sql_server_profiles(&destination.id).unwrap()[0].settings,
        mssql
    );
    assert_eq!(
        store.list_oracle_profiles(&destination.id).unwrap()[0].settings,
        ora
    );
    assert_eq!(
        store.list_snowflake_profiles(&destination.id).unwrap()[0].settings,
        snow
    );
}

#[test]
fn refuses_stale_or_cross_project_selections_and_rolls_back_name_conflicts() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("workspace.sqlite")).unwrap();
    let source = store.create_project("출발").unwrap();
    let destination = store.create_project("도착").unwrap();
    let first = store
        .create_postgres_profile(&source.id, postgres("Alpha", None))
        .unwrap();
    let second = store
        .create_postgres_profile(&source.id, postgres("Beta", None))
        .unwrap();
    let selection_source = || Source {
        engine: Engine::Postgres,
        id: first.id.clone(),
        revision: Some(first.revision),
    };
    let output = root.path().join("selected.json");
    let output = output.to_str().unwrap();
    assert!(store
        .export_database_profiles(&destination.id, vec![selection_source()], output)
        .is_err());
    assert!(store
        .export_database_profiles(
            &source.id,
            vec![selection_source(), selection_source()],
            output
        )
        .is_err());
    store
        .update_postgres_profile(&first.id, first.revision, postgres("Alpha", None))
        .unwrap();
    assert!(store
        .export_database_profiles(&source.id, vec![selection_source()], output)
        .is_err());
    assert!(!std::path::Path::new(output).exists());
    let all = || {
        store
            .list_database_exchange_candidates(&source.id)
            .unwrap()
            .into_iter()
            .map(|profile| profile.source)
            .collect()
    };
    store
        .export_database_profiles(&source.id, all(), output)
        .unwrap();
    let bytes = fs::read(output).unwrap();
    assert!(store
        .export_database_profiles(&source.id, all(), output)
        .is_err());
    assert_eq!(fs::read(output).unwrap(), bytes);
    let preview = store.preview_database_profile_import(output).unwrap();
    store
        .create_postgres_profile(&destination.id, second.settings)
        .unwrap();
    assert!(store
        .import_database_profiles(
            &destination.id,
            output,
            &preview.digest,
            vec![selection(0), selection(1)]
        )
        .is_err());
    let remaining = store.list_postgres_profiles(&destination.id).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].settings.name, "Beta");
    let mut rename = selection(1);
    rename.name = Some("Beta 읽기".into());
    assert_eq!(
        store
            .import_database_profiles(&destination.id, output, &preview.digest, vec![rename])
            .unwrap(),
        1
    );
    let mut changed = bytes;
    changed.push(b'\n');
    fs::write(output, changed).unwrap();
    assert!(store
        .import_database_profiles(&destination.id, output, &preview.digest, vec![selection(0)])
        .is_err());
    assert_eq!(
        store.list_postgres_profiles(&destination.id).unwrap().len(),
        2
    );
    let history = store.list_audit_events(None).unwrap();
    assert!(history
        .events
        .iter()
        .any(|item| item.operation == "database_profile.export" && item.outcome == "failed"));
    assert!(history
        .events
        .iter()
        .any(|item| item.operation == "database_profile.import" && item.affected_count == Some(1)));
}

#[test]
fn rejects_secret_fields_and_external_paths_from_the_document() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("파일 검증").unwrap();
    store
        .create_postgres_profile(&project.id, postgres("서버", None))
        .unwrap();
    let output = root.path().join("connections.json");
    let output = output.to_str().unwrap();
    let selected = store
        .list_database_exchange_candidates(&project.id)
        .unwrap()
        .into_iter()
        .map(|item| item.source)
        .collect();
    store
        .export_database_profiles(&project.id, selected, output)
        .unwrap();
    let document: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    for (property, value) in [
        ("password", "never-store"),
        ("ca_path", "local-path-from-import"),
        ("client_key_path", "local-private-key-from-import"),
    ] {
        let mut modified = document.clone();
        modified["profiles"][0]["connection"]["settings"][property] = Value::String(value.into());
        fs::write(output, serde_json::to_vec(&modified).unwrap()).unwrap();
        assert!(store.preview_database_profile_import(output).is_err());
    }
    let mut future = document;
    future["version"] = Value::from(2);
    fs::write(output, serde_json::to_vec(&future).unwrap()).unwrap();
    assert!(store.preview_database_profile_import(output).is_err());
}

fn postgres(name: &str, ca_path: Option<String>) -> PostgresProfileInput {
    PostgresProfileInput {
        name: name.into(),
        host: "postgres.example.test".into(),
        port: 5432,
        database: "report".into(),
        username: "reader".into(),
        ca_path,
        environment: "DEV".into(),
    }
}

fn selection(index: usize) -> ImportSelection {
    ImportSelection {
        index,
        name: None,
        sqlite_path: None,
        ca_path: None,
        client_certificate_path: None,
        client_key_path: None,
    }
}
