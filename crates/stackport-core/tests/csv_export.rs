use rusqlite::{params, Connection};
use serde_json::json;
use stackport_core::{CsvOptions, CsvQuery, QueryOutcome, SqlParameterValue, Store};
use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn fixture() -> (tempfile::TempDir, Connection, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(
        "CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT, data BLOB, note TEXT);",
    )
    .unwrap();
    let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("exports").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "fixture", source.to_str().unwrap(), "DEV")
        .unwrap();
    (dir, db, store, profile.id)
}

fn options(path: &Path) -> CsvOptions {
    CsvOptions {
        destination: path.to_str().unwrap().into(),
        include_header: true,
        spreadsheet_safe: true,
    }
}

#[test]
fn exports_all_filtered_sorted_rows_and_preserves_csv_values() {
    let (dir, mut db, store, profile) = fixture();
    let multiline = "한국어,\"값\"\n둘째 줄";
    let formula = "  =PRIVATE_RESULT()";
    let tx = db.transaction().unwrap();
    for id in 1..=205 {
        let label = match id {
            205 => formula,
            204 => multiline,
            _ => "ordinary",
        };
        let note = (id == 204).then_some("");
        tx.execute(
            "INSERT INTO records VALUES (?1, ?2, ?3, ?4)",
            params![id, label, &[0, 255u8], note],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let query: CsvQuery = serde_json::from_value(json!({ "kind": "table", "request": {
        "object": "records", "conjunction": "all",
        "filters": [{"column": "id", "condition": {"kind": "ge", "value": {"kind": "integer", "value": "3"}}}],
        "sort": [{"column": "id", "direction": "desc", "nulls": "default"}]
    }})).unwrap();
    let target = dir.path().join("private-output.csv");
    let token = store.prepare_query().unwrap();
    let QueryOutcome::Exported { report } = store
        .export_csv_prepared(&token, &profile, &query, &options(&target))
        .unwrap()
    else {
        panic!("expected a saved CSV");
    };
    assert_eq!((report.rows, report.protected_fields), (203, 1));
    let data = fs::read_to_string(&target).unwrap();
    assert_eq!(data.len() as u64, report.size_bytes);
    assert!(data.starts_with("\"id\",\"label\",\"data\",\"note\"\r\n205,\"'  =PRIVATE_RESULT()\",\"X'00FF'\",\\N\r\n204,\"한국어,\"\"값\"\"\n둘째 줄\",\"X'00FF'\",\"\"\r\n"));
    assert!(data.ends_with("3,\"ordinary\",\"X'00FF'\",\\N\r\n"));
    assert_eq!(data.matches("\r\n").count(), 204);
    let records = store.list_audit_events(None).unwrap().events;
    assert_eq!(records[0].operation, "sqlite.export.csv");
    assert_eq!(records[0].affected_count, Some(203));
    let serialized = serde_json::to_string(&records).unwrap();
    assert!(!serialized.contains("private-output.csv") && !serialized.contains(formula));
}

#[test]
fn binds_saved_values_and_never_publishes_failed_or_cancelled_exports() {
    let (dir, db, store, profile) = fixture();
    db.execute("INSERT INTO records VALUES (1, 'before', NULL, NULL)", [])
        .unwrap();
    let query = CsvQuery::Sql {
        sql: "SELECT :value AS label, -7 AS score LIMIT 1".into(),
        parameters: Some(vec![SqlParameterValue::Text("=raw-value".into())]),
    };
    let target = dir.path().join("raw.csv");
    let configured = CsvOptions {
        include_header: false,
        spreadsheet_safe: false,
        ..options(&target)
    };
    let token = store.prepare_query().unwrap();
    assert!(matches!(
        store
            .export_csv_prepared(&token, &profile, &query, &configured)
            .unwrap(),
        QueryOutcome::Exported { .. }
    ));
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "\"=raw-value\",-7\r\n"
    );
    let token = store.prepare_query().unwrap();
    assert!(store
        .export_csv_prepared(&token, &profile, &query, &configured)
        .is_err());
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "\"=raw-value\",-7\r\n"
    );

    let invalid = dir.path().join("invalid.csv");
    let token = store.prepare_query().unwrap();
    let bad_sql = CsvQuery::Sql {
        sql: "SELECT 1 UNION ALL SELECT CAST(X'ff' AS text)".into(),
        parameters: None,
    };
    assert!(store
        .export_csv_prepared(&token, &profile, &bad_sql, &options(&invalid))
        .unwrap_err()
        .contains("UTF-8"));
    assert!(!invalid.exists());
    let token = store.prepare_query().unwrap();
    let bad_sql = CsvQuery::Sql {
        sql: "DELETE FROM records RETURNING id".into(),
        parameters: None,
    };
    assert!(store
        .export_csv_prepared(&token, &profile, &bad_sql, &options(&invalid))
        .is_err());
    assert_eq!(
        db.query_row("SELECT id FROM records", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );

    let destination = dir.path().join("cancelled.csv");
    let export_options = options(&destination);
    let query = CsvQuery::Sql {
        sql: "WITH RECURSIVE numbers(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM numbers WHERE x < 5000000) SELECT x FROM numbers".into(),
        parameters: None,
    };
    let token = store.prepare_query().unwrap();
    let worker_store = store.clone();
    let worker_token = token.clone();
    let worker = thread::spawn(move || {
        worker_store.export_csv_prepared(&worker_token, &profile, &query, &export_options)
    });
    let started = Instant::now();
    let mut processed = 0;
    while started.elapsed() < Duration::from_secs(3) {
        match store.csv_export_progress(&token).unwrap() {
            Some(rows) if rows > 0 => {
                processed = rows;
                break;
            }
            None => break,
            Some(_) => thread::sleep(Duration::from_millis(2)),
        }
    }
    let accepted = store.cancel_query(&token).unwrap();
    let outcome = worker.join().unwrap().unwrap();
    assert!(processed > 0 && accepted);
    assert!(matches!(outcome, QueryOutcome::Cancelled));
    assert_eq!(store.csv_export_progress(&token).unwrap(), None);
    assert!(!destination.exists());
    assert!(!fs::read_dir(dir.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".stackport-csv-")));
}
