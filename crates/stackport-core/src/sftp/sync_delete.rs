//! Prepare and apply the mirror deletions of a reviewed, one-way synchronization plan.

use super::{
    compare::{local_delete_sha256, remote_delete_sha256},
    delete::{ensure_empty_directory, remove_remote_item},
    file_error, local_link,
    mutation::ensure_current_directory,
    remote_stage::same_permissions,
    sync::{ensure_local_directory, ensure_local_parent, resolve_item_paths, Kind, Side},
    transfer::request,
    RemotePath, SftpError, SftpManager, SyncProgress,
};
use crate::Result;
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, SftpString, StatusCode},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};
use uuid::Uuid;

const LIFETIME: Duration = Duration::from_secs(300);
const EXPIRED: &str = "동기화 삭제 확인이 만료되었거나 이미 사용되었습니다. 다시 검증하세요.";
const SOURCE_PRESENT: &str = "기준 폴더에 같은 경로가 생겼습니다. 대상을 보존했습니다.";
const TARGET_CHANGED: &str = "삭제 대상이 바뀌었습니다. 다시 비교하세요.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncDeleteInput {
    local_root: String,
    remote_root: String,
    target: Side,
    items: Vec<Candidate>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Candidate {
    path: String,
    kind: Kind,
    size: Option<String>,
    modified: Option<u64>,
    mode: Option<u32>,
    uid: Option<u32>,
    gid: Option<u32>,
}

#[derive(Serialize)]
pub struct SyncDeletePreview {
    token: Option<String>,
    ready: Vec<String>,
    conflicts: Vec<Conflict>,
    expires_seconds: u64,
}

#[derive(Serialize)]
struct Conflict {
    path: String,
    reason: String,
}

pub(super) struct PendingSyncDelete {
    token: String,
    local_root: PathBuf,
    remote_root: SftpString,
    expires: Instant,
    target: Side,
    items: Vec<Deletion>,
}

pub(super) struct Deletion {
    pub(super) relative: String,
    location: Location,
    snapshot: Snapshot,
}

struct Location {
    local: PathBuf,
    remote_parent: SftpString,
    remote: SftpString,
}

enum Snapshot {
    Local {
        metadata: fs::Metadata,
        sha256: Option<String>,
    },
    Remote {
        attributes: FileAttributes,
        sha256: Option<String>,
    },
}

impl SftpManager {
    pub async fn prepare_sync_deletions(
        &self,
        id: &str,
        input: SyncDeleteInput,
        progress: impl Fn(SyncProgress),
    ) -> Result<SyncDeletePreview> {
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        session
            .pending_sync_delete
            .lock()
            .map_err(|_| EXPIRED)?
            .take();
        if input.items.is_empty() || input.items.len() > 8_000 {
            return Err("검증할 삭제 후보 수를 확인하세요.".into());
        }
        let remote_root = RemotePath::Token(input.remote_root).into_path()?;
        let local_root = PathBuf::from(input.local_root);
        let local = local_root.clone();
        tokio::task::spawn_blocking(move || ensure_local_directory(&local))
            .await
            .map_err(|_| "로컬 폴더를 확인할 수 없습니다.")??;
        let files = &session.files;
        ensure_current_directory(files, &remote_root).await?;
        let mut pending = Vec::new();
        let mut conflicts = Vec::new();
        let mut seen = HashSet::new();
        let total = input.items.len();
        for (completed, candidate) in input.items.into_iter().enumerate() {
            progress(SyncProgress {
                completed,
                total,
                path: candidate.path.clone(),
            });
            let key = if cfg!(windows) {
                candidate.path.to_uppercase()
            } else {
                candidate.path.clone()
            };
            if !seen.insert(key) {
                return Err("삭제 계획에 중복 경로가 있습니다.".into());
            }
            match prepare_item(files, &local_root, &remote_root, input.target, &candidate).await {
                Ok(location) => pending.push(location),
                Err(reason) => conflicts.push(Conflict {
                    path: candidate.path,
                    reason,
                }),
            }
        }
        pending.sort_by_key(|item| std::cmp::Reverse(item.relative.matches('/').count()));
        let ready = pending.iter().map(|item| item.relative.clone()).collect();
        let token = (!pending.is_empty()).then(|| Uuid::new_v4().to_string());
        if let Some(token) = &token {
            *session.pending_sync_delete.lock().map_err(|_| EXPIRED)? = Some(PendingSyncDelete {
                token: token.clone(),
                local_root,
                remote_root,
                expires: Instant::now() + LIFETIME,
                target: input.target,
                items: pending,
            });
        }
        Ok(SyncDeletePreview {
            token,
            ready,
            conflicts,
            expires_seconds: LIFETIME.as_secs(),
        })
    }
}

impl PendingSyncDelete {
    pub(super) fn validate(&self, token: &str, local: &Path, remote: &SftpString) -> Result<Side> {
        if self.token != token
            || self.local_root != local
            || self.remote_root != *remote
            || self.expires <= Instant::now()
        {
            return Err(EXPIRED.into());
        }
        Ok(self.target)
    }

