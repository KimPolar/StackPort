use super::{
    audit::FileOperation,
    file_error,
    mutation::{direct_child_name, ensure_current_directory},
    transfer::request,
    RemotePath, SftpEntrySource, SftpError, SftpManager, SftpMutationReport, BROWSE_TIMEOUT,
};
use crate::Result;
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, SftpString, StatusCode},
};
use serde::Serialize;
use std::time::{Duration, Instant};
use tokio::time::timeout;
use uuid::Uuid;

const PREVIEW_LIFETIME: Duration = Duration::from_secs(120);
const PREVIEW_EXPIRED: &str =
    "삭제 확인이 만료되었거나 이미 사용되었습니다. 목록에서 다시 선택하세요.";

#[derive(Serialize)]
pub struct SftpDeletePreview {
    token: String,
    path: String,
    directory: bool,
    bytes: Option<String>,
    production: bool,
    expires_seconds: u64,
}

pub(super) struct PendingDelete {
    token: String,
    parent: SftpString,
    path: SftpString,
    snapshot: FileAttributes,
    expires: Instant,
}

impl SftpManager {
    pub async fn preview_delete(
        &self,
        id: &str,
        parent: String,
        source: SftpEntrySource,
    ) -> Result<SftpDeletePreview> {
        let parent = RemotePath::Token(parent).into_path()?;
        let path = RemotePath::Token(source.location.clone()).into_path()?;
        direct_child_name(&parent, &path)?;
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        session
            .pending_delete
            .lock()
            .map_err(|_| PREVIEW_EXPIRED)?
            .take();
        let files = &session.files;
        ensure_current_directory(files, &parent).await?;
        let snapshot = request(files.lstat(path.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        source.check_snapshot(&snapshot)?;
        let directory = snapshot.is_dir();
        if directory {
            ensure_empty_directory(files, &path).await?;
        }
        let preview = SftpDeletePreview {
            token: Uuid::new_v4().to_string(),
            path: path.to_string_lossy().into_owned(),
            directory,
            bytes: snapshot
                .size
                .filter(|_| !directory)
                .map(|size| size.to_string()),
            production: session.profile.environment == "PROD",
            expires_seconds: PREVIEW_LIFETIME.as_secs(),
        };
        *session.pending_delete.lock().map_err(|_| PREVIEW_EXPIRED)? = Some(PendingDelete {
            token: preview.token.clone(),
            parent,
            path,
            snapshot,
            expires: Instant::now() + PREVIEW_LIFETIME,
        });
        Ok(preview)
    }

    pub fn discard_delete_preview(&self, id: &str, token: &str) {
        if let Ok(session) = self.session(id) {
            if let Ok(mut pending) = session.pending_delete.lock() {
                if pending.as_ref().is_some_and(|value| value.token == token) {
                    pending.take();
                }
            }
        }
    }

    pub async fn delete_entry(
        &self,
        id: &str,
        token: String,
        confirmation: String,
    ) -> Result<SftpMutationReport> {
        self.run_mutation(id, FileOperation::Delete, |session| async move {
            if session.profile.environment == "PROD" && confirmation != "PROD" {
                return Err("운영 환경에서 삭제하려면 PROD를 입력하세요.".into());
            }
            let pending = {
                let mut slot = session.pending_delete.lock().map_err(|_| PREVIEW_EXPIRED)?;
                if slot
                    .as_ref()
                    .is_none_or(|value| value.token != token || value.expires <= Instant::now())
                {
                    return Err(PREVIEW_EXPIRED.into());
                }
                slot.take().ok_or(PREVIEW_EXPIRED)?
            };
            let store = self.store.clone();
            let profile_id = session.profile.id.clone();
            let current = tokio::task::spawn_blocking(move || store.ssh_profile(&profile_id))
                .await
                .map_err(|_| "현재 SSH 연결 설정을 확인하지 못했습니다.")??;
            if current != session.profile {
                return Err(
                    "SSH 연결 설정이 변경되었습니다. 다시 연결한 뒤 삭제 대상을 확인하세요.".into(),
                );
            }
            delete_confirmed(&session.files, pending).await
        })
        .await
    }
}

async fn delete_confirmed(files: &RawSftpSession, pending: PendingDelete) -> Result<()> {
    ensure_current_directory(files, &pending.parent).await?;
    let current = request(files.lstat(pending.path.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    let before = pending.snapshot;
    if current.permissions != before.permissions
        || current.size != before.size
        || current.mtime != before.mtime
        || current.uid != before.uid
        || current.gid != before.gid
    {
        return Err(
            "삭제 확인 이후 원격 항목이 변경되었습니다. 목록을 새로고침하고 다시 선택하세요."
                .into(),
        );
    }
    let directory = before.is_dir();
    let result = if directory {
        request(files.rmdir(pending.path.clone())).await
    } else {
        request(files.remove(pending.path.clone())).await
    };
    match result {
        Ok(_) => Ok(()),
        Err(SftpError::Status(status)) => {
            if directory && status.status_code == StatusCode::Failure {
                ensure_empty_directory(files, &pending.path).await?;
            }
            Err(file_error(SftpError::Status(status)))
        }
        Err(_) => {
            Err("삭제 응답을 받지 못했습니다. 원격 목록을 새로고침해 결과를 확인하세요.".into())
        }
    }
}

async fn ensure_empty_directory(files: &RawSftpSession, path: &SftpString) -> Result<()> {
    let handle = request(files.opendir(path.clone()))
        .await
        .map_err(file_error)?
        .handle;
    let checked = timeout(BROWSE_TIMEOUT, async {
        loop {
            match request(files.readdir(handle.clone())).await {
                Ok(page) if page.files.is_empty() => return Ok(()),
                Ok(page)
                    if page
                        .files
                        .iter()
                        .any(|entry| !matches!(entry.filename.as_bytes(), b"." | b"..")) =>
                {
                    return Err("원격 폴더에 항목이 있습니다. 빈 폴더만 삭제할 수 있습니다.".into());
                }
                Ok(_) => {}
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                    return Ok(())
                }
                Err(error) => return Err(file_error(error)),
            }
        }
    })
    .await;
    let closed = request(files.close(handle)).await.map_err(file_error);
    checked.map_err(|_| "원격 폴더 안의 항목을 확인하는 시간이 초과되었습니다.")??;
    closed?;
    Ok(())
}
