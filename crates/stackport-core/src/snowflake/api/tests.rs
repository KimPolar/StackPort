use super::*;
use crate::snowflake::{Auth, Manager, Session};
use flate2::{write::GzEncoder, Compression};
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::{pki_types::PrivatePkcs8KeyDer, ServerConfig};
use std::{io::Write, sync::Arc};
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
    let manager =
        Manager::new(crate::Store::open(directory.path().join("workspace.sqlite")).unwrap());
    let permit = Arc::clone(&manager.capacity).try_acquire_owned().unwrap();
    manager.sessions.lock().unwrap().insert(
        "definition".into(),
        Arc::new(Session {
            api,
            database: "Db".into(),
            operations: tokio::sync::Semaphore::new(1),
            _permit: permit,
        }),
    );
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
