use rusqlite::{params, Connection};
use serde_json::{json, Value as Json};
use stackport_core::{
    QueryOutcome, SqlParameterSetScope, SqlParameterSetWrite, SqlParameterValue, Store,
};

#[test]
fn discovers_sqlite_slots_and_binds_repeatable_typed_values() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let literal = "quote' ; %와 _";
    let db = Connection::open(&source).unwrap();
    db.execute("CREATE TABLE data (id INTEGER PRIMARY KEY, name TEXT)", [])
        .unwrap();
    db.execute("INSERT INTO data VALUES (1, ?1), (2, 'other')", [literal])
        .unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("parameters").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "fixture", source.to_str().unwrap(), "DEV")
        .unwrap();
    let sql = "SELECT id, :max, ?, @real, hex($bytes), $nullable IS NULL FROM data WHERE name = :search AND :search IS NOT NULL";
    let first_token = store.prepare_query().unwrap();
    let outcome = store
        .query_prepared(&first_token, &profile.id, sql, 0)
        .unwrap();
    let QueryOutcome::ParametersRequired { parameters, .. } = outcome else {
        panic!("expected parameters before execution");
    };
    let slots: Vec<_> = parameters
        .iter()
        .map(|parameter| (parameter.index, parameter.name.as_deref()))
        .collect();
    assert_eq!(
        slots,
        [
            (1, Some(":max")),
            (2, None),
            (3, Some("@real")),
            (4, Some("$bytes")),
            (5, Some("$nullable")),
            (6, Some(":search"))
        ]
    );
    assert!(store
        .query_prepared(&first_token, &profile.id, sql, 0)
        .is_err());

    let values = [
        SqlParameterValue::Integer(i64::MAX.to_string()),
        SqlParameterValue::Text(String::new()),
        SqlParameterValue::Real("12.5".into()),
        SqlParameterValue::Blob("00ff".into()),
        SqlParameterValue::Null,
        SqlParameterValue::Text(literal.into()),
    ];
    let token = store.prepare_query().unwrap();
    let result = store
        .query_prepared_with_parameters(&token, &profile.id, sql, 0, Some(&values))
        .unwrap();
    let QueryOutcome::Completed { result } = result else {
        panic!("expected a result");
    };
    assert_eq!(result.rows.len(), 1);
    assert_eq!(
        result.rows[0]
            .iter()
            .map(|cell| cell.display.as_str())
            .collect::<Vec<_>>(),
        ["1", "9223372036854775807", "", "12.5", "00FF", "1"]
    );

    let token = store.prepare_query().unwrap();
    assert!(store
        .query_prepared_with_parameters(&token, &profile.id, sql, 0, Some(&values[..2]))
        .unwrap_err()
        .contains("개수"));
    let token = store.prepare_query().unwrap();
    let invalid = [SqlParameterValue::Integer(
        "not-a-secret-in-the-error".into(),
    )];
    let error = store
        .query_prepared_with_parameters(&token, &profile.id, "SELECT ?", 0, Some(&invalid))
        .unwrap_err();
    assert!(!error.contains("not-a-secret-in-the-error"));
    let token = store.prepare_query().unwrap();
    assert!(store
        .query_prepared_with_parameters(
            &token,
            &profile.id,
            "DELETE FROM data WHERE name = ?",
            0,
            Some(&values[5..])
        )
        .is_err());
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM data WHERE name IN (?1, ?2)",
            params![literal, "other"],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[test]
