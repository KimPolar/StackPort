use rusqlite::{params, Connection};
use serde_json::{json, Value};
use stackport_core::{QueryOutcome, QueryPage, Store, TableQuery};

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
