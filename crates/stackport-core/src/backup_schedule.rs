//! Workspace scheduler for verified database backups.
use crate::{
    backup_artifact::{self, ArtifactSummary},
    db_error, open_user_db, postgres, BackupTunnelRoute, PostgresProfile, Result, SshTunnelManager, Store,
};
use chrono::{DateTime, Utc};
use rusqlite::hooks::{AuthContext, Authorization};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions, TryLockError},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const RETRY_DELAY: i64 = 60;
const LATEST_START: i64 = 4_102_444_800; // 2100-01-01 UTC

pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS backup_plans (
        profile_id TEXT PRIMARY KEY NOT NULL,
        sqlite_profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
        postgres_profile_id TEXT REFERENCES postgres_profiles(id) ON DELETE CASCADE,
        postgres_revision INTEGER,
        postgres_tunnel TEXT CHECK (postgres_tunnel IS NULL OR postgres_profile_id IS NOT NULL),
        revision INTEGER NOT NULL,
        workspace_path TEXT NOT NULL,
        directory TEXT NOT NULL,
        prefix TEXT NOT NULL,
        interval_minutes INTEGER,
        retention_days INTEGER NOT NULL,
        retry_once INTEGER NOT NULL,
        next_at INTEGER,
        retry_at INTEGER,
        CHECK (
            (sqlite_profile_id IS NOT NULL AND sqlite_profile_id=profile_id AND postgres_profile_id IS NULL AND postgres_revision IS NULL)
            OR (postgres_profile_id IS NOT NULL AND postgres_profile_id=profile_id AND sqlite_profile_id IS NULL AND postgres_revision IS NOT NULL AND postgres_revision>0)
        )
    );
    CREATE TABLE IF NOT EXISTS backup_runs (
        id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL REFERENCES backup_plans(profile_id) ON DELETE CASCADE,
        workspace_path TEXT NOT NULL,
        trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('scheduled', 'retry', 'manual')),
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'interrupted')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        expires_at INTEGER,
        path TEXT NOT NULL,
        size_bytes INTEGER,
        message TEXT
    );
    CREATE INDEX IF NOT EXISTS backup_runs_recent ON backup_runs(profile_id, started_at DESC);