fn parameter_sets_migrate_and_keep_one_default_per_sql_and_project() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("original").unwrap();
    let unrelated = store.create_project("unrelated").unwrap();
    drop(store);
    let old = Connection::open(&path).unwrap();
    old.execute_batch("DROP TABLE sql_parameter_sets; PRAGMA user_version = 18;")
        .unwrap();
    drop(old);

    let store = Store::open(&path).unwrap();
    let backup = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("workspace.sqlite.v18-")
        })
        .unwrap();
    let backup = Connection::open(backup).unwrap();
    assert_eq!(
        backup
            .pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        18
    );
    let scope = |project_id: &str, engine: &str, token: char| -> SqlParameterSetScope {
        serde_json::from_value(json!({ "project_id": project_id, "engine": engine, "key": token.to_string().repeat(64) })).unwrap()
    };
    let current = scope(&project.id, "sqlite", 'a');
    let values = json!([
        { "kind": "value", "value": { "kind": "integer", "value": "9223372036854775807" } },
        { "kind": "value", "value": { "kind": "blob", "value": "00fe" } },
        { "kind": "value", "value": { "kind": "null" } },
        { "kind": "secret", "value_kind": "text" }
    ]);
    let create = |name| -> SqlParameterSetWrite {
        serde_json::from_value(json!({ "kind": "create", "input": { "name": name, "is_default": true, "values": values } })).unwrap()
    };
    let first = serde_json::to_value(
        store
            .save_sql_parameter_set(&current, create("first"))
            .unwrap(),
    )
    .unwrap();
    let first_id = first["id"].as_str().unwrap();
    let second = serde_json::to_value(
        store
            .save_sql_parameter_set(&current, create("second"))
            .unwrap(),
    )
    .unwrap();
    let second_id = second["id"].as_str().unwrap();
    assert!(store
        .save_sql_parameter_set(&current, create("SECOND"))
        .is_err());
    let stale_update = serde_json::from_value(json!({
        "kind": "update", "id": first_id, "revision": 1,
        "input": { "name": "stale", "is_default": true, "values": values }
    }))
    .unwrap();
    assert!(store
        .save_sql_parameter_set(&current, stale_update)
        .is_err());
    assert!(store.read_sql_parameter_set(&current, first_id, 1).is_err());
    let summary = serde_json::to_value(store.list_sql_parameter_sets(&current).unwrap()).unwrap();
    assert_eq!(summary[0]["id"], second_id);
    assert_eq!(summary[0]["is_default"], true);
    assert_eq!(summary[1]["is_default"], false);
    assert_eq!(summary[1]["revision"], 2);
    assert_eq!(
        serde_json::to_value(store.read_sql_parameter_set(&current, first_id, 2).unwrap()).unwrap()
            ["values"],
        values
    );

    for other in [
        scope(&project.id, "postgres", 'a'),
        scope(&project.id, "sqlite", 'b'),
        scope(&unrelated.id, "sqlite", 'a'),
    ] {
        assert!(store.list_sql_parameter_sets(&other).unwrap().is_empty());
        assert!(store.read_sql_parameter_set(&other, first_id, 2).is_err());
        assert!(store.delete_sql_parameter_set(&other, first_id, 2).is_err());
    }
    assert!(store
        .save_sql_parameter_set(
            &scope(&project.id, "postgres_script", 'c'),
            create("invalid-type")
        )
        .is_err());
    assert!(serde_json::from_value::<SqlParameterSetWrite>(json!({
        "kind": "create",
        "input": { "name": "invalid secret", "is_default": false,
          "values": [{ "kind": "secret", "value_kind": "text", "value": "fixture-private" }] }
    }))
    .is_err());
    let duplicate = store.duplicate_project(&project.id, "copy").unwrap();
    let copied = serde_json::to_value(
        store
            .list_sql_parameter_sets(&scope(&duplicate.id, "sqlite", 'a'))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(copied[0]["name"], "second");
    assert_ne!(copied[0]["id"], second_id);
    store
        .delete_sql_parameter_set(&current, first_id, 2)
        .unwrap();
    drop(store);
    let saved = Store::open(&path).unwrap();
    let persisted: Json = serde_json::to_value(
        saved
            .read_sql_parameter_set(&current, second_id, 1)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(persisted["values"], values);
    saved.archive_project(&project.id).unwrap();
    assert!(saved.list_sql_parameter_sets(&current).is_err());
}

#[test]
fn parameter_sets_retain_native_scalar_types_and_legacy_workspace_values() {
    let directory = tempfile::tempdir().unwrap();
    let now = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = now.create_project("parameters").unwrap();
    let scope = |engine: &str| -> SqlParameterSetScope {
        serde_json::from_value(json!({
            "project_id": project.id, "engine": engine, "key": "a".repeat(64)
        }))
        .unwrap()
    };
    let save = |engine: &str, values: Json| {
        let write = serde_json::from_value(json!({
            "kind": "create", "input": { "name": "typed", "is_default": true, "values": values }
        }))
        .unwrap();
        now.save_sql_parameter_set(&scope(engine), write)
    };
    let value = |kind, value| json!({ "kind": "value", "value": { "kind": kind, "value": value } });
    let decimal = "-12345678901234567890123456789012.345678";
    let typed = json!([
        value("decimal", decimal), value("boolean", "true"),
        { "kind": "secret", "value_kind": "blob" }, { "kind": "value", "value": { "kind": "null" } }
    ]);
    for engine in ["sql_server", "snowflake"] {
        let row = serde_json::to_value(save(engine, typed.clone()).unwrap()).unwrap();
        let restored = now
            .read_sql_parameter_set(&scope(engine), row["id"].as_str().unwrap(), 1)
            .unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap()["values"], typed);
    }
    assert!(save("oracle", typed).is_err());
    assert!(save(
        "oracle",
        json!([value("decimal", "0.000012300"), value("blob", "00AB")])
    )
    .is_ok());
    assert!(save("postgres", json!([value("decimal", "1.2")])).is_err());
    assert!(save(
        "mysql",
        json!([
            value("integer", "18446744073709551615"),
            value("real", "-0.125")
        ])
    )
    .is_ok());
    assert!(save("mysql", json!([value("blob", "00")])).is_err());
    let long = "a".repeat(40 * 1024);
    assert!(save(
        "mysql_script",
        json!([value("text", &long), value("text", &long)])
    )
    .is_err());
    assert!(save("mysql_script", json!([value("text", &long)])).is_ok());
    assert!(save(
        "sqlite",
        json!([value("integer", "3"), value("blob", "00fe")])
    )
    .is_ok());
}

