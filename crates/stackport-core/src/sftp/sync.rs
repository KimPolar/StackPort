//! Apply additions and verified file replacements in a confirmed folder synchronization plan.

use super::{
    audit::{FileAudit, FileOperation},
    download::download_file,
    local_link,
    mutation::{create_folder, ensure_current_directory, new_child_path},
    upload::upload_file,
    FilesSession, RemotePath, SftpManager, SftpTransferOutcome, MAX_REMOTE_PATH,
};
use crate::{local_file::valid_filename, Result};
use russh_sftp::protocol::SftpString;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const MAX_ITEMS_PER_SYNC: usize = 8_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncPlan {
    local_root: String,
    remote_root: String,
    confirmation: String,
    #[serde(default)]
    deletion_confirmation: String,
    delete_token: Option<String>,
    items: Vec<PlanItem>,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(super) enum Side {
    Local,
    Remote,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Kind {
    File,
    Directory,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanItem {
    path: String,
    target: Side,
    kind: Kind,
    size: Option<String>,
    modified: Option<u64>,
    replacement: Option<super::sync_replace::ReplacementInput>,
}

#[derive(Clone, Copy)]
pub(super) struct CopySnapshot {
    pub(super) size: u64,
    pub(super) modified: Option<u64>,
}

#[derive(Clone, Copy)]
pub(super) struct SyncCopy {
    pub(super) source: CopySnapshot,
    pub(super) replacement: Option<super::sync_replace::Replacement>,
}

impl CopySnapshot {
    pub(super) fn check(self, size: u64, modified: Option<u64>) -> Result<()> {
        if size != self.size || self.modified.is_some_and(|time| Some(time) != modified) {
            return Err("비교 후 원본의 크기 또는 수정 시각이 바뀌었습니다.".into());
        }
        Ok(())
    }
}

struct ResolvedItem {
    relative: String,
    target: Side,
    local: PathBuf,
    remote_parent: SftpString,
    remote: SftpString,
    copy: Option<SyncCopy>,
}

#[derive(Serialize)]
pub struct SyncProgress {
    pub(super) completed: usize,
    pub(super) total: usize,
    pub(super) path: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ItemOutcome {
    Applied {
        bytes: Option<String>,
        sha256: Option<String>,
        warning: Option<String>,
    },
    Failed {
        reason: String,
    },
    Skipped {
        reason: &'static str,
    },
}

#[derive(Serialize)]
struct ItemReport {
    path: String,
    target: Side,
    deletion: bool,
    #[serde(flatten)]
    outcome: ItemOutcome,
}

#[derive(Serialize)]
pub struct SyncReport {
    items: Vec<ItemReport>,
    audit_warning: Option<&'static str>,
    stopped: bool,
}

pub(super) struct SyncRun {
    id: Uuid,
    stop: bool,
}

struct SyncRunGuard<'a>(&'a Mutex<Option<SyncRun>>);

impl<'a> SyncRunGuard<'a> {
    fn start(slot: &'a Mutex<Option<SyncRun>>, id: Uuid) -> Result<Self> {
        let mut active = slot.lock().map_err(|_| "동기화 상태를 열 수 없습니다.")?;
        if active.is_some() {
            return Err("다른 동기화가 진행 중입니다.".into());
        }
        *active = Some(SyncRun { id, stop: false });
        Ok(Self(slot))
    }

    fn stopped(&self) -> bool {
        self.0
            .lock()
            .map_or(true, |active| active.as_ref().is_none_or(|run| run.stop))
    }
}

impl Drop for SyncRunGuard<'_> {
    fn drop(&mut self) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    }
}

pub(super) fn ensure_local_parent(path: &Path) -> Result<()> {
    ensure_local_directory(
        path.parent()
            .ok_or("로컬 상위 폴더를 확인할 수 없습니다.")?,
    )
}

pub(super) fn ensure_local_directory(path: &Path) -> Result<()> {
    if !path.is_absolute() || (cfg!(windows) && path.to_string_lossy().starts_with(r"\\.\")) {
        return Err("로컬 폴더의 절대 경로를 확인하세요.".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "로컬 폴더를 열 수 없습니다.")?;
    if local_link(&metadata)
        || !metadata.is_dir()
        || !path.canonicalize().is_ok_and(|current| current == path)
    {
        return Err("로컬 폴더 경로가 바뀌었거나 링크입니다. 다시 비교하세요.".into());
    }
    Ok(())
}

pub(super) fn resolve_item_paths(
    local_root: &Path,
    remote_root: &SftpString,
    relative: &str,
    creating_remote: bool,
) -> Result<(PathBuf, SftpString, SftpString)> {
    let mut local = local_root.to_path_buf();
    let mut remote = remote_root.clone();
    let mut remote_parent = remote_root.clone();
    for segment in relative.split('/') {
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || segment.contains(['\\', ':', '\0'])
            || !valid_filename(segment)
        {
            return Err("동기화 계획의 상대 경로를 확인하세요.".into());
        }
        local.push(segment);
        remote_parent = remote;
        remote = if creating_remote {
            new_child_path(&remote_parent, segment)?
        } else {
            remote_parent.join(segment.as_bytes())
        };
        if remote.len() > MAX_REMOTE_PATH {
            return Err("동기화 계획의 원격 경로가 너무 깁니다.".into());
        }
    }
    Ok((local, remote_parent, remote))
}

fn resolve_items(input: SyncPlan, remote_root: &SftpString) -> Result<Vec<ResolvedItem>> {
    if input.items.len() > MAX_ITEMS_PER_SYNC {
        return Err("실행할 동기화 항목 수를 확인하세요.".into());
    }
    let local_root = Path::new(&input.local_root);
    let mut unique = HashSet::new();
    let mut additions = Vec::with_capacity(input.items.len());
    for addition in input.items {
        let name = if cfg!(windows) {
            addition.path.to_uppercase()
        } else {
            addition.path.clone()
        };
        if !unique.insert(name) {
            return Err("동기화 계획에 중복된 경로가 있습니다. 다시 비교하세요.".into());
        }
        let (local, remote_parent, remote) = resolve_item_paths(
            local_root,
            remote_root,
            &addition.path,
            addition.target == Side::Remote,
        )?;
        let copy = match addition.kind {
            Kind::Directory if addition.replacement.is_some() => {
                return Err("폴더는 파일 갱신 대상으로 지정할 수 없습니다.".into())
            }
            Kind::Directory => None,
            Kind::File => Some(SyncCopy {
                source: CopySnapshot {
                    size: addition
                        .size
                        .and_then(|value| value.parse().ok())
                        .ok_or("비교한 원본 파일의 크기를 확인하세요.")?,
                    modified: addition.modified,
                },
                replacement: addition.replacement.map(TryInto::try_into).transpose()?,
            }),
        };
        additions.push(ResolvedItem {
            relative: addition.path,
            target: addition.target,
            local,
            remote_parent,
            remote,
            copy,
        });
    }
    // A directory must be created before any of its children.
    additions.sort_by_key(|item| (item.copy.is_some(), item.relative.matches('/').count()));
    Ok(additions)
}

impl SftpManager {
    pub fn stop_sync(&self, id: &str, run_id: Uuid) -> bool {
        let Ok(session) = self.session(id) else {
            return false;
        };
        let Ok(mut active) = session.active_sync.lock() else {
            return false;
        };
        let Some(run) = active.as_mut().filter(|run| run.id == run_id) else {
            return false;
        };
        run.stop = true;
        true
    }

    pub async fn apply_sync_plan(
        &self,
        id: &str,
        run_id: Uuid,
        input: SyncPlan,
        progress: impl Fn(SyncProgress),
    ) -> Result<SyncReport> {
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let remote_root = RemotePath::Token(input.remote_root.clone()).into_path()?;
        let local_root = PathBuf::from(&input.local_root);
        let delete_token = input.delete_token.clone();
        let delete_target = if let Some(token) = &delete_token {
            if input.deletion_confirmation != "삭제" {
                return Err("동기화에서 항목을 영구 삭제하려면 삭제를 입력하세요.".into());
            }
            let slot = session
                .pending_sync_delete
                .lock()
                .map_err(|_| "삭제 확인을 열 수 없습니다.")?;
            let plan = slot.as_ref().ok_or("동기화 삭제 후보를 다시 검증하세요.")?;
            let target = plan.validate(token, &local_root, &remote_root)?;
            if input.items.iter().any(|item| item.target != target) {
                return Err("삭제는 같은 방향의 단방향 동기화에서만 반영할 수 있습니다.".into());
            }
            Some(target)
        } else {
            None
        };
        if session.is_production()
            && (delete_target == Some(Side::Remote)
                || input.items.iter().any(|item| item.target == Side::Remote))
            && input.confirmation != "PROD"
        {
            return Err("운영 연결에 저장하려면 PROD를 입력하세요.".into());
        }
        if delete_target.is_some() {
            session.verify_profile(&self.store, "SSH 연결 설정이 변경되었습니다. 다시 연결한 뒤 삭제 대상을 확인하세요.").await?;
        }
        let additions = resolve_items(input, &remote_root)?;
        let local = local_root.clone();
        tokio::task::spawn_blocking(move || ensure_local_directory(&local))
            .await
            .map_err(|_| "로컬 폴더를 확인할 수 없습니다.")??;
        ensure_current_directory(&session.files, &remote_root).await?;
        let deletions = if let Some(token) = delete_token {
            let mut slot = session
                .pending_sync_delete
                .lock()
                .map_err(|_| "삭제 확인을 열 수 없습니다.")?;
            slot.as_ref()
                .ok_or("동기화 삭제 후보를 다시 검증하세요.")?
                .validate(&token, &local_root, &remote_root)?;
            slot.take()
                .ok_or("동기화 삭제 후보를 다시 검증하세요.")?
                .into_items()
        } else {
            Vec::new()
        };
        let total = additions.len() + deletions.len();
        if total == 0 || total > MAX_ITEMS_PER_SYNC {
            return Err("실행할 동기화 항목 수를 확인하세요.".into());
        }
        if !deletions.is_empty() {
            let mut paths = HashSet::new();
            for path in additions
                .iter()
                .map(|item| item.relative.as_str())
                .chain(deletions.iter().map(|item| item.relative.as_str()))
            {
                let key = if cfg!(windows) {
                    path.to_uppercase()
                } else {
                    path.to_owned()
                };
                if !paths.insert(key) {
                    return Err("동기화 계획에 중복된 경로가 있습니다. 다시 비교하세요.".into());
                }
            }
        }
        let run = SyncRunGuard::start(&session.active_sync, run_id)?;
        let correlation = Uuid::new_v4().to_string();
        let audit = FileAudit::start(
            &self.store,
            session.profile.as_ref(),
            &correlation,
            if delete_target.is_some() {
                FileOperation::SynchronizeDelete
            } else {
                FileOperation::Synchronize
            },
        )
        .await?;

        progress(SyncProgress {
            completed: 0,
            total,
            path: String::new(),
        });
        let mut prepared_deletions = Vec::with_capacity(deletions.len());
        for item in deletions {
            let checked = if run.stopped() {
                Ok(())
            } else {
                item.verify_directory(&session.files).await
            };
            prepared_deletions.push((item, checked));
        }
        let mut items = Vec::with_capacity(total);
        let mut failed_folders = HashSet::new();
        let mut applied = 0;
        let mut stopped = false;
        for item in additions {
            progress(SyncProgress {
                completed: items.len(),
                total,
                path: item.relative.clone(),
            });
            let outcome = if run.stopped() {
                stopped = true;
                ItemOutcome::Skipped {
                    reason: "남은 동기화 작업을 중단했습니다.",
                }
            } else if session.ssh.is_closed() {
                ItemOutcome::Skipped {
                    reason: "SFTP 연결이 종료되었습니다.",
                }
            } else if failed_ancestor(&failed_folders, item.target, &item.relative) {
                ItemOutcome::Skipped {
                    reason: "상위 폴더를 만들지 못했습니다.",
                }
            } else {
                match apply_item(&session, &item).await {
                    Ok(outcome) => {
                        applied += 1;
                        outcome
                    }
                    Err(reason) => ItemOutcome::Failed { reason },
                }
            };
            if item.copy.is_none() && !matches!(outcome, ItemOutcome::Applied { .. }) {
                failed_folders.insert((item.target, item.relative.clone()));
            }
            items.push(ItemReport {
                path: item.relative,
                target: item.target,
                deletion: false,
                outcome,
            });
        }
        let mut changed_parents = HashSet::new();
        for (item, checked) in prepared_deletions {
            progress(SyncProgress {
                completed: items.len(),
                total,
                path: item.relative.clone(),
            });
            let outcome = if run.stopped() {
                stopped = true;
                ItemOutcome::Skipped {
                    reason: "남은 동기화 작업을 중단했습니다.",
                }
            } else {
                match checked {
                    Ok(()) if session.ssh.is_closed() => ItemOutcome::Skipped {
                        reason: "SFTP 연결이 종료되었습니다.",
                    },
                    Ok(()) => match item
                        .apply(
                            &session.files,
                            &local_root,
                            &remote_root,
                            changed_parents.contains(&item.relative),
                        )
                        .await
                    {
                        Ok(()) => {
                            applied += 1;
                            if let Some((parent, _)) = item.relative.rsplit_once('/') {
                                changed_parents.insert(parent.to_owned());
                            }
                            ItemOutcome::Applied {
                                bytes: None,
                                sha256: None,
                                warning: None,
                            }
                        }
                        Err(reason) => ItemOutcome::Failed { reason },
                    },
                    Err(reason) => ItemOutcome::Failed { reason },
                }
            };
            items.push(ItemReport {
                target: item.target(),
                path: item.relative,
                deletion: true,
                outcome,
            });
        }
        drop(run);
        let successful = applied == total
            || (stopped
                && !items
                    .iter()
                    .any(|item| matches!(item.outcome, ItemOutcome::Failed { .. })));
        let audit_warning = audit.finish_sync(successful, applied, stopped).await;
        Ok(SyncReport {
            items,
            audit_warning,
            stopped,
        })
    }
}

fn failed_ancestor(failed: &HashSet<(Side, String)>, target: Side, relative: &str) -> bool {
    let mut parent = relative;
    while let Some((next, _)) = parent.rsplit_once('/') {
        if failed.contains(&(target, next.to_owned())) {
            return true;
        }
        parent = next;
    }
    false
}

async fn apply_item(session: &FilesSession, item: &ResolvedItem) -> Result<ItemOutcome> {
    let files = &session.files;
    match (item.target, item.copy) {
        (Side::Remote, None) => {
            let local = item.local.clone();
            tokio::task::spawn_blocking(move || ensure_local_directory(&local))
                .await
                .map_err(|_| "로컬 원본 폴더를 확인할 수 없습니다.")??;
            ensure_current_directory(files, &item.remote_parent).await?;
            create_folder(files, item.remote_parent.clone(), item.remote.clone()).await?;
        }
        (Side::Local, None) => {
            ensure_current_directory(files, &item.remote).await?;
            let local = item.local.clone();
            tokio::task::spawn_blocking(move || {
                ensure_local_parent(&local)?;
                fs::create_dir(local)
                    .map_err(|error| format!("새 로컬 폴더를 만들 수 없습니다. {error}"))
            })
            .await
            .map_err(|_| "로컬 폴더 생성 작업을 확인할 수 없습니다.")??;
        }
        (target, Some(copy)) => {
            let local = item
                .local
                .to_str()
                .ok_or("로컬 파일 경로를 읽을 수 없습니다.")?
                .to_owned();
            let active = session.register_transfer()?;
            let transfer = &active.transfer;
            let outcome = match target {
                Side::Remote => {
                    upload_file(
                        session,
                        local,
                        item.remote_parent.clone(),
                        item.remote.clone(),
                        transfer,
                        |_| {},
                        Some(copy),
                    )
                    .await?
                }
                Side::Local => {
                    ensure_current_directory(files, &item.remote_parent).await?;
                    download_file(
                        files,
                        item.remote.clone(),
                        local,
                        transfer,
                        |_, _| {},
                        Some(copy),
                    )
                    .await?
                }
            };
            return match outcome {
                SftpTransferOutcome::Saved {
                    bytes,
                    sha256,
                    warning,
                } => Ok(ItemOutcome::Applied {
                    bytes: Some(bytes),
                    sha256: Some(sha256),
                    warning,
                }),
                SftpTransferOutcome::Cancelled { cleanup_warning } => {
                    Err(cleanup_warning.unwrap_or_else(|| "파일 복사가 중단되었습니다.".into()))
                }
            };
        }
    }
    Ok(ItemOutcome::Applied {
        bytes: None,
        sha256: None,
        warning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(paths: &[&str]) -> SyncPlan {
        SyncPlan {
            local_root: std::env::current_dir().unwrap().to_str().unwrap().into(),
            remote_root: String::new(),
            confirmation: String::new(),
            deletion_confirmation: String::new(),
            delete_token: None,
            items: paths
                .iter()
                .map(|path| PlanItem {
                    path: (*path).into(),
                    target: Side::Remote,
                    kind: Kind::Directory,
                    size: None,
                    modified: None,
                    replacement: None,
                })
                .collect(),
        }
    }

    #[test]
    fn resolves_only_unique_relative_paths_and_orders_parents_first() {
        let root = SftpString::from("/root");
        let valid = resolve_items(input(&["a/b", "a"]), &root).unwrap();
        assert_eq!(valid[0].relative, "a");
        assert_eq!(valid[1].remote.as_bytes(), b"/root/a/b");
        for invalid in [
            &["a", "a"][..],
            &["a/../b"],
            &["/a"],
            &["a//b"],
            &["D:/outside"],
            &["a\\b"],
        ] {
            assert!(resolve_items(input(invalid), &root).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn failed_directories_block_only_their_target_descendants() {
        let failed = HashSet::from([(Side::Remote, "parent".into())]);
        assert!(failed_ancestor(&failed, Side::Remote, "parent/child/a"));
        assert!(!failed_ancestor(&failed, Side::Local, "parent/child/a"));
        assert!(!failed_ancestor(&failed, Side::Remote, "parentb/child/a"));
    }
}
