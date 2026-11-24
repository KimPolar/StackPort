use super::{check_text, decode_text, encode_text, SftpManager, CLOSED, LIMIT};
use crate::{sftp::open_local_file, Result, TextLineEnding};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};
use tempfile::TempDir;

pub(super) struct ExternalDraft {
    directory: TempDir,
    original: [u8; 32],
}

impl SftpManager {
    pub async fn start_external_editor(
        &self,
        id: &str,
        token: String,
        executable: String,
        text: String,
    ) -> Result<()> {
        let session = self.session(id)?;
        tokio::task::spawn_blocking(move || {
            let _operation = session
                .operation
                .try_lock()
                .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
            let mut slot = session.pending_edit.lock().map_err(|_| CLOSED)?;
            let edit = slot
                .as_mut()
                .filter(|edit| edit.token == token)
                .ok_or(CLOSED)?;
            if edit.external.is_some() {
                return Err("이 파일은 이미 외부 편집기에서 열려 있습니다.".into());
            }
            let draft = ExternalDraft::launch(&executable, &text, edit.line_ending, edit.bom)?;
            edit.external = Some(Arc::new(draft));
            Ok(())
        })
        .await
        .map_err(|_| "외부 편집기를 실행하지 못했습니다.")?
    }

    pub async fn external_editor_changed(&self, id: &str, token: String) -> Result<bool> {
        let session = self.session(id)?;
        tokio::task::spawn_blocking(move || {
            let slot = session.pending_edit.lock().map_err(|_| CLOSED)?;
            let draft = slot
                .as_ref()
                .filter(|edit| edit.token == token)
                .and_then(|edit| edit.external.as_deref())
                .ok_or(CLOSED)?;
            let text = draft.read()?;
            Ok(Sha256::digest(text.as_bytes())[..] != draft.original)
        })
        .await
        .map_err(|_| "외부 편집기의 변경 사항을 확인하지 못했습니다.")?
    }

    pub async fn finish_external_editor(
        &self,
        id: &str,
        token: String,
        discard: bool,
    ) -> Result<Option<String>> {
        let session = self.session(id)?;
        tokio::task::spawn_blocking(move || {
            let mut slot = session.pending_edit.lock().map_err(|_| CLOSED)?;
            let edit = slot
                .as_mut()
                .filter(|edit| edit.token == token)
                .ok_or(CLOSED)?;
            let draft = edit.external.as_deref().ok_or(CLOSED)?;
            let text = if discard { None } else { Some(draft.read()?) };
            match fs::remove_file(draft.path()) {
                Ok(()) => {}
                Err(error) if discard && error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(
                    "임시 파일을 정리하지 못했습니다. 외부 편집기에서 파일을 닫고 다시 시도하세요."
                        .into(),
                ),
            }
            edit.external = None;
            Ok(text)
        })
        .await
        .map_err(|_| "외부 편집을 마치지 못했습니다.")?
    }
}

impl ExternalDraft {
    fn launch(executable: &str, text: &str, ending: TextLineEnding, bom: bool) -> Result<Self> {
        let program = Path::new(executable);
        let valid_extension = program
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"));
        if !program.is_absolute() || !valid_extension || !program.is_file() {
            return Err("외부 편집기의 .exe 파일 경로를 확인하세요.".into());
        }
        check_text(text)?;
        let bytes = encode_text(text, ending, bom, LIMIT)
            .ok_or("편집한 파일은 512 KiB 이하여야 합니다.")?;
        let directory = tempfile::Builder::new()
            .prefix("stackport-editor-")
            .tempdir()
            .map_err(|_| "외부 편집에 사용할 임시 폴더를 만들지 못했습니다.")?;
        let path = directory.path().join("StackPort.txt");
        fs::write(&path, bytes).map_err(|_| "외부 편집에 사용할 임시 파일을 만들지 못했습니다.")?;
        let child = Command::new(program)
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "외부 편집기를 실행하지 못했습니다.")?;
        // The editor may delegate to an existing instance, so monitor the file independently.
        #[cfg(not(windows))]
        std::thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
        });
        #[cfg(windows)]
        drop(child);
        Ok(Self {
            directory,
            original: Sha256::digest(text.as_bytes()).into(),
        })
    }

    fn read(&self) -> Result<String> {
        let path = self.path();
        let path = path
            .to_str()
            .ok_or("외부 편집의 임시 파일 경로를 읽을 수 없습니다.")?;
        let file = open_local_file(path)?;
        let mut bytes = Vec::new();
        file.take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "외부 편집의 임시 파일을 읽지 못했습니다.")?;
        if bytes.len() > LIMIT {
            return Err("편집한 파일은 512 KiB 이하여야 합니다.".into());
        }
        let (text, _, _) = decode_text(&bytes)?;
        Ok(text)
    }

    fn path(&self) -> PathBuf {
        self.directory.path().join("StackPort.txt")
    }
}
