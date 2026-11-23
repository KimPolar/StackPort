//! Terminal sessions. Input and output are never written to workspace storage.

use crate::Result;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, TryRecvError},
        Arc, Mutex,
    },
    time::Duration,
};
use uuid::Uuid;

// Output backpressure prevents a hidden or slow terminal from growing without
// bound. Dropping the receiver during shutdown unblocks a full queue.
const OUTPUT_CHUNKS: usize = 64;
const CHUNK_SIZE: usize = 8192;
const READ_LIMIT: usize = 65536;
const READ_WAIT: Duration = Duration::from_millis(200);
const INPUT_LIMIT: usize = 65536;

#[derive(Debug, Clone, Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub shell: String,
    pub process_id: Option<u32>,
    pub target: Option<String>,
    pub environment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalExit {
    pub code: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TerminalRead {
    pub data: Vec<u8>,
    pub exit: Option<TerminalExit>,
    pub output_closed: bool,
    pub output_error: Option<String>,
}

#[derive(Default)]
struct TerminalState {
    exit: Mutex<Option<TerminalExit>>,
    output_error: Mutex<Option<String>>,
}

struct Session {
    closing: Arc<AtomicBool>,
    state: Arc<TerminalState>,
    receiver: Mutex<Option<Receiver<Vec<u8>>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    job: Mutex<Option<ProcessJob>>,
    known_hosts: Mutex<Option<tempfile::TempPath>>,
}

impl Session {
    fn shutdown(&self) {
        if self.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        // A reader with a full queue switches to draining/discarding output
        // once its receiver is dropped. ConPTY must be drained while closing.
        if let Ok(mut receiver) = self.receiver.lock() {
            receiver.take();
        }
        // Closing the Windows job terminates the shell and its associated
        // children before the PTY handles are released.
        if let Ok(mut job) = self.job.lock() {
            job.take();
        }
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
        if let Ok(mut known_hosts) = self.known_hosts.lock() {
            known_hosts.take();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Shared by Tauri windows; individual sessions have independent processes,
/// output queues and lifecycle. No session count limit is imposed here.
#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl TerminalManager {
    pub fn open(&self, shell: &str, rows: u16, cols: u16) -> Result<TerminalInfo> {
        let command = shell_command(shell)?;
        self.open_command(shell, None, command, rows, cols, None)
    }

    pub(crate) fn open_command(
        &self,
        shell: &str,
        target: Option<String>,
        command: CommandBuilder,
        rows: u16,
        cols: u16,
        known_hosts: Option<tempfile::TempPath>,
    ) -> Result<TerminalInfo> {
        let size = terminal_size(rows, cols)?;
        let job = ProcessJob::new()?;
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| format!("터미널을 만들 수 없습니다: {e}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("터미널 출력을 열 수 없습니다: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("터미널 입력을 열 수 없습니다: {e}"))?;
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_CHUNKS);
        let closing = Arc::new(AtomicBool::new(false));
        let state = Arc::new(TerminalState::default());
        let session = Arc::new(Session {
            closing: Arc::clone(&closing),
            state: Arc::clone(&state),
            receiver: Mutex::new(Some(receiver)),
            writer: Mutex::new(Some(writer)),
            master: Mutex::new(Some(pair.master)),
            job: Mutex::new(Some(job)),
            known_hosts: Mutex::new(known_hosts),
        });
        let reader_closing = Arc::clone(&closing);
        let reader_state = Arc::clone(&state);
        if let Err(error) = std::thread::Builder::new()
            .name("stackport-terminal-output".into())
            .spawn(move || {
                let mut buffer = [0u8; CHUNK_SIZE];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            if !reader_closing.load(Ordering::SeqCst)
                                && sender.send(buffer[..count].to_vec()).is_err()
                                && !reader_closing.load(Ordering::SeqCst)
                            {
                                break;
                            }
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof
                            ) =>
                        {
                            break
                        }
                        Err(error) => {
                            if !reader_closing.load(Ordering::SeqCst) {
                                if let Ok(mut target) = reader_state.output_error.lock() {
                                    *target =
                                        Some(format!("터미널 출력을 읽을 수 없습니다: {error}"));
                                }
                            }
                            break;
                        }
                    }
                }
            })
        {
            drop(pair.slave);
            session.shutdown();
            return Err(format!("터미널 출력 작업을 시작할 수 없습니다: {error}"));
        }
        let mut child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                drop(pair.slave);
                session.shutdown();
                return Err(format!("셸을 시작할 수 없습니다: {error}"));
            }
        };
        drop(pair.slave);
        let attached = session
            .job
            .lock()
            .map_err(|_| "터미널 프로세스 상태를 사용할 수 없습니다.")?
            .as_ref()
            .ok_or("터미널 프로세스가 닫혔습니다.")?
            .attach(child.as_ref());
        if let Err(error) = attached {
            let _ = child.kill();
            session.shutdown();
            return Err(error);
        }
        let process_id = child.process_id();
        let wait_state = Arc::clone(&state);
        if let Err(error) = std::thread::Builder::new()
            .name("stackport-terminal-wait".into())
            .spawn(move || {
                let exit = match child.wait() {
                    Ok(status) => TerminalExit {
                        code: Some(status.exit_code()),
                        error: None,
                    },
                    Err(error) => TerminalExit {
                        code: None,
                        error: Some(format!("셸 종료 상태를 확인할 수 없습니다: {error}")),
                    },
                };
                if let Ok(mut target) = wait_state.exit.lock() {
                    *target = Some(exit);
                }
            })
        {
            session.shutdown();
            return Err(format!("셸 상태 감시를 시작할 수 없습니다: {error}"));
        }
        let id = Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .map_err(|_| "터미널 상태를 사용할 수 없습니다.")?
            .insert(id.clone(), session);
        Ok(TerminalInfo {
            id,
            shell: shell.into(),
            process_id,
            target,
            environment: None,
        })
    }

    fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .map_err(|_| "터미널 상태를 사용할 수 없습니다.")?
            .get(id)
            .cloned()
            .ok_or_else(|| "터미널이 없거나 이미 닫혔습니다.".into())
    }

    pub fn read(&self, id: &str) -> Result<TerminalRead> {
        let session = self.session(id)?;
        let mut data = Vec::new();
        let mut output_closed = false;
        {
            let receiver = session
                .receiver
                .lock()
                .map_err(|_| "터미널 출력을 사용할 수 없습니다.")?;
            let receiver = receiver.as_ref().ok_or("터미널이 닫혔습니다.")?;
            match receiver.recv_timeout(READ_WAIT) {
                Ok(chunk) => data.extend(chunk),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => output_closed = true,
            }
            while data.len() < READ_LIMIT {
                match receiver.try_recv() {
                    Ok(chunk) => data.extend(chunk),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        output_closed = true;
                        break;
                    }
                }
            }
        }
        let exit = session
            .state
            .exit
            .lock()
            .map_err(|_| "셸 종료 상태를 사용할 수 없습니다.")?
            .clone();
        let output_error = session
            .state
            .output_error
            .lock()
            .map_err(|_| "터미널 출력 상태를 사용할 수 없습니다.")?
            .clone();
        Ok(TerminalRead {
            data,
            exit,
            output_closed,
            output_error,
        })
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        if data.len() > INPUT_LIMIT {
            return Err("터미널 입력이 너무 큽니다. 나누어 입력하세요.".into());
        }
        let session = self.session(id)?;
        if session.closing.load(Ordering::SeqCst)
            || session
                .state
                .exit
                .lock()
                .map_err(|_| "셸 상태를 사용할 수 없습니다.")?
                .is_some()
        {
            return Err("이미 종료된 터미널입니다.".into());
        }
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "터미널 입력을 사용할 수 없습니다.")?;
        let writer = writer.as_mut().ok_or("터미널이 닫혔습니다.")?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|e| format!("터미널 입력을 보낼 수 없습니다: {e}"))
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<()> {
        let size = terminal_size(rows, cols)?;
        let session = self.session(id)?;
        let master = session
            .master
            .lock()
            .map_err(|_| "터미널 크기를 변경할 수 없습니다.")?;
        master
            .as_ref()
            .ok_or("터미널이 닫혔습니다.")?
            .resize(size)
            .map_err(|e| format!("터미널 크기를 변경할 수 없습니다: {e}"))
    }

    pub fn close(&self, id: &str) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "터미널 상태를 사용할 수 없습니다.")?
            .remove(id)
            .ok_or("터미널이 없거나 이미 닫혔습니다.")?;
        session.shutdown();
        Ok(())
    }
}

