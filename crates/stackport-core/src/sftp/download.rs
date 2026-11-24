//! Stream verified SFTP reads into a local file, then publish without replacing a destination.

use super::{
    audit::FileOperation,
    file_error,
    sync::{ensure_local_parent, SyncCopy},
    transfer::{
        check_remote_snapshot, read_chunk, remote_file_size, request, Transfer, CHUNK_SIZE,
    },
    RemotePath, SftpManager, SftpTransferOutcome, SftpTransferProgress, SftpTransferReport,
};
use crate::{local_file::valid_filename, Result};
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, OpenFlags, SftpHandle, SftpString},
};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tempfile::{NamedTempFile, TempPath};
use tokio::io::AsyncWriteExt;

impl SftpManager {
    pub async fn download(
        &self,
        id: &str,
        source: RemotePath,
        destination: String,
        progress: impl Fn(SftpTransferProgress),
    ) -> Result<SftpTransferReport> {
        let source = source.into_path()?;
        self.run_transfer(
            id,
            FileOperation::Download,
            |session, transfer| async move {
                let update = |received, total| progress(transfer.report(received, total, false));
                update(0, None);
                download_file(&session.files, source, destination, &transfer, update, None).await
            },
        )
        .await
    }
}

pub(super) async fn download_file(
    files: &RawSftpSession,
    source: SftpString,
    destination: String,
    transfer: &Transfer,
    progress: impl Fn(u64, Option<u64>),
    copy: Option<SyncCopy>,
) -> Result<SftpTransferOutcome> {
    transfer.check()?;
    let replacement = copy.and_then(|copy| copy.replacement);
    let (destination, temporary) = tokio::task::spawn_blocking(move || {
        if let Some(replacement) = replacement {
            replacement.verify_local(Path::new(&destination))?;
        }
        prepare_destination(&destination, copy.is_some(), replacement.is_some())
    })
    .await
    .map_err(|_| "다운로드 경로를 준비할 수 없습니다.")??;
    let (local, temporary) = temporary.into_parts();
    let mut local = tokio::fs::File::from_std(local);
    transfer.check()?;
    let listed = request(files.lstat(source.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    let expected = remote_file_size(&listed)?;
    if let Some(copy) = copy {
        copy.source.check(expected, listed.mtime.map(u64::from))?;
    }
    transfer.check()?;
    let handle = request(files.open(source.clone(), OpenFlags::READ, FileAttributes::empty()))
        .await
        .map_err(file_error)?
        .handle;
    let copied = copy_contents(
        files, &handle, &mut local, &listed, expected, transfer, progress,
    )
    .await;
    let closed = request(files.close(handle)).await.map_err(file_error);
    let digest = copied?;
    closed?;
    if copy.is_some() {
        let current = request(files.lstat(source))
            .await
            .map_err(file_error)?
            .attrs;
        check_remote_snapshot(&listed, &current, expected)?;
    }
    if let Some(replacement) = replacement {
        replacement.check_source(&digest)?;
    }
    transfer.check()?;
    local
        .sync_all()
        .await
        .map_err(|_| "다운로드 파일을 디스크에 기록할 수 없습니다.")?;
    drop(local);
    transfer.begin_publication()?;
    let warning = tokio::task::spawn_blocking(move || {
        if let Some(replacement) = replacement {
            return replacement.publish_local(temporary, &destination);
        }
        if copy.is_some() {
            ensure_local_parent(&destination)?;
        }
        publish(temporary, destination).map(|()| None)
    })
    .await
    .map_err(|_| "다운로드 파일을 저장할 수 없습니다.")??;
    Ok(SftpTransferOutcome::Saved {
        bytes: expected.to_string(),
        sha256: digest,
        warning,
    })
}

async fn copy_contents(
    files: &RawSftpSession,
    handle: &SftpHandle,
    local: &mut tokio::fs::File,
    listed: &FileAttributes,
    expected: u64,
    transfer: &Transfer,
    progress: impl Fn(u64, Option<u64>),
) -> Result<String> {
    let opened = request(files.fstat(handle.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    check_remote_snapshot(listed, &opened, expected)?;
    progress(0, Some(expected));
    let mut copied = 0;
    let mut checksum = Sha256::new();
    let mut last_update = Instant::now();
    while copied < expected {
        transfer.check()?;
        let wanted = (expected - copied).min(u64::from(CHUNK_SIZE)) as u32;
        let data = read_chunk(files, handle, copied, wanted).await?;
        transfer.check()?;
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
    transfer.check()?;
    let finished = request(files.fstat(handle.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    check_remote_snapshot(&opened, &finished, expected)?;
    Ok(format!("{:x}", checksum.finalize()))
}

fn prepare_destination(
    destination: &str,
    strict_parent: bool,
    replacing: bool,
) -> Result<(PathBuf, NamedTempFile)> {
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
    let parent = path.parent().ok_or("다운로드 폴더를 지정하세요.")?;
    let parent = if strict_parent {
        ensure_local_parent(path)?;
        parent.to_path_buf()
    } else {
        parent
            .canonicalize()
            .map_err(|_| "다운로드 폴더를 열 수 없습니다.")?
    };
    let destination = parent.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if replacing && metadata.is_file() && !super::local_link(&metadata) => {}
        Ok(_) => return Err("같은 이름의 파일이 있습니다. 새 파일 이름을 입력하세요.".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound && replacing => {
            return Err("갱신 대상 파일이 사라졌습니다. 다시 비교하세요.".into())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("다운로드 경로에 접근할 수 없습니다.".into()),
    }
    let temporary = tempfile::Builder::new()
        .prefix(".stackport-download-")
        .tempfile_in(parent)
        .map_err(|_| "다운로드 임시 파일을 만들 수 없습니다.")?;
    Ok((destination, temporary))
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
        let (destination, mut temporary) =
            prepare_destination(target.to_str().unwrap(), false, false).unwrap();
        temporary.write_all(b"download").unwrap();
        fs::write(&target, b"keep").unwrap();
        assert!(publish(temporary.into_temp_path(), destination).is_err());
        assert!(prepare_destination(target.to_str().unwrap(), false, false).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
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