#[test]
fn explains_the_read_only_query_without_running_it() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("plan.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(
        "CREATE TABLE inventory (id INTEGER PRIMARY KEY, sku TEXT, notes TEXT);
         CREATE INDEX by_sku ON inventory(sku);
         INSERT INTO inventory VALUES (1, 'fixture', 'sample');",
    )
    .unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("plans").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "fixture", source.to_str().unwrap(), "DEV")
        .unwrap();
    let sql = "SELECT notes, json(:invalid) FROM inventory WHERE sku = :sku ORDER BY notes";
    let token = store.prepare_query().unwrap();
    let outcome = store
        .explain_prepared(&token, &profile.id, sql, None)
        .unwrap();
    assert!(matches!(outcome, QueryOutcome::ParametersRequired { .. }));
    let inputs = [
        SqlParameterValue::Text("this-json-must-not-be-evaluated".into()),
        SqlParameterValue::Text("fixture".into()),
    ];
    let token = store.prepare_query().unwrap();
    let QueryOutcome::Plan { plan } = store
        .explain_prepared(&token, &profile.id, sql, Some(&inputs))
        .unwrap()
    else {
        panic!("expected an execution plan");
    };
    let text = serde_json::to_string(&plan).unwrap();
    assert!(text.contains("SEARCH inventory USING INDEX by_sku"));
    assert!(text.contains("USE TEMP B-TREE FOR ORDER BY"));
    assert!(!text.contains("this-json-must-not-be-evaluated"));
    let token = store.prepare_query().unwrap();
    assert!(store
        .query_prepared_with_parameters(&token, &profile.id, sql, 0, Some(&inputs))
        .is_err());
    let token = store.prepare_query().unwrap();
    assert!(store
        .explain_prepared(
            &token,
            &profile.id,
            "UPDATE inventory SET notes='changed'",
            None
        )
        .is_err());
    assert_eq!(
        db.query_row("SELECT notes FROM inventory", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "sample"
    );
}
