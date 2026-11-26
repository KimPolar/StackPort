//! SFTP navigation over a connection authenticated to a previously pinned host key.

mod audit;
mod compare;
mod copy;
mod delete;
mod download;
mod editor;
mod folder_tree;
mod mutation;
mod permissions;
mod preview;
mod remote_stage;
mod sync;
mod sync_delete;
mod sync_profile;
mod sync_replace;
mod transfer;
mod upload;
pub use audit::SftpTransferReport;
pub use compare::{save_merged_text, ComparedFile, FileContentComparison};
pub use delete::SftpDeletePreview;
pub use editor::{SftpEditDocument, SftpEditSave};
pub use folder_tree::{list_local_tree, FolderTree};
pub use mutation::{SftpEntrySource, SftpMutationReport};
pub use permissions::SftpPermissionChange;
pub use preview::{preview_local_file, FilePreview};
pub use sync::{SyncPlan, SyncProgress, SyncReport};
pub use sync_delete::{SyncDeleteInput, SyncDeletePreview};
pub use sync_profile::{SavedSyncProfile, SyncProfileInput};
pub(crate) use sync_profile::SCHEMA as SYNC_PROFILE_SCHEMA;
pub use transfer::SftpTransferProgress;
use transfer::SftpTransferOutcome;

pub use crate::ssh_transport::SshCredentials as SftpAuthentication;
pub use crate::ssh_transport::SshRouteHop as SftpHop;
use crate::{ssh_transport::{self, Endpoint, SshRoute}, Result, SshManager, SshProfile, SshRouteResult, Store};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use russh::ChannelMsg;
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, SftpString, StatusCode},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, UNIX_EPOCH},
};
use tokio::{
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore},
    time::timeout,
};
use uuid::Uuid;

const MAX_CONNECTIONS: usize = 8;
const MAX_ITEMS: usize = 2_000;
const MAX_REMOTE_PATH: usize = 4_096;
const START_TIMEOUT: Duration = Duration::from_secs(20);
const BROWSE_TIMEOUT: Duration = Duration::from_secs(18);

#[derive(Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum RemotePath {
    Text(String),
    Token(String),
}

impl RemotePath {
    fn into_path(self) -> Result<SftpString> {
        let bytes = match self {
            Self::Text(path) => path.into_bytes(),
            Self::Token(value) if value.len() <= MAX_REMOTE_PATH.div_ceil(3) * 4 => URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| "원격 경로를 읽을 수 없습니다.")?,
            Self::Token(_) => return Err("원격 경로가 너무 깁니다.".into()),
        };
        if bytes.is_empty() || bytes.len() > MAX_REMOTE_PATH || bytes.contains(&0) {
            return Err("유효한 4096바이트 이하의 원격 경로를 입력하세요.".into());
        }
        Ok(SftpString::from(bytes))
    }
}

