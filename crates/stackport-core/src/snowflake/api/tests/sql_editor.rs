use super::*;
use crate::snowflake::{QueryInput, QuerySource};

const START: &str = "00000000-0000-4000-8000-000000000001";
const UPDATE: &str = "00000000-0000-4000-8000-000000000002";
const SELECT: &str = "00000000-0000-4000-8000-000000000003";
const COMMIT: &str = "00000000-0000-4000-8000-000000000004";

fn input(sql: &str, first_line: u32, cursor_byte: Option<usize>) -> QueryInput {
    serde_json::from_value(
        json!({ "sql": sql, "first_line": first_line, "cursor_byte": cursor_byte }),
    )
    .unwrap()
}

#[tokio::test]
async fn runs_one_transaction_request_and_reads_child_results_in_order() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "sql", "DEMO");
    let request_id = Uuid::new_v4().to_string();
    let expected_request_id = request_id.clone();
    let server = tokio::spawn(async move {
        let (request, body, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(
            request,
            format!(
                "POST {PATH}?requestId={expected_request_id}&nullable=true&async=true HTTP/1.1"
            )
        );
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body["statement"],
            "BEGIN TRANSACTION\n;\nUPDATE demo SET x = 1\n;\nSELECT x FROM demo\n;\nCOMMIT"
        );
        assert_eq!(body["parameters"]["MULTI_STATEMENT_COUNT"], "4");
        assert_eq!(body["parameters"]["rows_per_resultset"], 101);
        assert_eq!(body["parameters"]["binary_output_format"], "HEX");
        assert_eq!(
            body["parameters"]["timestamp_tz_output_format"],
            "YYYY-MM-DD\"T\"HH24:MI:SS.FF9TZH:TZM"
        );
        assert_eq!(body["database"], "DEMO");
        assert_eq!(body["role"], "READER");
        assert_eq!(body["warehouse"], "DEMO_WH");
        assert!(body.get("schema").is_none());
        reply(stream, "202 Accepted", "", &status()).await;

        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE} HTTP/1.1"));
        reply(stream, "200 OK", "", &encoded(json!({ "statementHandle": HANDLE, "statementHandles": [START, UPDATE, SELECT, COMMIT],
            "data": [["Multiple statements executed successfully."]] }))).await;

        for (handle, message) in [
            (START, "Transaction started."),
            (UPDATE, "Statement executed successfully."),
        ] {
            let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
            assert_eq!(request, format!("GET {PATH}/{handle} HTTP/1.1"));
            let mut payload = json!({ "statementHandle": handle, "message": message });
            if handle == UPDATE {
                payload["stats"] = json!({ "numRowsInserted": 0, "numRowsUpdated": 2, "numRowsDeleted": 0, "numDuplicateRowsUpdated": 1 });
            }
            reply(stream, "200 OK", "", &encoded(payload)).await;
        }
        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{SELECT} HTTP/1.1"));
        reply(stream, "200 OK", "", &encoded(json!({
            "statementHandle": SELECT, "statementHandles": null,
            "resultSetMetaData": {
                "numRows": 3, "partitionInfo": [{ "rowCount": 1 }, { "rowCount": 2 }],
                "rowType": [{ "name": "N", "type": "fixed", "precision": 38, "scale": 6 },
                            { "name": "VALUE_BYTES", "type": "binary" }, { "name": "NOTE", "type": "text" }]
            },
            "data": [["12345678901234567890123456789012.345678", "00FF", "한글 🚀"]]
        }))).await;
        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{SELECT}?partition=1 HTTP/1.1"));
        let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
        gzip.write_all(&encoded(
            json!({ "data": [[null, "", "empty"], ["-0.000001", "AB", "마지막"]] }),
        ))
        .unwrap();
        reply(
            stream,
            "200 OK",
            "Content-Encoding: gzip\r\n",
            &gzip.finish().unwrap(),
        )
        .await;

        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{COMMIT} HTTP/1.1"));
        reply(
            stream,
            "200 OK",
            "",
            &encoded(json!({ "statementHandle": COMMIT, "message": "Transaction committed." })),
        )
        .await;
    });
    let outcome = manager
        .run_query(
            "sql",
            &request_id,
            input(
                "BEGIN TRANSACTION;\nUPDATE demo SET x = 1;\nSELECT x FROM demo;\nCOMMIT;",
                5,
                None,
            ),
        )
        .await
        .unwrap();
    let value = serde_json::to_value(outcome).unwrap();
    assert_eq!(value["status"], "succeeded", "{value}");
    assert_eq!(value["server_completed"], true);
    let results = value["statements"].as_array().unwrap();
    assert_eq!(results.len(), 4);
    assert_eq!(results[1]["stats"]["num_rows_updated"], 2);
    assert_eq!(results[1]["stats"]["num_duplicate_rows_updated"], 1);
    assert_eq!(results[2]["line"], 7);
    assert_eq!(results[2]["query_id"], SELECT);
    assert_eq!(
        results[2]["data"]["columns"][0]["data_type"],
        "NUMBER(38,6)"
    );
    let rows = results[2]["data"]["rows"].as_array().unwrap();
    assert_eq!(
        rows[0][0]["text"],
        "12345678901234567890123456789012.345678"
    );
    assert_eq!(
        rows[0][1],
        json!({ "text": "00FF", "encoding": "hex", "bytes": 2, "truncated": false })
    );
    assert_eq!(rows[1][0], Value::Null);
    assert_eq!(rows[1][1]["text"], "");
    assert_eq!(rows[2][2]["text"], "마지막");
    let audit = manager.store.list_audit_events(None).unwrap();
    let audit = serde_json::to_value(audit).unwrap();
    let event = audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["correlation_id"] == request_id)
        .unwrap();
    assert_eq!(event["operation"], "snowflake.sql.execute");
    assert_eq!(event["outcome"], "succeeded");
    assert!(!event.to_string().contains("UPDATE demo"));
    server.await.unwrap();
}

