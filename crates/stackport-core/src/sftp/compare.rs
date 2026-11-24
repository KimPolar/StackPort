//! Read and hash a pair of files selected from the folder comparison.

use super::{
    file_error, open_local_file,
    transfer::{check_remote_snapshot, read_chunk, remote_file_size, request, CHUNK_SIZE},
    RemotePath, SftpManager, BROWSE_TIMEOUT,
};
use crate::Result;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, time::UNIX_EPOCH};

const MAX_COMPARE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComparedFile {
    location: String,
    size: Option<String>,
    modified: Option<u64>,
}

#[derive(Serialize)]
pub struct FileContentComparison {
    matches: bool,
    local_sha256: String,
    remote_sha256: String,
}

impl SftpManager {
    pub async fn compare_contents(
        &self,
        id: &str,
        local: ComparedFile,
        remote: ComparedFile,
    ) -> Result<FileContentComparison> {
        let local = tokio::task::spawn_blocking(move || digest_local_file(&local));
        let (local, remote) = tokio::join!(local, self.digest_remote_file(id, remote));
        let local_sha256 = local
            .map_err(|_| "로컬 파일의 비교 작업을 완료할 수 없습니다.")?
            .map_err(|error| format!("로컬 파일 · {error}"))?;
        let remote_sha256 = remote.map_err(|error| format!("원격 파일 · {error}"))?;
        Ok(FileContentComparison {
            matches: local_sha256 == remote_sha256,
            local_sha256,
            remote_sha256,
        })
    }

    async fn digest_remote_file(&self, id: &str, source: ComparedFile) -> Result<String> {
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let files = &session.files;
        let path = RemotePath::Token(source.location.clone()).into_path()?;
        let listed = request(files.lstat(path.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        let size = remote_file_size(&listed)?;
        check_listing(&source, size, listed.mtime.map(u64::from))?;
        let handle = request(files.open(path.clone(), OpenFlags::READ, FileAttributes::empty()))
            .await
            .map_err(file_error)?
            .handle;
        let digest = tokio::time::timeout(BROWSE_TIMEOUT, async {
            let opened = request(files.fstat(handle.clone()))
                .await
                .map_err(file_error)?
                .attrs;
            check_remote_snapshot(&listed, &opened, size)?;
            let mut offset = 0;
            let mut sha = Sha256::new();
            while offset < size {
                let amount = (size - offset).min(u64::from(CHUNK_SIZE)) as u32;
                let data = read_chunk(files, &handle, offset, amount).await?;
                offset += data.len() as u64;
                sha.update(data);
            }
            let finished = request(files.fstat(handle.clone()))
                .await
                .map_err(file_error)?
                .attrs;
            check_remote_snapshot(&listed, &finished, size)?;
            let current = request(files.lstat(path)).await.map_err(file_error)?.attrs;
            check_remote_snapshot(&listed, &current, size)?;
            Ok::<_, String>(format!("{:x}", sha.finalize()))
        })
        .await;
        let closed = request(files.close(handle)).await.map_err(file_error);
        let sha = digest.map_err(|_| "파일 내용 비교 시간이 초과되었습니다.")??;
        closed?;
        Ok(sha)
    }
}

fn check_listing(source: &ComparedFile, size: u64, modified: Option<u64>) -> Result<()> {
    if source
        .size
        .as_ref()
        .is_some_and(|value| value.parse::<u64>().ok() != Some(size))
        || source.modified.is_some_and(|time| Some(time) != modified)
    {
        return Err("목록을 읽은 뒤 파일이 변경되었습니다. 폴더를 다시 비교하세요.".into());
    }
    if size > MAX_COMPARE_BYTES {
        return Err("내용 비교는 파일당 16 MiB까지 가능합니다.".into());
    }
    Ok(())
}

fn digest_local_file(source: &ComparedFile) -> Result<String> {
    let mut file = open_local_file(&source.location)?;
    let listed = file
        .metadata()
        .map_err(|_| "파일 속성을 읽을 수 없습니다.")?;
    let size = listed.len();
    let modified = listed.modified().ok();
    check_listing(
        source,
        size,
        modified
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_secs()),
    )?;
    let mut reader = (&mut file).take(size + 1);
    let mut buffer = [0; CHUNK_SIZE as usize];
    let mut sha = Sha256::new();
    let mut received = 0;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| "파일을 읽을 수 없습니다.")?;
        if count == 0 {
            break;
        }
        sha.update(&buffer[..count]);
        received += count as u64;
    }
    let current = file
        .metadata()
        .map_err(|_| "파일 속성을 읽을 수 없습니다.")?;
    if received != size || current.len() != size || current.modified().ok() != modified {
        return Err("비교하는 동안 파일이 변경되었습니다. 폴더를 다시 비교하세요.".into());
    }
    Ok(format!("{:x}", sha.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn digests_a_complete_regular_file_and_checks_the_listed_snapshot() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("sample.bin");
        let original = b"compare\0bytes";
        fs::write(&path, original).unwrap();
        let source = ComparedFile {
            location: path.to_str().unwrap().to_owned(),
            size: Some(original.len().to_string()),
            modified: None,
        };
        assert_eq!(
            digest_local_file(&source).unwrap(),
            format!("{:x}", Sha256::digest(original))
        );
        fs::write(&path, b"new size").unwrap();
        assert!(digest_local_file(&source)
            .unwrap_err()
            .contains("다시 비교"));
    }

    #[test]
    fn rejects_a_file_over_the_limit_before_reading() {
        let source = ComparedFile {
            location: String::new(),
            size: None,
            modified: None,
        };
        assert!(check_listing(&source, MAX_COMPARE_BYTES + 1, None)
            .unwrap_err()
            .contains("16 MiB"));
    }
}