#[derive(Serialize)]
pub struct BrowseDirectory {
    pub path: String,
    pub location: String,
    pub parent: Option<String>,
    pub entries: Vec<BrowseEntry>,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct BrowseEntry {
    name: String,
    name_is_lossy: bool,
    kind: &'static str,
    location: Option<String>,
    size: Option<String>,
    modified: Option<u64>,
    mode: Option<u32>,
    uid: Option<u32>,
    gid: Option<u32>,
    hidden: bool,
}

#[derive(Serialize)]
pub struct SftpOpened {
    pub id: String,
    pub directory: BrowseDirectory,
}

pub type RoutedSftpOpened = SshRouteResult<SftpOpened>;

pub struct SftpManager {
    store: Store,
    sessions: Mutex<HashMap<String, Arc<FilesSession>>>,
    permits: Arc<Semaphore>,
}

struct FilesSession {
    profile: SshProfile,
    ssh: SshRoute,
    files: RawSftpSession,
    operation: AsyncMutex<()>,
    pending_delete: Mutex<Option<delete::PendingDelete>>,
    pending_sync_delete: Mutex<Option<sync_delete::PendingSyncDelete>>,
    active_sync: Mutex<Option<sync::SyncRun>>,
    pending_edit: Mutex<Option<editor::PendingEdit>>,
    transfers: Mutex<transfer::TransferState>,
    fsync_supported: bool,
    posix_rename_supported: bool,
    lsetstat_supported: bool,
    _permit: OwnedSemaphorePermit,
}

impl SftpManager {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            sessions: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        }
    }

    fn session(&self, id: &str) -> Result<Arc<FilesSession>> {
        self.sessions
            .lock()
            .map_err(|_| "SFTP 연결 목록을 열 수 없습니다.")?
            .get(id)
            .cloned()
            .ok_or_else(|| "SFTP 연결이 닫혔습니다. 다시 연결하세요.".into())
    }

    pub async fn open(
        &self,
        ssh: Arc<SshManager>,
        profile: SshProfile,
        auth: SftpAuthentication,
    ) -> Result<SftpOpened> {
        let permit = self.acquire()?;
        let ready = timeout(START_TIMEOUT, async {
            let endpoint = ssh_transport::connect_endpoint(ssh, &profile, auth, None, false, None).await?;
            let Endpoint::Authenticated(connection) = endpoint else {
                return Err("먼저 이 서버의 SSH 호스트 키 지문을 확인하고 신뢰하세요.".into());
            };
            start_session(profile, SshRoute { connection, hops: Vec::new() }, permit).await
        }).await.map_err(|_| "SFTP 연결 준비 시간이 초과되었습니다.")??;
        self.insert_session(ready)
    }

    pub async fn open_routed(
        &self,
        ssh: Arc<SshManager>,
        destination: SftpHop,
        hops: Vec<SftpHop>,
    ) -> Result<RoutedSftpOpened> {
        let permit = self.acquire()?;
        let route = match ssh_transport::connect_route(ssh, &destination.profile, destination.authentication, hops, None).await? {
            SshRouteResult::Open { session } => session,
            SshRouteResult::TrustRequired { stage, host } => return Ok(RoutedSftpOpened::TrustRequired { stage, host }),
        };
        let stage = format!("대상 · {}", destination.profile.name);
        let ready = timeout(START_TIMEOUT, start_session(destination.profile, route, permit))
            .await.map_err(|_| format!("{stage} — SFTP 연결 준비 시간이 초과되었습니다."))?
            .map_err(|error| format!("{stage} — {error}"))?;
        let session = self.insert_session(ready)?;
        Ok(RoutedSftpOpened::Open { session })
    }

    fn acquire(&self) -> Result<OwnedSemaphorePermit> {
        self.sessions
            .lock()
            .map_err(|_| "SFTP 연결 목록을 열 수 없습니다.")?
            .retain(|_, session| !session.ssh.is_closed());
        Arc::clone(&self.permits)
            .try_acquire_owned()
            .map_err(|_| "열린 SFTP 연결이 너무 많습니다. 사용하지 않는 연결을 닫으세요.".into())
    }

    fn insert_session(&self, (session, directory): (FilesSession, BrowseDirectory)) -> Result<SftpOpened> {
        let id = Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .map_err(|_| "SFTP 연결 목록을 열 수 없습니다.")?
            .insert(id.clone(), Arc::new(session));
        Ok(SftpOpened { id, directory })
    }

    pub async fn list(&self, id: &str, requested: RemotePath) -> Result<BrowseDirectory> {
        let path = requested.into_path()?;
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        match timeout(BROWSE_TIMEOUT, read_directory(&session.files, path)).await {
            Ok(result) if !session.ssh.is_closed() => result,
            Ok(_) => {
                self.close(id).await?;
                Err("SFTP 연결이 종료되었습니다. 다시 연결하세요.".into())
            }
            Err(_) => {
                self.close(id).await?;
                Err("SFTP 폴더 응답 시간이 초과되어 연결을 닫았습니다.".into())
            }
        }
    }

    pub async fn close(&self, id: &str) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "SFTP 연결 목록을 열 수 없습니다.")?
            .remove(id);
        if let Some(session) = session {
            session.cancel_transfer_on_close();
            session.ssh.close().await;
        }
        Ok(())
    }
}

