use super::{
    mpsc, terminal_size, Arc, AtomicBool, Mutex, OutputChunk, Session, TerminalExit, TerminalInfo,
    TerminalManager, TerminalState, CHUNK_SIZE, OUTPUT_CHUNKS,
};
use crate::{
    ssh_transport::{self, SshRoute},
    Result, SshManager, SshRouteHop, SshRouteResult,
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
        let route =
            match ssh_transport::connect_route(manager, &profile, destination.authentication, hops)
                .await?
            {
                SshRouteResult::Open { session } => session,
                SshRouteResult::TrustRequired { stage, host } => {
                    return Ok(SshRouteResult::TrustRequired { stage, host })
                }
            };
        let channel = match timeout(SETUP_TIMEOUT, open_shell(&route, size)).await {
            Ok(Ok(channel)) => channel,
            result => {
                route.close().await;
                let reason = match result {
                    Ok(Err(reason)) => reason,
                    _ => "원격 터미널 준비 시간이 초과되었습니다.",
                };
                return Err(format!("대상 · {} — {reason}", profile.name));
            }
        };
        let (output, receiver) = mpsc::channel();
        let (input, input_rx) = async_mpsc::channel(INPUT_CHUNKS);
        let (size, size_rx) = watch::channel(size);
        let (stop, mut stop_rx) = oneshot::channel();
        let state = Arc::new(TerminalState::default());
        let id = Uuid::new_v4().to_string();
        let session = Arc::new(Session {
            closing: Arc::new(AtomicBool::new(false)),
            state: Arc::clone(&state),
            receiver: Mutex::new(Some(receiver)),
            writer: Mutex::new(None),
            master: Mutex::new(None),
            job: Mutex::new(None),
            known_hosts: Mutex::new(None),
            remote: Mutex::new(Some(RemoteControl { input, size, stop })),
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
        let address = if profile.host.contains(':') {
            format!("[{}]", profile.host)
        } else {
            profile.host
        };
        Ok(SshRouteResult::Open {
            session: TerminalInfo {
                id,
                shell: "ssh".into(),
                process_id: None,
                target: Some(format!("{}@{address}:{}", profile.username, profile.port)),
                environment: Some(profile.environment),
                cwd_authority: None,
            },
        })
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
    if !matches!(channel.wait().await, Some(ChannelMsg::Success)) {
        return Err("서버가 원격 터미널 요청을 거부했습니다.");
    }
    channel
        .request_shell(true)
        .await
        .map_err(|_| "원격 셸을 요청할 수 없습니다.")?;
    if !matches!(channel.wait().await, Some(ChannelMsg::Success)) {
        return Err("서버가 원격 셸 요청을 거부했습니다.");
    }
    Ok(channel)
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
