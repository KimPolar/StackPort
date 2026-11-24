//! Copy a remote regular file through bounded SFTP reads and writes.

use super::{
    audit::FileOperation,
    file_error,
    mutation::{direct_child_name, ensure_current_directory, new_child_path},
    remote_stage::{stage_remote_file, StagingTarget},
    transfer::{check_remote_snapshot, read_chunk, remote_file_size, request, CHUNK_SIZE},
    RemotePath, SftpEntrySource, SftpManager, SftpTransferProgress, SftpTransferReport,
    MAX_REMOTE_PATH,
};
use crate::Result;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

impl SftpManager {
    pub async fn copy_file(
        &self,
        id: &str,
        parent: String,
        source: SftpEntrySource,
        directory: String,
        name: Option<String>,
        progress: impl Fn(SftpTransferProgress),
    ) -> Result<SftpTransferReport> {
        let parent = RemotePath::Token(parent).into_path()?;
        let source_path = RemotePath::Token(source.location.clone()).into_path()?;
        let leaf = direct_child_name(&parent, &source_path)?;
        let directory = RemotePath::Token(directory).into_path()?;
        let destination = match name {
            Some(name) => new_child_path(&directory, &name)?,
            None => directory.join(leaf),
        };
        if destination.len() > MAX_REMOTE_PATH {
            return Err("새 원격 경로가 너무 깁니다.".into());
        }
        if destination == source_path {
            return Err("다른 대상 폴더나 새 파일 이름을 선택하세요.".into());
        }
        self.run_transfer(id, FileOperation::Copy, |session, transfer| async move {
            let transfer = transfer.as_ref();
            let update =
                |bytes, total, verifying| progress(transfer.report(bytes, total, verifying));
            update(0, None, false);
            transfer.check()?;
            let files = &session.files;
            ensure_current_directory(files, &parent).await?;
            if directory != parent {
                ensure_current_directory(files, &directory).await?;
            }
            let listed = request(files.lstat(source_path.clone()))
                .await
                .map_err(file_error)?
                .attrs;
            source.check_snapshot(&listed)?;
            let expected = remote_file_size(&listed)?;
            let target = StagingTarget {
                directory: &directory,
                path: &destination,
                size: expected,
                fsync_supported: session.fsync_supported,
            };
            let update = &update;
            stage_remote_file(
                files,
                target,
                transfer,
                update,
                |destination_handle| async move {
                    transfer.check()?;
                    let handle =
                        request(files.open(source_path, OpenFlags::READ, FileAttributes::empty()))
                            .await
                            .map_err(file_error)?
                            .handle;
                    let copied = async {
                        let opened = request(files.fstat(handle.clone()))
                            .await
                            .map_err(file_error)?
                            .attrs;
                        check_remote_snapshot(&listed, &opened, expected)?;
                        update(0, Some(expected), false);
                        let mut offset = 0;
                        let mut checksum = Sha256::new();
                        let mut last_update = Instant::now();
                        while offset < expected {
                            transfer.check()?;
                            let wanted = (expected - offset).min(u64::from(CHUNK_SIZE)) as u32;
                            let data = read_chunk(files, &handle, offset, wanted).await?;
                            transfer.check()?;
                            let length = data.len() as u64;
                            checksum.update(&data);
                            request(files.write(destination_handle.clone(), offset, data))
                                .await
                                .map_err(file_error)?;
                            offset += length;
                            if offset == expected
                                || last_update.elapsed() >= Duration::from_millis(200)
                            {
                                update(offset, Some(expected), false);
                                last_update = Instant::now();
                            }
                        }
                        let current = request(files.fstat(handle.clone()))
                            .await
                            .map_err(file_error)?
                            .attrs;
                        check_remote_snapshot(&opened, &current, expected)?;
                        Ok::<_, String>(checksum.finalize().into())
                    }
                    .await;
                    let closed = request(files.close(handle)).await.map_err(file_error);
                    let digest = copied?;
                    closed?;
                    Ok(digest)
                },
            )
            .await
        })
        .await
    }
}
