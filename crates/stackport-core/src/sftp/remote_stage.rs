use super::{
    file_error,
    mutation::{ensure_vacant, rename_to_vacant},
    transfer::{read_chunk, request, Transfer, CHUNK_SIZE},
    SftpError, SftpTransferOutcome, MAX_REMOTE_PATH,
};
use crate::Result;
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, OpenFlags, SftpHandle, SftpString, StatusCode},
};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub(super) struct StagingTarget<'a> {
    pub directory: &'a SftpString,
    pub path: &'a SftpString,
    pub size: u64,
    pub fsync_supported: bool,
}

pub(super) async fn stage_remote_file<F>(
    files: &RawSftpSession,
    target: StagingTarget<'_>,
    transfer: &Transfer,
    progress: &impl Fn(u64, Option<u64>, bool),
    write_contents: impl FnOnce(SftpHandle) -> F,
) -> Result<SftpTransferOutcome>
where
    F: Future<Output = Result<[u8; 32]>>,
{
    let temporary = target
        .directory
        .join(format!(".stackport-upload-{}.part", Uuid::new_v4()).as_bytes());
    if temporary.len() > MAX_REMOTE_PATH {
        return Err("원격 임시 파일 경로가 너무 깁니다.".into());
    }
    ensure_vacant(files, target.path).await?;
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
        let expected_digest = write_contents(handle.clone()).await?;
        let verified = verify_staging(
            files,
            &handle,
            target.size,
            expected_digest,
            transfer,
            progress,
        )
        .await?;
        if target.fsync_supported {
            request(files.fsync(handle.clone()))
                .await
                .map_err(file_error)?;
        }
        Ok::<_, String>(verified)
    }
    .await;
    let closed = request(files.close(handle)).await.map_err(file_error);
    let published = async {
        let sha256 = staged?;
        closed?;
        transfer.check()?;
        ensure_vacant(files, target.path).await?;
        transfer.begin_publication()?;
        rename_to_vacant(
            files,
            &temporary,
            target.path,
            "원격 서버에서 게시 응답을 받지 못했습니다. 재시도하기 전에 원격 폴더를 새로고침하세요.",
        )
        .await?;
        Ok(SftpTransferOutcome::Saved { bytes: target.size.to_string(), sha256 })
    }.await;

    match published {
        Ok(saved) => Ok(saved),
        Err(error) => {
            let cleanup_warning = match request(files.remove(temporary.clone())).await {
                Ok(_) => None,
                Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                    None
                }
                Err(_) => Some(format!(
                    "원격 임시 파일의 정리를 확인할 수 없습니다. {}",
                    temporary.to_string_lossy()
                )),
            };
            if transfer.cancelled() {
                return Ok(SftpTransferOutcome::Cancelled { cleanup_warning });
            }
            Err(match cleanup_warning {
                Some(warning) => format!("{error} {warning}"),
                None => error,
            })
        }
    }
}

async fn verify_staging(
    files: &RawSftpSession,
    handle: &SftpHandle,
    expected: u64,
    expected_digest: [u8; 32],
    transfer: &Transfer,
    progress: &impl Fn(u64, Option<u64>, bool),
) -> Result<String> {
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
    let digest = verified.finalize();
    if after.size != before.size || after.mtime != before.mtime || digest[..] != expected_digest {
        return Err("원격 임시 파일이 변경되었거나 SHA-256이 원본과 일치하지 않습니다.".into());
    }
    Ok(format!("{digest:x}"))
}
