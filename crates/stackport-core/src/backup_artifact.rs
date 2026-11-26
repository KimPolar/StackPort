//! File evidence and explicitly approved retention cleanup for backup plans.
#[cfg(windows)]
mod windows;

use crate::{backup_schedule::unix_now, db_error, insert_audit, AuditRecord, Result, Store};
use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

const APPROVAL_LIFETIME: Duration = Duration::from_secs(300);
const CHANGED: &str = "백업 이후 파일이 변경되었거나 다른 파일로 교체되었습니다.";

pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS backup_artifacts (
        run_id TEXT PRIMARY KEY NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        file_id TEXT,
        engine_version TEXT NOT NULL,
        verified_at INTEGER,
        removal_started_at INTEGER,
        removed_at INTEGER
    );
";

pub(crate) struct Evidence {
    pub(crate) sha256: String,
    pub(crate) file_id: Option<String>,
}

pub(crate) fn measure(file: &File, check: impl Fn() -> Result<()>) -> Result<Evidence> {
    Ok(Evidence {
        file_id: file_identity(file),
        sha256: fingerprint(file, check)?,
    })
}

pub(crate) fn file_identity(_file: &File) -> Option<String> {
    #[cfg(windows)]
    return windows::identity(_file);
    #[cfg(not(windows))]
    None
}

#[derive(Serialize)]
pub struct ArtifactSummary {
    pub(crate) sha256: String,
    pub(crate) engine_version: String,
    pub(crate) verified_at: Option<i64>,
    pub(crate) removal_started_at: Option<i64>,
    pub(crate) removed_at: Option<i64>,
    pub(crate) owned_here: bool,
    pub(crate) removal_supported: bool,
}

pub(crate) fn summary(row: &Row<'_>) -> rusqlite::Result<Option<ArtifactSummary>> {
    let Some(sha256) = row.get(10)? else {
        return Ok(None);
    };
    Ok(Some(ArtifactSummary {
        sha256,
        engine_version: row.get(11)?,
        verified_at: row.get(12)?,
        removal_started_at: row.get(13)?,
        removed_at: row.get(14)?,
        owned_here: row.get(15)?,
        removal_supported: cfg!(windows) && row.get(16)?,
    }))
}

struct Artifact {
    path: PathBuf,
    size_bytes: u64,
    expires_at: i64,
    evidence: Evidence,
}

struct Ticket {
    token: String,
    profile_id: String,
    run_id: String,
    expires: Instant,
}

#[derive(Default)]
pub(crate) struct RemovalReview(Mutex<Option<Ticket>>);

#[derive(Serialize)]
pub struct RemovalPreview {
    token: String,
    path: String,
    size_bytes: u64,
    sha256: String,
    expires_at: i64,
}

#[derive(Serialize)]
pub struct RemovalResult {
    removed_at: i64,
    audit_warning: bool,
}

impl Store {
    pub fn verify_sqlite_backup_file(&self, profile_id: &str, run_id: &str) -> Result<i64> {
        let artifact = self.owned_backup_file(profile_id, run_id)?;
        let _file = open_verified(&artifact, false)?;
        let checked = unix_now()?;
        let updated = self
            .connect()?
            .execute(
                "UPDATE backup_artifacts SET verified_at=?2 WHERE run_id=?1 AND removed_at IS NULL",
                params![run_id, checked],
            )
            .map_err(db_error)?;
        if updated != 1 {
            return Err("백업 실행 이력이 변경되었습니다.".into());
        }
        Ok(checked)
    }

