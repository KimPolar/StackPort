use super::{
    mpsc, terminal_size, Arc, AtomicBool, Mutex, OutputChunk, Session, TerminalExit, TerminalInfo,
    TerminalManager, TerminalState, CHUNK_SIZE, OUTPUT_CHUNKS,
};
use crate::{
    ssh,
    ssh_transport::{self, Endpoint, SshAddress, SshRoute},
    Result, SftpManager, SftpOpened, SshCredentials, SshManager, SshProfile, SshRouteHop, SshRouteResult,
};
use portable_pty::PtySize;
use russh::{client::Msg, Channel, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use std::time::Duration;
use tokio::{
    sync::{mpsc as async_mpsc, oneshot, watch, Semaphore},
    time::timeout,
};
use uuid::Uuid;

const SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const INPUT_CHUNKS: usize = 32;

pub(super) struct RemoteControl {
    input: async_mpsc::Sender<Vec<u8>>,
    size: watch::Sender<PtySize>,
    stop: oneshot::Sender<()>,
    route: Arc<SshRoute>,
    profile: Option<SshProfile>,
}

impl RemoteControl {
    pub(super) fn write(&self, data: &[u8]) -> Result<()> {
        self.input.try_send(data.to_vec()).map_err(|error| {
            match error {
                async_mpsc::error::TrySendError::Full(_) => {
                    "원격 터미널 입력 대기열이 가득 찼습니다. 잠시 뒤 다시 시도하세요."
                }
                async_mpsc::error::TrySendError::Closed(_) => "이미 종료된 터미널입니다.",
            }
            .into()
        })
    }

    pub(super) fn resize(&self, size: PtySize) -> Result<()> {
        self.size
            .send(size)
            .map_err(|_| "이미 종료된 터미널입니다.".into())
    }

    pub(super) fn stop(self) {
        let _ = self.stop.send(());
    }
}

impl TerminalManager {
    pub async fn open_native_ssh(
        &self,
        manager: Arc<SshManager>,
        destination: SshRouteHop,
        rows: u16,
        cols: u16,
    ) -> Result<TerminalInfo> {
        let size = terminal_size(rows, cols)?;
        let profile = destination.profile;
        let address = (&profile).into();
        let target = terminal_target(&address);
        let route = pinned_route(manager, address, destination.authentication).await?;
        self.start_remote(Some(profile), target, route, size).await
    }

    pub async fn open_direct_native_ssh(
        &self,
        manager: Arc<SshManager>,
        host: &str,
        port: u16,
        username: &str,
        authentication: SshCredentials,
        rows: u16,
        cols: u16,
    ) -> Result<TerminalInfo> {
        let size = terminal_size(rows, cols)?;
        let host = ssh::normalize_host(host)?;
        let username = ssh::normalize_username(username)?;
        let address = SshAddress { host: &host, port, username: &username };
        let target = terminal_target(&address);
        let route = pinned_route(manager, address, authentication).await?;
        self.start_remote(None, target, route, size).await
    }

    pub async fn open_sftp(&self, files: &SftpManager, id: &str) -> Result<SftpOpened> {
        let (profile, route) = {
            let sessions = self.sessions.lock().map_err(|_| "터미널 상태를 사용할 수 없습니다.")?;
            let session = sessions.get(id).ok_or("SSH 터미널이 닫혔습니다.")?;
            let remote = session.remote.lock().map_err(|_| "터미널 상태를 사용할 수 없습니다.")?;
            let remote = remote.as_ref().ok_or("이 터미널에서 공유 SFTP 연결을 열 수 없습니다.")?;
            (remote.profile.clone(), Arc::clone(&remote.route))
        };
        files.open_on_terminal(profile, route).await
    }

    pub async fn open_routed_ssh(
        &self,
        manager: Arc<SshManager>,
        destination: SshRouteHop,
        hops: Vec<SshRouteHop>,
        rows: u16,
        cols: u16,
    ) -> Result<SshRouteResult<TerminalInfo>> {
        let size = terminal_size(rows, cols)?;
        let profile = destination.profile;
        let route = match ssh_transport::connect_route(
            manager,
            &profile,
            destination.authentication,
            hops,
            None,
        )
        .await?
        {
            SshRouteResult::Open { session } => session,
            SshRouteResult::TrustRequired { stage, host } => {
                return Ok(SshRouteResult::TrustRequired { stage, host })
            }
        };
        let target = terminal_target(&(&profile).into());
        let session = self.start_remote(Some(profile), target, route, size).await?;
        Ok(SshRouteResult::Open { session })
    }

    async fn start_remote(&self, profile: Option<SshProfile>, target: String, route: SshRoute, size: PtySize) -> Result<TerminalInfo> {
        let channel = match timeout(SETUP_TIMEOUT, open_shell(&route, size)).await {
            Ok(Ok(channel)) => channel,
            result => {
                route.close().await;
                let reason = match result {
                    Ok(Err(reason)) => reason,
                    _ => "원격 터미널 준비 시간이 초과되었습니다.",
                };
                let name = profile.as_ref().map_or(target.as_str(), |profile| &profile.name);
                return Err(format!("대상 · {name} — {reason}"));
            }
        };
        let (output, receiver) = mpsc::channel();
        let (input, input_rx) = async_mpsc::channel(INPUT_CHUNKS);
        let (size, size_rx) = watch::channel(size);
        let (stop, mut stop_rx) = oneshot::channel();
        let state = Arc::new(TerminalState::default());
        let route = Arc::new(route);
        let id = Uuid::new_v4().to_string();
        let session = Arc::new(Session {
            closing: Arc::new(AtomicBool::new(false)),
            state: Arc::clone(&state),
            receiver: Mutex::new(Some(receiver)),
            writer: Mutex::new(None),
            master: Mutex::new(None),
            job: Mutex::new(None),
            known_hosts: Mutex::new(None),
            remote: Mutex::new(Some(RemoteControl {
                input, size, stop, route: Arc::clone(&route), profile: profile.clone(),
            })),
        });
        self.sessions
            .lock()
            .map_err(|_| "터미널 상태를 사용할 수 없습니다.")?
            .insert(id.clone(), session);
        tokio::spawn(async move {
            let (reader, writer) = channel.split();
            let exit = tokio::select! {
                biased;
                _ = &mut stop_rx => None,
                exit = read_output(reader, output) => Some(exit),
                error = send_input(writer, input_rx, size_rx) => Some(TerminalExit { code: None, error }),
            };
            if let Ok(mut stored) = state.exit.lock() {
                *stored = exit;
            }
            route.close().await;
        });
        Ok(TerminalInfo {
            id,
            shell: "ssh".into(),
            process_id: None,
            target: Some(target),
            environment: profile.map(|profile| profile.environment),
            cwd_authority: None,
        })
    }
}

async fn pinned_route(manager: Arc<SshManager>, address: SshAddress<'_>, authentication: SshCredentials) -> Result<SshRoute> {
    let endpoint = ssh_transport::connect_endpoint(manager, address, authentication, None, false, None).await?;
    let Endpoint::Authenticated(connection) = endpoint else {
        return Err("먼저 이 서버의 SSH 호스트 키 지문을 확인하고 신뢰하세요.".into());
    };
    Ok(SshRoute { connection, hops: Vec::new() })
}

fn terminal_target(address: &SshAddress<'_>) -> String {
    let SshAddress { host, port, username } = address;
    if host.contains(':') {
        format!("{username}@[{host}]:{port}")
    } else {
        format!("{username}@{host}:{port}")
    }
}

async fn open_shell(
    route: &SshRoute,
    size: PtySize,
) -> std::result::Result<Channel<Msg>, &'static str> {
    let mut channel = route
        .connection
        .channel_open_session()
        .await
        .map_err(|_| "SSH 세션 채널을 열 수 없습니다.")?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            size.cols.into(),
            size.rows.into(),
            0,
            0,
            &[],
        )
        .await
        .map_err(|_| "원격 터미널을 요청할 수 없습니다.")?;
    if !channel_accepted(&mut channel).await {
        return Err("서버가 원격 터미널 요청을 거부했습니다.");
    }
    channel
        .request_shell(true)
        .await
        .map_err(|_| "원격 셸을 요청할 수 없습니다.")?;
    if !channel_accepted(&mut channel).await {
        return Err("서버가 원격 셸 요청을 거부했습니다.");
    }
    Ok(channel)
}

