//! Stream verified SFTP reads into a local file, then publish without replacing a destination.

use super::{
    audit::{Direction, TransferAudit},
    file_error,
    transfer::{read_chunk, request, Transfer, CHUNK_SIZE},
    RemotePath, SftpManager, SftpTransferOutcome, SftpTransferProgress, SftpTransferReport,
};
use crate::Result;
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
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let active = session.register_transfer()?;
        let transfer = &active.transfer;
        let audit =
            TransferAudit::start(&self.store, &session.profile, &transfer.id, Direction::Download)
                .await?;
        let update = |received, total| progress(transfer.report(received, total, false));
        update(0, None);
        let result = download_file(&session.files, source, destination, transfer, update).await;
        let result = if transfer.cancelled() {
            Ok(SftpTransferOutcome::Cancelled {
                cleanup_warning: None,
            })
        } else {
            result
        };
        audit.finish(result).await
    }
}

async fn download_file(
    files: &RawSftpSession,
    source: SftpString,
    destination: String,
    transfer: &Transfer,
    progress: impl Fn(u64, Option<u64>),
) -> Result<SftpTransferOutcome> {
    transfer.check()?;
    let (destination, temporary) =
        tokio::task::spawn_blocking(move || prepare_destination(&destination))
            .await
            .map_err(|_| "다운로드 경로를 준비할 수 없습니다.")??;
    let (local, temporary) = temporary.into_parts();
    let mut local = tokio::fs::File::from_std(local);
    transfer.check()?;
    let listed = request(files.lstat(source.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    let expected = file_size(&listed)?;
    transfer.check()?;
    let handle = request(files.open(source, OpenFlags::READ, FileAttributes::empty()))
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
    transfer.check()?;
    local
        .sync_all()
        .await
        .map_err(|_| "다운로드 파일을 디스크에 기록할 수 없습니다.")?;
    drop(local);
    transfer.begin_publication()?;
    tokio::task::spawn_blocking(move || publish(temporary, destination))
        .await
        .map_err(|_| "다운로드 파일을 저장할 수 없습니다.")??;
    Ok(SftpTransferOutcome::Saved {
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
    transfer: &Transfer,
    progress: impl Fn(u64, Option<u64>),
) -> Result<String> {
    let opened = request(files.fstat(handle.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    check_snapshot(listed, &opened, expected)?;
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
    check_snapshot(&opened, &finished, expected)?;
    Ok(format!("{:x}", checksum.finalize()))
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