";

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    let legacy: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('backup_plans') WHERE name='profile_id')
          AND NOT EXISTS(SELECT 1 FROM pragma_table_info('backup_plans') WHERE name='sqlite_profile_id')",
        [], |row| row.get(0),
    ).map_err(db_error)?;
    if legacy {
        db.execute_batch(backup_artifact::SCHEMA).map_err(db_error)?;
        db.execute_batch("ALTER TABLE backup_artifacts RENAME TO legacy_backup_artifacts;
            ALTER TABLE backup_runs RENAME TO legacy_backup_runs;
            ALTER TABLE backup_plans RENAME TO legacy_backup_plans;
            DROP INDEX IF EXISTS backup_runs_recent;").map_err(db_error)?;
    }
    db.execute_batch(SCHEMA).map_err(db_error)?;
    db.execute_batch(backup_artifact::SCHEMA).map_err(db_error)?;
    let has_tunnels: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('backup_plans') WHERE name='postgres_tunnel')",
        [], |row| row.get(0),
    ).map_err(db_error)?;
    if !has_tunnels {
        db.execute_batch("ALTER TABLE backup_plans ADD COLUMN postgres_tunnel TEXT
            CHECK (postgres_tunnel IS NULL OR postgres_profile_id IS NOT NULL);").map_err(db_error)?;
    }
    if legacy {
        db.execute_batch("INSERT INTO backup_plans
            (profile_id, sqlite_profile_id, revision, workspace_path, directory, prefix, interval_minutes, retention_days, retry_once, next_at, retry_at)
            SELECT profile_id, profile_id, revision, workspace_path, directory, prefix, interval_minutes, retention_days, retry_once, next_at, retry_at FROM legacy_backup_plans;
            INSERT INTO backup_runs (rowid, id, profile_id, workspace_path, trigger_kind, status, started_at, finished_at, expires_at, path, size_bytes, message)
            SELECT rowid, id, profile_id, workspace_path, trigger_kind, status, started_at, finished_at, expires_at, path, size_bytes, message FROM legacy_backup_runs;
            INSERT INTO backup_artifacts SELECT * FROM legacy_backup_artifacts;
            DROP TABLE legacy_backup_artifacts;
            DROP TABLE legacy_backup_runs;
            DROP TABLE legacy_backup_plans;").map_err(db_error)?;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct BackupPlanWrite {
    revision: Option<i64>,
    directory: String,
    prefix: String,
    interval_minutes: Option<i64>,
    retention_days: i64,
    retry_once: bool,
    next_at: Option<i64>,
}

#[derive(Serialize)]
pub struct BackupPlan {
    revision: i64,
    #[serde(skip)]
    postgres_revision: Option<i64>,
    tunnel: Option<BackupTunnelRoute>,
    #[serde(skip)]
    workspace_path: String,
    directory: String,
    prefix: String,
    interval_minutes: Option<i64>,
    retention_days: i64,
    retry_once: bool,
    next_at: Option<i64>,
    retry_at: Option<i64>,
    requires_review: bool,
}

#[derive(Serialize)]
pub struct BackupRun {
    pub id: String,
    pub profile_id: String,
    pub status: String,
    pub engine: &'static str,
    trigger_kind: String,
    started_at: i64,
    finished_at: Option<i64>,
    expires_at: Option<i64>,
    path: String,
    size_bytes: Option<u64>,
    message: Option<String>,
    artifact: Option<ArtifactSummary>,
}

#[derive(Serialize)]
pub struct BackupPlanState {
    plan: Option<BackupPlan>,
    runs: Vec<BackupRun>,
}

#[derive(Serialize)]
pub struct ExpiredBackupPage {
    runs: Vec<BackupRun>,
    next_before: Option<i64>,
}

#[derive(Serialize)]
pub struct BackupCapacity {
    directory: String,
    estimated_bytes: u64,
    available_bytes: Option<u64>,
}

impl Store {
    pub fn sqlite_backup_capacity(
        &self,
        profile_id: &str,
        directory: &str,
    ) -> Result<BackupCapacity> {
        let profile = self.profile(profile_id)?;
        let directory = backup_directory(directory)?;
        let source = open_user_db(Path::new(&profile.path))?;
        // This read-only connection runs only the two fixed size PRAGMAs.
        source.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        let pages: u64 = source
            .pragma_query_value(None, "page_count", |r| r.get(0))
            .map_err(db_error)?;
        let page_size: u64 = source
            .pragma_query_value(None, "page_size", |r| r.get(0))
            .map_err(db_error)?;
        let estimated_bytes = pages
            .checked_mul(page_size)
            .ok_or("원본 데이터베이스 크기를 확인할 수 없습니다.")?;
        capacity(&directory, estimated_bytes)
    }

    pub fn postgres_backup_capacity(&self, profile: &PostgresProfile, directory: &str, route: Option<(&SshTunnelManager, &BackupTunnelRoute)>) -> Result<BackupCapacity> {
        let directory = backup_directory(directory)?;
        capacity(&directory, postgres::scheduled_backup_size(self, profile, route)?)
    }

    pub fn sqlite_backup_plan(&self, profile_id: &str) -> Result<BackupPlanState> {
        self.profile(profile_id)?;
        self.backup_plan(profile_id, None)
    }

    pub fn postgres_backup_plan(&self, profile_id: &str) -> Result<BackupPlanState> {
        let profile = self.postgres_profile(profile_id)?;
        self.backup_plan(profile_id, Some(&profile))
    }

    fn backup_plan(&self, profile_id: &str, postgres: Option<&PostgresProfile>) -> Result<BackupPlanState> {
        let workspace_path = self.backup_workspace_path()?;
        let db = self.connect()?;
        let mut plan = read_plan(&db, profile_id)?;
        if let Some(plan) = &mut plan {
            plan.requires_review = plan.workspace_path != workspace_path
                || plan.postgres_revision != postgres.map(|profile| profile.revision)
                || plan.tunnel.as_ref().is_some_and(|route| postgres.is_none_or(|profile| {
                    route.verify_saved(&db, &profile.project_id, &profile.settings.host, profile.settings.port).is_err()
                }));
        }
        let mut statement = db
            .prepare(&format!(
                "{RUN_SELECT} WHERE r.profile_id = ?1 ORDER BY r.started_at DESC, r.rowid DESC LIMIT 40"
            ))
            .map_err(db_error)?;
        let runs = statement
            .query_map(params![profile_id, workspace_path], run_from_row)
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        Ok(BackupPlanState { plan, runs })
    }

    pub fn expired_sqlite_backups(
        &self,
        profile_id: &str,
        before: Option<i64>,
    ) -> Result<ExpiredBackupPage> {
        let directory = self.backup_workspace_path()?;
        let db = self.connect()?;
        let mut statement = db
            .prepare(&format!(
            "{RUN_SELECT} WHERE r.profile_id=?1 AND r.workspace_path=?2 AND r.status='succeeded'
             AND a.file_id IS NOT NULL AND a.removed_at IS NULL AND r.expires_at<=?3
             AND (?4 IS NULL OR r.rowid<?4) ORDER BY r.rowid DESC LIMIT 41"
        ))
            .map_err(db_error)?;
        let mut results = statement
            .query_map(params![profile_id, directory, unix_now()?, before], |row| {
                Ok((row.get::<_, i64>(17)?, run_from_row(row)?))
            })
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        let next_before = if results.len() == 41 {
            results.pop();
            results.last().map(|(rowid, _)| *rowid)
        } else {
            None
        };
        let runs = results.into_iter().map(|(_, run)| run).collect();
        Ok(ExpiredBackupPage { runs, next_before })
    }

    pub fn save_sqlite_backup_plan(
        &self,
        profile_id: &str,
        input: BackupPlanWrite,
    ) -> Result<BackupPlanState> {
        self.save_backup_plan(profile_id, None, None, input)
    }

    pub fn save_postgres_backup_plan(&self, profile: &PostgresProfile, confirmation: &str, input: BackupPlanWrite, route: Option<(&SshTunnelManager, &BackupTunnelRoute)>) -> Result<BackupPlanState> {
        confirm_postgres(profile, confirmation)?;
        if !self.postgres_credential_status(profile)?.usable {
            return Err("예약 백업에는 이 PostgreSQL 연결의 Windows 자격 증명이 필요합니다.".into());
        }
        if let Some((manager, reviewed)) = route {
            manager.backup_tunnel(reviewed, &profile.project_id, &profile.settings.host, profile.settings.port)?;
        }
        self.save_backup_plan(&profile.id, Some(profile), route.map(|(_, reviewed)| reviewed), input)
    }

    fn save_backup_plan(&self, profile_id: &str, postgres: Option<&PostgresProfile>, route: Option<&BackupTunnelRoute>, input: BackupPlanWrite) -> Result<BackupPlanState> {
        let now = unix_now()?;
        let prefix = input.prefix.trim();
        if prefix.is_empty()
            || prefix.len() > 40
            || !prefix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(
                "백업 이름 접두어는 영문, 숫자, 하이픈, 밑줄을 사용해 1~40자로 입력하세요.".into(),
            );
        }
        if input
            .interval_minutes
            .is_some_and(|minutes| !(1..=43_200).contains(&minutes))
        {
            return Err("반복 간격은 1~43,200분으로 입력하세요.".into());
        }
        if !(1..=3_650).contains(&input.retention_days) {
            return Err("보존 기간은 1~3,650일로 입력하세요.".into());
        }
        if input
            .next_at
            .is_some_and(|at| at <= now || at > LATEST_START)
        {
            return Err("첫 예약은 현재보다 늦고 2100년 이전인 시각을 선택하세요.".into());
        }
        let directory = if postgres.is_some() {
            backup_directory(&input.directory)?.to_string_lossy().into_owned()
        } else {
            self.sqlite_backup_capacity(profile_id, &input.directory)?.directory
        };
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if let Some(expected) = postgres {
            if postgres::find_profile(&tx, profile_id)? != *expected {
                return Err("PostgreSQL 연결 설정이 변경되었습니다. 백업 계획을 다시 검토하세요.".into());
            }
            if let Some(route) = route {
                route.verify_saved(&tx, &expected.project_id, &expected.settings.host, expected.settings.port)?;
            }
        }
        if !active_profile(&tx, profile_id, postgres.is_some())? {
            return Err("활성 프로젝트의 연결을 선택하세요.".into());
        }
        let revision = read_plan(&tx, profile_id)?.map(|plan| plan.revision);
        if revision != input.revision {
            return Err(
                "다른 창에서 백업 계획을 수정했습니다. 새로고침하고 다시 저장하세요.".into(),
            );
        }
        let tunnel = route.map(serde_json::to_string).transpose()
            .map_err(|_| "백업 계획의 SSH 터널을 저장할 수 없습니다.")?;
        tx.execute(
            "INSERT INTO backup_plans
             (profile_id, revision, workspace_path, directory, prefix, interval_minutes, retention_days, retry_once, next_at,
              sqlite_profile_id, postgres_profile_id, postgres_revision, postgres_tunnel)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision, workspace_path=excluded.workspace_path,
             directory=excluded.directory, prefix=excluded.prefix, interval_minutes=excluded.interval_minutes,
             retention_days=excluded.retention_days, retry_once=excluded.retry_once, next_at=excluded.next_at, retry_at=NULL,
             postgres_revision=excluded.postgres_revision, postgres_tunnel=excluded.postgres_tunnel",
            params![profile_id, revision.unwrap_or(0) + 1, self.backup_workspace_path()?, directory,
                prefix, input.interval_minutes, input.retention_days, input.retry_once, input.next_at,
                postgres.is_none().then_some(profile_id), postgres.is_some().then_some(profile_id), postgres.map(|profile| profile.revision), tunnel],
        ).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        self.backup_plan(profile_id, postgres)
    }

    pub fn run_sqlite_backup_plan(&self, profile_id: &str, revision: i64) -> Result<BackupRun> {
        self.profile(profile_id)?;
        self.run_backup_plan(profile_id, revision, None, None)
    }

    pub fn run_postgres_backup_plan(&self, profile: &PostgresProfile, revision: i64, confirmation: &str, tunnels: &SshTunnelManager) -> Result<BackupRun> {
        confirm_postgres(profile, confirmation)?;
        if self.postgres_profile(&profile.id)? != *profile {
            return Err("PostgreSQL 연결 설정이 변경되었습니다. 백업 계획을 다시 검토하세요.".into());
        }
        self.run_backup_plan(&profile.id, revision, Some(profile.revision), Some(tunnels))
    }

    fn run_backup_plan(&self, profile_id: &str, revision: i64, postgres_revision: Option<i64>, tunnels: Option<&SshTunnelManager>) -> Result<BackupRun> {
        self.process_backup(Some((profile_id, revision, postgres_revision)), unix_now()?, tunnels)?
            .ok_or_else(|| "다른 백업 계획이 실행 중입니다. 완료된 뒤 다시 시도하세요.".into())
    }

    pub fn pause_sqlite_backup_plan(
        &self,
        profile_id: &str,
        revision: i64,
    ) -> Result<BackupPlanState> {
        self.profile(profile_id)?;
        self.pause_backup_plan(profile_id, revision, None)
    }

    pub fn pause_postgres_backup_plan(&self, profile_id: &str, revision: i64) -> Result<BackupPlanState> {
        let profile = self.postgres_profile(profile_id)?;
        self.pause_backup_plan(profile_id, revision, Some(&profile))
    }

    fn pause_backup_plan(&self, profile_id: &str, revision: i64, postgres: Option<&PostgresProfile>) -> Result<BackupPlanState> {
        let updated = self
            .connect()?
            .execute(
                "UPDATE backup_plans SET revision=revision+1, next_at=NULL, retry_at=NULL
             WHERE profile_id=?1 AND revision=?2",
                params![profile_id, revision],
            )
            .map_err(db_error)?;
        if updated != 1 {
            return Err("백업 계획이 변경되었습니다. 새로고침하고 다시 시도하세요.".into());
        }
        self.backup_plan(profile_id, postgres)
    }

    pub fn run_due_backup(&self, tunnels: &SshTunnelManager) -> Result<Option<BackupRun>> {
        self.process_backup(None, unix_now()?, Some(tunnels))
    }

    fn process_backup(
        &self,
        manual: Option<(&str, i64, Option<i64>)>,
        now: i64,
        tunnels: Option<&SshTunnelManager>,
    ) -> Result<Option<BackupRun>> {
        let workspace = self.backup_workspace_path()?;
        let mut db = self.connect()?;
        if manual.is_none() && due_profile(&db, &workspace, now)?.is_none() {
            let recovery: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM backup_runs WHERE workspace_path=?1 AND status='running')",
                [&workspace], |row| row.get(0),
            ).map_err(db_error)?;
            if !recovery {
                return Ok(None);
            }
        }
        let Some(_lock) = workspace_lock(Path::new(&workspace))? else {
            return Ok(None);
        };
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        // Holding the workspace lock proves no other process still owns a running job.
        tx.execute(
            "UPDATE backup_runs SET status='interrupted', finished_at=?1,
             message='이전 앱이 백업을 완료하기 전에 종료되었습니다. 생성된 파일이 있으면 별도로 검증하세요.'
             WHERE workspace_path=?2 AND status='running'",
            params![now, workspace],
        ).map_err(db_error)?;
        let profile_id = match manual {
            Some((id, _, _)) => id.to_owned(),
            None => match due_profile(&tx, &workspace, now)? {
                Some(id) => id,
                None => {
                    tx.commit().map_err(db_error)?;
                    return Ok(None);
                }
            },
        };
        let plan = read_plan(&tx, &profile_id)?.ok_or("백업 계획을 저장하세요.")?;
        let is_postgres = plan.postgres_revision.is_some();
        if !active_profile(&tx, &profile_id, is_postgres)?
            || plan.workspace_path != workspace
            || manual.is_some_and(|(_, revision, postgres_revision)| revision != plan.revision || postgres_revision != plan.postgres_revision)
        {
            return Err(
                "백업 계획의 연결 또는 설정이 변경되었습니다. 계획을 검토하고 다시 시도하세요."
                    .into(),
            );
        }

        let trigger_kind = if manual.is_some() {
            "manual"
        } else if plan
            .retry_at
            .is_some_and(|at| at <= now && plan.next_at.is_none_or(|next| at <= next))
        {
            tx.execute(
                "UPDATE backup_plans SET retry_at=NULL WHERE profile_id=?1",
                [&profile_id],
            )
            .map_err(db_error)?;
            "retry"
        } else {
            let due = plan.next_at.ok_or("실행할 예약을 찾을 수 없습니다.")?;
            let next_at = plan.interval_minutes.map(|minutes| {
                let period = minutes * 60;
                due + ((now - due) / period + 1) * period
            });
            tx.execute(
                "UPDATE backup_plans SET next_at=?2 WHERE profile_id=?1",
                params![profile_id, next_at],
            )
            .map_err(db_error)?;
            "scheduled"
        };
        let id = Uuid::new_v4().to_string();
        let timestamp =
            DateTime::<Utc>::from_timestamp(now, 0).ok_or("백업 시각을 확인할 수 없습니다.")?;
        let extension = if is_postgres { "backup" } else { "sqlite" };
        let destination = Path::new(&plan.directory).join(format!(
            "{}-{}-{id}.{extension}",
            plan.prefix,
            timestamp.format("%Y%m%dT%H%M%SZ")
        ));
        let path = destination.to_string_lossy();
        tx.execute(
            "INSERT INTO backup_runs (id, profile_id, workspace_path, trigger_kind, status, started_at, path)
             VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6)",
            params![id, profile_id, workspace, trigger_kind, now, path],
        ).map_err(db_error)?;
        tx.commit().map_err(db_error)?;

        let result = if let Some(revision) = plan.postgres_revision {
            self.execute_postgres_backup(&profile_id, revision, &plan.directory, &path, &id, plan.tunnel.as_ref(), tunnels)
        } else { self
            .sqlite_backup_capacity(&profile_id, &plan.directory)
            .and_then(|capacity| {
                if capacity.directory != plan.directory {
                    return Err(
                        "백업 폴더가 다른 위치를 가리킵니다. 계획에서 저장 폴더를 다시 확인하세요."
                            .into(),
                    );
                }
                if capacity
                    .available_bytes
                    .is_some_and(|available| available < capacity.estimated_bytes)
                {
                    return Err(
                        "백업 폴더의 여유 공간이 원본의 예상 백업 크기보다 작습니다.".into(),
                    );
                }
                let (report, evidence) = self.backup_sqlite_with(&profile_id, &path, backup_artifact::measure)?;
                Ok((report.size_bytes, evidence, rusqlite::version().to_owned(), report.audit_warning))
            }) };
        let finished_at = unix_now()?.max(now);
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let (status, expires_at, size_bytes, message, artifact) = match result {
            Ok((size_bytes, evidence, engine_version, warning)) => {
                tx.execute(
                    "INSERT INTO backup_artifacts (run_id, sha256, file_id, engine_version) VALUES (?1, ?2, ?3, ?4)",
                    params![id, evidence.sha256, evidence.file_id, engine_version],
                ).map_err(db_error)?;
                let artifact = ArtifactSummary {
                    sha256: evidence.sha256,
                    engine_version,
                    owned_here: true,
                    removal_supported: cfg!(windows) && evidence.file_id.is_some(),
                    verified_at: None,
                    removal_started_at: None,
                    removed_at: None,
                };
                (
                    "succeeded",
                    Some(finished_at + plan.retention_days * 86_400),
                    Some(size_bytes),
                    warning,
                    Some(artifact),
                )
            }
            Err(error) => {
                if trigger_kind == "scheduled"
                    && plan.retry_once
                    && matches!(destination.try_exists(), Ok(false))
                {
                    tx.execute(
                        "UPDATE backup_plans SET retry_at=?3 WHERE profile_id=?1 AND revision=?2 AND retry_at IS NULL",
                        params![profile_id, plan.revision, finished_at + RETRY_DELAY],
                    ).map_err(db_error)?;
                }
                ("failed", None, None, Some(error), None)
            }
        };
        let updated = tx.execute(
            "UPDATE backup_runs SET status=?2, finished_at=?3, expires_at=?4, size_bytes=?5, message=?6 WHERE id=?1",
            params![id, status, finished_at, expires_at, size_bytes, message],
        ).map_err(db_error)?;
        if updated != 1 {
            return Err(
                "백업 도중 연결이 삭제되었습니다. 생성된 파일이 있으면 백업 폴더에서 확인하세요."
                    .into(),
            );
        }
        tx.commit().map_err(db_error)?;
        Ok(Some(BackupRun {
            id,
            profile_id,
            status: status.into(),
            engine: engine_label(is_postgres),
            trigger_kind: trigger_kind.into(),
            started_at: now,
            finished_at: Some(finished_at),
            expires_at,
            path: path.into_owned(),
            size_bytes,
            message,
            artifact,
        }))
    }

    pub(crate) fn backup_workspace_path(&self) -> Result<String> {
        let path = self
            .path
            .canonicalize()
            .map_err(|_| "작업 공간의 위치를 확인할 수 없습니다.")?;
        Ok(path.to_string_lossy().into_owned())
    }
}