async fn channel_accepted(channel: &mut Channel<Msg>) -> bool {
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Success => return true,
            ChannelMsg::WindowAdjusted { .. } => continue,
            _ => return false,
        }
    }
    false
}

async fn read_output(
    mut reader: ChannelReadHalf,
    output: mpsc::Sender<OutputChunk>,
) -> TerminalExit {
    // Hold one permit per queued chunk until TerminalManager::read takes it.
    // The asynchronous SSH task never blocks a runtime thread on a full queue.
    let capacity = Arc::new(Semaphore::new(OUTPUT_CHUNKS));
    let mut exit = TerminalExit {
        code: None,
        error: None,
    };
    while let Some(message) = reader.wait().await {
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                for chunk in data.chunks(CHUNK_SIZE) {
                    let Ok(permit) = Arc::clone(&capacity).acquire_owned().await else {
                        return exit;
                    };
                    if output
                        .send(OutputChunk {
                            data: chunk.to_vec(),
                            _permit: Some(permit),
                        })
                        .is_err()
                    {
                        return exit;
                    }
                }
            }
            ChannelMsg::ExitStatus { exit_status } => exit.code = Some(exit_status),
            ChannelMsg::ExitSignal { .. } => {
                exit.error = Some("원격 셸이 신호로 종료되었습니다.".into())
            }
            ChannelMsg::Close => return exit,
            _ => {}
        }
    }
    if exit.code.is_none() && exit.error.is_none() {
        exit.error = Some("원격 SSH 연결이 종료되었습니다.".into());
    }
    exit
}

async fn send_input(
    writer: ChannelWriteHalf<Msg>,
    mut input: async_mpsc::Receiver<Vec<u8>>,
    mut size: watch::Receiver<PtySize>,
) -> Option<String> {
    loop {
        tokio::select! {
            data = input.recv() => {
                let data = data?;
                if writer.data_bytes(data).await.is_err() { return Some("원격 터미널 입력을 보낼 수 없습니다.".into()); }
            }
            change = size.changed() => {
                change.ok()?;
                let next = *size.borrow_and_update();
                if writer.window_change(next.cols.into(), next.rows.into(), 0, 0).await.is_err() {
                    return Some("원격 터미널 크기를 변경할 수 없습니다.".into());
                }
            }
        }
    }
}
