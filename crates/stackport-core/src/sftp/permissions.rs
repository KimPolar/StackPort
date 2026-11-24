//! Apply a single SFTP mode or ownership change to a reviewed entry.

use super::{
    audit::FileOperation,
    canonical_remote_path, file_error,
    mutation::{direct_child_name, ensure_current_directory},
    transfer::request,
    RemotePath, SftpEntrySource, SftpError, SftpManager, SftpMutationReport,
};
use crate::Result;
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, Packet, SftpString, StatusCode},
};
use serde::{Deserialize, Serialize};

pub(super) const LSETSTAT: &str = "lsetstat@openssh.com";
const UNIX_MODE_MASK: u32 = 0o7777;
const STALE: &str =
    "원격 권한이나 소유자가 목록을 읽은 뒤 변경되었습니다. 새로고침하고 다시 확인하세요.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SftpPermissionChange {
    parent: String,
    source: SftpEntrySource,
    expected: Permissions,
    change: Change,
    confirmation: String,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Permissions {
    mode: Option<u32>,
    uid: Option<u32>,
    gid: Option<u32>,
}

impl From<&FileAttributes> for Permissions {
    fn from(value: &FileAttributes) -> Self {
        Self {
            mode: value.permissions.map(|mode| mode & UNIX_MODE_MASK),
            uid: value.uid,
            gid: value.gid,
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Change {
    Mode { mode: u32 },
    Owner { uid: u32, gid: u32 },
}

impl Change {
    fn request(self, before: &Permissions) -> Result<FileAttributes> {
        let mut attrs = FileAttributes::empty();
        match self {
            Self::Mode { mode } => {
                if mode > UNIX_MODE_MASK {
                    return Err("권한은 0000~7777 사이의 8진수로 입력하세요.".into());
                }
                let current = before
                    .mode
                    .ok_or("서버가 현재 Unix 권한 값을 제공하지 않습니다.")?;
                if current == mode {
                    return Err("현재와 다른 권한을 입력하세요.".into());
                }
                attrs.permissions = Some(mode);
            }
            Self::Owner { uid, gid } => {
                if uid == u32::MAX || gid == u32::MAX {
                    return Err("UID와 GID는 0~4294967294 사이의 정수로 입력하세요.".into());
                }
                let old_uid = before
                    .uid
                    .ok_or("서버가 현재 UID와 GID를 모두 제공해야 합니다.")?;
                let old_gid = before
                    .gid
                    .ok_or("서버가 현재 UID와 GID를 모두 제공해야 합니다.")?;
                if (old_uid, old_gid) == (uid, gid) {
                    return Err("현재와 다른 UID 또는 GID를 입력하세요.".into());
                }
                attrs.uid = Some(uid);
                attrs.gid = Some(gid);
            }
        }
        Ok(attrs)
    }

    fn applied(self, before: &Permissions, after: &Permissions) -> bool {
        match self {
            Self::Mode { mode } => {
                after.mode == Some(mode) && after.uid == before.uid && after.gid == before.gid
            }
            Self::Owner { uid, gid } => after.uid == Some(uid) && after.gid == Some(gid),
        }
    }
}

impl SftpManager {
    pub async fn change_permissions(
        &self,
        id: &str,
        input: SftpPermissionChange,
    ) -> Result<SftpMutationReport> {
        let parent = RemotePath::Token(input.parent).into_path()?;
        let path = RemotePath::Token(input.source.location.clone()).into_path()?;
        direct_child_name(&parent, &path)?;
        let store = self.store.clone();
        let operation = match input.change {
            Change::Mode { .. } => FileOperation::Chmod,
            Change::Owner { .. } => FileOperation::Chown,
        };
        self.run_mutation(id, operation, |session| async move {
            if session.profile.environment == "PROD" && input.confirmation != "PROD" {
                return Err("운영 환경의 권한이나 소유자를 변경하려면 PROD를 입력하세요.".into());
            }
            let profile_id = session.profile.id.clone();
            let current_profile = tokio::task::spawn_blocking(move || store.ssh_profile(&profile_id))
                .await.map_err(|_| "현재 SSH 연결 설정을 확인할 수 없습니다.")??;
            if current_profile != session.profile {
                return Err("SSH 연결 설정이 변경되었습니다. 다시 연결한 뒤 변경 대상을 확인하세요.".into());
            }
            let files = &session.files;
            ensure_current_directory(files, &parent).await?;
            if !session.lsetstat_supported && canonical_remote_path(files, path.clone()).await? != path {
                return Err("원격 항목의 실제 경로가 바뀌었습니다. 새로고침하고 다시 확인하세요.".into());
            }
            let current = request(files.lstat(path.clone())).await.map_err(file_error)?.attrs;
            input.source.check_snapshot(&current)?;
            let before = Permissions::from(&current);
            if before != input.expected {
                return Err(STALE.into());
            }
            let attrs = input.change.request(&before)?;
            set_attributes(files, &path, attrs, session.lsetstat_supported).await?;
            let after = request(files.lstat(path)).await
                .map_err(|_| "서버가 변경을 응답했지만 권한을 다시 읽을 수 없습니다. 목록을 새로고침하세요.")?.attrs;
            if input.source.check_snapshot(&after).is_err() || !input.change.applied(&before, &Permissions::from(&after)) {
                return Err("서버 응답에서 요청한 변경을 확인할 수 없습니다. 목록을 새로고침해 현재 값을 확인하세요.".into());
            }
            Ok(())
        }).await
    }
}

async fn set_attributes(
    files: &RawSftpSession,
    path: &SftpString,
    attrs: FileAttributes,
    no_follow: bool,
) -> Result<()> {
    let result = if no_follow {
        #[derive(Serialize)]
        struct PathAttributes<'a> {
            path: &'a SftpString,
            attrs: &'a FileAttributes,
        }
        let encoded = russh_sftp::ser::to_bytes(&PathAttributes {
            path,
            attrs: &attrs,
        })
        .map_err(|_| "서버에 보낼 권한 변경 요청을 만들 수 없습니다.")?;
        match request(files.extended(LSETSTAT, encoded.to_vec())).await {
            Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok => Ok(()),
            Ok(Packet::Status(status)) => Err(SftpError::Status(status)),
            Ok(_) => Err(SftpError::UnexpectedPacket),
            Err(error) => Err(error),
        }
    } else {
        request(files.setstat(path.clone(), attrs))
            .await
            .map(|_| ())
    };
    result.map_err(|error| match &error {
        SftpError::Status(status) if status.status_code == StatusCode::PermissionDenied =>
            "서버가 권한 또는 소유자 변경을 거부했습니다. 원격 계정의 권한을 확인하세요.".into(),
        SftpError::Status(status) if status.status_code == StatusCode::OpUnsupported =>
            "이 서버는 요청한 권한 또는 소유자 변경을 지원하지 않습니다.".into(),
        SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile => file_error(error),
        SftpError::Status(_) =>
            "서버가 권한 또는 소유자 변경 요청을 완료하지 못했습니다. 목록을 새로고침해 현재 값을 확인하세요.".into(),
        _ => "권한 변경 결과를 받지 못했습니다. 목록을 새로고침해 현재 값을 확인하세요.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_and_ownership_use_separate_sftp_attribute_fields() {
        let before = Permissions {
            mode: Some(0o640),
            uid: Some(42),
            gid: Some(9),
        };
        let mode = Change::Mode { mode: 0o2750 }.request(&before).unwrap();
        assert_eq!(
            (mode.permissions, mode.uid, mode.gid),
            (Some(0o2750), None, None)
        );
        let owner = Change::Owner { uid: 42, gid: 12 }.request(&before).unwrap();
        assert_eq!(
            (owner.permissions, owner.uid, owner.gid),
            (None, Some(42), Some(12))
        );
        assert!(Change::Mode { mode: 0o10000 }.request(&before).is_err());
        assert!(Change::Owner {
            uid: u32::MAX,
            gid: 12
        }
        .request(&before)
        .is_err());
        assert!(Change::Owner { uid: 42, gid: 9 }.request(&before).is_err());
        let missing_gid = Permissions {
            gid: None,
            ..before
        };
        assert!(Change::Owner { uid: 42, gid: 12 }
            .request(&missing_gid)
            .is_err());
    }
}
