//! Stream a regular local file into a verified remote staging file.

use super::{
    audit::FileOperation,
    file_error,
    mutation::{ensure_current_directory, ensure_directory, new_child_path},
    open_local_file,
    remote_stage::{stage_new_file, StagingTarget},
    sync::CopySnapshot,
    transfer::{request, Transfer, CHUNK_SIZE},
    FilesSession, RemotePath, SftpManager, SftpTransferOutcome, SftpTransferProgress,
    SftpTransferReport,
};
use crate::Result;
use russh_sftp::protocol::SftpString;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

impl SftpManager {
    pub async fn upload(
        &self,
        id: &str,
        source: String,
        directory: RemotePath,
        filename: String,
        progress: impl Fn(SftpTransferProgress),
    ) -> Result<SftpTransferReport> {
        let directory = directory.into_path()?;
        let destination = new_child_path(&directory, &filename)?;
        self.run_transfer(id, FileOperation::Upload, |session, transfer| async move {
            upload_file(
                &session,
                source,
                directory,
                destination,
                &transfer,
                progress,
                None,
            )
            .await
        })
        .await
    }
}

pub(super) async fn upload_file(
    session: &FilesSession,
    source: String,
    directory: SftpString,
    destination: SftpString,
    transfer: &Transfer,
    progress: impl Fn(SftpTransferProgress),
    snapshot: Option<CopySnapshot>,
) -> Result<SftpTransferOutcome> {
    let update = |bytes, total, verifying| progress(transfer.report(bytes, total, verifying));
    update(0, None, false);
    transfer.check()?;
    let source = tokio::task::spawn_blocking(move || {
        if snapshot.is_some() {
            super::sync::ensure_local_parent(std::path::Path::new(&source))?;
        }
        open_local_file(&source)
    })
    .await
    .map_err(|_| "업로드할 로컬 파일을 열 수 없습니다.")??;
    let mut local = tokio::fs::File::from_std(source);
    let original = local
        .metadata()
        .await
        .map_err(|_| "업로드할 파일의 속성을 읽을 수 없습니다.")?;
    let expected = original.len();
    if let Some(snapshot) = snapshot {
        snapshot.check(
            expected,
            original
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_secs()),
        )?;
    }
    let files = &session.files;
    if snapshot.is_some() {
        ensure_current_directory(files, &directory).await?;
    } else {
        ensure_directory(files, directory.clone()).await?;
    }
    let target = StagingTarget {
        directory: &directory,
        path: &destination,
        size: expected,
        fsync_supported: session.fsync_supported,
    };
    let update = &update;
    stage_new_file(
        files,
        target,
        transfer,
        update,
        snapshot.is_some(),
        |handle| async move {
            let mut offset = 0;
            let mut checksum = Sha256::new();
            let mut last_update = Instant::now();
            update(0, Some(expected), false);
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
                    update(offset, Some(expected), false);
                    last_update = Instant::now();
                }
            }
            let current = local
                .metadata()
                .await
                .map_err(|_| "업로드한 로컬 파일의 속성을 다시 확인할 수 없습니다.")?;
            if current.len() != expected || current.modified().ok() != original.modified().ok() {
                return Err(
                    "로컬 파일의 크기 또는 수정 시간이 전송 중 변경되었습니다. 다시 시도하세요."
                        .into(),
                );
            }
            Ok(checksum.finalize().into())
        },
    )
    .await
}