    pub fn preview_sqlite_backup_removal(
        &self,
        profile_id: &str,
        run_id: &str,
    ) -> Result<RemovalPreview> {
        let artifact = self.expired_backup_file(profile_id, run_id)?;
        let _file = open_verified(&artifact, false)?;
        let token = Uuid::new_v4().to_string();
        let ticket = Ticket {
            token: token.clone(),
            profile_id: profile_id.into(),
            run_id: run_id.into(),
            expires: Instant::now() + APPROVAL_LIFETIME,
        };
        *self
            .backup_removal
            .0
            .lock()
            .map_err(|_| "삭제 미리보기를 저장할 수 없습니다.")? = Some(ticket);
        Ok(RemovalPreview {
            token,
            path: artifact.path.to_string_lossy().into_owned(),
            size_bytes: artifact.size_bytes,
            sha256: artifact.evidence.sha256,
            expires_at: artifact.expires_at,
        })
    }

    pub fn remove_sqlite_backup_file(&self, token: &str, confirmed: bool) -> Result<RemovalResult> {
        if !confirmed {
            return Err("미리보기에서 만료 파일의 영구 삭제를 확인하세요.".into());
        }
        let ticket = {
            let mut pending = self
                .backup_removal
                .0
                .lock()
                .map_err(|_| "삭제 미리보기를 읽을 수 없습니다.")?;
            if pending
                .as_ref()
                .is_none_or(|ticket| ticket.token != token || ticket.expires <= Instant::now())
            {
                return Err("삭제 미리보기가 만료되었거나 변경되었습니다. 다시 확인하세요.".into());
            }
            pending.take().ok_or("삭제 미리보기가 만료되었습니다.")?
        };
        let artifact = self.expired_backup_file(&ticket.profile_id, &ticket.run_id)?;
        let file = open_verified(&artifact, true)?;
        let db = self.connect()?;
        let (project, environment, operation) = db.query_row(
            "SELECT coalesce(s.project_id,p.project_id,m.project_id), coalesce(s.environment,p.environment,json_extract(m.settings_json,'$.environment')),
                CASE WHEN m.id IS NOT NULL THEN 'mysql.backup.delete' WHEN p.id IS NOT NULL THEN 'postgres.backup.delete' ELSE 'sqlite.backup.delete' END
             FROM backup_plans b LEFT JOIN profiles s ON s.id=b.sqlite_profile_id
             LEFT JOIN postgres_profiles p ON p.id=b.postgres_profile_id
             LEFT JOIN mysql_profiles m ON m.id=b.mysql_profile_id WHERE b.profile_id=?1",
            [&ticket.profile_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        ).map_err(db_error)?;
        let correlation = Uuid::new_v4().to_string();
        let audit = |outcome, affected_count| AuditRecord {
            correlation_id: &correlation,
            operation: match operation.as_str() {
                "mysql.backup.delete" => "mysql.backup.delete",
                "postgres.backup.delete" => "postgres.backup.delete",
                _ => "sqlite.backup.delete",
            },
            project_id: Some(&project),
            profile_id: Some(&ticket.profile_id),
            environment: Some(&environment),
            object_name: None,
            outcome,
            affected_count,
        };
        let at = unix_now()?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let updated = tx.execute(
            "UPDATE backup_artifacts SET removal_started_at=?2 WHERE run_id=?1 AND removed_at IS NULL",
            params![ticket.run_id, at],
        ).map_err(db_error)?;
        if updated != 1 {
            return Err("백업 실행 이력이 변경되었습니다.".into());
        }
        insert_audit(&tx, audit("started", None))?;
        tx.commit().map_err(db_error)?;

        #[cfg(windows)]
        let result = windows::remove(file);
        #[cfg(not(windows))]
        let result: Result<()> = {
            drop(file);
            Err("만료 백업 파일의 정리는 Windows에서 지원합니다.".into())
        };

        let detail_error =
            "삭제 요청 뒤 기록을 저장할 수 없습니다. 파일과 실행 이력을 다시 확인하세요.";
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| detail_error)?;
        let removed_at = result.as_ref().ok().map(|_| at);
        let updated = tx.execute(
            "UPDATE backup_artifacts SET removed_at=?2, removal_started_at=NULL WHERE run_id=?1",
            params![ticket.run_id, removed_at],
        ).map_err(|_| detail_error)?;
        if updated != 1 {
            return Err(detail_error.into());
        }
        let outcome = if removed_at.is_some() {
            "succeeded"
        } else {
            "failed"
        };
        let audit_warning = insert_audit(&tx, audit(outcome, removed_at.map(|_| 1))).is_err();
        tx.commit().map_err(|_| detail_error)?;
        result?;
        Ok(RemovalResult {
            removed_at: at,
            audit_warning,
        })
    }

