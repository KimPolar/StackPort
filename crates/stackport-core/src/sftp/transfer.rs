use super::{
    audit::{FileAudit, FileOperation},
    file_error, FilesSession, SftpManager, SftpTransferReport,
};
use crate::Result;
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, SftpHandle, StatusCode},
};
use serde::Serialize;
use std::{
    future::Future,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::time::timeout;
use uuid::Uuid;

pub(super) const CHUNK_SIZE: u32 = 32 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const PUBLISHING: u8 = 2;

#[derive(Serialize)]
pub struct SftpTransferProgress {
    transfer_id: String,
    transferred: String,
    total: Option<String>,
    elapsed_ms: u64,
    verifying: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SftpTransferOutcome {
    Saved { bytes: String, sha256: String, #[serde(skip_serializing_if = "Option::is_none")] warning: Option<String> },
    Cancelled { cleanup_warning: Option<String> },
}

pub(super) struct Transfer {
    pub(super) id: String,
    phase: AtomicU8,
    started: Instant,
}

impl Transfer {
    fn new() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            phase: AtomicU8::new(RUNNING),
            started: Instant::now(),
        }
    }

    pub fn report(
        &self,
        transferred: u64,
        total: Option<u64>,
        verifying: bool,
    ) -> SftpTransferProgress {
        SftpTransferProgress {
            transfer_id: self.id.clone(),
            transferred: transferred.to_string(),
            total: total.map(|value| value.to_string()),
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            verifying,
        }
    }

    fn cancel(&self) -> bool {
        self.phase
            .compare_exchange(RUNNING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn cancelled(&self) -> bool {
        self.phase.load(Ordering::Acquire) == CANCELLED
    }

    pub fn check(&self) -> Result<()> {
        if self.cancelled() {
            Err("SFTP 전송을 중단했습니다.".into())
        } else {
            Ok(())
        }
    }

    pub fn begin_publication(&self) -> Result<()> {
        self.phase
            .compare_exchange(RUNNING, PUBLISHING, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "SFTP 전송을 중단했습니다.".into())
    }
}

#[derive(Default)]
pub(super) struct TransferState {
    closing: bool,
    active: Option<Arc<Transfer>>,
}

pub(super) struct Registration<'a> {
    state: &'a Mutex<TransferState>,
    pub transfer: Arc<Transfer>,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.state
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .active
            .take();
    }
}

impl FilesSession {
    pub(super) fn register_transfer(&self) -> Result<Registration<'_>> {
        let mut state = self
            .transfers
            .lock()
            .map_err(|_| "SFTP 전송 상태를 열 수 없습니다.")?;
        if state.closing {
            return Err("SFTP 연결이 닫혔습니다. 다시 연결하세요.".into());
        }
        let transfer = Arc::new(Transfer::new());
        state.active = Some(Arc::clone(&transfer));
        Ok(Registration {
            state: &self.transfers,
            transfer,
        })
    }

    pub(super) fn cancel_transfer_on_close(&self) {
        if let Ok(mut state) = self.transfers.lock() {
            state.closing = true;
            if let Some(active) = state.active.as_ref() {
                active.cancel();
            }
        }
    }
}

impl SftpManager {
    pub(super) async fn run_transfer<F>(
        &self,
        id: &str,
        operation: FileOperation,
        run: impl FnOnce(Arc<FilesSession>, Arc<Transfer>) -> F,
    ) -> Result<SftpTransferReport>
    where
        F: Future<Output = Result<SftpTransferOutcome>>,
    {
        let session = self.session(id)?;
        let _operation = session
            .operation
            .try_lock()
            .map_err(|_| "이 SFTP 연결에서 다른 작업이 진행 중입니다.")?;
        let active = session.register_transfer()?;
        let audit = FileAudit::start(
            &self.store,
            &session.profile,
            &active.transfer.id,
            operation,
        )
        .await?;
        let result = run(Arc::clone(&session), Arc::clone(&active.transfer)).await;
        let result = match result {
            Err(_) if active.transfer.cancelled() => Ok(SftpTransferOutcome::Cancelled {
                cleanup_warning: None,
            }),
            result => result,
        };
        audit.finish_transfer(result).await
    }

    pub fn cancel_transfer(&self, id: &str, transfer_id: &str) -> bool {
        let Ok(session) = self.session(id) else {
            return false;
        };
        session.transfers.lock().ok().is_some_and(|state| {
            state
                .active
                .as_ref()
                .is_some_and(|transfer| transfer.id == transfer_id && transfer.cancel())
        })
    }
}

pub(super) fn remote_file_size(attrs: &FileAttributes) -> Result<u64> {
    if !attrs.is_regular() {
        return Err("원격 경로가 일반 파일인지 확인할 수 없습니다.".into());
    }
    attrs
        .size
        .ok_or_else(|| "서버가 원격 파일 크기를 반환하지 않았습니다.".into())
}

pub(super) fn check_remote_snapshot(
    before: &FileAttributes,
    current: &FileAttributes,
    size: u64,
) -> Result<()> {
    if remote_file_size(current)? != size || current.mtime != before.mtime {
        return Err(
            "원격 파일의 크기 또는 수정 시간이 전송 중 변경되었습니다. 다시 시도하세요.".into(),
        );
    }
    Ok(())
}

pub(super) async fn request<T>(
    future: impl Future<Output = std::result::Result<T, SftpError>>,
) -> std::result::Result<T, SftpError> {
    timeout(REQUEST_TIMEOUT, future)
        .await
        .map_err(|_| SftpError::Timeout)?
}

pub(super) async fn read_chunk(
    files: &RawSftpSession,
    handle: &SftpHandle,
    offset: u64,
    wanted: u32,
) -> Result<Vec<u8>> {
    match request(files.read(handle.clone(), offset, wanted)).await {
        Ok(packet) if !packet.data.is_empty() && packet.data.len() <= wanted as usize => {
            Ok(packet.data)
        }
        Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
            Err("원격 파일이 예상 크기보다 먼저 끝났습니다.".into())
        }
        Ok(_) => Err("서버가 잘못된 파일 데이터 길이를 반환했습니다.".into()),
        Err(error) => Err(file_error(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_cannot_override_publication_or_be_sent_twice() {
        let cancelled = Transfer::new();
        assert!(cancelled.cancel());
        assert!(!cancelled.cancel());
        assert!(cancelled.check().is_err());
        assert!(cancelled.begin_publication().is_err());
        let publishing = Transfer::new();
        publishing.begin_publication().unwrap();
        assert!(!publishing.cancel());
    }
}
