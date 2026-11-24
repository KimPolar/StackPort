use rusqlite::{params, Connection};
use stackport_core::{QueryOutcome, SqlParameterValue, Store};

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
    let QueryOutcome::ParametersRequired { parameters } = outcome else {
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
