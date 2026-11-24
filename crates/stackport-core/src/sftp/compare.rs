//! Hash a pair of files and generate a bounded comparison from the hashed bytes.

use super::{
    file_error, open_local_file,
    preview::utf8_prefix,
    transfer::{check_remote_snapshot, read_chunk, remote_file_size, request, CHUNK_SIZE},
    RemotePath, SftpManager, BROWSE_TIMEOUT,
};
use crate::{local_file::write_new_file, text_draft::UTF8_BOM, Result};
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, OpenFlags, SftpString},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, time::UNIX_EPOCH};

const MAX_COMPARE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DIFFERENCE_BYTES: u64 = 64 * 1024;
const HEX_ROW_BYTES: usize = 16;
const MAX_HEX_ROWS: usize = 64;
const MAX_MERGED_BYTES: usize = (2 * MAX_DIFFERENCE_BYTES) as usize + UTF8_BOM.len();

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
    difference: Option<FileDifference>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum FileDifference {
    Text {
        local: String,
        remote: String,
    },
    Binary {
        differing_bytes: usize,
        changed_rows: usize,
        rows: Vec<HexRow>,
    },
    TooLarge,
}

#[derive(Serialize)]
struct HexRow {
    offset: usize,
    local: Vec<u8>,
    remote: Vec<u8>,
}

pub(super) struct FileDigest {
    pub(super) sha256: String,
    bytes: Option<Vec<u8>>,
}

struct DigestReader {
    sha: Sha256,
    bytes: Option<Vec<u8>>,
}

impl DigestReader {
    fn new(size: u64, preview: bool) -> Self {
        Self {
            sha: Sha256::new(),
            bytes: (preview && size <= MAX_DIFFERENCE_BYTES)
                .then(|| Vec::with_capacity(size as usize)),
        }
    }

    fn update(&mut self, chunk: &[u8]) {
        self.sha.update(chunk);
        if let Some(bytes) = &mut self.bytes {
            bytes.extend_from_slice(chunk);
        }
    }

    fn finish(self) -> FileDigest {
        FileDigest {
            sha256: format!("{:x}", self.sha.finalize()),
            bytes: self.bytes,
        }
    }
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
        let local = local
            .map_err(|_| "로컬 파일의 비교 작업을 완료할 수 없습니다.")?
            .map_err(|error| format!("로컬 파일 · {error}"))?;
        let remote = remote.map_err(|error| format!("원격 파일 · {error}"))?;
        let matches = local.sha256 == remote.sha256;
        Ok(FileContentComparison {
            matches,
            difference: (!matches).then(|| describe_difference(local.bytes, remote.bytes)),
            local_sha256: local.sha256,
            remote_sha256: remote.sha256,
        })
    }

    async fn digest_remote_file(&self, id: &str, source: ComparedFile) -> Result<FileDigest> {
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
        digest_remote_contents(files, &path, &listed).await
    }
}

pub(super) async fn digest_remote_contents(
    files: &RawSftpSession,
    path: &SftpString,
    listed: &FileAttributes,
) -> Result<FileDigest> {
    digest_remote(files, path, listed, true).await
}

pub(super) async fn remote_delete_sha256(
    files: &RawSftpSession,
    path: &SftpString,
    listed: &FileAttributes,
) -> Result<String> {
    Ok(digest_remote(files, path, listed, false).await?.sha256)
}

