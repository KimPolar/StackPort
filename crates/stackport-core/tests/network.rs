use stackport_core::NetworkManager;
use std::{io::Read, net::TcpListener, time::Duration};

#[test]
fn tcp_probe_connects_to_loopback_without_sending_application_data() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = [0u8; 16];
        stream.read(&mut bytes).unwrap()
    });
    let report = NetworkManager::default()
        .diagnose("127.0.0.1", address.port())
        .unwrap();
    assert_eq!(report.dns.status, "literal");
    assert_eq!(report.tcp.status, "connected");
    assert_eq!(
        report.connected_address.as_deref(),
        Some(address.to_string().as_str())
    );
    assert_eq!(server.join().unwrap(), 0);
}

#[test]
fn dns_and_tcp_are_reported_separately() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || listener.accept().unwrap());
    let report = NetworkManager::default()
        .diagnose("localhost", port)
        .unwrap();
    assert_eq!(report.dns.status, "resolved");
    assert!(!report.addresses.is_empty());
    assert_eq!(report.tcp.status, "connected");
    drop(server.join().unwrap());
}

#[test]
fn invalid_targets_and_unavailable_tcp_ports_do_not_look_connected() {
    let manager = NetworkManager::default();
    assert!(manager.diagnose("-oProxyCommand=bad", 22).is_err());
    assert!(manager.diagnose("127.0.0.1", 0).is_err());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let report = manager.diagnose("127.0.0.1", port).unwrap();
    assert!(matches!(
        report.tcp.status,
        "refused" | "unreachable" | "timed_out" | "failed"
    ));
    assert!(report.connected_address.is_none());
}
#[cfg(windows)]
#[test]
fn windows_echo_and_route_use_validated_loopback_targets() {
    use stackport_core::{NetworkManager, RouteFamily, RouteTool};
    let network = NetworkManager::default();
    assert!(network
        .probe_route("-t", RouteTool::Ping, RouteFamily::Auto)
        .is_err());
    let ping = network
        .probe_route("127.0.0.1", RouteTool::Ping, RouteFamily::Ipv4)
        .unwrap();
    assert_eq!(ping.exit_code, Some(0));
    assert!(!ping.timed_out && !ping.truncated);
    assert!(ping.output.contains("127.0.0.1"));
    let route = network
        .probe_route("127.0.0.1", RouteTool::Trace, RouteFamily::Ipv4)
        .unwrap();
    assert_eq!(route.exit_code, Some(0));
    assert!(!route.timed_out);
    assert!(route.output.contains("127.0.0.1"));
}
