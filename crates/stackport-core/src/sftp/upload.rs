//! Verify a remote staging file before asking the server to publish it.

use super::{
    file_error,
    transfer::{read_chunk, request, Transfer, CHUNK_SIZE},
    RemotePath, SftpManager, SftpTransferOutcome, SftpTransferProgress, MAX_REMOTE_PATH,
};
use crate::Result;
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, SftpHandle, SftpString, StatusCode},
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;

impl SftpManager {
    pub async fn upload(
        &self,
        id: &str,
        source: String,
        directory: RemotePath,
        filename: String,
        progress: impl Fn(SftpTransferProgress),
    ) -> Result<SftpTransferOutcome> {
        validate_name(&filename)?;
        let directory = directory.into_path()?;
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let active = session.register_transfer()?;
        let transfer = &active.transfer;
        let update = |bytes, total, verifying| progress(transfer.report(bytes, total, verifying));
        update(0, None, false);
        let outcome = upload_file(
            &session.files,
            session.fsync_supported,
            source,
            directory,
            filename,
            transfer,
            update,
        )
        .await;
        match outcome {
            Err(_) if transfer.cancelled() => Ok(SftpTransferOutcome::Cancelled {
                cleanup_warning: None,
            }),
            outcome => outcome,
        }
    }
}

async fn upload_file(
    files: &RawSftpSession,
    fsync_supported: bool,
    source: String,
    directory: SftpString,
    filename: String,
    transfer: &Transfer,
    progress: impl Fn(u64, Option<u64>, bool),
) -> Result<SftpTransferOutcome> {
    let source = tokio::task::spawn_blocking(move || open_local_source(&source))
        .await
        .map_err(|_| "업로드할 로컬 파일을 열 수 없습니다.")??;
    let mut local = tokio::fs::File::from_std(source);
    let original = local
        .metadata()
        .await
        .map_err(|_| "업로드할 파일의 속성을 읽을 수 없습니다.")?;
    let expected = original.len();
    transfer.check()?;
    let destination = directory.join(filename.as_bytes());
    let temporary =
        directory.join(format!(".stackport-upload-{}.part", uuid::Uuid::new_v4()).as_bytes());
    if destination.len() > MAX_REMOTE_PATH || temporary.len() > MAX_REMOTE_PATH {
        return Err("원격 업로드 경로가 너무 깁니다.".into());
    }
    if !request(files.lstat(directory))
        .await
        .map_err(file_error)?
        .attrs
        .is_dir()
    {
        return Err("선택한 원격 경로가 현재 일반 디렉터리인지 확인할 수 없습니다.".into());
    }
    ensure_vacant(files, &destination).await?;
    transfer.check()?;
    let handle = request(files.open(
        temporary.clone(),
        OpenFlags::READ | OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
        FileAttributes {
            permissions: Some(0o600),
            ..FileAttributes::empty()
        },
    ))
    .await
    .map_err(file_error)?
    .handle;

    let staged = async {
        let sha = stage_file(files, &handle, &mut local, &original, transfer, &progress).await?;
        if fsync_supported {
            request(files.fsync(handle.clone()))
                .await
                .map_err(file_error)?;
        }
        Ok::<_, String>(sha)
    }
    .await;
    let closed = request(files.close(handle)).await.map_err(file_error);
    let published = async {
        let sha256 = staged?;
        closed?;
        transfer.check()?;
        ensure_vacant(files, &destination).await?;
        transfer.begin_publication()?;
        match request(files.rename(temporary.clone(), destination.clone())).await {
            Ok(_) => Ok(SftpTransferOutcome::Saved { bytes: expected.to_string(), sha256 }),
            Err(SftpError::Status(status)) => {
                ensure_vacant(files, &destination).await?;
                Err(file_error(SftpError::Status(status)))
            }
            Err(_) => Err("원격 서버에서 게시 응답을 받지 못했습니다. 재시도하기 전에 원격 폴더를 새로고침하세요.".into()),
        }
    }.await;

    if let Err(error) = published {
        let cleanup_warning = match request(files.remove(temporary.clone())).await {
            Ok(_) => None,
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => None,
            Err(_) => Some(format!(
                "원격 임시 파일의 정리를 확인할 수 없습니다. {}",
                temporary.to_string_lossy()
            )),
        };
        if transfer.cancelled() {
            return Ok(SftpTransferOutcome::Cancelled { cleanup_warning });
        }
        return Err(match cleanup_warning {
            Some(warning) => format!("{error} {warning}"),
            None => error,
        });
    }
    published
}

