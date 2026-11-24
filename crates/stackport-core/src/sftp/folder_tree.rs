//! Bounded, read-only traversal for comparing two folder hierarchies.

use super::{
    canonical_remote_path, list_local_directory, local_link, mutation::ensure_current_directory,
    read_local_directory, read_resolved_directory, BrowseDirectory, BrowseEntry, RemotePath,
    SftpManager, MAX_ITEMS,
};
use crate::Result;
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::Path,
    time::Duration,
};

const MAX_TREE_ENTRIES: usize = 4_000;
const MAX_TREE_FOLDERS: usize = 256;
const MAX_DEPTH: usize = 16;
const SCAN_TIME: Duration = Duration::from_secs(24);
const PARTIAL: &str = "목록 한도에 도달해 일부 항목만 확인했습니다.";
const LIMIT: &str = "폴더 또는 항목 수 한도에 도달했습니다.";
const TIMED_OUT: &str = "폴더 비교 시간이 초과되었습니다.";

#[derive(Serialize)]
pub struct FolderTree {
    path: String,
    folders: Vec<TreeFolder>,
}

#[derive(Serialize)]
struct TreeFolder {
    relative_path: String,
    entries: Vec<BrowseEntry>,
    issue: Option<String>,
}

struct Descendant {
    relative_path: String,
    location: String,
    depth: usize,
}

struct Scan {
    tree: FolderTree,
    queued: VecDeque<Descendant>,
    entries_read: usize,
    folders_started: usize,
}

impl Scan {
    fn new(root: BrowseDirectory) -> Self {
        let mut scan = Self {
            tree: FolderTree {
                path: root.path.clone(),
                folders: Vec::new(),
            },
            queued: VecDeque::new(),
            entries_read: 0,
            folders_started: 1,
        };
        scan.record(String::new(), 0, root);
        scan
    }

    fn capacity(&self) -> usize {
        if self.folders_started >= MAX_TREE_FOLDERS {
            return 0;
        }
        (MAX_TREE_ENTRIES - self.entries_read).min(MAX_ITEMS)
    }

    fn next(&mut self) -> Option<(Descendant, usize)> {
        let limit = self.capacity();
        if limit == 0 {
            return None;
        }
        let folder = self.queued.pop_front()?;
        self.folders_started += 1;
        Some((folder, limit))
    }

    fn record(&mut self, relative_path: String, depth: usize, directory: BrowseDirectory) {
        self.entries_read += directory.entries.len();
        let mut counts = HashMap::new();
        for entry in &directory.entries {
            *counts.entry(&entry.name).or_insert(0) += 1;
        }
        for entry in directory
            .entries
            .iter()
            .filter(|entry| entry.kind == "directory")
        {
            let child = if relative_path.is_empty() {
                entry.name.clone()
            } else {
                format!("{relative_path}/{}", entry.name)
            };
            let issue = if entry.name_is_lossy || counts[&entry.name] > 1 {
                Some("폴더 이름을 정확히 확인할 수 없습니다.")
            } else if depth >= MAX_DEPTH {
                Some("하위 폴더 깊이 한도에 도달했습니다.")
            } else if entry.location.is_none() {
                Some("폴더 경로를 확인할 수 없습니다.")
            } else {
                None
            };
            if let Some(issue) = issue {
                self.unread(child, issue.into());
            } else if let Some(location) = &entry.location {
                self.queued.push_back(Descendant {
                    relative_path: child,
                    location: location.clone(),
                    depth: depth + 1,
                });
            }
        }
        self.tree.folders.push(TreeFolder {
            relative_path,
            entries: directory.entries,
            issue: directory.truncated.then(|| PARTIAL.into()),
        });
    }

    fn unread(&mut self, relative_path: String, issue: String) {
        self.tree.folders.push(TreeFolder {
            relative_path,
            entries: Vec::new(),
            issue: Some(issue),
        });
    }

    fn finish(mut self, reason: &str) -> FolderTree {
        while let Some(descendant) = self.queued.pop_front() {
            self.unread(descendant.relative_path, reason.into());
        }
        self.tree
    }
}

pub fn list_local_tree(location: &str) -> Result<FolderTree> {
    let deadline = std::time::Instant::now() + SCAN_TIME;
    let mut scan = Scan::new(list_local_directory(location)?);
    while let Some((folder, limit)) = scan.next() {
        if std::time::Instant::now() >= deadline {
            scan.unread(folder.relative_path, TIMED_OUT.into());
            return Ok(scan.finish(TIMED_OUT));
        }
        let path = Path::new(&folder.location);
        let child = fs::symlink_metadata(path)
            .ok()
            .filter(|metadata| metadata.is_dir() && !local_link(metadata))
            .filter(|_| path.canonicalize().is_ok_and(|resolved| resolved == path));
        let result = match child {
            Some(_) => read_local_directory(path, limit),
            None => Err("로컬 폴더가 변경되었거나 링크 또는 접근 제한을 확인했습니다.".into()),
        };
        match result {
            Ok(directory) => scan.record(folder.relative_path, folder.depth, directory),
            Err(error) => scan.unread(folder.relative_path, error),
        }
    }
    Ok(scan.finish(LIMIT))
}