async fn start_session(
    profile: SshProfile,
    ssh: SshRoute,
    permit: OwnedSemaphorePermit,
) -> Result<(FilesSession, BrowseDirectory)> {
    let mut channel = ssh.connection
        .channel_open_session()
        .await
        .map_err(|_| "SFTP 채널을 열 수 없습니다.")?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|_| "서버에 SFTP를 요청할 수 없습니다.")?;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => break,
            Some(ChannelMsg::WindowAdjusted { .. }) => continue,
            Some(ChannelMsg::Failure) => {
                let _ = channel.close().await;
                return Err("서버가 SFTP 서브시스템 요청을 거부했습니다.".into());
            }
            _ => {
                let _ = channel.close().await;
                return Err("SFTP 서브시스템을 시작하기 전에 SSH 채널이 닫혔거나 예상하지 못한 응답을 받았습니다.".into());
            }
        }
    }
    let files = RawSftpSession::new(channel.into_stream());
    let version = files.init().await.map_err(file_error)?;
    if version.version != 3 {
        return Err("서버의 SFTP 프로토콜 버전을 지원하지 않습니다.".into());
    }
    let directory = read_directory(&files, SftpString::from(".")).await?;
    Ok((
        FilesSession {
            profile,
            ssh,
            files,
            operation: AsyncMutex::new(()),
            pending_delete: Mutex::new(None),
            pending_sync_delete: Mutex::new(None),
            active_sync: Mutex::new(None),
            pending_edit: Mutex::new(None),
            transfers: Mutex::new(transfer::TransferState::default()),
            fsync_supported: version.extensions.get("fsync@openssh.com").is_some_and(|value| value == "1"),
            posix_rename_supported: version.extensions.get(russh_sftp::extensions::POSIX_RENAME).is_some_and(|value| value == "1"),
            lsetstat_supported: version.extensions.get(permissions::LSETSTAT).is_some_and(|value| value == "1"),
            _permit: permit,
        },
        directory,
    ))
}

async fn canonical_remote_path(files: &RawSftpSession, requested: SftpString) -> Result<SftpString> {
    let mut canonical = transfer::request(files.realpath(requested)).await.map_err(file_error)?.files;
    if canonical.len() != 1 {
        return Err("서버가 올바른 원격 경로를 반환하지 않았습니다.".into());
    }
    let path = canonical.remove(0).filename;
    if path.is_empty() || path.len() > MAX_REMOTE_PATH || path.contains(&0) {
        return Err("서버가 올바른 원격 경로를 반환하지 않았습니다.".into());
    }
    Ok(path)
}

async fn read_directory(files: &RawSftpSession, requested: SftpString) -> Result<BrowseDirectory> {
    let path = canonical_remote_path(files, requested).await?;
    read_resolved_directory(files, path, MAX_ITEMS).await
}

async fn read_resolved_directory(
    files: &RawSftpSession,
    path: SftpString,
    limit: usize,
) -> Result<BrowseDirectory> {
    let handle = files
        .opendir(path.clone())
        .await
        .map_err(file_error)?
        .handle;
    let result = async {
        let mut entries = Vec::new();
        loop {
            let next = match files.readdir(handle.clone()).await {
                Ok(next) if !next.files.is_empty() => next.files,
                Ok(_) => return Ok((entries, false)),
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                    return Ok((entries, false))
                }
                Err(error) => return Err(file_error(error)),
            };
            for entry in next {
                let name = entry.filename.as_bytes();
                if name.is_empty()
                    || matches!(name, b"." | b"..")
                    || name.contains(&b'/')
                    || name.contains(&0)
                {
                    continue;
                }
                if entries.len() == limit {
                    return Ok((entries, true));
                }
                let location = path.join(name);
                entries.push(remote_entry(
                    &entry.filename,
                    entry.attrs,
                    (location.len() <= MAX_REMOTE_PATH).then(|| token(location.as_bytes())),
                ));
            }
        }
    }
    .await;
    let closed = files.close(handle).await.map_err(file_error);
    let (mut entries, truncated) = result?;
    closed?;
    sort_entries(&mut entries);
    let parent = parent_remote(path.as_bytes()).map(token);
    Ok(BrowseDirectory {
        path: path.to_string_lossy().into(),
        location: token(path.as_bytes()),
        parent,
        entries,
        truncated,
    })
}