    fn owned_backup_file(&self, profile: &str, run: &str) -> Result<Artifact> {
        let workspace = self.backup_workspace_path()?;
        self.connect()?
            .query_row(
                "SELECT r.path, r.size_bytes, r.expires_at, a.sha256, a.file_id
             FROM backup_runs r JOIN backup_artifacts a ON a.run_id=r.id
             WHERE r.id=?1 AND r.profile_id=?2 AND r.workspace_path=?3
             AND r.status='succeeded' AND a.removed_at IS NULL",
                params![run, profile, workspace],
                |row| {
                    Ok(Artifact {
                        path: PathBuf::from(row.get::<_, String>(0)?),
                        size_bytes: row.get(1)?,
                        expires_at: row.get(2)?,
                        evidence: Evidence {
                            sha256: row.get(3)?,
                            file_id: row.get(4)?,
                        },
                    })
                },
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "이 작업 공간에서 생성한 검증 가능한 백업 파일을 선택하세요.".into())
    }

    fn expired_backup_file(&self, profile: &str, run: &str) -> Result<Artifact> {
        let artifact = self.owned_backup_file(profile, run)?;
        if artifact.expires_at > unix_now()? {
            return Err("보존 기간 동안에는 이 파일을 삭제할 수 없습니다.".into());
        }
        if !cfg!(windows) || artifact.evidence.file_id.is_none() {
            return Err("안전한 삭제에 필요한 Windows 파일 식별 정보를 확인할 수 없습니다.".into());
        }
        Ok(artifact)
    }
}

fn open_verified(artifact: &Artifact, remove: bool) -> Result<File> {
    let metadata = fs::symlink_metadata(&artifact.path)
        .map_err(|_| "기록된 백업 파일을 찾을 수 없습니다. 폴더와 파일을 확인하세요.")?;
    if !metadata.is_file() {
        return Err(CHANGED.into());
    }
    #[cfg(windows)]
    let file = windows::open(&artifact.path, remove)?;
    #[cfg(not(windows))]
    let file = {
        let _ = remove;
        if artifact.path.canonicalize().ok().as_deref() != Some(artifact.path.as_path()) {
            return Err(CHANGED.into());
        }
        File::open(&artifact.path).map_err(|_| "백업 파일을 읽을 수 없습니다.")?
    };
    let current = file
        .metadata()
        .map_err(|_| "백업 파일의 크기를 확인할 수 없습니다.")?;
    if !current.is_file() || current.len() != artifact.size_bytes {
        return Err(CHANGED.into());
    }
    let evidence = measure(&file, || Ok(()))?;
    if evidence.sha256 != artifact.evidence.sha256
        || artifact.evidence.file_id.is_some() && artifact.evidence.file_id != evidence.file_id
    {
        return Err(CHANGED.into());
    }
    Ok(file)
}

fn fingerprint(mut file: &File, check: impl Fn() -> Result<()>) -> Result<String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "백업 파일을 처음부터 읽을 수 없습니다.")?;
    let mut sha = Sha256::new();
    let mut buffer = [0; 128 * 1024];
    loop {
        check()?;
        let count = file
            .read(&mut buffer)
            .map_err(|_| "백업 파일의 SHA-256을 계산할 수 없습니다.")?;
        if count == 0 {
            break;
        }
        sha.update(&buffer[..count]);
    }
    Ok(format!("{:x}", sha.finalize()))
}
