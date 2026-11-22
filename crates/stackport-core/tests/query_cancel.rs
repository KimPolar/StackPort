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