#[tokio::test]
async fn retains_error_location_and_snowflake_code_for_current_statement() {
    let (fixture, api) = fixture(Auth::Oauth, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "sql", "DEMO");
    let server = tokio::spawn(async move {
        let (_, body, stream) = fixture.request("OAUTH").await;
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["statement"], "SELECT missing");
        assert!(body["parameters"].get("MULTI_STATEMENT_COUNT").is_none());
        reply(
            stream,
            "422 Unprocessable Entity",
            "",
            &encoded(json!({
                "statementHandle": HANDLE, "code": "000904", "sqlState": "42000",
                "message": "SQL compilation error: invalid identifier"
            })),
        )
        .await;
    });
    let sql = "SELECT '한글';\nSELECT missing;\nSELECT 99;";
    let response = manager
        .run_query(
            "sql",
            &Uuid::new_v4().to_string(),
            input(sql, 10, sql.find("missing")),
        )
        .await
        .unwrap();
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["status"], "failed");
    assert_eq!(value["error"]["line"], 11);
    assert_eq!(value["error"]["code"], "000904");
    assert_eq!(value["error"]["sql_state"], "42000");
    assert_eq!(value["error"]["query_id"], HANDLE);
    server.await.unwrap();
}

fn with_bindings(
    sql: &str,
    first_line: u32,
    cursor: Option<usize>,
    parameters: Value,
) -> QueryInput {
    serde_json::from_value(json!({ "sql": sql, "first_line": first_line, "cursor_byte": cursor, "parameters": parameters })).unwrap()
}

