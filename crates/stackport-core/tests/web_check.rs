use stackport_core::{NetworkManager, WebMethod};

#[test]
fn rejects_ambiguous_targets_and_out_of_range_samples() {
    let manager = NetworkManager::default();
    for invalid in [
        "file:///C:/local",
        "http://127.0.0.1:0/",
        "http://@127.0.0.1/",
        "http://user:password@127.0.0.1/",
        "http://127.0.0.1/#fragment",
        "http:///127.0.0.1/",
        "http://127.0.0.1\\ignored",
        "http://127.0.0.1/line\nbreak",
        "https:127.0.0.1",
    ] {
        assert!(
            manager.probe_web(invalid, WebMethod::Head, 1).is_err(),
            "{invalid}"
        );
    }
    for invalid in [0, 6] {
        assert!(manager
            .probe_web("http://127.0.0.1:1/", WebMethod::Head, invalid)
            .is_err());
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use stackport_core::WebResponse;
    use std::{
        io::{BufRead, BufReader, Write},
        net::{TcpListener, TcpStream},
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn samples_same_url_and_returns_redirect_and_masked_headers() {
        let http = TcpListener::bind("127.0.0.1:0").unwrap();
        let sink = TcpListener::bind("127.0.0.1:0").unwrap();
        sink.set_nonblocking(true).unwrap();
        let address = format!("http://{}/health?name=a%20b", http.local_addr().unwrap());
        let location = format!("http://{}/other", sink.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let started = Instant::now();
            let (mut first, first_request) = incoming(&http, started);
            assert_eq!(first_request[0], "HEAD /health?name=a%20b HTTP/1.1");
            write!(first, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nSet-Cookie: session=synthetic\r\nX-Sample: one\r\nX-Sample: two\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            drop(first);
            let first_finished = Instant::now();
            let (mut second, second_request) = incoming(&http, started);
            assert_eq!(second_request[0], first_request[0]);
            assert!(first_finished.elapsed() >= Duration::from_millis(900));
            assert!(second_request
                .iter()
                .all(|line| !line.to_ascii_lowercase().starts_with("cookie:")));
            second
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
            assert!(
                matches!(sink.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
            );
        });
        let response = NetworkManager::default()
            .probe_web(&address, WebMethod::Head, 2)
            .unwrap();
        worker.join().unwrap();
        assert_eq!(response.samples.len(), 2);
        let WebResponse::Received {
            status_code,
            headers,
            tls,
        } = &response.samples[0].response
        else {
            panic!("{:?}", response.samples);
        };
        assert_eq!(*status_code, 302);
        assert!(tls.is_none());
        assert_eq!(
            headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case("set-cookie"))
                .unwrap()
                .value,
            "[숨김]"
        );
        assert_eq!(
            headers
                .iter()
                .filter(|h| h.name.eq_ignore_ascii_case("x-sample"))
                .count(),
            2
        );
        assert!(matches!(
            response.samples[1].response,
            WebResponse::Received {
                status_code: 204,
                ..
            }
        ));
    }

    #[test]
    fn get_returns_http_errors_and_supports_ipv6() {
        let http = TcpListener::bind("[::1]:0").unwrap();
        let address = format!("http://{}/health", http.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let (mut stream, request) = incoming(&http, Instant::now());
            assert_eq!(request[0], "GET /health HTTP/1.1");
            stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad").unwrap();
        });
        let response = NetworkManager::default()
            .probe_web(&address, WebMethod::Get, 1)
            .unwrap();
        worker.join().unwrap();
        assert!(
            matches!(
                response.samples[0].response,
                WebResponse::Received {
                    status_code: 503,
                    ..
                }
            ),
            "{response:?}"
        );
    }

    #[test]
    fn rejects_oversized_responses() {
        let http = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/", http.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let (mut stream, _) = incoming(&http, Instant::now());
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nX-Large: {}\r\nConnection: close\r\n\r\n",
                "x".repeat(24 * 1024)
            );
        });
        let response = NetworkManager::default()
            .probe_web(&address, WebMethod::Head, 1)
            .unwrap();
        worker.join().unwrap();
        assert!(
            matches!(
                response.samples[0].response,
                WebResponse::Failed {
                    reason: "headers",
                    ..
                }
            ),
            "{response:?}"
        );
    }

    fn incoming(listener: &TcpListener, start: Instant) -> (TcpStream, Vec<String>) {
        listener.set_nonblocking(true).unwrap();
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && start.elapsed() < Duration::from_secs(10) =>
                {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(error) => panic!("Did not receive HTTP request: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(&mut stream);
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                break;
            }
            lines.push(line.trim_end().into());
        }
        (stream, lines)
    }
}