const RUN_SELECT: &str =
    "SELECT r.id, r.profile_id, r.status, r.trigger_kind, r.started_at, r.finished_at,
    r.expires_at, r.path, r.size_bytes, r.message, a.sha256, a.engine_version, a.verified_at,
    a.removal_started_at, a.removed_at, r.workspace_path = ?2, a.file_id IS NOT NULL, r.rowid, p.postgres_revision IS NOT NULL
    FROM backup_runs r JOIN backup_plans p ON p.profile_id=r.profile_id LEFT JOIN backup_artifacts a ON a.run_id = r.id";

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<BackupRun> {
    Ok(BackupRun {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        status: row.get(2)?,
        engine: engine_label(row.get(18)?),
        trigger_kind: row.get(3)?,
        started_at: row.get(4)?,
        finished_at: row.get(5)?,
        expires_at: row.get(6)?,
        path: row.get(7)?,
        size_bytes: row.get(8)?,
        message: row.get(9)?,
        artifact: backup_artifact::summary(row)?,
    })
}

fn read_plan(db: &Connection, profile_id: &str) -> Result<Option<BackupPlan>> {
    db.query_row(
        "SELECT revision, workspace_path, directory, prefix, interval_minutes, retention_days, retry_once, next_at, retry_at, postgres_revision, postgres_tunnel
         FROM backup_plans WHERE profile_id=?1",
        [profile_id], |row| Ok(BackupPlan {
            revision: row.get(0)?, workspace_path: row.get(1)?, directory: row.get(2)?, prefix: row.get(3)?,
            interval_minutes: row.get(4)?, retention_days: row.get(5)?, retry_once: row.get(6)?,
            next_at: row.get(7)?, retry_at: row.get(8)?, postgres_revision: row.get(9)?, requires_review: false,
            tunnel: row.get::<_, Option<String>>(10)?.map(|json| serde_json::from_str(&json)
                .map_err(|error| rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(error)))).transpose()?,
        }),
    ).optional().map_err(db_error)
}

