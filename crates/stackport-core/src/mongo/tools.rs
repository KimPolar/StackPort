use super::{MongoPassword, MongoSettings};
#[cfg(windows)]
use crate::terminal::ProcessJob;
use crate::Result;
#[cfg(not(windows))]
struct ProcessJob;
use serde::Serialize;
use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    time::timeout,
};
use zeroize::Zeroizing;

const PROBE_TIME: Duration = Duration::from_secs(8);
const HANDSHAKE_TIME: Duration = Duration::from_secs(10);
const TOOL_CONFIGURATION: &str = "MongoDB 도구에 연결 설정을 전달할 수 없습니다.";

pub(super) struct Tools {
    directory: PathBuf,
    pub(super) version: String,
}

impl Tools {
    pub(super) async fn open(directory: String) -> Result<Self> {
        let path = Path::new(directory.trim());
        if !path.is_absolute() {
            return Err("MongoDB Database Tools의 bin 폴더를 지정하세요.".into());
        }
        let directory = tokio::fs::canonicalize(path)
            .await
            .map_err(|_| "MongoDB Database Tools 폴더를 열 수 없습니다.")?;
        let (dump, restore) = tokio::try_join!(
            probe(&directory, "mongodump"),
            probe(&directory, "mongorestore")
        )?;
        if dump != restore {
            return Err("mongodump와 mongorestore의 버전이 같아야 합니다.".into());
        }
        if version_parts(&dump).is_none_or(|parts| parts < [100, 3, 0]) {
            return Err(
                "보호된 연결 설정을 지원하는 MongoDB Database Tools 100.3.0 이상이 필요합니다."
                    .into(),
            );
        }
        Ok(Self {
            directory,
            version: dump,
        })
    }

    pub(super) fn command(&self, name: &'static str) -> Command {
        command(&self.directory, name)
    }
}

pub(super) fn version_parts(text: &str) -> Option<[u32; 3]> {
    let mut parts = text.split('.');
    let result = [
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ];
    parts.next().is_none().then_some(result)
}

fn command(directory: &Path, name: &'static str) -> Command {
    let mut command = Command::new(directory.join(format!("{name}.exe")));
    command
        .current_dir(directory)
        .env_clear()
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

async fn probe(directory: &Path, tool: &'static str) -> Result<String> {
    let mut command = command(directory, tool);
    command.arg("--version").stdout(Stdio::piped());
    let (mut child, _job) = start(command)?;
    let stdout = child
        .stdout
        .take()
        .ok_or("MongoDB 도구 버전을 읽을 수 없습니다.")?;
    let text = timeout(PROBE_TIME, async move {
        let mut bytes = Vec::new();
        stdout
            .take(512)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "MongoDB 도구 버전을 읽을 수 없습니다.")?;
        finish(&mut child, "MongoDB 도구가 버전을 반환하지 않았습니다.").await?;
        String::from_utf8(bytes).map_err(|_| "MongoDB 도구 버전을 읽을 수 없습니다.")
    })
    .await
    .map_err(|_| "MongoDB 도구 버전 확인 시간이 초과되었습니다.")??;
    text.lines()
        .next()
        .and_then(|line| line.strip_prefix(&format!("{tool} version: ")))
        .filter(|version| version_parts(version).is_some())
        .map(str::to_owned)
        .ok_or_else(|| "MongoDB Database Tools의 실행 파일 두 개를 확인하세요.".into())
}

#[cfg(windows)]
fn start(mut command: Command) -> Result<(Child, ProcessJob)> {
    let job = ProcessJob::new()?;
    let mut child = command
        .spawn()
        .map_err(|_| "MongoDB Database Tools를 실행할 수 없습니다.")?;
    let attached = child
        .raw_handle()
        .ok_or_else(|| "MongoDB 도구의 프로세스 핸들을 열 수 없습니다.".into())
        .and_then(|handle| job.attach_handle(handle));
    if let Err(error) = attached {
        if !child.try_wait().is_ok_and(|status| status.is_some()) {
            return Err(error);
        }
    }
    Ok((child, job))
}

#[cfg(not(windows))]
fn start(_command: Command) -> Result<(Child, ProcessJob)> {
    Err("MongoDB Database Tools 통합은 Windows에서 지원합니다.".into())
}