async fn digest_remote(
    files: &RawSftpSession,
    path: &SftpString,
    listed: &FileAttributes,
    bounded: bool,
) -> Result<FileDigest> {
    let size = remote_file_size(listed)?;
    if bounded {
        check_size(size)?;
    }
    let handle = request(files.open(path.clone(), OpenFlags::READ, FileAttributes::empty()))
        .await
        .map_err(file_error)?
        .handle;
    let read = async {
        let opened = request(files.fstat(handle.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        check_remote_snapshot(listed, &opened, size)?;
        let mut offset = 0;
        let mut digest = DigestReader::new(size, bounded);
        while offset < size {
            let amount = (size - offset).min(u64::from(CHUNK_SIZE)) as u32;
            let data = read_chunk(files, &handle, offset, amount).await?;
            offset += data.len() as u64;
            digest.update(&data);
        }
        let finished = request(files.fstat(handle.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        check_remote_snapshot(listed, &finished, size)?;
        let current = request(files.lstat(path.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        check_remote_snapshot(listed, &current, size)?;
        Ok::<_, String>(digest.finish())
    };
    let digest = if bounded {
        tokio::time::timeout(BROWSE_TIMEOUT, read)
            .await
            .unwrap_or_else(|_| Err("파일 내용 비교 시간이 초과되었습니다.".into()))
    } else {
        read.await
    };
    let closed = request(files.close(handle)).await.map_err(file_error);
    let digest = digest?;
    closed?;
    Ok(digest)
}

fn check_listing(source: &ComparedFile, size: u64, modified: Option<u64>) -> Result<()> {
    check_listing_metadata(source, size, modified)?;
    check_size(size)
}

fn check_listing_metadata(source: &ComparedFile, size: u64, modified: Option<u64>) -> Result<()> {
    if source
        .size
        .as_ref()
        .is_some_and(|value| value.parse::<u64>().ok() != Some(size))
        || source.modified.is_some_and(|time| Some(time) != modified)
    {
        return Err("목록을 읽은 뒤 파일이 변경되었습니다. 폴더를 다시 비교하세요.".into());
    }
    Ok(())
}

fn check_size(size: u64) -> Result<()> {
    if size > MAX_COMPARE_BYTES {
        return Err("내용 비교는 파일당 16 MiB까지 가능합니다.".into());
    }
    Ok(())
}

fn digest_local_file(source: &ComparedFile) -> Result<FileDigest> {
    digest_local(source, true)
}

fn digest_local(source: &ComparedFile, bounded: bool) -> Result<FileDigest> {
    let mut file = open_local_file(&source.location)?;
    let listed = file
        .metadata()
        .map_err(|_| "파일 속성을 읽을 수 없습니다.")?;
    let size = listed.len();
    let modified = listed.modified().ok();
    check_listing_metadata(
        source,
        size,
        modified
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_secs()),
    )?;
    if bounded {
        check_size(size)?;
    }
    let mut reader = (&mut file).take(size.saturating_add(1));
    let mut buffer = [0; CHUNK_SIZE as usize];
    let mut digest = DigestReader::new(size, bounded);
    let mut received = 0;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| "파일을 읽을 수 없습니다.")?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        received += count as u64;
    }
    let current = file
        .metadata()
        .map_err(|_| "파일 속성을 읽을 수 없습니다.")?;
    if received != size || current.len() != size || current.modified().ok() != modified {
        return Err("비교하는 동안 파일이 변경되었습니다. 폴더를 다시 비교하세요.".into());
    }
    Ok(digest.finish())
}

pub(super) fn local_sha256(path: &str, size: u64, modified: Option<u64>) -> Result<String> {
    Ok(digest_local_file(&ComparedFile {
        location: path.into(),
        size: Some(size.to_string()),
        modified,
    })?
    .sha256)
}

pub(super) fn local_delete_sha256(path: &str, size: u64) -> Result<String> {
    Ok(digest_local(
        &ComparedFile {
            location: path.into(),
            size: Some(size.to_string()),
            modified: None,
        },
        false,
    )?
    .sha256)
}

fn describe_difference(local: Option<Vec<u8>>, remote: Option<Vec<u8>>) -> FileDifference {
    let (Some(local), Some(remote)) = (local, remote) else {
        return FileDifference::TooLarge;
    };
    if let (Some(left), Some(right)) = (
        utf8_prefix(&local, local.len() as u64),
        utf8_prefix(&remote, remote.len() as u64),
    ) {
        return FileDifference::Text {
            local: left.to_owned(),
            remote: right.to_owned(),
        };
    }

    let mut differing_bytes = 0;
    let mut changed_rows = 0;
    let mut rows = Vec::new();
    let end = local.len().max(remote.len());
    for offset in (0..end).step_by(HEX_ROW_BYTES) {
        let local_row = local
            .get(offset..local.len().min(offset + HEX_ROW_BYTES))
            .unwrap_or_default();
        let remote_row = remote
            .get(offset..remote.len().min(offset + HEX_ROW_BYTES))
            .unwrap_or_default();
        let changed = (0..local_row.len().max(remote_row.len()))
            .filter(|&index| local_row.get(index) != remote_row.get(index))
            .count();
        if changed > 0 {
            differing_bytes += changed;
            changed_rows += 1;
            if rows.len() < MAX_HEX_ROWS {
                rows.push(HexRow {
                    offset,
                    local: local_row.to_vec(),
                    remote: remote_row.to_vec(),
                });
            }
        }
    }
    FileDifference::Binary {
        differing_bytes,
        changed_rows,
        rows,
    }
}

pub fn save_merged_text(destination: &str, text: &str) -> Result<usize> {
    if text.len() > MAX_MERGED_BYTES || utf8_prefix(text.as_bytes(), text.len() as u64).is_none() {
        return Err("병합 결과의 UTF-8 텍스트 또는 크기 한도를 확인하세요.".into());
    }
    write_new_file(destination, None, ".stackport-merge-", text.as_bytes())
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
            digest_local_file(&source).unwrap().sha256,
            format!("{:x}", Sha256::digest(original))
        );
        fs::write(&path, b"new size").unwrap();
        assert!(matches!(digest_local_file(&source), Err(error) if error.contains("다시 비교")));
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

    #[test]
    fn describes_text_unchanged_bytes_and_bounded_binary_rows() {
        let left = "\u{feff}가\r\n".as_bytes().to_vec();
        let right = "가\n".as_bytes().to_vec();
        assert!(matches!(
            describe_difference(Some(left.clone()), Some(right.clone())),
            FileDifference::Text { local, remote } if local.as_bytes() == left && remote.as_bytes() == right
        ));
        assert!(matches!(
            describe_difference(Some(left), None),
            FileDifference::TooLarge
        ));

        let size = HEX_ROW_BYTES * (MAX_HEX_ROWS + 3);
        let left = vec![0; size];
        let mut right = left.clone();
        for offset in (HEX_ROW_BYTES..size).step_by(HEX_ROW_BYTES) {
            right[offset] = 0xff;
        }
        right.push(0xff);
        assert!(matches!(
            describe_difference(Some(left), Some(right)),
            FileDifference::Binary { differing_bytes, changed_rows, rows }
                if differing_bytes == MAX_HEX_ROWS + 3 && changed_rows == differing_bytes
                    && rows.len() == MAX_HEX_ROWS && rows[0].offset == HEX_ROW_BYTES
                    && rows[0].local[0] == 0 && rows[0].remote[0] == 0xff
        ));
    }

    #[test]
    fn saves_exact_merged_utf8_bytes_to_a_new_file_only() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("merged.conf");
        let destination = path.to_str().unwrap();
        let text = "\u{feff}원격\r\n로컬\n끝";
        assert_eq!(save_merged_text(destination, text).unwrap(), text.len());
        assert!(save_merged_text(destination, "replacement").is_err());
        assert_eq!(fs::read(path).unwrap(), text.as_bytes());
        assert!(save_merged_text("relative.txt", text).is_err());
        let invalid = folder.path().join("invalid");
        assert!(save_merged_text(invalid.to_str().unwrap(), "\0").is_err());
        assert!(
            save_merged_text(invalid.to_str().unwrap(), &" ".repeat(MAX_MERGED_BYTES + 1)).is_err()
        );
        assert!(!invalid.exists());
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }
}
