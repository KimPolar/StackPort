use super::*;
use crate::snowflake::{Auth, ExportOptions, ExportOutcome, Manager, Profile, Session};
use crate::TableQueryClauses;
use flate2::{write::GzEncoder, Compression};
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::{pki_types::PrivatePkcs8KeyDer, ServerConfig};
use std::{
    fs,
    io::Write,
    path::Path as FilePath,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::Notify,
};
use tokio_rustls::{server::TlsStream, TlsAcceptor};

const HOST: &str = "snowflake.test";
const PATH: &str = "/api/v2/statements";
const HANDLE: &str = "3be31f8c-2b7b-4195-be04-bdd196b9e24d";
const TEST_TOKEN: &str = "synthetic-token-for-loopback";

struct Fixture {
    listener: TcpListener,
    acceptor: TlsAcceptor,
}

#[tokio::test]
async fn reads_async_status_and_gzipped_partitions_over_verified_https() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let server = tokio::spawn(async move {
        let (request, body, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert!(request.starts_with("POST /api/v2/statements?requestId="));
        assert!(request.contains("&async=true HTTP/1.1"));
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["statement"], "SELECT ?");
        assert_eq!(body["database"], "DEMO");
        assert_eq!(body["schema"], "INFORMATION_SCHEMA");
        assert_eq!(body["role"], "READER");
        assert_eq!(body["warehouse"], "DEMO_WH");
        assert_eq!(body["parameters"]["rows_per_resultset"], 4);
        assert_eq!(
            body["bindings"]["1"],
            json!({ "type": "TEXT", "value": "a'b" })
        );
        reply(stream, "202 Accepted", "", &status()).await;

        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE} HTTP/1.1"));
        reply(stream, "429 Too Many Requests", "", &status()).await;
        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE} HTTP/1.1"));
        reply(stream, "200 OK", "", &encoded(json!({
            "statementHandle": HANDLE,
            "resultSetMetaData": { "numRows": 3, "partitionInfo": [{ "rowCount": 1 }, { "rowCount": 2 }] },
            "data": [["123456789012345678901234567890.12345678"]]
        }))).await;

        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE}?partition=1 HTTP/1.1"));
        let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
        gzip.write_all(&encoded(json!({ "data": [[null], ["서울 🚀"]] })))
            .unwrap();
        reply(
            stream,
            "200 OK",
            "Content-Encoding: gzip\r\n",
            &gzip.finish().unwrap(),
        )
        .await;
    });

    let rows = api.query("SELECT ?", &["a'b"], 4).await.unwrap();
    assert_eq!(
        rows,
        vec![
            vec![Some("123456789012345678901234567890.12345678".into())],
            vec![None],
            vec![Some("서울 🚀".into())],
        ]
    );
    server.await.unwrap();
}