async fn finish(child: &mut Child, failure: &'static str) -> std::result::Result<(), &'static str> {
    if child.wait().await.is_ok_and(|status| status.success()) {
        Ok(())
    } else {
        Err(failure)
    }
}

#[cfg(windows)]
pub(super) async fn run(
    mut command: Command,
    settings: &MongoSettings,
    auth_database: Option<&str>,
    password: MongoPassword,
    failure: &'static str,
) -> Result<()> {
    #[derive(Serialize)]
    struct Config<'a> {
        uri: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        password: Option<&'a str>,
    }
    if password.0.len() > 4096 || (settings.username.is_none() && !password.0.is_empty()) {
        return Err("MongoDB 사용자 이름과 암호를 확인하세요.".into());
    }
    let uri = tool_uri(&settings.uri, settings.tls)?;
    let config = Zeroizing::new(
        serde_json::to_vec(&Config {
            uri: &uri,
            password: settings.username.as_ref().map(|_| password.0.as_str()),
        })
        .map_err(|_| TOOL_CONFIGURATION)?,
    );
    drop(password);
    if let Some(username) = &settings.username {
        command.arg(format!("--username={username}"));
        if let Some(auth_database) = auth_database {
            command.arg(format!("--authenticationDatabase={auth_database}"));
        }
    }
    if let Some(ca) = &settings.ca_path {
        command.arg(format!("--sslCAFile={ca}"));
    }
    let pipe_path = format!(r"\\.\pipe\StackPortMongo-{}", uuid::Uuid::new_v4());
    let mut pipe = secure_pipe(&pipe_path)?;
    command.arg(format!("--config={pipe_path}"));
    let (mut child, _job) = start(command)?;
    let pid = child.id().ok_or(TOOL_CONFIGURATION)?;
    tokio::select! {
        biased;
        result = timeout(HANDSHAKE_TIME, pipe.connect()) => result.map_err(|_| TOOL_CONFIGURATION)?.map_err(|_| TOOL_CONFIGURATION)?,
        _ = child.wait() => return Err(failure.into()),
    }
    if !expected_client(&pipe, pid) {
        return Err(TOOL_CONFIGURATION.into());
    }
    timeout(HANDSHAKE_TIME, pipe.write_all(&config))
        .await
        .map_err(|_| TOOL_CONFIGURATION)?
        .map_err(|_| TOOL_CONFIGURATION)?;
    drop(config);
    drop(pipe);
    finish(&mut child, failure).await?;
    Ok(())
}

#[cfg(not(windows))]
pub(super) async fn run(
    _command: Command,
    _settings: &MongoSettings,
    _auth_database: Option<&str>,
    _password: MongoPassword,
    _failure: &'static str,
) -> Result<()> {
    Err("MongoDB Database Tools 통합은 Windows에서 지원합니다.".into())
}

fn tool_uri(original: &str, tls: bool) -> Result<String> {
    let (scheme, rest) = original.split_once("://").ok_or(TOOL_CONFIGURATION)?;
    let (address, options) = rest.split_once('?').unwrap_or((rest, ""));
    let hosts = address.split('/').next().ok_or(TOOL_CONFIGURATION)?;
    let mut result = format!("{scheme}://{hosts}/?tls={tls}&connectTimeoutMS=5000&serverSelectionTimeoutMS=5000&retryWrites=false&retryReads=false");
    for option in options.split('&') {
        let Some((key, _)) = option.split_once('=') else {
            continue;
        };
        if ["replicaset", "directconnection", "loadbalanced", "appname"]
            .contains(&key.to_ascii_lowercase().as_str())
        {
            result.push('&');
            result.push_str(option);
        }
    }
    Ok(result)
}

#[cfg(windows)]
fn secure_pipe(path: &str) -> Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use std::{ffi::c_void, ptr};
    use tokio::net::windows::named_pipe::ServerOptions;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            SECURITY_ATTRIBUTES,
        },
    };
    // The DACL grants access to this object's owner. The peer PID is checked separately.
    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)\0".encode_utf16().collect();
    let mut descriptor = ptr::null_mut();
    // SAFETY: Windows allocates a security descriptor from the terminated UTF-16 string.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(TOOL_CONFIGURATION.into());
    }
    let mut attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    // SAFETY: the descriptor remains valid for the CreateNamedPipe call and is not inherited.
    let pipe = unsafe {
        ServerOptions::new()
            .access_inbound(false)
            .access_outbound(true)
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .max_instances(1)
            .create_with_security_attributes_raw(
                path,
                (&mut attrs as *mut SECURITY_ATTRIBUTES).cast::<c_void>(),
            )
    };
    unsafe { LocalFree(descriptor) };
    pipe.map_err(|_| TOOL_CONFIGURATION.into())
}

#[cfg(windows)]
fn expected_client(pipe: &tokio::net::windows::named_pipe::NamedPipeServer, expected: u32) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    let mut actual = 0;
    // SAFETY: the pipe handle stays alive and `actual` points to a writable u32.
    let ok = unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut actual) };
    ok != 0 && actual == expected
}
