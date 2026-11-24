use super::SftpTransferOutcome;
use crate::{insert_audit, AuditRecord, Result, SshProfile, Store};
use serde::Serialize;

#[derive(Serialize)]
pub struct SftpTransferReport {
    #[serde(flatten)]
    outcome: SftpTransferOutcome,
    audit_warning: Option<&'static str>,
}

#[derive(Clone, Copy)]
pub(super) enum FileOperation {
    Download,
    Upload,
    CreateFolder,
    Rename,
    Move,
    Copy,
    Delete,
}

impl FileOperation {
    fn name(self, cancelled: bool) -> &'static str {
        match (self, cancelled) {
            (Self::Download, false) => "sftp.download",
            (Self::Download, true) => "sftp.download.cancel",
            (Self::Upload, false) => "sftp.upload",
            (Self::Upload, true) => "sftp.upload.cancel",
            (Self::CreateFolder, _) => "sftp.mkdir",
            (Self::Rename, _) => "sftp.rename",
            (Self::Move, _) => "sftp.move",
            (Self::Copy, false) => "sftp.copy",
            (Self::Copy, true) => "sftp.copy.cancel",
            (Self::Delete, _) => "sftp.delete",
        }
    }
}

pub(super) struct FileAudit {
    store: Store,
    profile: SshProfile,
    correlation_id: String,
    operation: FileOperation,
}

impl FileAudit {
    pub(super) async fn start(
        store: &Store,
        profile: &SshProfile,
        correlation_id: &str,
        operation: FileOperation,
    ) -> Result<Self> {
        let audit = Self {
            store: store.clone(),
            profile: profile.clone(),
            correlation_id: correlation_id.to_owned(),
            operation,
        };
        const ERROR: &str = "작업 시작 기록을 저장할 수 없습니다. 작업 공간을 확인하세요.";
        tokio::task::spawn_blocking(move || {
            audit.record("started", false, None).map_err(|_| ERROR)?;
            Ok::<_, &str>(audit)
        })
        .await
        .map_err(|_| ERROR)?
        .map_err(String::from)
    }

    pub(super) async fn finish_transfer(
        self,
        result: Result<SftpTransferOutcome>,
    ) -> Result<SftpTransferReport> {
        let cancelled = matches!(&result, Ok(SftpTransferOutcome::Cancelled { .. }));
        let (outcome, audit_warning) = self.finish(result, cancelled).await?;
        Ok(SftpTransferReport {
            outcome,
            audit_warning,
        })
    }

    pub(super) async fn finish<T>(
        self,
        result: Result<T>,
        cancelled: bool,
    ) -> Result<(T, Option<&'static str>)> {
        let status = if result.is_ok() {
            "succeeded"
        } else {
            "failed"
        };
        let count = (result.is_ok() && !cancelled).then_some(1);
        let written = matches!(
            tokio::task::spawn_blocking(move || self.record(status, cancelled, count)).await,
            Ok(Ok(()))
        );
        let warning = "작업 결과의 기록을 저장하지 못했습니다.";
        match result {
            Ok(outcome) => Ok((outcome, (!written).then_some(warning))),
            Err(error) if !written => Err(format!("{error} {warning}")),
            Err(error) => Err(error),
        }
    }

    fn record(&self, outcome: &'static str, cancelled: bool, count: Option<i64>) -> Result<()> {
        insert_audit(
            &self.store.connect()?,
            AuditRecord {
                correlation_id: &self.correlation_id,
                operation: self.operation.name(cancelled),
                project_id: Some(&self.profile.project_id),
                profile_id: Some(&self.profile.id),
                environment: Some(&self.profile.environment),
                object_name: None,
                outcome,
                affected_count: count,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_audit_blocks_start_but_preserves_a_published_outcome() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let folder = tempfile::tempdir().unwrap();
            let store = Store::open(folder.path().join("workspace.sqlite")).unwrap();
            let profile = SshProfile {
                id: "profile-fixture".into(),
                project_id: "project-fixture".into(),
                name: "fixture".into(),
                host: "fixture.example".into(),
                port: 22,
                username: "user".into(),
                environment: "DEV".into(),
                revision: 1,
            };
            let audit = FileAudit::start(&store, &profile, "first", FileOperation::Upload)
                .await
                .unwrap();
            let db = store.connect().unwrap();
            db.execute_batch(
                "CREATE TRIGGER reject_log BEFORE INSERT ON audit_events
                 BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;",
            )
            .unwrap();
            let written = audit
                .finish_transfer(Ok(SftpTransferOutcome::Saved {
                    bytes: "3".into(),
                    sha256: "fixture".into(),
                }))
                .await
                .unwrap();
            assert!(matches!(written.outcome, SftpTransferOutcome::Saved { .. }));
            assert!(written.audit_warning.is_some());
            assert!(
                FileAudit::start(&store, &profile, "second", FileOperation::Download)
                    .await
                    .is_err()
            );
            let page = store.list_audit_events(None).unwrap();
            assert_eq!(page.events.len(), 1);
            assert_eq!(page.events[0].correlation_id, "first");
            assert_eq!(page.events[0].outcome, "started");
        });
    }
}