fn parent_remote(path: &[u8]) -> Option<&[u8]> {
    let normalized = path.strip_suffix(b"/").unwrap_or(path);
    if normalized.is_empty()
        || (normalized.len() == 3 && normalized[0] == b'/' && normalized[2] == b':')
    {
        return None;
    }
    let last = normalized.iter().rposition(|&byte| byte == b'/')?;
    Some(
        &normalized[..if last == 0
            || (last == 2 && normalized[1] == b':')
            || (last == 3 && normalized[0] == b'/' && normalized[2] == b':')
        {
            last + 1
        } else {
            last
        }],
    )
}

fn token(path: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(path)
}

fn remote_entry(name: &SftpString, attrs: FileAttributes, location: Option<String>) -> BrowseEntry {
    let kind = if attrs.is_dir() {
        "directory"
    } else if attrs.is_symlink() {
        "symlink"
    } else if attrs.is_regular() {
        "file"
    } else {
        "other"
    };
    BrowseEntry {
        name: name.to_string_lossy().into(),
        name_is_lossy: std::str::from_utf8(name.as_bytes()).is_err(),
        kind,
        location,
        size: attrs.size.map(|size| size.to_string()),
        modified: attrs.mtime.map(u64::from),
        mode: attrs.permissions.map(|bits| bits & 0o7777),
        uid: attrs.uid,
        gid: attrs.gid,
        hidden: name.starts_with(b"."),
    }
}

fn file_error(error: SftpError) -> String {
    let message = match error {
        SftpError::Timeout => "SFTP 서버 응답 시간이 초과되었습니다.",
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => "원격 경로가 없거나 이미 이동되었습니다.",
            StatusCode::PermissionDenied => "서버가 이 원격 경로에 대한 접근을 거부했습니다.",
            _ => "서버가 SFTP 요청을 완료하지 못했습니다.",
        },
        _ => "SFTP 서버 연결 또는 응답을 확인할 수 없습니다.",
    };
    message.into()
}

pub fn list_local_directory(value: &str) -> Result<BrowseDirectory> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err("로컬 폴더의 절대 경로를 입력하세요.".into());
    }
    let path = path
        .canonicalize()
        .map_err(|_| "로컬 폴더에 접근할 수 없습니다.")?;
    read_local_directory(&path, MAX_ITEMS)
}

fn read_local_directory(path: &Path, limit: usize) -> Result<BrowseDirectory> {
    let mut entries = Vec::new();
    let mut directory = fs::read_dir(path).map_err(|_| "로컬 폴더를 열 수 없습니다.")?;
    for entry in directory.by_ref().take(limit) {
        let entry = entry.map_err(|_| "로컬 폴더 항목을 읽을 수 없습니다.")?;
        let metadata = fs::symlink_metadata(entry.path()).ok();
        let kind = metadata
            .as_ref()
            .map(|data| {
                if data.file_type().is_symlink() {
                    "symlink"
                } else if data.is_dir() {
                    "directory"
                } else if data.is_file() {
                    "file"
                } else {
                    "other"
                }
            })
            .unwrap_or("other");
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy().into_owned();
        let name_is_lossy = file_name.to_str().is_none();
        let hidden = name.starts_with('.') || metadata.as_ref().is_some_and(local_hidden);
        entries.push(BrowseEntry {
            kind,
            location: entry.path().to_str().map(str::to_owned),
            name,
            name_is_lossy,
            hidden,
            size: metadata
                .as_ref()
                .filter(|_| kind == "file")
                .map(|data| data.len().to_string()),
            modified: metadata
                .as_ref()
                .and_then(|data| data.modified().ok())
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs()),
            mode: None,
            uid: None,
            gid: None,
        });
    }
    let truncated = directory.next().is_some();
    sort_entries(&mut entries);
    let location = path
        .to_str()
        .ok_or("로컬 경로의 문자를 읽을 수 없습니다.")?
        .to_owned();
    let parent = path.parent().and_then(Path::to_str).map(str::to_owned);
    Ok(BrowseDirectory {
        path: location.clone(),
        location,
        parent,
        entries,
        truncated,
    })
}