#[tokio::test]
async fn sends_ordered_typed_bindings_for_the_current_statement() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "sql", "DEMO");
    let exact = "-12345678901234567890123456789012.345678";
    let text = "한글 '?'; 🚀";
    let statement = "SELECT '?' AS LITERAL, ?, ?, ?, ?, ?, ?, ?";
    let sql = format!("SELECT '앞 문장';\n{statement};\nSELECT 99;");
    let cursor = sql.find("AS LITERAL");
    let source: QuerySource =
        serde_json::from_value(json!({"sql": sql, "first_line": 6, "cursor_byte": cursor}))
            .unwrap();
    assert_eq!(source.parameter_count().unwrap(), 7);
    let server = tokio::spawn(async move {
        let (_, body, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["statement"], statement);
        assert!(body["parameters"].get("MULTI_STATEMENT_COUNT").is_none());
        assert_eq!(
            body["bindings"],
            json!({
                "1": {"type": "TEXT", "value": text},
                "2": {"type": "FIXED", "value": "9007199254740993"},
                "3": {"type": "DECFLOAT", "value": exact},
                "4": {"type": "REAL", "value": "1.25e-3"},
                "5": {"type": "BOOLEAN", "value": "true"},
                "6": {"type": "BINARY", "value": "00fF"},
                "7": {"type": "ANY", "value": null},
            })
        );
        reply(stream, "200 OK", "", &encoded(json!({
            "statementHandle": HANDLE, "message": format!("Warning about {text}"),
            "resultSetMetaData": {"numRows": 1, "partitionInfo": [{"rowCount": 1}], "rowType": [{"name": "EXACT", "type": "decfloat"}]},
            "data": [[exact]]
        }))).await;
    });
    let args = json!([
        {"kind": "text", "value": text, "masked": true}, {"kind": "integer", "value": "9007199254740993"},
        {"kind": "decimal", "value": exact}, {"kind": "real", "value": "1.25e-3"},
        {"kind": "boolean", "value": "1"}, {"kind": "blob", "value": "00fF"}, {"kind": "null"},
    ]);
    let response = manager
        .run_query(
            "sql",
            &Uuid::new_v4().to_string(),
            with_bindings(&sql, 6, cursor, args),
        )
        .await
        .unwrap();
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["status"], "succeeded");
    assert_eq!(value["statements"][0]["line"], 7);
    assert!(value["statements"][0]["warning"].is_null());
    assert_eq!(value["statements"][0]["data"]["rows"][0][0]["text"], exact);
    server.await.unwrap();
}

#[tokio::test]
async fn suppresses_sensitive_server_error_details_and_audit_values() {
    let (fixture, api) = fixture(Auth::Oauth, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "sql", "DEMO");
    let secret = "masked-value-for-test";
    let server = tokio::spawn(async move {
        let (_, _, stream) = fixture.request("OAUTH").await;
        reply(stream, "422 Unprocessable Entity", "", &encoded(json!({
            "statementHandle": HANDLE, "code": "100037", "sqlState": "22018", "message": format!("Could not convert {secret}")
        }))).await;
    });
    let request_id = Uuid::new_v4().to_string();
    let response = manager
        .run_query(
            "sql",
            &request_id,
            with_bindings(
                "SELECT TO_NUMBER(?)",
                3,
                None,
                json!([{"kind": "text", "value": secret, "masked": true}]),
            ),
        )
        .await
        .unwrap();
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["status"], "failed");
    assert_eq!(value["error"]["line"], 3);
    assert_eq!(value["error"]["code"], "100037");
    assert_eq!(value["error"]["sql_state"], "22018");
    assert_eq!(value["error"]["query_id"], HANDLE);
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("숨긴 값"));
    assert!(!value.to_string().contains(secret));
    let audit = serde_json::to_value(manager.store.list_audit_events(None).unwrap()).unwrap();
    let event = audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["correlation_id"] == request_id)
        .unwrap();
    assert_eq!(event["outcome"], "failed");
    assert!(!event.to_string().contains(secret));
    assert!(!event.to_string().contains("SELECT"));
    server.await.unwrap();
}

#[tokio::test]
async fn rejects_mismatched_invalid_and_multi_statement_bindings_before_posting() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "sql", "DEMO");
    for (sql, parameter, reason) in [
        ("SELECT ?; SELECT 1", json!({"kind": "null"}), "문장 하나"),
        ("SELECT ?, ?", json!({"kind": "null"}), "? 개수"),
        (
            "SELECT ?",
            json!({"kind": "integer", "value": "9223372036854775808", "masked": true}),
            "64비트",
        ),
        (
            "SELECT ?",
            json!({"kind": "decimal", "value": "123456789012345678901234567890123456789"}),
            "38자리",
        ),
        (
            "SELECT ?",
            json!({"kind": "blob", "value": "00f"}),
            "16진수",
        ),
        (
            "SELECT ?",
            json!({"kind": "text", "value": "한".repeat(6000)}),
            "16 KiB",
        ),
    ] {
        let result = manager
            .run_query(
                "sql",
                &Uuid::new_v4().to_string(),
                with_bindings(sql, 1, None, json!([parameter])),
            )
            .await;
        let Err(message) = result else {
            panic!("invalid binding succeeded");
        };
        assert!(message.contains(reason), "{message}");
        assert!(!message.contains("9223372036854775808"));
    }
    assert!(tokio::time::timeout(
        Duration::from_millis(100),
        fixture.request("PROGRAMMATIC_ACCESS_TOKEN")
    )
    .await
    .is_err());
}

