use rusqlite::{params, Connection};
use serde_json::{json, Value};
use stackport_core::{
    PostgresProfileInput, QueryOutcome, QueryPage, Store, TableQuery, TableQueryClauses,
    TableQueryPresetWrite, TableQueryTarget,
};

const QUOTED_OBJECT: &str = "measure\"ments";
const QUOTED_COLUMN: &str = "observed\"at";
const LITERAL: &str = "a' OR 1=1 -- %_";

fn browse(store: &Store, profile: &str, request: Value, page: u32) -> Result<QueryPage, String> {
    let request: TableQuery = serde_json::from_value(request).unwrap();
    let token = store.prepare_query().unwrap();
    match store.query_object_prepared(&token, profile, &request, page)? {
        QueryOutcome::Completed { result } => Ok(result),
        outcome => panic!("expected a completed query, got {outcome:?}"),
    }
}

#[test]
fn typed_filters_and_global_sort_apply_before_pagination() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("measurements.sqlite");
    let mut db = Connection::open(&source).unwrap();
    db.execute_batch(
        r#"CREATE TABLE "measure""ments" (id INTEGER PRIMARY KEY, label TEXT, "observed""at" TEXT, weight REAL);
           CREATE VIEW measurement_view AS SELECT id, label FROM "measure""ments";"#,
    )
    .unwrap();
    let transaction = db.transaction().unwrap();
    for i in 1..=205 {
        let label = if i % 2 == 0 { Some(LITERAL) } else { None };
        let date = if i < 5 { "2026-11-24" } else { "2026-12-01" };
        transaction
            .execute(
                r#"INSERT INTO "measure""ments" VALUES (?1, ?2, ?3, ?4)"#,
                params![i, label, date, f64::from(i) / 10.0],
            )
            .unwrap();
    }
    transaction.commit().unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("data").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "fixture", source.to_str().unwrap(), "DEV")
        .unwrap();

    let request = json!({
        "object": QUOTED_OBJECT, "conjunction": "any",
        "filters": [
            {"column": "label", "condition": {"kind": "contains", "value": LITERAL}},
            {"column": "label", "condition": {"kind": "is_null"}}
        ],
        "sort": [
            {"column": "label", "direction": "desc", "nulls": "first"},
            {"column": "weight", "direction": "desc", "nulls": "default"}
        ]
    });
    let first = browse(&store, &profile.id, request.clone(), 0).unwrap();
    assert_eq!(first.rows.len(), 100);
    assert_eq!(first.rows[0][0].display, "205");
    assert_eq!(first.rows[99][0].display, "7");
    assert_eq!(first.metrics.rows_read, 101);
    assert!(first.metrics.fullscan_steps.is_some_and(|count| count > 0));
    assert!(first.metrics.sort_operations.is_some_and(|count| count > 0));
    assert!(first.metrics.vm_steps.is_some_and(|count| count > 0));
    let second = browse(&store, &profile.id, request, 1).unwrap();
    assert!(second.has_more);
    assert_eq!(second.rows[0][0].display, "5");
    assert_eq!(second.rows[3][0].display, "204");
    assert!(!second.generated_sql.unwrap().contains(LITERAL));

    let matching = browse(
        &store,
        &profile.id,
        json!({
            "object": QUOTED_OBJECT, "conjunction": "all", "sort": [],
            "filters": [
                {"column": QUOTED_COLUMN, "condition": {"kind": "between",
                    "from": {"kind": "text", "value": "2026-11-01"}, "to": {"kind": "text", "value": "2026-11-30"}}},
                {"column": "weight", "condition": {"kind": "gt", "value": {"kind": "real", "value": "0.2"}}},
                {"column": "label", "condition": {"kind": "eq", "value": {"kind": "text", "value": LITERAL}}}
            ]
        }),
        0,
    ).unwrap();
    assert_eq!(matching.rows.len(), 1);
    assert_eq!(matching.rows[0][0].display, "4");
    assert!(matching
        .generated_sql
        .unwrap()
        .contains(r#"sp_source."observed""at" BETWEEN ? AND ?"#));

    let view = browse(
        &store, &profile.id,
        json!({"object": "measurement_view", "conjunction": "all", "filters": [
            {"column": "id", "condition": {"kind": "ge", "value": {"kind": "integer", "value": "205"}}}
        ], "sort": []}), 0
    ).unwrap();
    assert_eq!(view.rows.len(), 1);
    assert_eq!(view.rows[0][0].display, "205");
    let lookup = store
        .query(
            &profile.id,
            r#"SELECT id FROM "measure""ments" WHERE id = 205"#,
            0,
        )
        .unwrap();
    assert_eq!(lookup.metrics.rows_read, 1);
    assert_eq!(lookup.metrics.fullscan_steps, Some(0));
    assert_eq!(lookup.metrics.sort_operations, Some(0));
    for object in ["sqlite_schema", "measurement_view; DROP TABLE x;"] {
        assert!(browse(
            &store,
            &profile.id,
            json!({"object": object, "conjunction": "all", "filters": [], "sort": []}),
            0
        )
        .is_err());
    }
    assert!(browse(
        &store,
        &profile.id,
        json!({
            "object": QUOTED_OBJECT, "conjunction": "all", "filters": [],
            "sort": [{"column": "missing", "direction": "asc", "nulls": "default"}]
        }),
        0
    )
    .is_err());
    assert!(browse(&store, &profile.id, json!({
        "object": QUOTED_OBJECT, "conjunction": "all", "sort": [],
        "filters": [{"column": "id", "condition": {"kind": "eq", "value": {"kind": "integer", "value": "9223372036854775808"}}}]
    }), 0).is_err());
    assert_eq!(
        db.query_row(r#"SELECT count(*) FROM "measure""ments""#, [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        205
    );
}

#[test]
fn saved_conditions_round_trip_by_object_and_reject_stale_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("data.sqlite");
    Connection::open(&source).unwrap().execute_batch(
        "CREATE TABLE items(id INTEGER PRIMARY KEY, due TEXT, note TEXT);
         INSERT INTO items VALUES (1, '2026-11-25', NULL), (2, '2026-11-25', 'value'), (3, '2026-12-01', NULL);",
    ).unwrap();
    let metadata = directory.path().join("workspace.sqlite");
    let mut store = Store::open(&metadata).unwrap();
    let project = store.create_project("data").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "data", source.to_str().unwrap(), "DEV")
        .unwrap();
    let other = store
        .create_sqlite_profile(&project.id, "other", source.to_str().unwrap(), "DEV")
        .unwrap();
    let target = TableQueryTarget::Sqlite {
        profile_id: profile.id.clone(),
        object: "items".into(),
    };
    let clauses = json!({
        "conjunction": "all",
        "filters": [{"column": "due", "condition": {"kind": "between",
            "from": {"kind": "date", "value": "2026-11-01"}, "to": {"kind": "date", "value": "2026-11-30"}}}],
        "sort": [{"column": "note", "direction": "asc", "nulls": "last"}]
    });
    let create = |name: &str| TableQueryPresetWrite::Create {
        name: name.into(),
        clauses: serde_json::from_value(clauses.clone()).unwrap(),
    };
    store
        .write_table_query_preset(&target, create(" November "))
        .unwrap();
    assert!(store
        .write_table_query_preset(&target, create("november"))
        .unwrap_err()
        .contains("같은 이름"));
    store = Store::open(&metadata).unwrap();
    let saved = store
        .list_table_query_presets(&target)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(saved.name, "November");
    assert_eq!(saved.revision, 1);
    for wrong in [
        TableQueryTarget::Sqlite {
            profile_id: profile.id.clone(),
            object: "other_items".into(),
        },
        TableQueryTarget::Sqlite {
            profile_id: other.id,
            object: "items".into(),
        },
    ] {
        assert!(store.list_table_query_presets(&wrong).unwrap().is_empty());
        assert!(store
            .read_table_query_preset(&wrong, &saved.id, saved.revision)
            .is_err());
    }
    let mut restored = serde_json::to_value(
        store
            .read_table_query_preset(&target, &saved.id, 1)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(restored, clauses);
    restored["object"] = "items".into();
    let rows = browse(&store, &profile.id, restored, 0).unwrap().rows;
    assert_eq!(
        rows.iter()
            .map(|row| row[0].display.as_str())
            .collect::<Vec<_>>(),
        ["2", "1"]
    );
    let replace = || TableQueryPresetWrite::Replace {
        id: saved.id.clone(),
        revision: saved.revision,
        clauses: serde_json::from_value(clauses.clone()).unwrap(),
    };
    store.write_table_query_preset(&target, replace()).unwrap();
    assert!(store.write_table_query_preset(&target, replace()).is_err());
    assert!(store
        .read_table_query_preset(&target, &saved.id, 1)
        .is_err());
    assert_eq!(
        store.list_table_query_presets(&target).unwrap()[0].revision,
        2
    );
    let events = serde_json::to_string(&store.list_audit_events(None).unwrap()).unwrap();
    assert!(events.contains("table_query_preset.replace"));
    assert!(!events.contains("November"));
    assert!(!events.contains("2026-11-01"));
    store.archive_project(&project.id).unwrap();
    assert!(store.list_table_query_presets(&target).is_err());
    store.unarchive_project(&project.id).unwrap();
    store.delete_profile(&profile.id).unwrap();
    let db = Connection::open(&metadata).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM table_query_presets", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn postgres_saved_conditions_follow_the_target_and_current_profile_revision() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("data").unwrap();
    let settings = PostgresProfileInput {
        name: "Reports".into(),
        host: "db.invalid".into(),
        port: 5432,
        database: "reports".into(),
        username: "reader".into(),
        environment: "DEV".into(),
        ca_path: None,
    };
    let profile = store
        .create_postgres_profile(&project.id, settings.clone())
        .unwrap();
    let target = |revision| TableQueryTarget::Postgres {
        profile_id: profile.id.clone(),
        revision,
        schema: "public".into(),
        object: "items".into(),
    };
    let clauses = || {
        serde_json::from_value(json!({
            "conjunction": "any",
            "filters": [{"column": "quantity", "condition": {"kind": "eq",
                "value": {"kind": "text", "value": "9007199254740993.123"}}}],
            "sort": []
        }))
        .unwrap()
    };
    assert!(store
        .write_table_query_preset(
            &target(1),
            TableQueryPresetWrite::Create {
                name: "empty".into(),
                clauses: TableQueryClauses::default(),
            }
        )
        .is_err());
    store
        .write_table_query_preset(
            &target(1),
            TableQueryPresetWrite::Create {
                name: "exact".into(),
                clauses: clauses(),
            },
        )
        .unwrap();
    let saved = store
        .list_table_query_presets(&target(1))
        .unwrap()
        .pop()
        .unwrap();
    let renamed = store
        .update_postgres_profile(
            &profile.id,
            1,
            PostgresProfileInput {
                name: "Renamed".into(),
                ..settings.clone()
            },
        )
        .unwrap();
    assert!(store.list_table_query_presets(&target(1)).is_err());
    assert_eq!(
        store
            .list_table_query_presets(&target(renamed.revision))
            .unwrap()[0]
            .id,
        saved.id
    );
    let redirected = store
        .update_postgres_profile(
            &profile.id,
            renamed.revision,
            PostgresProfileInput {
                database: "another".into(),
                ..settings.clone()
            },
        )
        .unwrap();
    assert!(store
        .list_table_query_presets(&target(redirected.revision))
        .unwrap()
        .is_empty());
    assert!(store
        .read_table_query_preset(&target(redirected.revision), &saved.id, saved.revision)
        .is_err());
    let back = store
        .update_postgres_profile(&profile.id, redirected.revision, settings)
        .unwrap();
    let restored = store
        .read_table_query_preset(&target(back.revision), &saved.id, saved.revision)
        .unwrap();
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(clauses()).unwrap()
    );
    store
        .write_table_query_preset(
            &target(back.revision),
            TableQueryPresetWrite::Delete {
                id: saved.id,
                revision: saved.revision,
            },
        )
        .unwrap();
    assert!(store
        .list_table_query_presets(&target(back.revision))
        .unwrap()
        .is_empty());
}
