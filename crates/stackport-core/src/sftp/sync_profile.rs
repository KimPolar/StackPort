//! Reusable inputs for a fresh manual synchronization preview.

use super::{RemotePath, SftpManager};
use crate::{db_error, require_changed, ssh_profiles::verify_saved, Result, SshProfile, Store};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub(crate) const SCHEMA: &str = "CREATE TABLE sftp_sync_profiles (
    id TEXT PRIMARY KEY,
    ssh_profile_id TEXT NOT NULL REFERENCES ssh_profiles(id) ON DELETE CASCADE,
    ssh_revision INTEGER NOT NULL CHECK(ssh_revision > 0),
    name TEXT NOT NULL COLLATE NOCASE,
    local_root TEXT NOT NULL,
    remote_root TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('upload', 'download', 'both')),
    recursive INTEGER NOT NULL CHECK(recursive IN (0, 1)),
    mirror_deletes INTEGER NOT NULL CHECK(mirror_deletes IN (0, 1) AND (direction <> 'both' OR mirror_deletes = 0)),
    pattern_text TEXT NOT NULL,
    UNIQUE(ssh_profile_id, name)
);";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Options {
    direction: String,
    recursive: bool,
    mirror_deletes: bool,
    pattern_text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncProfileInput {
    name: String,
    local_root: String,
    remote_root: String,
    options: Options,
}

#[derive(Serialize)]
pub struct SavedSyncProfile {
    id: String,
    name: String,
    local_root: String,
    remote_root: String,
    remote_path: String,
    options: Options,
    available: bool,
}

impl SftpManager {
    pub async fn saved_sync_profiles(&self, id: &str) -> Result<Vec<SavedSyncProfile>> {
        self.sync_profile_worker(id, false, list_profiles).await
    }

    pub async fn save_sync_profile(&self, id: &str, input: SyncProfileInput) -> Result<()> {
        self.sync_profile_worker(id, true, move |db, profile| {
            save_profile(db, profile, input)
        })
        .await
    }

    pub async fn remove_sync_profile(&self, id: &str, profile_id: String) -> Result<()> {
        self.sync_profile_worker(id, true, move |db, profile| {
            remove_profile(db, profile, &profile_id)
        })
        .await
    }

    async fn sync_profile_worker<T: Send + 'static>(
        &self,
        id: &str,
        write: bool,
        operation: impl FnOnce(&Connection, &SshProfile) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let profile = self.session(id)?.profile.clone();
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || with_profile(&store, &profile, write, operation))
            .await
            .map_err(|_| "동기화 프로필 작업을 마치지 못했습니다.")?
    }
}

fn with_profile<T>(
    store: &Store,
    profile: &SshProfile,
    write: bool,
    operation: impl FnOnce(&Connection, &SshProfile) -> Result<T>,
) -> Result<T> {
    let mut db = store.connect()?;
    let transaction = if write {
        TransactionBehavior::Immediate
    } else {
        TransactionBehavior::Deferred
    };
    let tx = db
        .transaction_with_behavior(transaction)
        .map_err(db_error)?;
    verify_saved(&tx, profile).map_err(|_| "SSH 연결 설정이 바뀌었습니다. 다시 연결하세요.")?;
    let value = operation(&tx, profile)?;
    tx.commit().map_err(db_error)?;
    Ok(value)
}

fn list_profiles(db: &Connection, profile: &SshProfile) -> Result<Vec<SavedSyncProfile>> {
    let mut statement = db.prepare(
        "SELECT id, name, local_root, remote_root, direction, recursive, mirror_deletes, pattern_text, ssh_revision = ?2
         FROM sftp_sync_profiles WHERE ssh_profile_id = ?1 ORDER BY name, id",
    ).map_err(db_error)?;
    let rows = statement
        .query_map(params![profile.id, profile.revision], |row| {
            Ok(SavedSyncProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                local_root: row.get(2)?,
                remote_root: row.get(3)?,
                remote_path: String::new(),
                options: Options {
                    direction: row.get(4)?,
                    recursive: row.get(5)?,
                    mirror_deletes: row.get(6)?,
                    pattern_text: row.get(7)?,
                },
                available: row.get(8)?,
            })
        })
        .map_err(db_error)?;
    rows.map(|row| {
        let mut item = row.map_err(db_error)?;
        item.remote_path = RemotePath::Token(item.remote_root.clone())
            .into_path()?
            .to_string_lossy()
            .into_owned();
        Ok(item)
    })
    .collect()
}

