use super::SavedSshTunnel;
use crate::{
    ssh_transport::{self, Endpoint, SshRoute},
    Result, SshManager, SshProfile, SshRouteHop, SshRouteResult, Store, MAX_SSH_HOPS,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io,
    net::{Ipv4Addr, SocketAddr},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering::Relaxed},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    sync::{oneshot, watch},
    task::JoinSet,
    time::{interval, interval_at, timeout, MissedTickBehavior},
};

const MAX_TUNNELS: usize = 16;
const MAX_RECORDS: usize = 64;
const MAX_CLIENTS: usize = 32;
const FORWARD_TIMEOUT: Duration = Duration::from_secs(10);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

pub struct SshTunnelManager {
    store: Store,
    starting: tokio::sync::Mutex<()>,
    sessions: Mutex<HashMap<String, Session>>,
}

struct Session {
    stats: Arc<Stats>,
    stop: Option<oneshot::Sender<()>>,
    done: watch::Receiver<bool>,
}

struct Stats {
    tunnel: SavedSshTunnel,
    local_port: u16,
    gateway: SshProfile,
    hops: Vec<String>,
    created: Instant,
    clients: AtomicU32,
    sent: AtomicU64,
    received: AtomicU64,
    state: Mutex<State>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Running,
    Stopping,
    Stopped,
    Disconnected,
}

struct State {
    phase: Phase,
    last_error: Option<String>,
}

#[derive(Serialize)]
pub struct SshTunnelStatus {
    tunnel: SavedSshTunnel,
    local_port: u16,
    gateway: SshProfile,
    hops: Vec<String>,
    phase: Phase,
    clients: u32,
    sent_bytes: String,
    received_bytes: String,
    last_error: Option<String>,
}

impl SshTunnelManager {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            starting: tokio::sync::Mutex::new(()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn status(&self) -> Result<Vec<SshTunnelStatus>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "터널 상태를 읽을 수 없습니다.")?;
        let mut recent: Vec<_> = sessions.values().collect();
        recent.sort_by_key(|session| std::cmp::Reverse(session.stats.created));
        recent
            .into_iter()
            .map(|session| session.stats.snapshot())
            .collect()
    }

    pub async fn start(
        &self,
        ssh: Arc<SshManager>,
        tunnel: SavedSshTunnel,
        gateway: SshRouteHop,
        hops: Vec<SshRouteHop>,
        confirmation: &str,
    ) -> Result<SshRouteResult<SshTunnelStatus>> {
        let _starting = self
            .starting
            .try_lock()
            .map_err(|_| "다른 터널이 연결 중입니다. 연결이 끝난 뒤 다시 시작하세요.")?;
        if hops.len() > MAX_SSH_HOPS {
            return Err(format!("경유 서버는 최대 {MAX_SSH_HOPS}개입니다."));
        }
        let profiles = gateway_profiles(&tunnel, &gateway, &hops, confirmation)?;
        self.verify(&tunnel, &profiles).await?;
        {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "터널 상태를 읽을 수 없습니다.")?;
            if sessions
                .get(&tunnel.id)
                .is_some_and(|session| !*session.done.borrow())
            {
                return Err("이 터널이 이미 실행 중입니다.".into());
            }
            if sessions
                .values()
                .filter(|session| !*session.done.borrow())
                .count()
                >= MAX_TUNNELS
            {
                return Err(
                    "열린 SSH 터널이 너무 많습니다. 사용하지 않는 터널을 중단하세요.".into(),
                );
            }
        }
        let socket = bind(tunnel.settings.local_port)?;
        let route = match connect_gateway(ssh, gateway, hops).await? {
            SshRouteResult::Open { session } => session,
            SshRouteResult::TrustRequired { stage, host } => {
                return Ok(SshRouteResult::TrustRequired { stage, host })
            }
        };
        if let Err(error) = self.verify(&tunnel, &profiles).await {
            route.close().await;
            return Err(error);
        }
        let listener = socket
            .listen(64)
            .map_err(|error| listen_error(tunnel.settings.local_port, error))?;
        let local_port = listener
            .local_addr()
            .map_err(|_| "열린 로컬 포트를 확인할 수 없습니다.")?
            .port();
        let stats = Arc::new(Stats {
            tunnel,
            local_port,
            gateway: profiles[0].clone(),
            hops: profiles[1..].iter().map(|item| item.name.clone()).collect(),
            created: Instant::now(),
            clients: AtomicU32::new(0),
            sent: AtomicU64::new(0),
            received: AtomicU64::new(0),
            state: Mutex::new(State {
                phase: Phase::Running,
                last_error: None,
            }),
        });
        let snapshot = stats.snapshot()?;
        let (stop, stopped) = oneshot::channel();
        let (complete, done) = watch::channel(false);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "터널 상태를 기록할 수 없습니다.")?;
        if sessions.len() >= MAX_RECORDS {
            let oldest = sessions
                .iter()
                .filter(|(_, item)| *item.done.borrow())
                .min_by_key(|(_, item)| item.stats.created)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                sessions.remove(&id);
            }
        }
        sessions.insert(
            stats.tunnel.id.clone(),
            Session {
                stats: Arc::clone(&stats),
                stop: Some(stop),
                done,
            },
        );
        tokio::spawn(serve(listener, route, stats, stopped, complete));
        Ok(SshRouteResult::Open { session: snapshot })
    }

    pub async fn stop(&self, id: &str) -> Result<SshTunnelStatus> {
        let (stats, mut done) = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "터널 상태를 읽을 수 없습니다.")?;
            let session = sessions
                .get_mut(id)
                .ok_or("열린 SSH 터널을 찾을 수 없습니다.")?;
            request_stop(session);
            (Arc::clone(&session.stats), session.done.clone())
        };
        while !*done.borrow_and_update() {
            done.changed()
                .await
                .map_err(|_| "터널 종료를 확인할 수 없습니다.")?;
        }
        stats.snapshot()
    }

    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for session in sessions.values_mut() {
                request_stop(session);
            }
        }
    }

    async fn verify(&self, tunnel: &SavedSshTunnel, profiles: &[SshProfile]) -> Result<()> {
        let store = self.store.clone();
        let tunnel = tunnel.clone();
        let profiles = profiles.to_vec();
        tokio::task::spawn_blocking(move || {
            if store.ssh_tunnel(&tunnel.id)? != tunnel {
                return Err("터널 설정이 변경되었습니다. 새로고침하세요.".into());
            }
            for profile in profiles {
                if store.ssh_profile(&profile.id)? != profile {
                    return Err(format!(
                        "{}의 SSH 설정이 변경되었습니다. 경로를 다시 확인하세요.",
                        profile.name
                    ));
                }
            }
            Ok(())
        })
        .await
        .map_err(|_| "터널 설정을 확인할 수 없습니다.")?
    }
}