#[tokio::test]
async fn fetches_a_complete_qualified_definition_over_https() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let directory = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(directory.path(), api, "definition", "Db");
    let text = "create or replace view \"Db\".\"S'Me\".\"a\\b\"\"c\" as\r\nselect '한글';\n";
    let task = tokio::spawn(async move {
        let (_, body, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        let body: Value = serde_json::from_slice(&body).unwrap();
        let sql = body["statement"].as_str().unwrap();
        assert!(sql.contains(r#"GET_DDL('TABLE', '"Db"."S''Me"."a\\b""c"', TRUE)"#));
        assert!(body.get("bindings").is_none());
        assert!(sql.contains("OCTET_LENGTH(body) <= 1048576"));
        let result = |row: Value| {
            encoded(json!({
                "statementHandle": HANDLE,
                "resultSetMetaData": { "numRows": 1, "partitionInfo": [{ "rowCount": 1 }] },
                "data": [row]
            }))
        };
        reply(
            stream,
            "200 OK",
            "",
            &result(json!([text, text.len().to_string()])),
        )
        .await;
        let (_, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        reply(stream, "200 OK", "", &result(json!([null, "1048577"]))).await;
    });
    let object = serde_json::to_string(&["S'Me", "a\\b\"c"]).unwrap();
    assert_eq!(
        manager
            .definition("definition", object.clone())
            .await
            .unwrap(),
        text
    );
    assert!(manager
        .definition("definition", object)
        .await
        .unwrap_err()
        .contains("1 MiB"));
    task.await.unwrap();
}

#[tokio::test]
async fn rejects_redirects_and_untrusted_certificates() {
    let (service, api) = fixture(Auth::Oauth, true).await;
    let server = tokio::spawn(async move {
        let (_, _, stream) = service.request("OAUTH").await;
        reply(
            stream,
            "307 Temporary Redirect",
            "Location: /unexpected\r\n",
            b"",
        )
        .await;
    });
    assert!(api
        .query("SELECT 1", &[], 1)
        .await
        .unwrap_err()
        .contains("HTTP 307"));
    server.await.unwrap();

    let (service, api) = fixture(Auth::Oauth, false).await;
    let server = tokio::spawn(async move {
        let (socket, _) = service.listener.accept().await.unwrap();
        if let Ok(mut stream) = service.acceptor.accept(socket).await {
            let mut byte = [0];
            assert!(stream.read(&mut byte).await.unwrap_or(0) == 0);
        }
    });
    assert!(api
        .query("SELECT 1", &[], 1)
        .await
        .unwrap_err()
        .contains("인증서"));
    server.await.unwrap();
}

#[tokio::test]
async fn closing_a_session_cancels_the_pending_statement() {
    let (fixture, api) = fixture(Auth::Oauth, true).await;
    let requested = Arc::new(Notify::new());
    let notify = Arc::clone(&requested);
    let server = tokio::spawn(async move {
        let (_, _, stream) = fixture.request("OAUTH").await;
        reply(stream, "202 Accepted", "", &status()).await;
        let (request, _, stream) = fixture.request("OAUTH").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE} HTTP/1.1"));
        reply(stream, "202 Accepted", "", &status()).await;
        notify.notify_one();

        let (request, _, stream) = fixture.request("OAUTH").await;
        assert_eq!(request, format!("POST {PATH}/{HANDLE}/cancel HTTP/1.1"));
        reply(stream, "200 OK", "", b"{}").await;
    });
    let (result, _) = tokio::join!(api.query("SELECT 1", &[], 1), async {
        timeout(Duration::from_secs(15), requested.notified())
            .await
            .unwrap();
        api.close();
    });
    assert_eq!(result.unwrap_err(), CLOSED);
    server.await.unwrap();
}

#[tokio::test]
async fn snowflake_exports_full_ordered_gzipped_partitions_with_native_types() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, profile) = test_session(dir.path(), api, "export", "Db");
    let writer = Arc::clone(&manager);
    let request_id = Uuid::new_v4().to_string();
    let active = request_id.clone();
    let destination = dir.path().join("complete.json");
    let target = destination.clone();
    let task = tokio::spawn(async move {
        let columns = [
            ("id", "NUMBER", Some("38"), Some("0")),
            ("label", "TEXT", None, None),
            ("raw", "BINARY", None, None),
            ("amount", "NUMBER", Some("38"), Some("8")),
            ("detail", "VARIANT", None, None),
            ("logged_at", "TIMESTAMP_TZ", None, None),
        ];
        let mut catalog: Vec<_> = columns
            .into_iter()
            .map(|(name, ty, precision, scale)| json!([name, ty, "YES", "NO", precision, scale]))
            .collect();
        catalog.extend(
            (0..66).map(|i| json!([format!("extra_{i}"), "TEXT", "YES", "NO", null, null])),
        );
        reply_columns(&fixture, catalog).await;
        let (request, body, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert!(request.contains("&nullable=true&async=true"));
        let body: Value = serde_json::from_slice(&body).unwrap();
        let sql = body["statement"].as_str().unwrap();
        assert!(sql.contains("FROM \"Db\".\"Case.Schema\".\"Item\"\"s\" AS sp_source"));
        assert!(sql.contains("HEX_ENCODE(sp_source.\"raw\")"));
        assert!(sql.contains("TO_JSON(sp_source.\"detail\")"));
        assert!(sql.ends_with("ORDER BY sp_source.\"id\" DESC NULLS LAST"));
        assert!(!sql.contains("LIMIT") && !sql.contains("9007199254740993"));
        assert_eq!(body["parameters"]["rows_per_resultset"], 0);
        assert_eq!(body["timeout"], 300);
        assert_eq!(body["bindings"]["1"]["value"], "9007199254740993");
        reply(stream, "202 Accepted", "", &status()).await;

        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE} HTTP/1.1"));
        let row = |number: usize, label: &str| {
            let mut values = vec![
                json!(number.to_string()),
                json!(label),
                json!("00fF"),
                json!("123456789012345678901234567890.12345678"),
                json!("{\"n\":9007199254740993}"),
                json!("2026-09-18T04:12:33.123456789+09:00"),
            ];
            values.resize(72, Value::Null);
            values[71] = json!("마지막 열");
            values
        };
        reply(
            stream,
            "200 OK",
            "",
            &part(130, &[1, 129], vec![row(130, "서울 🚀")]),
        )
        .await;

        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE}?partition=1 HTTP/1.1"));
        assert_eq!(writer.export_progress("export", &active).unwrap(), Some(1));
        assert!(!target.exists());
        reply(stream, "429 Too Many Requests", "", b"{}").await;
        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE}?partition=1 HTTP/1.1"));
        let text = "한".repeat(24_000);
        let rows: Vec<_> = (1..130).rev().map(|number| row(number, &text)).collect();
        let body = encoded(json!({ "data": rows }));
        assert!(body.len() > RESPONSE_LIMIT);
        let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
        gzip.write_all(&body).unwrap();
        reply(
            stream,
            "200 OK",
            "Content-Encoding: gzip\r\n",
            &gzip.finish().unwrap(),
        )
        .await;
    });

    let clauses: TableQueryClauses = serde_json::from_value(json!({
        "filters": [{ "column": "id", "condition": { "kind": "ge", "value": { "kind": "text", "value": "9007199254740993" } } }],
        "conjunction": "all", "sort": [{ "column": "id", "direction": "desc", "nulls": "last" }]
    })).unwrap();
    let result = timeout(
        Duration::from_secs(25),
        manager.export(
            "export",
            request_id.clone(),
            test_object(),
            clauses,
            export_options(&destination, "json"),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let ExportOutcome::Exported { report } = result else {
        panic!("expected a complete export")
    };
    assert_eq!(report.rows, 130);
    assert!(report.audit_warning.is_none());
    assert_eq!(report.size_bytes, fs::metadata(&destination).unwrap().len());
    let body: Value = serde_json::from_reader(fs::File::open(&destination).unwrap()).unwrap();
    assert_eq!(body["format"], "stackport.snowflake-results");
    assert_eq!(body["version"], 1);
    assert_eq!(body["columns"].as_array().unwrap().len(), 72);
    assert_eq!(body["columns"][2]["encoding"], "hex");
    assert_eq!(body["columns"][3]["data_type"], "NUMBER(38,8)");
    for (row, id) in body["rows"].as_array().unwrap().iter().zip((1..=130).rev()) {
        assert_eq!(row[0], id.to_string());
        assert_eq!(row[2], "00FF");
        assert_eq!(row[3], "123456789012345678901234567890.12345678");
        assert_eq!(row[4], "{\"n\":9007199254740993}");
        assert_eq!(row[5], "2026-09-18T04:12:33.123456789+09:00");
        assert_eq!(row[71], "마지막 열");
    }
    assert_eq!(body["rows"][0][1], "서울 🚀");
    assert_eq!(body["rows"][129][1], "한".repeat(24_000));
    let audit = manager
        .store
        .list_audit_events(None)
        .unwrap()
        .events
        .into_iter()
        .find(|event| event.correlation_id == request_id)
        .unwrap();
    assert_eq!(audit.operation, "snowflake.export.json");
    assert_eq!(audit.profile_id.as_deref(), Some(profile.id.as_str()));
    assert_eq!(
        audit.object_name.as_deref(),
        Some(r#""Db"."Case.Schema"."Item""s""#)
    );
    assert_eq!(audit.affected_count, Some(130));
    task.await.unwrap();
}

#[tokio::test]
async fn snowflake_csv_preserves_nulls_empty_values_and_formula_protection() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "export", "Db");
    let filename = dir.path().join("safe.csv");
    let task = tokio::spawn(async move {
        let columns = vec![
            json!(["number", "NUMBER", "YES", "NO", "38", "6"]),
            column("label", "TEXT"),
            column("binary", "VARBINARY"),
            column("variant", "VARIANT"),
        ];
        reply_columns(&fixture, columns.clone()).await;
        let (_, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        let data = vec![
            vec![
                json!("-12345678901234567890123456789012.345678"),
                json!("=SUM(1,2)"),
                json!("00ff"),
                json!("null"),
            ],
            vec![Value::Null, json!(""), json!(""), Value::Null],
        ];
        reply(stream, "200 OK", "", &part(2, &[2], data)).await;
        reply_columns(&fixture, columns).await;
    });
    let save = || {
        manager.export(
            "export",
            Uuid::new_v4().to_string(),
            test_object(),
            TableQueryClauses::default(),
            export_options(&filename, "csv"),
        )
    };
    let ExportOutcome::Exported { report } = save().await.unwrap() else {
        panic!("expected CSV")
    };
    assert_eq!(report.protected_fields, 1);
    assert_eq!(report.rows, 2);
    let csv = fs::read_to_string(&filename).unwrap();
    assert_eq!(
        csv,
        concat!(
            "\"number\",\"label\",\"binary\",\"variant\"\r\n",
            "-12345678901234567890123456789012.345678,\"'=SUM(1,2)\",\"X'00FF'\",\"null\"\r\n",
            "\\N,\"\",\"X''\",\\N\r\n"
        )
    );
    assert!(save().await.err().unwrap().contains("같은 이름"));
    assert_eq!(fs::read_to_string(&filename).unwrap(), csv);
    task.await.unwrap();
}

#[tokio::test]
async fn snowflake_rejects_incomplete_partitions_and_malformed_rows_without_publishing() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "export", "Db");
    let task = tokio::spawn(async move {
        reply_columns(&fixture, vec![column("label", "TEXT")]).await;
        let (_, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        reply(
            stream,
            "200 OK",
            "",
            &part(3, &[1, 2], vec![vec![json!("first")]]),
        )
        .await;
        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE}?partition=1 HTTP/1.1"));
        reply(
            stream,
            "200 OK",
            "",
            &encoded(json!({"data": [["second"]]})),
        )
        .await;
        reply_columns(&fixture, vec![column("raw", "BINARY")]).await;
        let (_, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        reply(
            stream,
            "200 OK",
            "",
            &part(1, &[1], vec![vec![json!("not hex")]]),
        )
        .await;
        reply_columns(&fixture, vec![column("label", "TEXT")]).await;
        let (_, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        reply(
            stream,
            "200 OK",
            "",
            &part(1, &[1], vec![vec![json!("label"), json!("extra")]]),
        )
        .await;
    });
    for name in ["short.json", "hex.json", "width.json"] {
        let target = dir.path().join(name);
        let result = manager
            .export(
                "export",
                Uuid::new_v4().to_string(),
                test_object(),
                TableQueryClauses::default(),
                export_options(&target, "json"),
            )
            .await;
        assert_eq!(result.err().unwrap(), BAD_RESPONSE);
        assert!(!target.exists());
        assert!(fs::read_dir(dir.path()).unwrap().all(|item| !item
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".stackport-")));
    }
    task.await.unwrap();
}