fn local_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn open_local_file(value: &str) -> Result<fs::File> {
    let path = Path::new(value);
    if !path.is_absolute() || (cfg!(windows) && value.starts_with("\\\\.\\")) {
        return Err("로컬 파일의 절대 경로를 확인하세요.".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "로컬 파일을 찾을 수 없습니다.")?;
    if !metadata.is_file() {
        return Err("로컬 경로가 일반 파일인지 확인하세요.".into());
    }
    let mut open = fs::OpenOptions::new();
    open.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        open.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = open.open(path).map_err(|_| "로컬 파일을 열 수 없습니다.")?;
    if !file
        .metadata()
        .map_err(|_| "로컬 파일의 속성을 읽을 수 없습니다.")?
        .is_file()
    {
        return Err("로컬 경로가 일반 파일인지 확인하세요.".into());
    }
    Ok(file)
}

#[cfg(windows)]
fn local_hidden(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn local_hidden(_metadata: &fs::Metadata) -> bool {
    false
}

fn sort_entries(entries: &mut [BrowseEntry]) {
    entries.sort_by(|a, b| {
        (a.kind != "directory")
            .cmp(&(b.kind != "directory"))
            .then(a.name.cmp(&b.name))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_round_trip_raw_filenames_and_drive_roots() {
        let path = b"/home/\xff";
        assert_eq!(
            RemotePath::Token(token(path))
                .into_path()
                .unwrap()
                .as_bytes(),
            path
        );
        assert!(RemotePath::Token(token(b"/home/\0x")).into_path().is_err());
        assert!(RemotePath::Text("x".repeat(MAX_REMOTE_PATH + 1))
            .into_path()
            .is_err());
        assert_eq!(parent_remote(b"/home"), Some(b"/".as_slice()));
        assert_eq!(parent_remote(b"/C:/Users"), Some(b"/C:/".as_slice()));
        assert_eq!(parent_remote(b"C:/Users"), Some(b"C:/".as_slice()));
        assert_eq!(parent_remote(b"/C:/"), None);
        assert_eq!(parent_remote(b"/"), None);
    }

    #[test]
    fn remote_listing_distinguishes_lossy_names_from_literal_replacement_characters() {
        let raw = SftpString::from(b"file-\xff".to_vec());
        let valid = SftpString::from("file-�".as_bytes().to_vec());
        let lossy = remote_entry(&raw, FileAttributes::empty(), None);
        let exact = remote_entry(&valid, FileAttributes::empty(), None);
        assert_eq!(lossy.name, exact.name);
        assert!(lossy.name_is_lossy);
        assert!(!exact.name_is_lossy);
    }

    #[test]
    fn local_browser_reports_directories_sizes_and_hidden_files() {
        let local = tempfile::tempdir().unwrap();
        fs::create_dir(local.path().join("문서")).unwrap();
        fs::write(local.path().join(".숨김"), b"fixture").unwrap();
        let listing = list_local_directory(local.path().to_str().unwrap()).unwrap();
        assert_eq!(listing.entries[0].kind, "directory");
        assert_eq!(listing.entries[0].name, "문서");
        assert_eq!(listing.entries[1].size.as_deref(), Some("7"));
        assert!(listing.entries[1].hidden);
        assert!(list_local_directory("relative").is_err());
    }
}
