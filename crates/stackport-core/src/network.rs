//! Explicit, bounded DNS and TCP diagnostics without authentication.

use crate::{
    network_tools, ssh, web_check, Result, RouteDiagnostic, RouteFamily, RouteTool, WebDiagnostic,
    WebMethod,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    io,
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

const MAX_PROBES: usize = 4;
const MAX_DNS_WORKERS: usize = 4;
const MAX_ADDRESSES: usize = 8;
const DNS_TIMEOUT: Duration = Duration::from_secs(4);
const TCP_BUDGET: Duration = Duration::from_secs(4);
const TCP_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Serialize)]
pub struct DiagnosticStep {
    pub status: &'static str,
    pub elapsed_ms: u64,
}

#[derive(Serialize)]
pub struct TcpAttempt {
    pub address: String,
    pub status: &'static str,
    pub elapsed_ms: u64,
}

#[derive(Serialize)]
pub struct NetworkDiagnostics {
    pub host: String,
    pub port: u16,
    pub dns: DiagnosticStep,
    pub tcp: DiagnosticStep,
    pub addresses: Vec<String>,
    pub attempts: Vec<TcpAttempt>,
    pub connected_address: Option<String>,
}

#[derive(Default)]
pub struct NetworkManager {
    active: Arc<AtomicUsize>,
    dns_workers: Arc<AtomicUsize>,
}

struct Permit(Arc<AtomicUsize>);

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn reserve(counter: &Arc<AtomicUsize>, max: usize) -> Option<Permit> {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < max).then_some(current + 1)
        })
        .ok()
        .map(|_| Permit(Arc::clone(counter)))
}

enum Resolution {
    Success(Vec<SocketAddr>),
    Failed,
    TimedOut,
    Busy,
}

// OS name resolution cannot be cancelled portably. At most four detached
// workers may outlive a timed-out request, and their permits last until exit.
fn resolve_with_timeout<F>(counter: &Arc<AtomicUsize>, timeout: Duration, resolve: F) -> Resolution
where
    F: FnOnce() -> io::Result<Vec<SocketAddr>> + Send + 'static,
{
    let Some(permit) = reserve(counter, MAX_DNS_WORKERS) else {
        return Resolution::Busy;
    };
    let (send, receive) = mpsc::sync_channel(1);
    if std::thread::Builder::new()
        .name("stackport-dns".into())
        .spawn(move || {
            let _permit = permit;
            let _ = send.send(resolve());
        })
        .is_err()
    {
        return Resolution::Failed;
    }
    match receive.recv_timeout(timeout) {
        Ok(Ok(addresses)) if !addresses.is_empty() => Resolution::Success(addresses),
        Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => Resolution::Failed,
        Err(mpsc::RecvTimeoutError::Timeout) => Resolution::TimedOut,
    }
}

fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

impl NetworkManager {
    pub fn probe_web(&self, address: &str, method: WebMethod, samples: u8) -> Result<WebDiagnostic> {
        let target = web_check::parse_address(address)?;
        if !(1..=5).contains(&samples) {
            return Err("요청 횟수는 1회부터 5회까지 선택하세요.".into());
        }
        let _probe = reserve(&self.active, MAX_PROBES)
            .ok_or("동시에 실행할 수 있는 연결 진단 수를 초과했습니다.")?;
        web_check::run(target, method, samples)
    }

    pub fn probe_route(
        &self,
        target: &str,
        tool: RouteTool,
        family: RouteFamily,
    ) -> Result<RouteDiagnostic> {
        let target = ssh::normalize_host(target)?;
        let _probe = reserve(&self.active, MAX_PROBES)
            .ok_or("동시에 실행할 수 있는 연결 진단 수를 초과했습니다.")?;
        network_tools::run(&target, tool, family)
    }

