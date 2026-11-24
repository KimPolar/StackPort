use super::{
    audit::{FileAudit, FileOperation},
    file_error,
    transfer::request,
    RemotePath, SftpError, SftpManager, MAX_REMOTE_PATH,
};
use crate::Result;
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, SftpString, StatusCode},
};
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize)]
pub struct SftpFolderCreated {
    audit_warning: Option<&'static str>,
}

impl SftpManager {
    pub async fn create_folder(
        &self,
        id: &str,
        parent: String,
        name: String,
    ) -> Result<SftpFolderCreated> {
        let parent = RemotePath::Token(parent).into_path()?;
        let path = new_child_path(&parent, &name)?;
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let correlation_id = Uuid::new_v4().to_string();
        let audit = FileAudit::start(
            &self.store,
            &session.profile,
            &correlation_id,
            FileOperation::CreateFolder,
        )
        .await?;
        let result = create_folder(&session.files, parent, path).await;
        let ((), audit_warning) = audit.finish(result, false).await?;
        Ok(SftpFolderCreated { audit_warning })
    }
}

async fn create_folder(files: &RawSftpSession, parent: SftpString, path: SftpString) -> Result<()> {
    ensure_directory(files, parent).await?;
    ensure_vacant(files, &path).await?;
    let attrs = FileAttributes {
        permissions: Some(0o700),
        ..FileAttributes::empty()
    };
    match request(files.mkdir(path.clone(), attrs)).await {
        Ok(_) => Ok(()),
        Err(SftpError::Status(status)) => {
            // SFTP v3 servers may report an existing name with generic failure.
            if status.status_code == StatusCode::Failure {
                ensure_vacant(files, &path).await?;
            }
            Err(file_error(SftpError::Status(status)))
        }
        Err(_) => Err(
            "원격 폴더 생성 응답을 받지 못했습니다. 재시도하기 전에 원격 목록을 새로고침하세요."
                .into(),
        ),
    }
}

pub(super) fn new_child_path(parent: &SftpString, name: &str) -> Result<SftpString> {
    if name.is_empty()
        || name.len() > 255
        || matches!(name, "." | "..")
        || name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
    {
        return Err(
            "경로 구분자 없이 새 원격 이름을 입력하세요. 이름은 255바이트 이하여야 합니다.".into(),
        );
    }
    let path = parent.join(name.as_bytes());
    if path.len() > MAX_REMOTE_PATH {
        return Err("새 원격 경로가 너무 깁니다.".into());
    }
    Ok(path)
}

pub(super) async fn ensure_directory(files: &RawSftpSession, path: SftpString) -> Result<()> {
    let result = request(files.lstat(path)).await.map_err(file_error)?;
    if !result.attrs.is_dir() {
        return Err("선택한 원격 경로가 현재 일반 디렉터리인지 확인할 수 없습니다.".into());
    }
    Ok(())
}

pub(super) async fn ensure_vacant(files: &RawSftpSession, path: &SftpString) -> Result<()> {
    match request(files.lstat(path.clone())).await {
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(()),
        Ok(_) => {
            Err("원격 폴더에 같은 이름의 파일 또는 폴더가 있습니다. 새 이름을 입력하세요.".into())
        }
        Err(error) => Err(file_error(error)),
    }
}
