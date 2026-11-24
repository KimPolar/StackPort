#![cfg(windows)]

use stackport_core::local_ports;
use std::net::{TcpListener, TcpStream, UdpSocket};

#[test]
fn local_inventory_reads_owned_tcp_and_udp_endpoints() {
    let listening = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listening.local_addr().unwrap();
    let client = TcpStream::connect(address).unwrap();
    let (_accepted, client_address) = listening.accept().unwrap();
    let datagram = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
    let udp = datagram.local_addr().unwrap();
    let ipv6 = TcpListener::bind(("::1", 0)).ok();
    let snapshot = local_ports().unwrap();
    let pid = std::process::id();
    let exe = std::env::current_exe().unwrap();
    let name = exe.file_name().unwrap().to_str().unwrap();
    let row = snapshot
        .ports
        .iter()
        .find(|row| {
            row.transport == "TCP"
                && row.family == "IPv4"
                && row.state == "LISTEN"
                && row.local.address == "127.0.0.1"
                && row.local.port == address.port()
                && row.pid == pid
        })
        .unwrap();
    assert_eq!(row.process.as_deref(), Some(name));
    assert!(row.remote.is_none());
    assert!(snapshot.ports.iter().any(|row| {
        row.transport == "TCP"
            && row.state == "ESTABLISHED"
            && row.pid == pid
            && row.local.port == address.port()
            && row.remote.as_ref().is_some_and(|remote| {
                remote.address == "127.0.0.1" && remote.port == client_address.port()
            })
    }));
    assert_eq!(client.local_addr().unwrap(), client_address);
    assert!(snapshot.ports.iter().any(|row| {
        row.transport == "UDP"
            && row.family == "IPv4"
            && row.state == "BOUND"
            && row.local.address == "127.0.0.1"
            && row.local.port == udp.port()
            && row.pid == pid
    }));
    if let Some(listener) = ipv6 {
        let port = listener.local_addr().unwrap().port();
        assert!(snapshot.ports.iter().any(|row| {
            row.transport == "TCP"
                && row.family == "IPv6"
                && row.state == "LISTEN"
                && row.local.address == "::1"
                && row.local.port == port
                && row.pid == pid
        }));
    }
}
