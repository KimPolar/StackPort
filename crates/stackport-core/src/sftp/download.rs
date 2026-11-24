//! Stream verified SFTP reads into a local file, then publish without replacing a destination.

use super::{file_error, FilesSession, RemotePath, SftpManager};
use crate::Result;
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, SftpHandle, SftpString, StatusCode},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    future::Future,
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tempfile::{NamedTempFile, TempPath};
use tokio::{io::AsyncWriteExt, time::timeout};
use uuid::Uuid;

const READ_SIZE: u32 = 32 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const PUBLISHING: u8 = 2;

#[derive(Serialize)]
pub struct SftpDownloadProgress {
    transfer_id: String,
    received: String,
    total: Option<String>,
    elapsed_ms: u64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SftpDownloadOutcome {
    Saved { bytes: String, sha256: String },
    Cancelled,
}

struct Download {
    id: String,
    phase: Arc<AtomicU8>,
}

impl Download {
    fn cancel(&self) -> bool {
        self.phase
            .compare_exchange(RUNNING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

#[derive(Default)]
pub(super) struct DownloadState {
    closing: bool,
    active: Option<Download>,
}

struct ActiveDownload<'a>(&'a Mutex<DownloadState>);

impl Drop for ActiveDownload<'_> {
    fn drop(&mut self) {
        self.0
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .active
            .take();
    }
}

impl FilesSession {
    pub(super) fn cancel_download_on_close(&self) {
        if let Ok(mut state) = self.downloads.lock() {
            state.closing = true;
            if let Some(active) = state.active.as_ref() {
                active.cancel();
            }
        }
    }
}

impl SftpManager {
    pub fn cancel_download(&self, id: &str, transfer_id: &str) -> bool {
        let Ok(session) = self.session(id) else {
            return false;
        };
        session
            .downloads
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .active
                    .as_ref()
                    .filter(|download| download.id == transfer_id)
                    .map(Download::cancel)
            })
            .unwrap_or(false)
    }