    pub fn diagnose(&self, host: &str, port: u16) -> Result<NetworkDiagnostics> {
        let host = ssh::normalize_host(host)?;
        ssh::validate_port(port)?;
        let _probe = reserve(&self.active, MAX_PROBES)
            .ok_or("동시에 실행할 수 있는 연결 진단 수를 초과했습니다. 진행 중인 진단이 끝나면 다시 시도하세요.")?;
        let dns_start = Instant::now();
        let (dns_status, addresses) = if let Ok(ip) = host.parse::<IpAddr>() {
            ("literal", vec![SocketAddr::new(ip, port)])
        } else {
            let name = host.clone();
            match resolve_with_timeout(&self.dns_workers, DNS_TIMEOUT, move || {
                let mut seen = HashSet::new();
                Ok((name.as_str(), port)
                    .to_socket_addrs()?
                    .filter(|address| seen.insert(*address))
                    .take(MAX_ADDRESSES)
                    .collect())
            }) {
                Resolution::Success(addresses) => ("resolved", addresses),
                Resolution::Failed => ("failed", vec![]),
                Resolution::TimedOut => ("timed_out", vec![]),
                Resolution::Busy => ("busy", vec![]),
            }
        };
        let dns = DiagnosticStep {
            status: dns_status,
            elapsed_ms: elapsed_ms(dns_start),
        };
        let tcp_start = Instant::now();
        let deadline = tcp_start + TCP_BUDGET;
        let mut tcp_status = "not_tested";
        let mut connected_address = None;
        let mut attempts = Vec::new();
        for address in &addresses {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                tcp_status = "timed_out";
                break;
            };
            if remaining.is_zero() {
                tcp_status = "timed_out";
                break;
            }
            let attempt_start = Instant::now();
            match TcpStream::connect_timeout(address, remaining.min(TCP_ATTEMPT_TIMEOUT)) {
                Ok(stream) => {
                    drop(stream);
                    tcp_status = "connected";
                    connected_address = Some(address.to_string());
                    attempts.push(TcpAttempt {
                        address: address.to_string(),
                        status: "connected",
                        elapsed_ms: elapsed_ms(attempt_start),
                    });
                    break;
                }
                Err(error) => {
                    // Prefer a timeout if one address timed out; otherwise show
                    // the latest failure. No application data is sent.
                    let status = match error.kind() {
                        io::ErrorKind::ConnectionRefused => "refused",
                        io::ErrorKind::TimedOut => "timed_out",
                        io::ErrorKind::NetworkUnreachable | io::ErrorKind::HostUnreachable => {
                            "unreachable"
                        }
                        _ => "failed",
                    };
                    attempts.push(TcpAttempt {
                        address: address.to_string(),
                        status,
                        elapsed_ms: elapsed_ms(attempt_start),
                    });
                    if tcp_status != "timed_out" {
                        tcp_status = status;
                    }
                }
            }
        }
        Ok(NetworkDiagnostics {
            host,
            port,
            dns,
            tcp: DiagnosticStep {
                status: tcp_status,
                elapsed_ms: elapsed_ms(tcp_start),
            },
            addresses: addresses
                .into_iter()
                .map(|address| address.to_string())
                .collect(),
            attempts,
            connected_address,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timed_out_dns_workers_keep_their_capacity_until_they_finish() {
        let counter = Arc::new(AtomicUsize::new(MAX_DNS_WORKERS - 1));
        let (release, wait) = mpsc::channel();
        assert!(matches!(
            resolve_with_timeout(&counter, Duration::from_millis(10), move || {
                wait.recv().unwrap();
                Ok(vec![])
            }),
            Resolution::TimedOut
        ));
        assert!(matches!(
            resolve_with_timeout(&counter, Duration::from_millis(10), || Ok(vec![])),
            Resolution::Busy
        ));
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while counter.load(Ordering::Acquire) != MAX_DNS_WORKERS - 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(counter.load(Ordering::Acquire), MAX_DNS_WORKERS - 1);
    }
}