fn gateway_profiles(
    tunnel: &SavedSshTunnel,
    gateway: &SshRouteHop,
    hops: &[SshRouteHop],
    confirmation: &str,
) -> Result<Vec<SshProfile>> {
    if tunnel.settings.ssh_profile_id != gateway.profile.id {
        return Err("터널에 저장된 SSH 연결을 사용하세요.".into());
    }
    let profiles: Vec<_> = std::iter::once(&gateway.profile)
        .chain(hops.iter().map(|hop| &hop.profile))
        .collect();
    for profile in &profiles {
        if profile.project_id != tunnel.project_id {
            return Err("같은 프로젝트의 SSH 연결을 사용하세요.".into());
        }
        if profile.environment == "PROD" && confirmation != "PROD" {
            return Err(format!(
                "{}의 운영 환경을 확인하려면 PROD를 입력하세요.",
                profile.name
            ));
        }
    }
    Ok(profiles.into_iter().cloned().collect())
}

async fn connect_gateway(
    ssh: Arc<SshManager>,
    gateway: SshRouteHop,
    hops: Vec<SshRouteHop>,
) -> Result<SshRouteResult<SshRoute>> {
    if !hops.is_empty() {
        return ssh_transport::connect_route(ssh, &gateway.profile, gateway.authentication, hops)
            .await;
    }
    let stage = format!("SSH 서버 · {}", gateway.profile.name);
    match ssh_transport::connect_endpoint(ssh, &gateway.profile, gateway.authentication, None, true)
        .await
        .map_err(|error| format!("{stage} — {error}"))?
    {
        Endpoint::Authenticated(connection) => Ok(SshRouteResult::Open {
            session: SshRoute {
                connection,
                hops: Vec::new(),
            },
        }),
        Endpoint::TrustRequired(host) => Ok(SshRouteResult::TrustRequired { stage, host }),
    }
}

fn request_stop(session: &mut Session) {
    if let Some(stop) = session.stop.take() {
        if let Ok(mut state) = session.stats.state.lock() {
            if state.phase == Phase::Running {
                state.phase = Phase::Stopping;
            }
        }
        let _ = stop.send(());
    }
}

impl Stats {
    fn snapshot(&self) -> Result<SshTunnelStatus> {
        let state = self
            .state
            .lock()
            .map_err(|_| "터널 상태를 읽을 수 없습니다.")?;
        Ok(SshTunnelStatus {
            tunnel: self.tunnel.clone(),
            local_port: self.local_port,
            gateway: self.gateway.clone(),
            hops: self.hops.clone(),
            phase: state.phase,
            clients: self.clients.load(Relaxed),
            sent_bytes: self.sent.load(Relaxed).to_string(),
            received_bytes: self.received.load(Relaxed).to_string(),
            last_error: state.last_error.clone(),
        })
    }

    fn error(&self, error: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.last_error = Some(error.into());
        }
    }
}