fn terminal_size(rows: u16, cols: u16) -> Result<PtySize> {
    if rows == 0 || cols == 0 || rows > 1000 || cols > 1000 {
        return Err("유효한 터미널 크기를 지정하세요.".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[cfg(windows)]
fn shell_command(shell: &str) -> Result<CommandBuilder> {
    use std::path::PathBuf;
    let system = PathBuf::from(
        std::env::var_os("SystemRoot").ok_or("Windows 시스템 경로를 찾을 수 없습니다.")?,
    )
    .join("System32");
    let (program, args): (PathBuf, &[&str]) = match shell {
        "powershell" => (
            system
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
            &["-NoLogo", "-NoProfile"],
        ),
        "cmd" => (system.join("cmd.exe"), &["/D"]),
        _ => return Err("지원하지 않는 로컬 셸입니다.".into()),
    };
    if !program.is_file() {
        return Err("선택한 셸 실행 파일을 찾을 수 없습니다.".into());
    }
    let mut command = CommandBuilder::new(program);
    command.args(args);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if let Some(home) = std::env::var_os("USERPROFILE") {
        command.cwd(home);
    }
    Ok(command)
}

#[cfg(not(windows))]
fn shell_command(_shell: &str) -> Result<CommandBuilder> {
    Err("로컬 터미널은 현재 Windows에서만 지원합니다.".into())
}

#[cfg(windows)]
struct ProcessJob(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl ProcessJob {
    fn new() -> Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: the unnamed job has no inherited handle; OwnedHandle closes it.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(format!(
                "프로세스 작업을 만들 수 없습니다: {}",
                std::io::Error::last_os_error()
            ));
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if ok == 0 {
            return Err(format!(
                "프로세스 종료 정책을 설정할 수 없습니다: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self(handle))
    }

    fn attach(&self, child: &dyn Child) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        let process = child
            .as_raw_handle()
            .ok_or("셸 프로세스 핸들을 사용할 수 없습니다.")?;
        // SAFETY: both handles remain alive for the duration of this call.
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
            return Err(format!(
                "셸 종료 관리를 설정할 수 없습니다: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
struct ProcessJob;
#[cfg(not(windows))]
impl ProcessJob {
    fn new() -> Result<Self> {
        Err("로컬 터미널은 현재 Windows에서만 지원합니다.".into())
    }
    fn attach(&self, _child: &dyn Child) -> Result<()> {
        Err("로컬 터미널은 현재 Windows에서만 지원합니다.".into())
    }
}