impl SftpManager {
    pub async fn list_tree(&self, id: &str, location: String) -> Result<FolderTree> {
        use tokio::time::{timeout_at, Instant};

        let deadline = Instant::now() + SCAN_TIME;
        let requested = RemotePath::Token(location).into_path()?;
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let files = &session.files;
        let root = timeout_at(deadline, async {
            let path = canonical_remote_path(files, requested.clone()).await?;
            if path != requested {
                return Err("원격 폴더 경로가 바뀌었습니다. 목록을 새로고침하세요.".into());
            }
            read_resolved_directory(files, path, MAX_ITEMS).await
        })
        .await;
        let root = match root {
            Ok(_) if session.ssh.is_closed() => {
                self.close(id).await?;
                return Err("SFTP 연결이 종료되었습니다. 다시 연결하세요.".into());
            }
            Ok(result) => result?,
            Err(_) => {
                self.close(id).await?;
                return Err("폴더 비교 시간이 초과되어 SFTP 연결을 닫았습니다.".into());
            }
        };
        let mut scan = Scan::new(root);
        while let Some((folder, limit)) = scan.next() {
            if Instant::now() >= deadline {
                scan.unread(folder.relative_path, TIMED_OUT.into());
                return Ok(scan.finish(TIMED_OUT));
            }
            let result = timeout_at(deadline, async {
                let path = RemotePath::Token(folder.location).into_path()?;
                ensure_current_directory(files, &path).await?;
                read_resolved_directory(files, path, limit).await
            })
            .await;
            match result {
                Ok(_) if session.ssh.is_closed() => {
                    self.close(id).await?;
                    let reason = "SFTP 연결이 종료되었습니다. 다시 연결하세요.";
                    scan.unread(folder.relative_path, reason.into());
                    return Ok(scan.finish(reason));
                }
                Ok(Ok(directory)) => scan.record(folder.relative_path, folder.depth, directory),
                Ok(Err(error)) => scan.unread(folder.relative_path, error),
                Err(_) => {
                    self.close(id).await?;
                    let reason = "폴더 비교 시간이 초과되어 SFTP 연결을 닫았습니다.";
                    scan.unread(folder.relative_path, reason.into());
                    return Ok(scan.finish(reason));
                }
            }
        }
        Ok(scan.finish(LIMIT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_nested_folders_and_reports_the_depth_boundary() {
        let root = tempfile::tempdir().unwrap();
        let mut directory = root.path().join("nested");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("sample.txt"), b"nested data").unwrap();
        let mut relative = "nested".to_owned();
        for _ in 0..MAX_DEPTH {
            directory.push("d");
            relative.push_str("/d");
            fs::create_dir(&directory).unwrap();
        }
        fs::write(directory.join("unseen.txt"), b"beyond scope").unwrap();
        let result = list_local_tree(root.path().to_str().unwrap()).unwrap();
        let nested = result
            .folders
            .iter()
            .find(|folder| folder.relative_path == "nested")
            .unwrap();
        assert!(nested
            .entries
            .iter()
            .any(|entry| entry.name == "sample.txt"));
        let boundary = result
            .folders
            .iter()
            .find(|folder| folder.relative_path == relative)
            .unwrap();
        assert!(boundary
            .issue
            .as_deref()
            .is_some_and(|issue| issue.contains("깊이 한도")));
        assert!(boundary.entries.is_empty());
    }

    #[test]
    fn marks_queued_folders_unread_when_the_total_budget_is_exhausted() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("queued")).unwrap();
        let mut scan = Scan::new(list_local_directory(root.path().to_str().unwrap()).unwrap());
        scan.entries_read = MAX_TREE_ENTRIES;
        assert_eq!(scan.capacity(), 0);
        let tree = scan.finish(LIMIT);
        let pending = tree
            .folders
            .iter()
            .find(|folder| folder.relative_path == "queued")
            .unwrap();
        assert_eq!(pending.issue.as_deref(), Some(LIMIT));
    }

    #[test]
    fn counts_failed_folders_against_the_folder_budget() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("a")).unwrap();
        fs::create_dir(root.path().join("b")).unwrap();
        let mut scan = Scan::new(list_local_directory(root.path().to_str().unwrap()).unwrap());
        scan.folders_started = MAX_TREE_FOLDERS - 1;
        let (first, _) = scan.next().unwrap();
        scan.unread(first.relative_path, "read failed".into());
        assert!(scan.next().is_none());
        let tree = scan.finish(LIMIT);
        assert!(tree
            .folders
            .iter()
            .any(|folder| folder.relative_path == "b" && folder.issue.as_deref() == Some(LIMIT)));
    }
}