pub(crate) fn active_profile(db: &Connection, profile_id: &str, postgres: bool) -> Result<bool> {
    let table = if postgres { "postgres_profiles" } else { "profiles" };
    db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} p WHERE p.id=?1
         AND NOT EXISTS(SELECT 1 FROM project_archives a WHERE a.project_id=p.project_id))"),
        [profile_id],
        |row| row.get(0),
    )
    .map_err(db_error)
}

fn due_profile(db: &Connection, workspace: &str, now: i64) -> Result<Option<String>> {
    db.query_row(
        "SELECT b.profile_id FROM backup_plans b LEFT JOIN profiles p ON p.id=b.sqlite_profile_id
         LEFT JOIN postgres_profiles pg ON pg.id=b.postgres_profile_id
         WHERE b.workspace_path=?1 AND (b.next_at<=?2 OR b.retry_at<=?2)
         AND NOT EXISTS(SELECT 1 FROM project_archives a WHERE a.project_id=coalesce(p.project_id, pg.project_id))
         ORDER BY min(coalesce(b.next_at, 9223372036854775807), coalesce(b.retry_at, 9223372036854775807)), b.profile_id LIMIT 1",
        params![workspace, now], |row| row.get(0),
    ).optional().map_err(db_error)
}

fn engine_label(postgres: bool) -> &'static str {
    if postgres { "PostgreSQL" } else { "SQLite" }
}