async fn ensure_vacant(files: &RawSftpSession, path: &SftpString) -> Result<()> {
    match request(files.lstat(path.clone())).await {
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(()),
        Ok(_) => {
            Err("원격 폴더에 같은 이름의 파일 또는 폴더가 있습니다. 새 이름을 입력하세요.".into())
        }
        Err(error) => Err(file_error(error)),
    }
}

async fn stage_file(
    files: &RawSftpSession,
    handle: &SftpHandle,
    local: &mut tokio::fs::File,
    original: &fs::Metadata,
    transfer: &Transfer,
    progress: &impl Fn(u64, Option<u64>, bool),
) -> Result<String> {
    let expected = original.len();
    let mut offset = 0;
    let mut checksum = Sha256::new();
    let mut last_update = Instant::now();
    progress(0, Some(expected), false);
    while offset < expected {
        transfer.check()?;
        let length = (expected - offset).min(u64::from(CHUNK_SIZE)) as usize;
        let mut data = vec![0; length];
        local
            .read_exact(&mut data)
            .await
            .map_err(|_| "로컬 파일이 전송 중 변경되었거나 읽을 수 없습니다.")?;
        checksum.update(&data);
        request(files.write(handle.clone(), offset, data))
            .await
            .map_err(file_error)?;
        offset += length as u64;
        if offset == expected || last_update.elapsed() >= Duration::from_millis(200) {
            progress(offset, Some(expected), false);
            last_update = Instant::now();
        }
    }
    let current = local
        .metadata()
        .await
        .map_err(|_| "업로드한 로컬 파일의 속성을 다시 확인할 수 없습니다.")?;
    if current.len() != expected || current.modified().ok() != original.modified().ok() {
        return Err(
            "로컬 파일의 크기 또는 수정 시간이 전송 중 변경되었습니다. 다시 시도하세요.".into(),
        );
    }
    let sha256 = checksum.finalize();
    transfer.check()?;
    let before = request(files.fstat(handle.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    if before.size != Some(expected) {
        return Err("원격 임시 파일의 크기가 원본과 다릅니다.".into());
    }
    progress(0, Some(expected), true);
    let mut received = 0;
    let mut verified = Sha256::new();
    let mut last_update = Instant::now();
    while received < expected {
        transfer.check()?;
        let length = (expected - received).min(u64::from(CHUNK_SIZE)) as u32;
        let data = read_chunk(files, handle, received, length).await?;
        received += data.len() as u64;
        verified.update(data);
        if received == expected || last_update.elapsed() >= Duration::from_millis(200) {
            progress(received, Some(expected), true);
            last_update = Instant::now();
        }
    }
    transfer.check()?;
    let after = request(files.fstat(handle.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    if after.size != before.size || after.mtime != before.mtime || verified.finalize() != sha256 {
        return Err("원격 임시 파일이 변경되었거나 SHA-256이 원본과 일치하지 않습니다.".into());
    }
    Ok(format!("{sha256:x}"))
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || matches!(name, "." | "..")
        || name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
    {
        return Err("경로 구분자 없이 새 원격 파일 이름을 입력하세요.".into());
    }
    Ok(())
}

fn open_local_source(value: &str) -> Result<fs::File> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err("업로드할 로컬 파일의 절대 경로를 확인하세요.".into());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "업로드할 로컬 파일을 찾을 수 없습니다.")?;
    if !metadata.is_file() {
        return Err("업로드할 로컬 경로가 일반 파일인지 확인하세요.".into());
    }
    let mut open = fs::OpenOptions::new();
    open.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        open.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = open
        .open(path)
        .map_err(|_| "업로드할 로컬 파일을 열 수 없습니다.")?;
    if !file
        .metadata()
        .map_err(|_| "업로드할 로컬 파일의 속성을 읽을 수 없습니다.")?
        .is_file()
    {
        return Err("업로드할 로컬 경로가 일반 파일인지 확인하세요.".into());
    }
    Ok(file)
}