fn save_profile(db: &Connection, profile: &SshProfile, input: SyncProfileInput) -> Result<()> {
    let name = crate::valid_name(&input.name)?;
    if name.encode_utf16().count() > 80 || name.chars().any(char::is_control) {
        return Err("동기화 프로필 이름은 80자 이하로 입력하세요.".into());
    }
    if !Path::new(&input.local_root).is_absolute()
        || input.local_root.contains('\0')
        || input.local_root.len() > 32_768
    {
        return Err("올바른 로컬 폴더의 절대 경로를 선택하세요.".into());
    }
    let remote = RemotePath::Token(input.remote_root.clone()).into_path()?;
    let bytes = remote.as_bytes();
    if !bytes.starts_with(b"/")
        && !(bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":/")
    {
        return Err("올바른 원격 폴더의 절대 경로를 선택하세요.".into());
    }
    let options = input.options;
    if !matches!(options.direction.as_str(), "upload" | "download" | "both")
        || (options.direction == "both" && options.mirror_deletes)
    {
        return Err("동기화 방향과 삭제 옵션을 확인하세요.".into());
    }
    let patterns = clean_patterns(&options.pattern_text)?;
    let changed = db.execute(
        "INSERT INTO sftp_sync_profiles(id, ssh_profile_id, ssh_revision, name, local_root, remote_root, direction, recursive, mirror_deletes, pattern_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(ssh_profile_id, name) DO NOTHING",
        params![Uuid::new_v4().to_string(), profile.id, profile.revision, name, input.local_root, input.remote_root,
            options.direction, options.recursive, options.mirror_deletes, patterns],
    ).map_err(db_error)?;
    require_changed(
        changed,
        "이 SSH 연결에 같은 이름의 동기화 프로필이 있습니다.",
    )
}

fn clean_patterns(input: &str) -> Result<String> {
    if input.len() > 18_000 {
        return Err("제외 패턴이 너무 깁니다.".into());
    }
    let lines: Vec<_> = input
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() > 24
        || lines.iter().any(|line| {
            let bytes = line.as_bytes();
            line.encode_utf16().count() > 180
                || line.contains('\\')
                || line.chars().any(char::is_control)
                || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":/")
                || line.split('/').any(|part| {
                    matches!(part, "" | "." | "..") || (part != "**" && part.contains("**"))
                })
        })
    {
        return Err("제외 패턴은 줄마다 180자 이하의 상대 경로로 최대 24개 입력하세요.".into());
    }
    Ok(lines.join("\n"))
}

fn remove_profile(db: &Connection, profile: &SshProfile, id: &str) -> Result<()> {
    let changed = db
        .execute(
            "DELETE FROM sftp_sync_profiles WHERE id = ?1 AND ssh_profile_id = ?2",
            params![id, profile.id],
        )
        .map_err(db_error)?;
    require_changed(changed, "동기화 프로필을 찾을 수 없습니다.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{sftp::token, SshProfileInput};

    fn connection(name: &str) -> SshProfileInput {
        SshProfileInput {
            name: name.into(),
            host: "localhost".into(),
            port: 22,
            username: "fixture".into(),
            environment: "DEV".into(),
        }
    }

    #[test]
    fn profiles_round_trip_and_stay_bound_to_the_saved_connection_revision() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspace.sqlite");
        let store = Store::open(&path).unwrap();
        let project = store.create_project("fixture").unwrap();
        let ssh = store
            .create_ssh_profile(&project.id, connection("first"))
            .unwrap();
        let other = store
            .create_ssh_profile(&project.id, connection("other"))
            .unwrap();
        let remote_root = token(b"/fixture/\xff");
        let input = |name: &str, direction: &str| SyncProfileInput {
            name: name.into(),
            local_root: root.path().to_str().unwrap().into(),
            remote_root: remote_root.clone(),
            options: Options {
                direction: direction.into(),
                recursive: true,
                mirror_deletes: true,
                pattern_text: " *.tmp \r\n\r\ncache/**".into(),
            },
        };
        with_profile(&store, &ssh, true, |db, ssh| {
            save_profile(db, ssh, input("Daily", "download"))
        })
        .unwrap();
        assert!(with_profile(&store, &ssh, true, |db, ssh| save_profile(
            db,
            ssh,
            input("daily", "download")
        ))
        .is_err());
        assert!(with_profile(&store, &ssh, true, |db, ssh| save_profile(
            db,
            ssh,
            input("Invalid", "both")
        ))
        .is_err());
        let reopened = Store::open(&path).unwrap();
        let profiles = with_profile(&reopened, &ssh, false, list_profiles).unwrap();
        let [saved] = profiles.as_slice() else {
            panic!("expected one saved profile")
        };
        assert!(saved.available);
        assert_eq!(saved.name, "Daily");
        assert_eq!(saved.remote_root, remote_root);
        assert_eq!(saved.remote_path, "/fixture/�");
        assert_eq!(saved.options.direction, "download");
        assert_eq!(saved.options.pattern_text, "*.tmp\ncache/**");
        assert!(saved.options.recursive && saved.options.mirror_deletes);
        assert!(with_profile(&reopened, &other, false, list_profiles)
            .unwrap()
            .is_empty());
        assert!(
            with_profile(&reopened, &other, true, |db, ssh| remove_profile(
                db, ssh, &saved.id
            ))
            .is_err()
        );

        let updated = reopened
            .update_ssh_profile(&ssh.id, ssh.revision, connection("renamed"))
            .unwrap();
        assert!(with_profile(&reopened, &ssh, false, list_profiles).is_err());
        let profiles = with_profile(&reopened, &updated, false, list_profiles).unwrap();
        assert!(!profiles[0].available);
        with_profile(&reopened, &updated, true, |db, ssh| {
            remove_profile(db, ssh, &saved.id)
        })
        .unwrap();
        assert!(with_profile(&reopened, &updated, false, list_profiles)
            .unwrap()
            .is_empty());
    }
}