#[tokio::test]
async fn snowflake_export_cancellation_uses_the_pending_handle() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "export", "Db");
    let signal = Arc::new(Notify::new());
    let pending = Arc::clone(&signal);
    let task = tokio::spawn(async move {
        reply_columns(&fixture, vec![column("label", "TEXT")]).await;
        let (_, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        reply(stream, "202 Accepted", "", &status()).await;
        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("GET {PATH}/{HANDLE} HTTP/1.1"));
        reply(stream, "202 Accepted", "", &status()).await;
        pending.notify_one();
        let (request, _, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(request, format!("POST {PATH}/{HANDLE}/cancel HTTP/1.1"));
        reply(stream, "200 OK", "", b"{}").await;
    });
    let target = dir.path().join("cancelled.json");
    let request_id = Uuid::new_v4().to_string();
    let (result, _) = tokio::join!(
        manager.export(
            "export",
            request_id.clone(),
            test_object(),
            TableQueryClauses::default(),
            export_options(&target, "json")
        ),
        async {
            timeout(Duration::from_secs(10), signal.notified())
                .await
                .unwrap();
            assert!(!manager
                .cancel_export("export", &Uuid::new_v4().to_string())
                .unwrap());
            assert!(manager.cancel_export("export", &request_id).unwrap());
        }
    );
    assert!(matches!(result.unwrap(), ExportOutcome::Cancelled));
    assert!(!target.exists());
    assert_eq!(
        manager.export_progress("export", &request_id).unwrap(),
        None
    );
    task.await.unwrap();
}

