use super::{
    audit::{FileAudit, FileOperation},
    canonical_remote_path, file_error,
    transfer::request,
    FilesSession, RemotePath, SftpError, SftpManager, MAX_REMOTE_PATH,
};
use crate::Result;
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, SftpString, StatusCode},
};
use serde::{Deserialize, Serialize};
use std::{future::Future, sync::Arc};
use uuid::Uuid;

#[derive(Serialize)]
pub struct SftpMutationReport {
    audit_warning: Option<&'static str>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SftpEntrySource {
    pub(super) location: String,
    kind: EntryKind,
    size: Option<String>,
    modified: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum EntryKind {
    File,
    Directory,
}

impl SftpManager {
    pub async fn create_folder(
        &self,
        id: &str,
        parent: String,
        name: String,
    ) -> Result<SftpMutationReport> {
        let parent = RemotePath::Token(parent).into_path()?;
        let path = new_child_path(&parent, &name)?;
        self.run_mutation(id, FileOperation::CreateFolder, |session| async move {
            create_folder(&session.files, parent, path).await
        })
        .await
    }

    pub async fn rename(
        &self,
        id: &str,
        parent: String,
        source: SftpEntrySource,
        name: String,
    ) -> Result<SftpMutationReport> {
        let parent = RemotePath::Token(parent).into_path()?;
        let old_path = RemotePath::Token(source.location.clone()).into_path()?;
        direct_child_name(&parent, &old_path)?;
        let new_path = new_child_path(&parent, &name)?;
        if old_path == new_path {
            return Err("현재 이름과 다른 새 이름을 입력하세요.".into());
        }
        self.run_mutation(id, FileOperation::Rename, |session| async move {
            let files = &session.files;
            ensure_directory(files, parent).await?;
            relocate_entry(
                files,
                &source,
                &old_path,
                &new_path,
                "이름 변경 응답을 받지 못했습니다. 재시도하기 전에 원격 목록을 새로고침하세요.",
            )
            .await
        })
        .await
    }

    pub async fn move_entry(
        &self,
        id: &str,
        parent: String,
        source: SftpEntrySource,
        destination: String,
    ) -> Result<SftpMutationReport> {
        let parent = RemotePath::Token(parent).into_path()?;
        let old_path = RemotePath::Token(source.location.clone()).into_path()?;
        let leaf = direct_child_name(&parent, &old_path)?;
        let destination = RemotePath::Token(destination).into_path()?;
        let new_path = destination.join(leaf);
        if new_path.len() > MAX_REMOTE_PATH {
            return Err("새 원격 경로가 너무 깁니다.".into());
        }
        if old_path == new_path {
            return Err("현재 원격 폴더와 다른 대상 폴더를 선택하세요.".into());
        }
        if matches!(source.kind, EntryKind::Directory)
            && (destination == old_path
                || destination
                    .strip_prefix(old_path.as_bytes())
                    .is_some_and(|tail| tail.starts_with(b"/")))
        {
            return Err("폴더를 자기 자신이나 하위 폴더로 이동할 수 없습니다.".into());
        }
        self.run_mutation(id, FileOperation::Move, |session| async move {
            let files = &session.files;
            for directory in [parent, destination] {
                ensure_current_directory(files, &directory).await?;
            }
            relocate_entry(
                files,
                &source,
                &old_path,
                &new_path,
                "이동 응답을 받지 못했습니다. 재시도하기 전에 원본과 대상 폴더의 목록을 확인하세요.",
            )
            .await
        })
        .await
    }

    pub(super) async fn run_mutation<F>(
        &self,
        id: &str,
        operation: FileOperation,
        run: impl FnOnce(Arc<FilesSession>) -> F,
    ) -> Result<SftpMutationReport>
    where
        F: Future<Output = Result<()>>,
    {
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let correlation_id = Uuid::new_v4().to_string();
        let audit =
            FileAudit::start(&self.store, session.profile.as_ref(), &correlation_id, operation).await?;
        let result = run(Arc::clone(&session)).await;
        let ((), audit_warning) = audit.finish(result, false).await?;
        Ok(SftpMutationReport { audit_warning })
    }
}

pub(super) fn direct_child_name<'a>(parent: &SftpString, path: &'a SftpString) -> Result<&'a [u8]> {
    let leaf = path
        .as_bytes()
        .rsplit(|byte| *byte == b'/')
        .next()
        .unwrap_or_default();
    if leaf.is_empty()
        || matches!(leaf, b"." | b"..")
        || leaf.contains(&b'\\')
        || parent.join(leaf) != *path
    {
        return Err("현재 원격 폴더에서 작업할 항목을 다시 선택하세요.".into());
    }
    Ok(leaf)
}

impl SftpEntrySource {
    pub(super) fn check_snapshot(&self, attrs: &FileAttributes) -> Result<()> {
        let kind_matches = match self.kind {
            EntryKind::File => attrs.is_regular(),
            EntryKind::Directory => attrs.is_dir(),
        };
        let size_changed = self.size.as_deref().is_some_and(|size| {
            size.parse::<u64>()
                .map_or(true, |listed| attrs.size != Some(listed))
        });
        let time_changed = self.modified.is_some_and(|time| attrs.mtime != Some(time));
        if !kind_matches || size_changed || time_changed {
            return Err(
                "원격 항목이 목록을 읽은 뒤 변경되었습니다. 새로고침하고 다시 선택하세요.".into(),
            );
        }
        Ok(())
    }
}

async fn relocate_entry(
    files: &RawSftpSession,
    selected: &SftpEntrySource,
    source: &SftpString,
    destination: &SftpString,
    unknown_outcome: &'static str,
) -> Result<()> {
    ensure_vacant(files, destination).await?;
    let current = request(files.lstat(source.clone()))
        .await
        .map_err(file_error)?
        .attrs;
    selected.check_snapshot(&current)?;
    rename_to_vacant(files, source, destination, unknown_outcome).await
}

pub(super) async fn rename_to_vacant(
    files: &RawSftpSession,
    source: &SftpString,
    destination: &SftpString,
    unknown_outcome: &'static str,
) -> Result<()> {
    // The standard SFTP v3 rename rejects occupied destinations on the server.
    match request(files.rename(source.clone(), destination.clone())).await {
        Ok(_) => Ok(()),
        Err(SftpError::Status(status)) => {
            if status.status_code == StatusCode::Failure {
                ensure_vacant(files, destination).await?;
            }
            Err(file_error(SftpError::Status(status)))
        }
        Err(_) => Err(unknown_outcome.into()),
    }
}

pub(super) async fn create_folder(files: &RawSftpSession, parent: SftpString, path: SftpString) -> Result<()> {
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

pub(super) async fn ensure_current_directory(
    files: &RawSftpSession,
    path: &SftpString,
) -> Result<()> {
    if canonical_remote_path(files, path.clone()).await? != *path {
        return Err("원격 폴더 경로가 바뀌었습니다. 목록을 새로고침하고 다시 선택하세요.".into());
    }
    ensure_directory(files, path.clone()).await
}

pub(super) async fn ensure_vacant(files: &RawSftpSession, path: &SftpString) -> Result<()> {
    match request(files.lstat(path.clone())).await {
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(()),
        Ok(_) => Err("원격 폴더에 같은 이름의 파일 또는 폴더가 있습니다.".into()),
        Err(error) => Err(file_error(error)),
    }
}