    pub async fn download(
        &self,
        id: &str,
        source: RemotePath,
        destination: String,
        progress: impl Fn(SftpDownloadProgress),
    ) -> Result<SftpDownloadOutcome> {
        let source = source.into_path()?;
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let transfer_id = Uuid::new_v4().to_string();
        let phase = Arc::new(AtomicU8::new(RUNNING));
        {
            let mut state = session
                .downloads
                .lock()
                .map_err(|_| "SFTP 전송 상태를 열 수 없습니다.")?;
            if state.closing {
                return Err("SFTP 연결이 닫혔습니다. 다시 연결하세요.".into());
            }
            state.active = Some(Download {
                id: transfer_id.clone(),
                phase: Arc::clone(&phase),
            });
        }
        let _active = ActiveDownload(&session.downloads);
        let started = Instant::now();
        let update = |received: u64, total: Option<u64>| {
            progress(SftpDownloadProgress {
                transfer_id: transfer_id.clone(),
                received: received.to_string(),
                total: total.map(|value| value.to_string()),
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        };
        update(0, None);
        let result = download_file(&session.files, source, destination, &phase, update).await;
        if phase.load(Ordering::Acquire) == CANCELLED {
            return Ok(SftpDownloadOutcome::Cancelled);
        }
        result
    }
}

async fn download_file(
    files: &RawSftpSession,
    source: SftpString,
    destination: String,
    phase: &AtomicU8,
    progress: impl Fn(u64, Option<u64>),
) -> Result<SftpDownloadOutcome> {
    let (destination, temporary) =
        tokio::task::spawn_blocking(move || prepare_destination(&destination))
            .await
            .map_err(|_| "다운로드 경로를 준비할 수 없습니다.")??;
    let (local, temporary) = temporary.into_parts();
    let mut local = tokio::fs::File::from_std(local);
    check_cancelled(phase)?;
    let listed = request(files.lstat(source.clone())).await?.attrs;
    let expected = file_size(&listed)?;
    check_cancelled(phase)?;
    let handle = request(files.open(source, OpenFlags::READ, FileAttributes::empty()))
        .await?
        .handle;
    let copied = copy_contents(
        files, &handle, &mut local, &listed, expected, phase, progress,
    )
    .await;
    let closed = request(files.close(handle)).await;
    let digest = copied?;
    closed?;
    check_cancelled(phase)?;
    local
        .sync_all()
        .await
        .map_err(|_| "다운로드 파일을 디스크에 기록할 수 없습니다.")?;
    drop(local);
    phase
        .compare_exchange(RUNNING, PUBLISHING, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "다운로드를 중단했습니다.")?;
    tokio::task::spawn_blocking(move || publish(temporary, destination))
        .await
        .map_err(|_| "다운로드 파일을 저장할 수 없습니다.")??;
    Ok(SftpDownloadOutcome::Saved {
        bytes: expected.to_string(),
        sha256: digest,
    })
}

async fn copy_contents(
    files: &RawSftpSession,
    handle: &SftpHandle,
    local: &mut tokio::fs::File,
    listed: &FileAttributes,
    expected: u64,
    phase: &AtomicU8,
    progress: impl Fn(u64, Option<u64>),
) -> Result<String> {
    let opened = request(files.fstat(handle.clone())).await?.attrs;
    check_snapshot(listed, &opened, expected)?;
    progress(0, Some(expected));
    let mut copied = 0;
    let mut checksum = Sha256::new();
    let mut last_update = Instant::now();
    while copied < expected {
        check_cancelled(phase)?;
        let wanted = (expected - copied).min(u64::from(READ_SIZE)) as u32;
        let data = match timeout(REQUEST_TIMEOUT, files.read(handle.clone(), copied, wanted)).await
        {
            Ok(Ok(packet)) if !packet.data.is_empty() && packet.data.len() <= wanted as usize => {
                packet.data
            }
            Ok(Err(SftpError::Status(status))) if status.status_code == StatusCode::Eof => {
                return Err("원격 파일이 예상 크기보다 먼저 끝났습니다.".into())
            }
            Ok(Err(error)) => return Err(file_error(error)),
            Ok(Ok(_)) => return Err("서버가 잘못된 파일 데이터 길이를 반환했습니다.".into()),
            Err(_) => return Err("SFTP 서버 응답 시간이 초과되었습니다.".into()),
        };
        check_cancelled(phase)?;
        local
            .write_all(&data)
            .await
            .map_err(|_| "다운로드 파일에 쓸 수 없습니다.")?;
        checksum.update(&data);
        copied += data.len() as u64;
        if copied == expected || last_update.elapsed() >= Duration::from_millis(200) {
            progress(copied, Some(expected));
            last_update = Instant::now();
        }
    }
    check_cancelled(phase)?;
    let finished = request(files.fstat(handle.clone())).await?.attrs;
    check_snapshot(&opened, &finished, expected)?;
    Ok(format!("{:x}", checksum.finalize()))
}

async fn request<T>(future: impl Future<Output = std::result::Result<T, SftpError>>) -> Result<T> {
    timeout(REQUEST_TIMEOUT, future)
        .await
        .map_err(|_| "SFTP 서버 응답 시간이 초과되었습니다.")?
        .map_err(file_error)
}

fn check_cancelled(phase: &AtomicU8) -> Result<()> {
    if phase.load(Ordering::Acquire) == CANCELLED {
        Err("다운로드를 중단했습니다.".into())
    } else {
        Ok(())
    }
}

fn file_size(attrs: &FileAttributes) -> Result<u64> {
    if !attrs.is_regular() {
        return Err("다운로드할 원격 경로가 일반 파일인지 확인할 수 없습니다.".into());
    }
    attrs
        .size
        .ok_or_else(|| "서버가 원격 파일 크기를 반환하지 않았습니다.".into())
}

fn check_snapshot(before: &FileAttributes, current: &FileAttributes, size: u64) -> Result<()> {
    if file_size(current)? != size || current.mtime != before.mtime {
        return Err(
            "원격 파일의 크기 또는 수정 시간이 전송 중 변경되었습니다. 다시 시도하세요.".into(),
        );
    }
    Ok(())
}

fn prepare_destination(destination: &str) -> Result<(PathBuf, NamedTempFile)> {
    let path = Path::new(destination);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("저장할 파일 이름을 입력하세요.")?;
    if !path.is_absolute()
        || !valid_filename(name)
        || (cfg!(windows) && destination.starts_with("\\\\.\\"))
    {
        return Err("새 다운로드 파일의 유효한 절대 경로를 입력하세요.".into());
    }
    let parent = path
        .parent()
        .ok_or("다운로드 폴더를 지정하세요.")?
        .canonicalize()
        .map_err(|_| "다운로드 폴더를 열 수 없습니다.")?;
    let destination = parent.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(_) => return Err("같은 이름의 파일이 있습니다. 새 파일 이름을 입력하세요.".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("다운로드 경로에 접근할 수 없습니다.".into()),
    }
    let temporary = tempfile::Builder::new()
        .prefix(".stackport-download-")
        .tempfile_in(parent)
        .map_err(|_| "다운로드 임시 파일을 만들 수 없습니다.")?;
    Ok((destination, temporary))
}

fn valid_filename(name: &str) -> bool {
    if !cfg!(windows) {
        return !name.contains('\0');
    }
    if name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let number_device = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|value| {
            matches!(
                value,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    !number_device
        && !matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
}

fn publish(temporary: TempPath, destination: PathBuf) -> Result<()> {
    temporary.persist_noclobber(destination).map_err(|error| {
        if error.error.kind() == io::ErrorKind::AlreadyExists {
            "다운로드 중 같은 이름의 파일이 생겼습니다. 새 경로를 선택하세요.".into()
        } else {
            "다운로드 파일을 저장할 수 없습니다.".into()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn local_destination_is_not_replaced_when_a_file_appears_during_download() {
        let folder = tempfile::tempdir().unwrap();
        let target = folder.path().join("새 파일.txt");
        let (destination, mut temporary) = prepare_destination(target.to_str().unwrap()).unwrap();
        temporary.write_all(b"download").unwrap();
        fs::write(&target, b"keep").unwrap();
        assert!(publish(temporary.into_temp_path(), destination).is_err());
        assert!(prepare_destination(target.to_str().unwrap()).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }

    #[test]
    fn cancellation_cannot_override_publication_or_be_sent_twice() {
        let active = Download {
            id: String::new(),
            phase: Arc::new(AtomicU8::new(RUNNING)),
        };
        assert!(active.cancel());
        assert!(!active.cancel());
        assert!(check_cancelled(&active.phase).is_err());
        let publishing = Download {
            id: String::new(),
            phase: Arc::new(AtomicU8::new(PUBLISHING)),
        };
        assert!(!publishing.cancel());
    }

    #[test]
    #[cfg(windows)]
    fn special_windows_names_and_streams_are_refused() {
        for name in [
            "NUL.txt",
            "Com1.log",
            "LPT²",
            "conout$",
            "file.txt:alternate",
            "file.",
            "file ",
            "a?b",
            "nested\\file",
        ] {
            assert!(!valid_filename(name), "{name}");
        }
        assert!(valid_filename("동작 확인.txt"));
    }
}