fn confirm_postgres(profile: &PostgresProfile, confirmation: &str) -> Result<()> {
    if profile.settings.environment == "PROD" && confirmation != "PROD" {
        return Err("운영 PostgreSQL 백업을 승인하려면 PROD를 입력하세요.".into());
    }
    Ok(())
}

pub(crate) fn confirm_backup_directory(directory: &str) -> Result<()> {
    if backup_directory(directory)? != Path::new(directory) {
        return Err("백업 폴더가 다른 위치를 가리킵니다. 계획에서 저장 폴더를 다시 확인하세요.".into());
    }
    Ok(())
}

fn capacity(directory: &Path, estimated_bytes: u64) -> Result<BackupCapacity> {
    Ok(BackupCapacity {
        directory: directory.to_string_lossy().into_owned(),
        estimated_bytes,
        available_bytes: free_space(directory)?,
    })
}

fn workspace_lock(workspace: &Path) -> Result<Option<File>> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(workspace.with_extension("backup.lock"))
        .map_err(|_| "백업 실행 잠금 파일을 열 수 없습니다.")?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(lock)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(_)) => Err("다른 앱과 백업 실행을 조정할 수 없습니다.".into()),
    }
}

pub(crate) fn unix_now() -> Result<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| i64::try_from(time.as_secs()).ok())
        .ok_or_else(|| "장치의 현재 시각을 확인하세요.".into())
}