#[tokio::test]
async fn snowflake_export_cancellation_removes_partial_data_and_keeps_the_session() {
    let (fixture, api) = fixture(Auth::Pat, true).await;
    let dir = tempfile::tempdir().unwrap();
    let (manager, _) = test_session(dir.path(), api, "export", "Db");
    let task = tokio::spawn(async move {
        reply_columns(&fixture, vec![column("label", "TEXT")]).await;
        let (_, _, mut stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        let partial = b"{\"data\":[[\"one row\"],";
        let header = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n");
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(partial).await.unwrap();
        stream.flush().await.unwrap();
        // A partial result must never block a query on the normal session.
        let (_, body, preview) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["statement"],
            "SELECT 1"
        );
        reply(
            preview,
            "200 OK",
            "",
            &part(1, &[1], vec![vec![json!("1")]]),
        )
        .await;
        let (_, body, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["statement"],
            "SELECT 2"
        );
        reply(stream, "200 OK", "", &part(1, &[1], vec![vec![json!("2")]])).await;
    });
    let target = dir.path().join("cancelled.json");
    let request_id = Uuid::new_v4().to_string();
    let (result, _) = tokio::join!(
        manager.export(
            "export",
            request_id.clone(),
            test_object(),
            TableQueryClauses::default(),
            export_options(&target, "json")
        ),
        async {
            timeout(Duration::from_secs(10), async {
                while manager.export_progress("export", &request_id).unwrap() != Some(1) {
                    sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            let session = manager.session("export").unwrap();
            assert_eq!(
                session.api.query("SELECT 1", &[], 1).await.unwrap()[0][0].as_deref(),
                Some("1")
            );
            assert!(manager.cancel_export("export", &request_id).unwrap());
        }
    );
    assert!(matches!(result.unwrap(), ExportOutcome::Cancelled));
    assert!(!target.exists());
    assert!(fs::read_dir(dir.path()).unwrap().all(|item| !item
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".stackport-")));
    let session = manager.session("export").unwrap();
    assert_eq!(
        session.api.query("SELECT 2", &[], 1).await.unwrap()[0][0].as_deref(),
        Some("2")
    );
    task.await.unwrap();
}

fn test_session(
    directory: &FilePath,
    api: Api,
    name: &str,
    database: &str,
) -> (Arc<Manager>, Profile) {
    let store = crate::Store::open(directory.join("workspace.sqlite")).unwrap();
    let project = store.create_project("Snowflake loopback").unwrap();
    let mut settings = api.settings.clone();
    settings.host = "fixture.snowflakecomputing.com".into();
    let profile = store
        .create_snowflake_profile(&project.id, settings)
        .unwrap();
    let manager = Arc::new(Manager::new(store));
    let permit = Arc::clone(&manager.capacity).try_acquire_owned().unwrap();
    manager.sessions.lock().unwrap().insert(
        name.into(),
        Arc::new(Session {
            api,
            database: database.into(),
            profile: profile.clone(),
            operations: tokio::sync::Semaphore::new(3),
            export: Mutex::new(None),
            _permit: permit,
        }),
    );
    (manager, profile)
}

fn column(name: &str, data_type: &str) -> Value {
    json!([name, data_type, "YES", "NO", null, null])
}

fn part(total: usize, partition_rows: &[usize], data: Vec<Vec<Value>>) -> Vec<u8> {
    let partitions: Vec<_> = partition_rows
        .iter()
        .map(|rows| json!({ "rowCount": rows }))
        .collect();
    encoded(
        json!({ "statementHandle": HANDLE, "resultSetMetaData": {"numRows": total, "partitionInfo": partitions}, "data": data }),
    )
}

async fn reply_columns(fixture: &Fixture, columns: Vec<Value>) {
    let (_, body, stream) = fixture.request("PROGRAMMATIC_ACCESS_TOKEN").await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert!(body["statement"]
        .as_str()
        .unwrap()
        .contains("ORDER BY ORDINAL_POSITION LIMIT 4097"));
    assert_eq!(body["bindings"]["1"]["value"], "Case.Schema");
    assert_eq!(body["bindings"]["2"]["value"], "Item\"s");
    let count = columns.len();
    let data = columns
        .into_iter()
        .map(|row| row.as_array().unwrap().clone())
        .collect();
    reply(stream, "200 OK", "", &part(count, &[count], data)).await;
}

fn test_object() -> String {
    serde_json::to_string(&["Case.Schema", "Item\"s"]).unwrap()
}

fn export_options(file: &FilePath, format: &str) -> ExportOptions {
    serde_json::from_value(json!({ "destination": file, "format": format, "include_header": true, "spreadsheet_safe": true })).unwrap()
}

async fn fixture(auth: Auth, trusted: bool) -> (Fixture, Api) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut ca = CertificateParams::new(Vec::new()).unwrap();
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca.key_usages.push(KeyUsagePurpose::KeyCertSign);
    ca.distinguished_name
        .push(DnType::CommonName, "StackPort loopback test CA");
    let key = KeyPair::generate().unwrap();
    let root = ca.self_signed(&key).unwrap();
    let issuer = Issuer::new(ca, key);
    let mut leaf = CertificateParams::new(vec![HOST.into()]).unwrap();
    leaf.distinguished_name.push(DnType::CommonName, HOST);
    let key = KeyPair::generate().unwrap();
    let leaf = leaf.signed_by(&key, &issuer).unwrap();
    let tls = ServerConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![leaf.der().clone()],
            PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
        )
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(tls));

    let mut builder = client_builder().no_proxy().resolve(HOST, address);
    if trusted {
        builder =
            builder.tls_certs_merge([reqwest::Certificate::from_der(root.der().as_ref()).unwrap()]);
    }
    let api = Api {
        client: builder.build().unwrap(),
        endpoint: Url::parse(&format!("https://{HOST}:{}{PATH}", address.port())).unwrap(),
        settings: ProfileSettings {
            name: "loopback".into(),
            host: HOST.into(),
            database: "DEMO".into(),
            warehouse: Some("DEMO_WH".into()),
            role: Some("READER".into()),
            auth,
            environment: "DEV".into(),
        },
        token: AccessToken(Zeroizing::new(TEST_TOKEN.into())),
        cancel: CancellationToken::new(),
    };
    (Fixture { listener, acceptor }, api)
}