async fn serve(
    listener: TcpListener,
    route: SshRoute,
    stats: Arc<Stats>,
    mut stop: oneshot::Receiver<()>,
    done: watch::Sender<bool>,
) {
    let route = Arc::new(route);
    let mut peers = JoinSet::new();
    let mut check = interval(Duration::from_secs(1));
    let mut keepalive = interval_at(
        tokio::time::Instant::now() + KEEPALIVE_INTERVAL,
        KEEPALIVE_INTERVAL,
    );
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let error = loop {
        tokio::select! {
            _ = &mut stop => break None,
            _ = check.tick() => {
                if route.is_closed() || route.hops.iter().any(|hop| hop.is_closed()) { break Some("터널의 SSH 연결이 끊겼습니다."); }
            }
            _ = keepalive.tick() => {
                let _ = timeout(Duration::from_millis(100), route.connection.send_keepalive(true)).await;
            }
            _ = peers.join_next(), if !peers.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) if peers.len() < MAX_CLIENTS => {
                    let route = Arc::clone(&route);
                    let stats = Arc::clone(&stats);
                    stats.clients.fetch_add(1, Relaxed);
                    let client = Client(stats);
                    peers.spawn(async move {
                        if let Err(error) = forward(&route, &client.0, stream, peer).await { client.0.error(error); }
                    });
                }
                Ok(_) => stats.error("동시 연결이 너무 많아 새 TCP 연결을 거부했습니다."),
                Err(_) => break Some("로컬 포트에서 새 연결을 받을 수 없습니다."),
            }
        }
    };
    drop(listener);
    peers.shutdown().await;
    route.close().await;
    if let Ok(mut state) = stats.state.lock() {
        state.phase = if error.is_some() {
            Phase::Disconnected
        } else {
            Phase::Stopped
        };
        if let Some(error) = error {
            state.last_error = Some(error.into());
        }
    }
    done.send_replace(true);
}

struct Client(Arc<Stats>);

impl Drop for Client {
    fn drop(&mut self) {
        self.0.clients.fetch_sub(1, Relaxed);
    }
}

async fn forward(
    route: &SshRoute,
    stats: &Stats,
    stream: TcpStream,
    peer: SocketAddr,
) -> std::result::Result<(), &'static str> {
    let target = &stats.tunnel.settings;
    let channel = timeout(
        FORWARD_TIMEOUT,
        route.connection.channel_open_direct_tcpip(
            target.target_host.as_str(),
            target.target_port.into(),
            peer.ip().to_string(),
            peer.port().into(),
        ),
    )
    .await
    .map_err(|_| "SSH 서버의 대상 연결 시간이 초과되었습니다.")?
    .map_err(|_| {
        "SSH 서버가 대상 연결을 열지 못했습니다. 대상 주소와 서버의 포트 전달 권한을 확인하세요."
    })?;
    let (local_read, local_write) = stream.into_split();
    let (remote_read, remote_write) = tokio::io::split(channel.into_stream());
    tokio::try_join!(
        copy_counted(local_read, remote_write, &stats.sent),
        copy_counted(remote_read, local_write, &stats.received),
    )
    .map_err(|_| "터널 연결의 데이터 전달이 중단되었습니다.")?;
    Ok(())
}

async fn copy_counted(
    mut input: impl AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
    bytes: &AtomicU64,
) -> io::Result<()> {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let count = input.read(&mut buffer).await?;
        if count == 0 {
            return output.shutdown().await;
        }
        let mut remaining = &buffer[..count];
        while !remaining.is_empty() {
            let written = output.write(remaining).await?;
            if written == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            bytes.fetch_add(written as u64, Relaxed);
            remaining = &remaining[written..];
        }
    }
}

fn bind(port: u16) -> Result<TcpSocket> {
    let socket = TcpSocket::new_v4().map_err(|error| listen_error(port, error))?;
    #[cfg(windows)]
    exclusive(&socket).map_err(|error| listen_error(port, error))?;
    socket
        .bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .map_err(|error| listen_error(port, error))?;
    Ok(socket)
}

#[cfg(windows)]
fn exclusive(socket: &TcpSocket) -> io::Result<()> {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{setsockopt, SOL_SOCKET, SO_EXCLUSIVEADDRUSE};
    let enabled = 1u32.to_ne_bytes();
    // The socket is owned by TcpSocket and the flag buffer lives through the call.
    let result = unsafe {
        setsockopt(
            socket.as_raw_socket() as usize,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            enabled.as_ptr(),
            enabled.len() as i32,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn listen_error(port: u16, error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::AddrInUse => format!("로컬 포트 {port}를 이미 사용 중입니다."),
        io::ErrorKind::PermissionDenied => format!(
            "로컬 포트 {port}가 예약되어 있거나 이미 사용 중입니다. 다른 포트를 선택하세요."
        ),
        _ => format!("로컬 포트를 열 수 없습니다. {error}"),
    }
}
