use rusqlite::Connection;
use stackport_core::{QueryOutcome, Store};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const LONG_QUERY: &str = "WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT sum(n) FROM numbers";

fn fixture() -> (TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.sqlite");
    Connection::open(&source)
        .unwrap()
        .execute("CREATE TABLE data (id INTEGER PRIMARY KEY)", [])
        .unwrap();
    let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("test").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "test", source.to_str().unwrap(), "DEV")
        .unwrap();
    (dir, store, profile.id)
}

#[test]
fn cancellation_before_start_is_confirmed_and_token_is_single_use() {
    let (_dir, store, profile) = fixture();
    let token = store.prepare_query().unwrap();
    assert!(store.cancel_query(&token).unwrap());
    assert!(matches!(
        store
            .query_prepared(&token, &profile, LONG_QUERY, 0)
            .unwrap(),
        QueryOutcome::Cancelled
    ));
    assert!(!store.cancel_query(&token).unwrap());
    assert!(store
        .query_prepared(&token, &profile, "SELECT 1", 0)
        .is_err());
}

#[test]
fn cancelling_a_running_query_does_not_affect_another_query() {
    let (_dir, store, profile) = fixture();
    let token = store.prepare_query().unwrap();
    let other = store.prepare_query().unwrap();
    let thread_store = store.clone();
    let thread_profile = profile.clone();
    let thread_token = token.clone();
    let started = Instant::now();
    let worker = std::thread::spawn(move || {
        thread_store.query_prepared(&thread_token, &thread_profile, LONG_QUERY, 0)
    });
    std::thread::sleep(Duration::from_millis(150));
    assert!(store.cancel_query(&token).unwrap());
    assert!(matches!(
        worker.join().unwrap().unwrap(),
        QueryOutcome::Cancelled
    ));
    assert!(started.elapsed() < Duration::from_secs(5));
    match store
        .query_prepared(&other, &profile, "SELECT 42", 0)
        .unwrap()
    {
        QueryOutcome::Completed { result } => assert_eq!(result.rows[0][0].display, "42"),
        _ => panic!("the unrelated query was interrupted"),
    }
    assert!(!store.cancel_query(&token).unwrap());
}

#[test]
fn completed_or_failed_requests_are_not_reported_as_cancelled() {
    let (_dir, store, profile) = fixture();
    let complete = store.prepare_query().unwrap();
    assert!(matches!(
        store
            .query_prepared(&complete, &profile, "SELECT 1", 0)
            .unwrap(),
        QueryOutcome::Completed { .. }
    ));
    assert!(!store.cancel_query(&complete).unwrap());
    let failed = store.prepare_query().unwrap();
    assert!(store
        .query_prepared(&failed, &profile, "DELETE FROM data", 0)
        .is_err());
    assert!(!store.cancel_query(&failed).unwrap());
}

#[test]
fn document_runs_in_order_and_keeps_the_prefix_when_a_statement_fails() {
    let (_dir, store, profile) = fixture();
    let prefix = "SELECT '한😀; 결과' AS marker;\n-- comment ;\n";
    let blocked = "CREATE TABLE blocked (id);";
    let sql = format!("{prefix}{blocked}\nSELECT 3;");
    let token = store.prepare_query().unwrap();
    let report = store
        .query_document_prepared(&token, &profile, &sql, None)
        .unwrap();
    let report = serde_json::to_value(report).unwrap();
    assert_eq!(report["status"], "batch");
    assert_eq!(report["total"], 3);
    assert_eq!(report["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        report["items"][0]["result"]["rows"][0][0]["display"],
        "한😀; 결과"
    );
    assert_eq!(report["stopped"]["status"], "error");
    assert_eq!(report["stopped"]["start"], prefix.encode_utf16().count());
    assert_eq!(
        report["stopped"]["end"],
        prefix.encode_utf16().count() + blocked.len()
    );
    assert!(!store.cancel_query(&token).unwrap());
    assert!(store.query(&profile, "SELECT id FROM blocked", 0).is_err());
}

#[test]
fn document_bounds_statement_count_and_buffered_previews() {
    let (_dir, store, profile) = fixture();
    let token = store.prepare_query().unwrap();
    assert!(store
        .query_document_prepared(&token, &profile, &"SELECT 1;".repeat(17), None)
        .unwrap_err()
        .contains("16개"));
    let fields = vec!["printf('%05000d',x)"; 24].join(",");
    let script = format!("SELECT 1; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<101) SELECT {fields} FROM n; SELECT 3;");
    let token = store.prepare_query().unwrap();
    let report = serde_json::to_value(
        store
            .query_document_prepared(&token, &profile, &script, None)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(report["items"].as_array().unwrap().len(), 1);
    assert_eq!(report["stopped"]["status"], "error");
    assert!(report["stopped"]["message"]
        .as_str()
        .unwrap()
        .contains("메모리 한도"));
}

#[test]
fn a_single_document_statement_accepts_trailing_comments() {
    let (_dir, store, profile) = fixture();
    let token = store.prepare_query().unwrap();
    let QueryOutcome::Completed { result } = store
        .query_document_prepared(&token, &profile, "SELECT 5 AS value; -- ;", None)
        .unwrap()
    else {
        panic!("expected a single result");
    };
    assert_eq!(result.rows[0][0].display, "5");
}