fn backup_directory(value: &str) -> Result<PathBuf> {
    let path = Path::new(value.trim());
    if !path.is_absolute() {
        return Err("기존 백업 폴더의 절대 경로를 지정하세요.".into());
    }
    path.canonicalize()
        .ok()
        .filter(|directory| directory.is_dir())
        .ok_or_else(|| "백업 폴더를 열 수 없습니다. 경로와 권한을 확인하세요.".into())
}

#[cfg(windows)]
fn free_space(path: &Path) -> Result<Option<u64>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut directory: Vec<u16> = path.as_os_str().encode_wide().collect();
    if !directory.ends_with(&[b'\\' as u16]) {
        directory.push(b'\\' as u16);
    }
    directory.push(0);
    let mut available = 0;
    if unsafe {
        GetDiskFreeSpaceExW(
            directory.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err("백업 폴더의 사용 가능한 공간을 확인할 수 없습니다.".into());
    }
    Ok(Some(available))
}

#[cfg(not(windows))]
fn free_space(_: &Path) -> Result<Option<u64>> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        root: tempfile::TempDir,
        workspace: PathBuf,
        output: PathBuf,
        store: Store,
        profile_id: String,
        project_id: String,
        _source: Connection,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().join("workspace.sqlite");
            let output = root.path().join("backups");
            fs::create_dir(&output).unwrap();
            let store = Store::open(&workspace).unwrap();
            let project = store.create_project("예약 백업 검증").unwrap();
            let source_path = root.path().join("source.sqlite");
            let source = Connection::open(&source_path).unwrap();
            source
                .execute_batch(
                    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
                 CREATE TABLE document(id INTEGER PRIMARY KEY, value TEXT);
                 INSERT INTO document(value) VALUES ('검증 값');",
                )
                .unwrap();
            let profile = store
                .create_sqlite_profile(&project.id, "원본", source_path.to_str().unwrap(), "DEV")
                .unwrap();
            Self {
                root,
                workspace,
                output,
                store,
                profile_id: profile.id,
                project_id: project.id,
                _source: source,
            }
        }

        fn plan(&self, first: i64, interval: Option<i64>) {
            self.store
                .save_sqlite_backup_plan(
                    &self.profile_id,
                    BackupPlanWrite {
                        revision: None,
                        directory: self.output.to_str().unwrap().into(),
                        prefix: "fixture".into(),
                        interval_minutes: interval,
                        retention_days: 7,
                        retry_once: true,
                        next_at: Some(first),
                    },
                )
                .unwrap();
        }

        fn current(&self) -> BackupPlanState {
            self.store.sqlite_backup_plan(&self.profile_id).unwrap()
        }
    }

    #[test]
    fn due_schedule_survives_restart_and_coalesces_missed_intervals() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        f.plan(first, Some(1));
        let reopened = Store::open(&f.workspace).unwrap();
        assert!(reopened
            .process_backup(None, first - 1, None)
            .unwrap()
            .is_none());
        let overdue = first + 125;
        let run = reopened
            .process_backup(None, overdue, None)
            .unwrap()
            .unwrap();
        assert_eq!(run.status, "succeeded");
        assert_eq!(run.trigger_kind, "scheduled");
        assert_eq!(run.expires_at, Some(overdue + 7 * 86_400));
        assert_eq!(f.current().plan.unwrap().next_at, Some(first + 180));
        assert!(reopened
            .process_backup(None, overdue, None)
            .unwrap()
            .is_none());
        let backup = Connection::open(&run.path).unwrap();
        let value: String = backup
            .query_row("SELECT value FROM document", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "검증 값");
        assert_eq!(f.current().runs.len(), 1);
    }

    #[test]
    fn a_failed_one_shot_retries_once_and_can_be_paused_with_missing_storage() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        f.plan(first, None);
        let gone = f.root.path().join("removed-backups");
        fs::rename(&f.output, &gone).unwrap();
        let run = f.store.process_backup(None, first, None).unwrap().unwrap();
        assert_eq!(run.status, "failed");
        let plan = f.current().plan.unwrap();
        assert_eq!(plan.next_at, None);
        assert_eq!(plan.retry_at, Some(first + RETRY_DELAY));
        assert!(f
            .store
            .process_backup(None, first + RETRY_DELAY - 1, None)
            .unwrap()
            .is_none());
        fs::rename(&gone, &f.output).unwrap();
        let retry = f
            .store
            .process_backup(None, first + RETRY_DELAY, None)
            .unwrap()
            .unwrap();
        assert_eq!(
            (retry.trigger_kind.as_str(), retry.status.as_str()),
            ("retry", "succeeded")
        );
        assert_eq!(f.current().plan.unwrap().retry_at, None);
        assert!(f
            .store
            .process_backup(None, first + 180, None)
            .unwrap()
            .is_none());

        fs::rename(&f.output, &gone).unwrap();
        let paused = f
            .store
            .pause_sqlite_backup_plan(&f.profile_id, 1)
            .unwrap()
            .plan
            .unwrap();
        assert_eq!(
            (paused.revision, paused.next_at, paused.retry_at),
            (2, None, None)
        );
        assert!(f.store.run_sqlite_backup_plan(&f.profile_id, 1).is_err());
    }

    #[test]
    fn duplicate_workers_cannot_claim_and_an_orphaned_run_is_reported() {
        let f = Fixture::new();
        let now = unix_now().unwrap();
        f.plan(now + 120, None);
        let scope = f.store.backup_workspace_path().unwrap();
        let held = workspace_lock(Path::new(&scope)).unwrap().unwrap();
        f.store.connect().unwrap().execute(
            "INSERT INTO backup_runs (id, profile_id, workspace_path, trigger_kind, status, started_at, path)
             VALUES('orphan', ?1, ?2, 'manual', 'running', ?3, 'fixture.sqlite')",
            params![f.profile_id, scope, now]
        ).unwrap();
        let other = Store::open(&f.workspace).unwrap();
        assert!(other.run_sqlite_backup_plan(&f.profile_id, 1).is_err());
        assert!(other.process_backup(None, now, None).unwrap().is_none());
        assert_eq!(f.current().runs[0].status, "running");
        drop(held);
        assert!(other.process_backup(None, now, None).unwrap().is_none());
        assert_eq!(f.current().runs[0].status, "interrupted");
    }

    #[test]
    fn a_workspace_copy_requires_review_and_archival_skips_new_runs() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        f.plan(first, None);
        let cloned = f.root.path().join("copy.sqlite");
        fs::copy(&f.workspace, &cloned).unwrap();
        let copy = Store::open(&cloned).unwrap();
        assert!(
            copy.sqlite_backup_plan(&f.profile_id)
                .unwrap()
                .plan
                .unwrap()
                .requires_review
        );
        assert!(copy.process_backup(None, first, None).unwrap().is_none());
        assert!(copy.run_sqlite_backup_plan(&f.profile_id, 1).is_err());
        f.store.archive_project(&f.project_id).unwrap();
        assert!(f
            .store
            .process_backup(None, first, None)
            .unwrap()
            .is_none());
        assert!(f.store.run_sqlite_backup_plan(&f.profile_id, 1).is_err());
    }

    #[test]
    fn v24_postgres_plans_preserve_their_direct_route() {
        let f = Fixture::new();
        let profile = f.store.create_postgres_profile(&f.project_id, crate::PostgresProfileInput {
            name: "기존 PostgreSQL".into(), host: "localhost".into(), port: 5432,
            database: "postgres".into(), username: "test".into(), environment: "DEV".into(), ca_path: None,
        }).unwrap();
        let planned = unix_now().unwrap() + 180;
        {
            let db = f.store.connect().unwrap();
            db.execute(
                "INSERT INTO backup_plans (profile_id, postgres_profile_id, postgres_revision, revision, workspace_path,
                 directory, prefix, retention_days, retry_once, next_at) VALUES (?1, ?1, ?2, 1, ?3, ?4, 'original', 7, 1, ?5)",
                params![profile.id, profile.revision, f.store.backup_workspace_path().unwrap(), f.output.to_string_lossy(), planned],
            ).unwrap();
            db.execute_batch("ALTER TABLE backup_plans DROP COLUMN postgres_tunnel; PRAGMA user_version=24;").unwrap();
        }
        let migrated = Store::open(&f.workspace).unwrap();
        let plan = migrated.postgres_backup_plan(&profile.id).unwrap().plan.unwrap();
        assert_eq!(plan.next_at, Some(planned));
        assert_eq!(plan.postgres_revision, Some(profile.revision));
        assert!(!plan.requires_review);
        assert!(plan.tunnel.is_none());
    }

    #[test]
    fn v23_migration_preserves_plan_run_rowid_and_file_evidence() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        f.plan(first, Some(60));
        let run = f.store.process_backup(None, first, None).unwrap().unwrap();
        let rowid: i64;
        {
            let db = f.store.connect().unwrap();
            rowid = db.query_row("SELECT rowid FROM backup_runs WHERE id=?1", [&run.id], |row| row.get(0)).unwrap();
            db.execute_batch("CREATE TEMP TABLE saved_plans AS SELECT profile_id, revision, workspace_path, directory, prefix,
                interval_minutes, retention_days, retry_once, next_at, retry_at FROM backup_plans;
                CREATE TEMP TABLE saved_runs AS SELECT rowid AS original_rowid, * FROM backup_runs;
                CREATE TEMP TABLE saved_artifacts AS SELECT * FROM backup_artifacts;
                DROP TABLE backup_artifacts; DROP TABLE backup_runs; DROP TABLE backup_plans;
                CREATE TABLE backup_plans (profile_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL, workspace_path TEXT NOT NULL, directory TEXT NOT NULL, prefix TEXT NOT NULL,
                    interval_minutes INTEGER, retention_days INTEGER NOT NULL, retry_once INTEGER NOT NULL, next_at INTEGER, retry_at INTEGER);
                INSERT INTO backup_plans SELECT * FROM saved_plans;").unwrap();
            let (_, run_schema) = SCHEMA.split_once("CREATE TABLE IF NOT EXISTS backup_runs").unwrap();
            db.execute_batch(&format!("CREATE TABLE IF NOT EXISTS backup_runs{run_schema}")).unwrap();
            db.execute_batch(backup_artifact::SCHEMA).unwrap();
            db.execute_batch("INSERT INTO backup_runs (rowid, id, profile_id, workspace_path, trigger_kind, status, started_at,
                finished_at, expires_at, path, size_bytes, message) SELECT * FROM saved_runs;
                INSERT INTO backup_artifacts SELECT * FROM saved_artifacts;
                PRAGMA user_version=23;").unwrap();
        }
        let migrated = Store::open(&f.workspace).unwrap();
        let state = migrated.sqlite_backup_plan(&f.profile_id).unwrap();
        assert_eq!(state.plan.unwrap().next_at, Some(first + 3600));
        assert_eq!(state.runs[0].id, run.id);
        assert_eq!(state.runs[0].artifact.as_ref().unwrap().sha256, run.artifact.unwrap().sha256);
        let db = migrated.connect().unwrap();
        assert_eq!(db.query_row("SELECT rowid FROM backup_runs WHERE id=?1", [&run.id], |row| row.get::<_, i64>(0)).unwrap(), rowid);
        assert_eq!(db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert!(migrated.verify_sqlite_backup_file(&f.profile_id, &run.id).is_ok());
    }

    #[test]
    fn pre_v23_backup_history_is_preserved_without_inventing_creation_evidence() {
        let f = Fixture::new();
        f.plan(unix_now().unwrap() + 120, None);
        let run = f.store.run_sqlite_backup_plan(&f.profile_id, 1).unwrap();
        let db = f.store.connect().unwrap();
        db.execute_batch("DROP TABLE backup_artifacts; PRAGMA user_version=22;")
            .unwrap();
        drop(db);
        let reopened = Store::open(&f.workspace).unwrap();
        let history = reopened.sqlite_backup_plan(&f.profile_id).unwrap();
        assert_eq!(history.runs[0].path, run.path);
        assert!(history.runs[0].artifact.is_none());
        assert!(reopened
            .preview_sqlite_backup_removal(&f.profile_id, &run.id)
            .is_err());
        assert!(Path::new(&run.path).is_file());
    }

    #[cfg(windows)]
    #[test]
    fn expired_file_pages_reach_back_beyond_recent_runs_without_duplicates() {
        let f = Fixture::new();
        f.plan(unix_now().unwrap() + 120, None);
        let original = f.store.run_sqlite_backup_plan(&f.profile_id, 1).unwrap();
        let mut db = f.store.connect().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute(
            "UPDATE backup_runs SET expires_at=0 WHERE id=?1",
            [&original.id],
        )
        .unwrap();
        for i in 0..41 {
            let id = format!("backup-{i}");
            tx.execute(
                "INSERT INTO backup_runs(id, profile_id, workspace_path, trigger_kind, status, started_at, expires_at, path)
                 SELECT ?2, profile_id, workspace_path, 'manual', 'succeeded', started_at, 0, path FROM backup_runs WHERE id=?1",
                params![original.id, id],
            ).unwrap();
            tx.execute(
                "INSERT INTO backup_artifacts(run_id, sha256, file_id, engine_version)
                 SELECT ?2, sha256, file_id, engine_version FROM backup_artifacts WHERE run_id=?1",
                params![original.id, id],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        assert!(!f.current().runs.iter().any(|run| run.id == original.id));
        let first = f.store.expired_sqlite_backups(&f.profile_id, None).unwrap();
        assert_eq!(first.runs.len(), 40);
        let last = f
            .store
            .expired_sqlite_backups(&f.profile_id, first.next_before)
            .unwrap();
        assert_eq!(last.runs.len(), 2);
        assert!(last.next_before.is_none());
        assert_eq!(last.runs[1].id, original.id);
        assert!(!last
            .runs
            .iter()
            .any(|old| first.runs.iter().any(|new| new.id == old.id)));
    }

    #[cfg(windows)]
    #[test]
    fn retention_rechecks_identity_hash_links_and_confirmation_before_unlinking() {
        let f = Fixture::new();
        f.plan(unix_now().unwrap() + 120, None);
        let run = f.store.run_sqlite_backup_plan(&f.profile_id, 1).unwrap();
        let path = Path::new(&run.path);
        let original_bytes = fs::read(path).unwrap();
        assert!(f
            .store
            .verify_sqlite_backup_file(&f.profile_id, &run.id)
            .is_ok());
        let expired = || {
            f.store
                .preview_sqlite_backup_removal(&f.profile_id, &run.id)
        };
        assert!(expired().err().unwrap().contains("보존 기간"));
        f.store
            .connect()
            .unwrap()
            .execute("UPDATE backup_runs SET expires_at=0 WHERE id=?1", [&run.id])
            .unwrap();

        let preview = serde_json::to_value(expired().unwrap()).unwrap();
        let token = preview["token"].as_str().unwrap();
        assert!(f.store.remove_sqlite_backup_file(token, false).is_err());
        let mut changed = original_bytes.clone();
        *changed.last_mut().unwrap() ^= 1;
        fs::write(path, &changed).unwrap();
        assert!(f
            .store
            .remove_sqlite_backup_file(token, true)
            .err()
            .unwrap()
            .contains("변경"));
        assert_eq!(fs::read(path).unwrap(), changed);
        fs::write(path, &original_bytes).unwrap();
        assert!(f.store.remove_sqlite_backup_file(token, true).is_err());

        let preview = serde_json::to_value(expired().unwrap()).unwrap();
        let original = f.output.join("original.sqlite");
        fs::rename(path, &original).unwrap();
        fs::write(path, &original_bytes).unwrap();
        assert!(f
            .store
            .remove_sqlite_backup_file(preview["token"].as_str().unwrap(), true)
            .err()
            .unwrap()
            .contains("교체"));
        assert_eq!(fs::read(path).unwrap(), original_bytes);
        fs::remove_file(path).unwrap();
        fs::rename(&original, path).unwrap();

        let alias = f.output.join("alias.sqlite");
        fs::hard_link(path, &alias).unwrap();
        let preview = serde_json::to_value(expired().unwrap()).unwrap();
        assert!(f
            .store
            .remove_sqlite_backup_file(preview["token"].as_str().unwrap(), true)
            .err()
            .unwrap()
            .contains("하드 링크"));
        fs::remove_file(alias).unwrap();
        let preview = serde_json::to_value(expired().unwrap()).unwrap();
        f.store
            .remove_sqlite_backup_file(preview["token"].as_str().unwrap(), true)
            .unwrap();
        assert!(!path.exists());
        assert!(f.current().runs[0]
            .artifact
            .as_ref()
            .unwrap()
            .removed_at
            .is_some());
    }
}