#[tokio::test]
async fn confirms_server_cancellation_of_a_pending_script() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "sql", "DEMO");
    let marker = Arc::new(Notify::new());
    let ready = Arc::clone(&marker);
    let server = tokio::spawn(async move {
        let (_, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        reply(stream, "202 Accepted", "", &status()).await;
        let (request, _, _pending) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE} HTTP/1.1"));
        ready.notify_one();
        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("POST {PATH}/{HANDLE}/cancel HTTP/1.1"));
        reply(
            stream,
            "200 OK",
            "",
            &encoded(json!({ "statementHandle": HANDLE, "code": "000604" })),
        )
        .await;
    });
    let request_id = Uuid::new_v4().to_string();
    let run = manager.run_query("sql", &request_id, input("SELECT 1; SELECT 2", 1, None));
    let (outcome, ()) = tokio::join!(run, async {
        tokio::time::timeout(Duration::from_secs(10), marker.notified())
            .await
            .unwrap();
        assert!(!manager
            .cancel_query("sql", &Uuid::new_v4().to_string())
            .unwrap());
        assert!(manager.cancel_query("sql", &request_id).unwrap());
    });
    let value = serde_json::to_value(outcome.unwrap()).unwrap();
    assert_eq!(value["status"], "cancelled");
    assert_eq!(value["server_interrupted"], true);
    assert_eq!(value["server_completed"], false);
    assert_eq!(value["audit_warning"], false);
    server.await.unwrap();
}

#[tokio::test]
async fn distinguishes_cancelling_download_after_server_execution() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "sql", "DEMO");
    let marker = Arc::new(Notify::new());
    let ready = Arc::clone(&marker);
    let server = tokio::spawn(async move {
        let (_, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        reply(
            stream,
            "200 OK",
            "",
            &encoded(json!({ "statementHandle": HANDLE, "statementHandles": [SELECT, COMMIT] })),
        )
        .await;
        let (request, _, _pending) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{SELECT} HTTP/1.1"));
        ready.notify_one();
        assert!(
            tokio::time::timeout(Duration::from_millis(450), fixture.listener.accept())
                .await
                .is_err()
        );
    });
    let request_id = Uuid::new_v4().to_string();
    let run = manager.run_query("sql", &request_id, input("SELECT 1; COMMIT", 1, None));
    let (outcome, ()) = tokio::join!(run, async {
        tokio::time::timeout(Duration::from_secs(10), marker.notified())
            .await
            .unwrap();
        assert!(manager.cancel_query("sql", &request_id).unwrap());
    });
    let value = serde_json::to_value(outcome.unwrap()).unwrap();
    assert_eq!(value["status"], "cancelled");
    assert_eq!(value["server_completed"], true);
    assert_eq!(value["server_interrupted"], Value::Null);
    server.await.unwrap();
}

#[tokio::test]
async fn reports_a_server_timeout_with_its_cancellation_status() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "sql", "DEMO");
    let server = tokio::spawn(async move {
        let (_, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        reply(stream, "408 Request Timeout", "", &encoded(json!({
            "statementHandle": HANDLE, "code": "000630", "sqlState": "57014", "message": "Statement reached its timeout limit."
        }))).await;
    });
    let result = manager
        .run_query(
            "sql",
            &Uuid::new_v4().to_string(),
            input("SELECT 1", 1, None),
        )
        .await
        .unwrap();
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["status"], "timed_out");
    assert_eq!(value["server_interrupted"], true);
    assert_eq!(value["error"]["query_id"], HANDLE);
    server.await.unwrap();
}
