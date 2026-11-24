//! Edit a bounded UTF-8 file against a verified remote snapshot.

use super::{
    audit::FileOperation,
    file_error,
    mutation::{direct_child_name, ensure_current_directory, new_child_path},
    remote_stage::{can_preserve_permissions, preserve_permissions, same_permissions, stage_and_publish, stage_remote_file, StagingTarget},
    transfer::{check_remote_snapshot, read_chunk, remote_file_size, request, CHUNK_SIZE},
    RemotePath, SftpEntrySource, SftpError, SftpManager, SftpTransferOutcome, SftpTransferProgress,
    SftpTransferReport, BROWSE_TIMEOUT,
};
use crate::{
    text_draft::{encode_text, UTF8_BOM},
    Result, TextLineEnding,
};
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, OpenFlags, SftpString},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::time::timeout;
use uuid::Uuid;

const LIMIT: usize = 512 * 1024;
const CLOSED: &str = "편집 세션이 닫혔습니다. 원격 파일을 다시 여세요.";
const CONFLICT: &str =
    "편집을 시작한 뒤 원격 파일이 변경되었습니다. 변경 내용을 보관하거나 다른 이름으로 저장하세요.";

#[derive(Serialize)]
pub struct SftpEditDocument {
    token: String,
    path: String,
    text: String,
    line_ending: TextLineEnding,
    bom: bool,
    replace_supported: bool,
    production: bool,
    max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SftpEditSave {
    token: String,
    text: String,
    copy_name: Option<String>,
    confirmation: String,
}

#[derive(Clone)]
pub(super) struct PendingEdit {
    token: String,
    parent: SftpString,
    path: SftpString,
    attrs: FileAttributes,
    digest: [u8; 32],
    line_ending: TextLineEnding,
    bom: bool,
    replace_supported: bool,
}

impl SftpManager {
    pub async fn open_editor(
        &self,
        id: &str,
        parent: String,
        source: SftpEntrySource,
    ) -> Result<SftpEditDocument> {
        let parent = RemotePath::Token(parent).into_path()?;
        let path = RemotePath::Token(source.location.clone()).into_path()?;
        direct_child_name(&parent, &path)?;
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        session.pending_edit.lock().map_err(|_| CLOSED)?.take();
        let files = &session.files;
        ensure_current_directory(files, &parent).await?;
        let attrs = request(files.lstat(path.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        source.check_snapshot(&attrs)?;
        let bytes = read_text_file(files, &path, &attrs).await?;
        let digest = Sha256::digest(&bytes).into();
        let (text, line_ending, bom) = decode_text(&bytes)?;
        let replace_supported = session.posix_rename_supported && can_preserve_permissions(&attrs);
        let token = Uuid::new_v4().to_string();
        let display_path = path.to_string_lossy().into_owned();
        *session.pending_edit.lock().map_err(|_| CLOSED)? = Some(PendingEdit {
            token: token.clone(),
            path,
            parent,
            attrs,
            digest,
            line_ending,
            bom,
            replace_supported,
        });
        Ok(SftpEditDocument {
            token,
            path: display_path,
            text,
            line_ending,
            bom,
            replace_supported,
            production: session.profile.environment == "PROD",
            max_bytes: LIMIT,
        })
    }

    pub fn discard_editor(&self, id: &str, token: &str) {
        if let Ok(session) = self.session(id) {
            if let Ok(mut slot) = session.pending_edit.lock() {
                if slot.as_ref().is_some_and(|edit| edit.token == token) {
                    slot.take();
                }
            }
        }
    }

    pub async fn save_editor(
        &self,
        id: &str,
        input: SftpEditSave,
        progress: impl Fn(SftpTransferProgress),
    ) -> Result<SftpTransferReport> {
        let operation = if input.copy_name.is_some() {
            FileOperation::EditedCopy
        } else {
            FileOperation::Edit
        };
        self.run_transfer(id, operation, |session, transfer| async move {
            let transfer = transfer.as_ref();
            let update = |bytes, total, verifying| progress(transfer.report(bytes, total, verifying));
            update(0, None, false);
            let edit = session.pending_edit.lock().map_err(|_| CLOSED)?.as_ref()
                .filter(|edit| edit.token == input.token).cloned().ok_or(CLOSED)?;
            let replacing = input.copy_name.is_none();
            if replacing && !edit.replace_supported {
                return Err("이 파일은 원래 경로에 저장할 수 없습니다. 새 이름으로 저장하세요.".into());
            }
            if replacing && session.profile.environment == "PROD" && input.confirmation != "PROD" {
                return Err("운영 환경의 원본을 저장하려면 PROD를 입력하세요.".into());
            }
            let store = self.store.clone();
            let profile_id = session.profile.id.clone();
            let current = tokio::task::spawn_blocking(move || store.ssh_profile(&profile_id)).await
                .map_err(|_| "현재 SSH 연결 설정을 확인하지 못했습니다.")??;
            if current != session.profile {
                return Err("SSH 연결 설정이 변경되었습니다. 편집 내용을 보관하고 다시 연결하세요.".into());
            }
            let destination = match input.copy_name {
                Some(name) => new_child_path(&edit.parent, &name)?,
                None => edit.path.clone(),
            };
            if !replacing && edit.path == destination {
                return Err("원본과 다른 새 파일 이름을 입력하세요.".into());
            }
            if input.text.len() > LIMIT {
                return Err("편집한 파일은 512 KiB 이하여야 합니다.".into());
            }
            check_text(&input.text)?;
            let bytes = encode_text(&input.text, edit.line_ending, edit.bom, LIMIT)
                .ok_or("편집한 파일은 512 KiB 이하여야 합니다.")?;
            let files = &session.files;
            transfer.check()?;
            ensure_current_directory(files, &edit.parent).await?;
            if replacing {
                ensure_unchanged(files, &edit).await?;
            }
            let expected = bytes.len() as u64;
            let target = StagingTarget { directory: &edit.parent, path: &destination, size: expected, fsync_supported: session.fsync_supported };
            let update = &update;
            let write_contents = |handle: russh_sftp::protocol::SftpHandle| {
                let attrs = &edit.attrs;
                async move {
                    let digest = Sha256::digest(&bytes).into();
                    update(0, Some(expected), false);
                    for (index, block) in bytes.chunks(CHUNK_SIZE as usize).enumerate() {
                        transfer.check()?;
                        let offset = index as u64 * u64::from(CHUNK_SIZE);
                        request(files.write(handle.clone(), offset, block.to_vec())).await.map_err(file_error)?;
                        update(offset + block.len() as u64, Some(expected), false);
                    }
                    if replacing {
                        preserve_permissions(files, handle, attrs).await?;
                    }
                    Ok(digest)
                }
            };
            let result = if replacing {
                stage_and_publish(files, target, transfer, update, write_contents, |temporary| async {
                    ensure_current_directory(files, &edit.parent).await?;
                    ensure_unchanged(files, &edit).await?;
                    transfer.begin_publication()?;
                    match request(files.posix_rename(temporary, destination.clone())).await {
                        Ok(_) => Ok(()),
                        Err(SftpError::Status(status)) => Err(file_error(SftpError::Status(status))),
                        Err(_) => Err("저장 응답을 받지 못했습니다. 원격 파일을 다시 확인하세요.".into()),
                    }
                }).await
            } else {
                stage_remote_file(files, target, transfer, update, write_contents).await
            };
            if matches!(result, Ok(SftpTransferOutcome::Saved { .. })) {
                self.discard_editor(id, &input.token);
            }
            result
        }).await
    }
}

async fn ensure_unchanged(files: &RawSftpSession, edit: &PendingEdit) -> Result<()> {
    let current = match request(files.lstat(edit.path.clone())).await {
        Ok(response) => response.attrs,
        Err(SftpError::Status(status))
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
        {
            return Err(CONFLICT.into())
        }
        Err(error) => return Err(file_error(error)),
    };
    if !same_snapshot(&edit.attrs, &current) {
        return Err(CONFLICT.into());
    }
    let bytes = read_text_file(files, &edit.path, &current).await?;
    if Sha256::digest(&bytes)[..] != edit.digest {
        return Err(CONFLICT.into());
    }
    Ok(())
}

fn same_snapshot(before: &FileAttributes, current: &FileAttributes) -> bool {
    same_permissions(before, current)
        && before.size == current.size
        && before.mtime == current.mtime
}

async fn read_text_file(
    files: &RawSftpSession,
    path: &SftpString,
    listed: &FileAttributes,
) -> Result<Vec<u8>> {
    let expected = remote_file_size(listed)?;
    if expected > LIMIT as u64 {
        return Err("512 KiB 이하의 UTF-8 파일만 편집할 수 있습니다.".into());
    }
    let handle = request(files.open(path.clone(), OpenFlags::READ, FileAttributes::empty()))
        .await
        .map_err(file_error)?
        .handle;
    let read = timeout(BROWSE_TIMEOUT, async {
        let opened = request(files.fstat(handle.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        check_remote_snapshot(listed, &opened, expected)?;
        if !same_permissions(listed, &opened) {
            return Err(CONFLICT.into());
        }
        let mut bytes = Vec::with_capacity(expected as usize);
        while (bytes.len() as u64) < expected {
            let offset = bytes.len() as u64;
            let wanted = (expected - offset).min(u64::from(CHUNK_SIZE)) as u32;
            bytes.extend(read_chunk(files, &handle, offset, wanted).await?);
        }
        let current = request(files.fstat(handle.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        let listed_now = request(files.lstat(path.clone()))
            .await
            .map_err(file_error)?
            .attrs;
        if !same_snapshot(&opened, &current) || !same_snapshot(&opened, &listed_now) {
            return Err(CONFLICT.into());
        }
        Ok::<_, String>(bytes)
    })
    .await;
    let closed = request(files.close(handle)).await.map_err(file_error);
    let bytes = read.map_err(|_| "원격 파일을 읽는 시간이 초과되었습니다.")??;
    closed?;
    Ok(bytes)
}

fn decode_text(bytes: &[u8]) -> Result<(String, TextLineEnding, bool)> {
    let bom = bytes.starts_with(UTF8_BOM);
    let raw = std::str::from_utf8(bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes))
        .map_err(|_| "UTF-8 텍스트 파일만 편집할 수 있습니다.")?;
    let crlf = raw.contains("\r\n");
    let normalized = raw.replace("\r\n", "\n");
    if normalized.contains('\r')
        || (crlf
            && raw
                .as_bytes()
                .split_inclusive(|&byte| byte == b'\n')
                .any(|line| line.ends_with(b"\n") && !line.ends_with(b"\r\n")))
    {
        return Err("LF 또는 CRLF 한 종류의 줄바꿈을 사용하는 파일만 편집할 수 있습니다.".into());
    }
    check_text(&normalized)?;
    Ok((
        normalized,
        if crlf {
            TextLineEnding::Crlf
        } else {
            TextLineEnding::Lf
        },
        bom,
    ))
}

fn check_text(text: &str) -> Result<()> {
    if text
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\t' | '\n'))
    {
        return Err("UTF-8 일반 텍스트 파일만 편집할 수 있습니다.".into());
    }
    Ok(())
}
