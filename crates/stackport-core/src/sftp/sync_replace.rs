//! Verify both compared versions before replacing an existing synchronization target.

use super::{
    compare::{digest_remote_contents, local_sha256},
    file_error, local_link,
    remote_stage::can_preserve_permissions,
    sync::{ensure_local_parent, CopySnapshot},
    transfer::{remote_file_size, request},
};
use crate::Result;
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, SftpString},
};
use serde::Deserialize;
use std::{fs, io, path::Path};
use tempfile::TempPath;

const TARGET_CHANGED: &str = "비교 후 대상 파일이 바뀌었습니다. 다시 비교하세요.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReplacementInput {
    source_sha256: String,
    target_sha256: String,
    target_size: String,
    target_modified: Option<u64>,
    target_mode: Option<u32>,
    target_uid: Option<u32>,
    target_gid: Option<u32>,
}

#[derive(Clone, Copy)]
pub(super) struct Replacement {
    source_sha256: [u8; 64],
    target_sha256: [u8; 64],
    target: CopySnapshot,
    target_mode: Option<u32>,
    target_uid: Option<u32>,
    target_gid: Option<u32>,
}

impl TryFrom<ReplacementInput> for Replacement {
    type Error = String;

    fn try_from(value: ReplacementInput) -> Result<Self> {
        fn hash(value: &str) -> Result<[u8; 64]> {
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err("갱신할 파일의 SHA-256을 다시 확인하세요.".into());
            }
            Ok(value.as_bytes().try_into().expect("length checked"))
        }
        let source_sha256 = hash(&value.source_sha256)?;
        let target_sha256 = hash(&value.target_sha256)?;
        if source_sha256 == target_sha256 {
            return Err("갱신할 원본과 대상의 내용이 같습니다.".into());
        }
        Ok(Self {
            source_sha256,
            target_sha256,
            target: CopySnapshot {
                size: value
                    .target_size
                    .parse()
                    .map_err(|_| "갱신 대상 파일의 크기를 확인하세요.")?,
                modified: value.target_modified,
            },
            target_mode: value.target_mode,
            target_uid: value.target_uid,
            target_gid: value.target_gid,
        })
    }
}

impl Replacement {
    pub(super) fn check_source(self, digest: &str) -> Result<()> {
        if digest.as_bytes() != self.source_sha256 {
            return Err("비교 후 원본 파일의 SHA-256이 바뀌었습니다. 다시 비교하세요.".into());
        }
        Ok(())
    }

    pub(super) async fn verify_remote(
        self,
        files: &RawSftpSession,
        path: &SftpString,
    ) -> Result<FileAttributes> {
        let before = request(files.lstat(path.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        self.check_remote_metadata(&before)?;
        if !can_preserve_permissions(&before) {
            return Err("원격 대상의 소유자와 권한을 보존할 수 없습니다.".into());
        }
        let digest = digest_remote_contents(files, path, &before).await?;
        let current = request(files.lstat(path.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        self.check_remote_metadata(&current)?;
        if digest.sha256.as_bytes() != self.target_sha256 {
            return Err(TARGET_CHANGED.into());
        }
        Ok(current)
    }

    fn check_remote_metadata(self, attrs: &FileAttributes) -> Result<()> {
        let size = remote_file_size(attrs).map_err(|_| TARGET_CHANGED)?;
        if self.target.check(size, attrs.mtime.map(u64::from)).is_err()
            || self.target_mode != attrs.permissions.map(|mode| mode & 0o7777)
            || self.target_uid != attrs.uid
            || self.target_gid != attrs.gid
        {
            return Err(TARGET_CHANGED.into());
        }
        Ok(())
    }

    pub(super) fn verify_local(self, path: &Path) -> Result<fs::Metadata> {
        ensure_local_parent(path)?;
        let path_text = path.to_str().ok_or("로컬 대상 경로를 읽을 수 없습니다.")?;
        let before = fs::symlink_metadata(path).map_err(|_| TARGET_CHANGED)?;
        if local_link(&before) || !before.is_file() {
            return Err(TARGET_CHANGED.into());
        }
        let digest = local_sha256(path_text, self.target.size, self.target.modified)
            .map_err(|error| format!("로컬 대상 · {error}"))?;
        let current = fs::symlink_metadata(path).map_err(|_| TARGET_CHANGED)?;
        if local_link(&current)
            || !current.is_file()
            || digest.as_bytes() != self.target_sha256
            || current.len() != before.len()
            || current.modified().ok() != before.modified().ok()
        {
            return Err(TARGET_CHANGED.into());
        }
        Ok(current)
    }

    pub(super) fn publish_local(
        self,
        temporary: TempPath,
        destination: &Path,
    ) -> Result<Option<String>> {
        let original = self.verify_local(destination)?;
        replace_local(temporary, destination, original.permissions())
    }
}

#[cfg(windows)]
fn replace_local(
    temporary: TempPath,
    destination: &Path,
    _permissions: fs::Permissions,
) -> Result<Option<String>> {
    use std::{os::windows::ffi::OsStrExt, ptr::null_mut};
    use windows_sys::Win32::Storage::FileSystem::{MoveFileW, ReplaceFileW};

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    let parent = destination
        .parent()
        .ok_or("교체할 로컬 폴더를 확인할 수 없습니다.")?;
    let backup_dir = tempfile::Builder::new()
        .prefix(".stackport-sync-")
        .tempdir_in(parent)
        .map_err(|_| "교체 중 원본을 보호할 임시 폴더를 만들 수 없습니다.")?;
    let backup = backup_dir.path().join("original");
    let destination_wide = wide(destination);
    let temporary_wide = wide(&temporary);
    let backup_wide = wide(&backup);
    // All three paths are on the same volume. Keep the backup if Windows cannot finish or restore the replacement.
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            temporary_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            null_mut(),
            null_mut(),
        )
    };
    if replaced != 0 {
        let path = backup_dir.path().display().to_string();
        return Ok(backup_dir
            .close()
            .err()
            .map(|_| format!("교체는 완료됐으며 원본 사본이 남았습니다. {path}")));
    }
    let error = io::Error::last_os_error();
    if !matches!(fs::symlink_metadata(&backup), Err(ref error) if error.kind() == io::ErrorKind::NotFound)
    {
        // MoveFileW refuses an occupied destination. Never replace another file while recovering.
        let restored = unsafe { MoveFileW(backup_wide.as_ptr(), destination_wide.as_ptr()) };
        if restored == 0 {
            let kept = backup_dir.keep().join("original");
            return Err(format!(
                "로컬 파일을 교체할 수 없습니다. 원본 사본을 보존했습니다. {}",
                kept.display()
            ));
        }
    }
    Err(format!("로컬 파일을 교체할 수 없습니다. {error}"))
}

#[cfg(not(windows))]
fn replace_local(
    temporary: TempPath,
    destination: &Path,
    permissions: fs::Permissions,
) -> Result<Option<String>> {
    fs::set_permissions(&temporary, permissions)
        .map_err(|_| "로컬 대상의 권한을 보존할 수 없습니다.")?;
    temporary
        .persist(destination)
        .map_err(|_| "로컬 파일을 교체할 수 없습니다.")?;
    Ok(None)
}