    pub(super) fn into_items(self) -> Vec<Deletion> {
        self.items
    }
}

async fn prepare_item(
    files: &RawSftpSession,
    local_root: &Path,
    remote_root: &SftpString,
    target: Side,
    candidate: &Candidate,
) -> Result<Deletion> {
    let (local, remote_parent, remote) =
        resolve_item_paths(local_root, remote_root, &candidate.path, false)?;
    let location = Location {
        local,
        remote_parent,
        remote,
    };
    let snapshot = match target {
        Side::Remote => {
            verify_local_missing(local_root, &candidate.path).await?;
            ensure_current_directory(files, &location.remote_parent).await?;
            let attributes = stat_remote(files, &location.remote).await?;
            let directory = candidate.kind == Kind::Directory;
            if (if directory {
                !attributes.is_dir()
            } else {
                !attributes.is_regular()
            }) || candidate.modified != attributes.mtime.map(u64::from)
                || candidate.mode != attributes.permissions.map(|mode| mode & 0o7777)
                || candidate.uid != attributes.uid
                || candidate.gid != attributes.gid
                || candidate
                    .size
                    .as_ref()
                    .is_some_and(|size| size.parse().ok() != attributes.size)
            {
                return Err(TARGET_CHANGED.into());
            }
            let sha256 = if directory {
                None
            } else {
                Some(remote_delete_sha256(files, &location.remote, &attributes).await?)
            };
            Snapshot::Remote { attributes, sha256 }
        }
        Side::Local => {
            verify_remote_missing(files, remote_root, &candidate.path).await?;
            let path = location.local.clone();
            let (kind, size, modified) =
                (candidate.kind, candidate.size.clone(), candidate.modified);
            tokio::task::spawn_blocking(move || {
                ensure_local_parent(&path)?;
                let metadata = stat_local(&path)?;
                if (if kind == Kind::Directory {
                    !metadata.is_dir()
                } else {
                    !metadata.is_file()
                }) || modified
                    != metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|time| time.as_secs())
                    || size
                        .as_ref()
                        .is_some_and(|size| size.parse::<u64>().ok() != Some(metadata.len()))
                {
                    return Err(TARGET_CHANGED.into());
                }
                let sha256 = if kind == Kind::Directory {
                    None
                } else {
                    Some(hash_local(&path, metadata.len())?)
                };
                Ok::<_, String>(Snapshot::Local { metadata, sha256 })
            })
            .await
            .map_err(|_| "로컬 삭제 후보를 검증할 수 없습니다.")??
        }
    };
    Ok(Deletion {
        relative: candidate.path.clone(),
        location,
        snapshot,
    })
}

impl Deletion {
    pub(super) fn target(&self) -> Side {
        match self.snapshot {
            Snapshot::Local { .. } => Side::Local,
            Snapshot::Remote { .. } => Side::Remote,
        }
    }

    pub(super) async fn verify_directory(&self, files: &RawSftpSession) -> Result<()> {
        match &self.snapshot {
            Snapshot::Remote {
                attributes,
                sha256: None,
            } => {
                ensure_current_directory(files, &self.location.remote).await?;
                check_remote(
                    attributes,
                    &stat_remote(files, &self.location.remote).await?,
                    false,
                )
            }
            Snapshot::Local {
                metadata,
                sha256: None,
            } => {
                let path = self.location.local.clone();
                let metadata = metadata.clone();
                tokio::task::spawn_blocking(move || {
                    ensure_local_directory(&path)?;
                    check_local(&metadata, &stat_local(&path)?, false)
                })
                .await
                .map_err(|_| "로컬 삭제 폴더를 검증할 수 없습니다.")?
            }
            _ => Ok(()),
        }
    }

    pub(super) async fn apply(
        &self,
        files: &RawSftpSession,
        local_root: &Path,
        remote_root: &SftpString,
        removed_child: bool,
    ) -> Result<()> {
        match &self.snapshot {
            Snapshot::Remote { attributes, sha256 } => {
                ensure_current_directory(files, &self.location.remote_parent).await?;
                let directory = sha256.is_none();
                let current = stat_remote(files, &self.location.remote).await?;
                check_remote(attributes, &current, removed_child && directory)?;
                if let Some(expected) = sha256 {
                    if remote_delete_sha256(files, &self.location.remote, &current).await?
                        != *expected
                    {
                        return Err(TARGET_CHANGED.into());
                    }
                } else {
                    ensure_current_directory(files, &self.location.remote).await?;
                    ensure_empty_directory(files, &self.location.remote).await?;
                }
                verify_local_missing(local_root, &self.relative).await?;
                check_remote(
                    &current,
                    &stat_remote(files, &self.location.remote).await?,
                    false,
                )?;
                remove_remote_item(files, &self.location.remote, directory).await
            }
            Snapshot::Local { metadata, sha256 } => {
                let path = self.location.local.clone();
                let before = metadata.clone();
                let expected = sha256.clone();
                let directory = expected.is_none();
                let current = tokio::task::spawn_blocking(move || {
                    ensure_local_parent(&path)?;
                    let current = stat_local(&path)?;
                    check_local(&before, &current, removed_child && directory)?;
                    if let Some(expected) = expected {
                        if hash_local(&path, current.len())? != expected {
                            return Err(TARGET_CHANGED.into());
                        }
                    }
                    Ok::<_, String>(current)
                })
                .await
                .map_err(|_| "로컬 삭제 대상을 다시 검증할 수 없습니다.")??;
                verify_remote_missing(files, remote_root, &self.relative).await?;
                let path = self.location.local.clone();
                tokio::task::spawn_blocking(move || {
                    ensure_local_parent(&path)?;
                    check_local(&current, &stat_local(&path)?, false)?;
                    let removed = if directory {
                        fs::remove_dir(path)
                    } else {
                        fs::remove_file(path)
                    };
                    removed.map_err(|error| format!("로컬 항목을 삭제할 수 없습니다. {error}"))
                })
                .await
                .map_err(|_| "로컬 삭제 결과를 확인할 수 없습니다.")?
            }
        }
    }
}