impl Fixture {
    async fn request(&self, token_type: &str) -> (String, Vec<u8>, TlsStream<TcpStream>) {
        let (socket, _) = self.listener.accept().await.unwrap();
        let mut stream = BufReader::new(self.acceptor.accept(socket).await.unwrap());
        let mut request = String::new();
        stream.read_line(&mut request).await.unwrap();
        let mut length = 0;
        let mut authorization = String::new();
        let mut kind = String::new();
        loop {
            let mut header = String::new();
            assert!(stream.read_line(&mut header).await.unwrap() > 0);
            if header == "\r\n" {
                break;
            }
            let (name, value) = header.split_once(':').unwrap();
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap();
            } else if name.eq_ignore_ascii_case("authorization") {
                authorization = value.trim().into();
            } else if name.eq_ignore_ascii_case("x-snowflake-authorization-token-type") {
                kind = value.trim().into();
            }
        }
        assert_eq!(authorization, format!("Bearer {TEST_TOKEN}"));
        assert_eq!(kind, token_type);
        let mut body = vec![0; length];
        stream.read_exact(&mut body).await.unwrap();
        (request.trim_end().into(), body, stream.into_inner())
    }
}

async fn reply(mut stream: TlsStream<TcpStream>, response: &str, headers: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {response}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    stream.shutdown().await.unwrap();
}

fn status() -> Vec<u8> {
    encoded(
        json!({ "statementHandle": HANDLE, "statementStatusUrl": "/untrusted-status-location" }),
    )
}

fn encoded(value: Value) -> Vec<u8> {
    serde_json::to_vec(&value).unwrap()
}