async fn verify_local_missing(root: &Path, path: &str) -> Result<()> {
    let mut current = root.to_path_buf();
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut segments = path.split('/').peekable();
        ensure_local_directory(&current)?;
        while let Some(segment) = segments.next() {
            current.push(segment);
            match fs::symlink_metadata(&current) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Ok(_) if segments.peek().is_none() => return Err(SOURCE_PRESENT.into()),
                Ok(_) => ensure_local_directory(&current)?,
                Err(_) => return Err("기준 로컬 경로가 비어 있는지 확인할 수 없습니다.".into()),
            }
        }
        Err(SOURCE_PRESENT.into())
    })
    .await
    .map_err(|_| "기준 로컬 경로를 확인할 수 없습니다.")?
}

async fn verify_remote_missing(
    files: &RawSftpSession,
    root: &SftpString,
    path: &str,
) -> Result<()> {
    let mut current = root.clone();
    let mut segments = path.split('/').peekable();
    ensure_current_directory(files, &current).await?;
    while let Some(segment) = segments.next() {
        current = current.join(segment.as_bytes());
        match request(files.lstat(current.clone())).await {
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                return Ok(())
            }
            Ok(_) if segments.peek().is_none() => return Err(SOURCE_PRESENT.into()),
            Ok(_) => ensure_current_directory(files, &current).await?,
            Err(error) => return Err(file_error(error)),
        }
    }
    Err(SOURCE_PRESENT.into())
}

async fn stat_remote(files: &RawSftpSession, path: &SftpString) -> Result<FileAttributes> {
    Ok(request(files.lstat(path.clone()))
        .await
        .map_err(file_error)?
        .attrs)
}

fn check_remote(
    before: &FileAttributes,
    current: &FileAttributes,
    ignore_directory_size_time: bool,
) -> Result<()> {
    if !same_permissions(before, current)
        || before.is_dir() != current.is_dir()
        || before.is_regular() != current.is_regular()
        || (!ignore_directory_size_time
            && (before.size != current.size || before.mtime != current.mtime))
    {
        return Err(TARGET_CHANGED.into());
    }
    Ok(())
}

fn stat_local(path: &Path) -> Result<fs::Metadata> {
    let current = fs::symlink_metadata(path).map_err(|_| TARGET_CHANGED)?;
    if local_link(&current) || !(current.is_file() || current.is_dir()) {
        return Err(TARGET_CHANGED.into());
    }
    Ok(current)
}

fn check_local(
    before: &fs::Metadata,
    current: &fs::Metadata,
    ignore_directory_size_time: bool,
) -> Result<()> {
    if before.is_dir() != current.is_dir()
        || before.permissions().readonly() != current.permissions().readonly()
        || before.created().ok() != current.created().ok()
        || (!ignore_directory_size_time
            && (before.len() != current.len() || before.modified().ok() != current.modified().ok()))
    {
        return Err(TARGET_CHANGED.into());
    }
    Ok(())
}

fn hash_local(path: &Path, size: u64) -> Result<String> {
    local_delete_sha256(
        path.to_str().ok_or("로컬 삭제 경로를 읽을 수 없습니다.")?,
        size,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletion_review_applies_only_to_its_roots_and_validity_window() {
        let local = PathBuf::from("local");
        let remote = SftpString::from("/remote");
        let mut review = PendingSyncDelete {
            token: "fixture-token".into(),
            local_root: local.clone(),
            remote_root: remote.clone(),
            expires: Instant::now() + LIFETIME,
            target: Side::Remote,
            items: Vec::new(),
        };
        assert!(matches!(
            review.validate("fixture-token", &local, &remote),
            Ok(Side::Remote)
        ));
        assert!(review.validate("other-token", &local, &remote).is_err());
        assert!(review
            .validate("fixture-token", Path::new("other-local"), &remote)
            .is_err());
        assert!(review
            .validate("fixture-token", &local, &SftpString::from("/other-remote"))
            .is_err());
        review.expires = Instant::now();
        assert!(review.validate("fixture-token", &local, &remote).is_err());
    }
}
