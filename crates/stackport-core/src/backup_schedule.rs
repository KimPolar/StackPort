//! Workspace scheduler for verified database backups.
mod calendar;
mod execution;

pub use calendar::{preview_backup_calendar, BackupCalendar, CalendarOccurrence};
pub(crate) use execution::{Execution, RunControl, Stop};
use calendar::CalendarSchedule;
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
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MAX_RETRIES: u8 = 5;
const DEFAULT_RETRY_DELAY_MINUTES: u16 = 1;
const DEFAULT_POSTGRES_TIMEOUT_SECONDS: u32 = 30 * 60;
const MAX_TIMEOUT_SECONDS: u32 = 86_400;
pub const MAX_CONCURRENT_BACKUPS: u8 = 4;
const LATEST_START: i64 = 4_102_444_800; // 2100-01-01 UTC
const NO_CALENDAR_OCCURRENCE: &str = "2100년까지 실행할 수 있는 달력 일정이 없습니다.";

pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS backup_execution_policy (
        id INTEGER PRIMARY KEY CHECK(id=1),
        revision INTEGER NOT NULL CHECK(revision>=1),
        max_concurrent INTEGER NOT NULL CHECK(max_concurrent BETWEEN 1 AND 4)
    );
    INSERT INTO backup_execution_policy (id, revision, max_concurrent) VALUES (1, 1, 1)
        ON CONFLICT(id) DO NOTHING;
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
        calendar TEXT CHECK (calendar IS NULL OR interval_minutes IS NULL),
        retention_days INTEGER NOT NULL,
        retry_limit INTEGER NOT NULL CHECK (retry_limit BETWEEN 0 AND 5),
        retry_delay_minutes INTEGER NOT NULL DEFAULT 1 CHECK (retry_delay_minutes BETWEEN 1 AND 1440),
        retry_attempt INTEGER NOT NULL DEFAULT 1 CHECK (retry_attempt BETWEEN 1 AND 5),
        timeout_seconds INTEGER NOT NULL DEFAULT 0 CHECK (timeout_seconds BETWEEN 0 AND 86400),
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
        retry_attempt INTEGER NOT NULL DEFAULT 1 CHECK (retry_attempt BETWEEN 1 AND 5),
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'interrupted', 'cancelled', 'timed_out')),
        worker_slot INTEGER CHECK(worker_slot BETWEEN 1 AND 4),
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
    let has_column = |table, column| db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
        params![table, column], |row| row.get::<_, bool>(0),
    ).map_err(db_error);
    if !has_column("backup_plans", "postgres_tunnel")? {
        db.execute_batch("ALTER TABLE backup_plans ADD COLUMN postgres_tunnel TEXT
            CHECK (postgres_tunnel IS NULL OR postgres_profile_id IS NOT NULL);").map_err(db_error)?;
    }
    if !has_column("backup_plans", "calendar")? {
        db.execute_batch("ALTER TABLE backup_plans ADD COLUMN calendar TEXT
            CHECK (calendar IS NULL OR interval_minutes IS NULL);").map_err(db_error)?;
    }
    if !has_column("backup_plans", "retry_limit")? {
        db.execute_batch("ALTER TABLE backup_plans RENAME COLUMN retry_once TO retry_limit;").map_err(db_error)?;
    }
    if !has_column("backup_plans", "retry_delay_minutes")? {
        db.execute_batch("ALTER TABLE backup_plans ADD COLUMN retry_delay_minutes INTEGER NOT NULL DEFAULT 1
            CHECK (retry_delay_minutes BETWEEN 1 AND 1440);").map_err(db_error)?;
    }
    if !has_column("backup_plans", "retry_attempt")? {
        db.execute_batch("ALTER TABLE backup_plans ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 1
            CHECK (retry_attempt BETWEEN 1 AND 5);").map_err(db_error)?;
    }
    if !has_column("backup_runs", "retry_attempt")? {
        db.execute_batch("ALTER TABLE backup_runs ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 1
            CHECK (retry_attempt BETWEEN 1 AND 5);").map_err(db_error)?;
    }
    if !has_column("backup_plans", "timeout_seconds")? {
        db.execute_batch("ALTER TABLE backup_plans ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 0
            CHECK (timeout_seconds BETWEEN 0 AND 86400);").map_err(db_error)?;
        db.execute("UPDATE backup_plans SET timeout_seconds=?1 WHERE postgres_profile_id IS NOT NULL",
            [DEFAULT_POSTGRES_TIMEOUT_SECONDS]).map_err(db_error)?;
    }
    if legacy {
        db.execute_batch("INSERT INTO backup_plans
            (profile_id, sqlite_profile_id, revision, workspace_path, directory, prefix, interval_minutes, retention_days, retry_limit, next_at, retry_at)
            SELECT profile_id, profile_id, revision, workspace_path, directory, prefix, interval_minutes, retention_days, retry_once, next_at, retry_at FROM legacy_backup_plans;
            INSERT INTO backup_runs (rowid, id, profile_id, workspace_path, trigger_kind, status, started_at, finished_at, expires_at, path, size_bytes, message)
            SELECT rowid, id, profile_id, workspace_path, trigger_kind, status, started_at, finished_at, expires_at, path, size_bytes, message FROM legacy_backup_runs;
            INSERT INTO backup_artifacts SELECT * FROM legacy_backup_artifacts;
            DROP TABLE legacy_backup_artifacts;
            DROP TABLE legacy_backup_runs;
            DROP TABLE legacy_backup_plans;").map_err(db_error)?;
    }
    let old_run_status: bool = db.query_row(
        "SELECT instr(sql, 'timed_out')=0 FROM sqlite_schema WHERE type='table' AND name='backup_runs'",
        [], |row| row.get(0),
    ).map_err(db_error)?;
    if old_run_status {
        db.execute_batch("ALTER TABLE backup_artifacts RENAME TO previous_backup_artifacts;
            ALTER TABLE backup_runs RENAME TO previous_backup_runs;
            DROP INDEX IF EXISTS backup_runs_recent;").map_err(db_error)?;
        db.execute_batch(SCHEMA).map_err(db_error)?;
        db.execute_batch(backup_artifact::SCHEMA).map_err(db_error)?;
        db.execute_batch("INSERT INTO backup_runs
            (rowid, id, profile_id, workspace_path, trigger_kind, retry_attempt, status, started_at, finished_at, expires_at, path, size_bytes, message)
            SELECT rowid, id, profile_id, workspace_path, trigger_kind, retry_attempt, status, started_at, finished_at,
                expires_at, path, size_bytes, message FROM previous_backup_runs;
            INSERT INTO backup_artifacts
            SELECT run_id, sha256, file_id, engine_version, verified_at, removal_started_at, removed_at FROM previous_backup_artifacts;
            DROP TABLE previous_backup_artifacts;
            DROP TABLE previous_backup_runs;").map_err(db_error)?;
    }
    if !has_column("backup_runs", "worker_slot")? {
        db.execute_batch("ALTER TABLE backup_runs ADD COLUMN worker_slot INTEGER
            CHECK(worker_slot BETWEEN 1 AND 4);").map_err(db_error)?;
    }
    db.execute_batch("
        CREATE UNIQUE INDEX IF NOT EXISTS backup_running_profile ON backup_runs(workspace_path, profile_id)
            WHERE status='running';
        CREATE UNIQUE INDEX IF NOT EXISTS backup_running_slot ON backup_runs(workspace_path, worker_slot)
            WHERE status='running' AND worker_slot IS NOT NULL;
    ").map_err(db_error)?;
    Ok(())
}

#[derive(Deserialize)]
pub struct BackupPlanWrite {
    revision: Option<i64>,
    directory: String,
    prefix: String,
    interval_minutes: Option<i64>,
    #[serde(default)]
    calendar: Option<BackupCalendar>,
    #[serde(default)]
    calendar_enabled: bool,
    retention_days: i64,
    #[serde(default)]
    retry_once: bool,
    retry_limit: Option<u8>,
    retry_delay_minutes: Option<u16>,
    timeout_seconds: Option<u32>,
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
    calendar: Option<BackupCalendar>,
    retention_days: i64,
    retry_once: bool,
    retry_limit: u8,
    retry_delay_minutes: u16,
    retry_attempt: Option<u8>,
    timeout_seconds: u32,
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
    can_cancel: bool,
    trigger_kind: String,
    retry_attempt: Option<u8>,
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
    execution_policy: BackupExecutionPolicy,
}

#[derive(Serialize)]
pub struct BackupExecutionPolicy {
    revision: i64,
    max_concurrent: u8,
    max_supported: u8,
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
        self.sqlite_backup_capacity_with(profile_id, directory, None)
    }

    fn sqlite_backup_capacity_with(
        &self,
        profile_id: &str,
        directory: &str,
        control: Option<&RunControl>,
    ) -> Result<BackupCapacity> {
        let profile = self.profile(profile_id)?;
        let directory = backup_directory(directory)?;
        let source = open_user_db(Path::new(&profile.path))?;
        // This read-only connection runs only the two fixed size PRAGMAs.
        source.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        let page_value = |pragma| {
            if let Some(control) = control {
                control.check()?;
                source.busy_timeout(control.bounded_wait(Duration::from_secs(5))).map_err(db_error)?;
            }
            source.pragma_query_value(None, pragma, |row| row.get::<_, u64>(0)).map_err(db_error)
        };
        let pages = page_value("page_count")?;
        let page_size = page_value("page_size")?;
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
        let mut runs = statement
            .query_map(params![profile_id, workspace_path], run_from_row)
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        for run in runs.iter_mut().filter(|run| run.status == "running") {
            run.can_cancel = self.backup_execution.for_run(profile_id, &run.id).is_some_and(|control| control.can_cancel());
        }
        let execution_policy = execution_policy(&db)?;
        Ok(BackupPlanState { plan, runs, execution_policy })
    }

    pub fn set_backup_concurrency(&self, revision: i64, max_concurrent: u8) -> Result<BackupExecutionPolicy> {
        if !(1..=MAX_CONCURRENT_BACKUPS).contains(&max_concurrent) {
            return Err("동시 백업 실행 한도는 1~4개로 설정하세요.".into());
        }
        self.connect()?.query_row(
            "UPDATE backup_execution_policy SET max_concurrent=?1, revision=revision+1 WHERE id=1 AND revision=?2
             RETURNING revision, max_concurrent",
            params![max_concurrent, revision], execution_policy_from_row,
        ).optional().map_err(db_error)?
            .ok_or_else(|| "다른 창에서 동시 실행 한도를 변경했습니다. 값을 확인하고 다시 선택하세요.".into())
    }

    pub fn cancel_backup_plan_run(&self, profile_id: &str, run_id: &str) -> bool {
        self.backup_execution.for_run(profile_id, run_id).is_some_and(|control| control.request_cancel())
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
        let retry_limit = input.retry_limit.unwrap_or(u8::from(input.retry_once));
        let retry_delay_minutes = input.retry_delay_minutes.unwrap_or(DEFAULT_RETRY_DELAY_MINUTES);
        if retry_limit > MAX_RETRIES || !(1..=1_440).contains(&retry_delay_minutes) {
            return Err("재시도는 최대 5회, 간격은 1~1,440분으로 입력하세요.".into());
        }
        if input.timeout_seconds.is_some_and(|seconds| seconds > MAX_TIMEOUT_SECONDS) {
            return Err("최대 실행 시간은 0~86,400초로 입력하세요.".into());
        }
        if input.calendar.is_some() && (input.next_at.is_some() || input.interval_minutes.is_some()) {
            return Err("달력 일정과 단발·간격 예약은 함께 저장할 수 없습니다.".into());
        }
        if input.calendar.is_none() && input.calendar_enabled {
            return Err("달력 예약을 사용하려면 cron 식과 시간대를 입력하세요.".into());
        }
        if input
            .next_at
            .is_some_and(|at| at <= now || at > LATEST_START)
        {
            return Err("첫 예약은 현재보다 늦고 2100년 이전인 시각을 선택하세요.".into());
        }
        let next_at = match &input.calendar {
            Some(calendar) => {
                let next = CalendarSchedule::parse(calendar)?.next_after(now)?.ok_or(NO_CALENDAR_OCCURRENCE)?;
                input.calendar_enabled.then_some(next.at)
            }
            None => input.next_at,
        };
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
        let previous = read_plan(&tx, profile_id)?;
        let revision = previous.as_ref().map(|plan| plan.revision);
        if revision != input.revision {
            return Err(
                "다른 창에서 백업 계획을 수정했습니다. 새로고침하고 다시 저장하세요.".into(),
            );
        }
        let tunnel = route.map(serde_json::to_string).transpose()
            .map_err(|_| "백업 계획의 SSH 터널을 저장할 수 없습니다.")?;
        let calendar = input.calendar.as_ref().map(serde_json::to_string).transpose()
            .map_err(|_| "백업 달력 일정을 저장할 수 없습니다.")?;
        let timeout_seconds = input.timeout_seconds.or_else(|| previous.map(|plan| plan.timeout_seconds))
            .unwrap_or(if postgres.is_some() { DEFAULT_POSTGRES_TIMEOUT_SECONDS } else { 0 });
        tx.execute(
            "INSERT INTO backup_plans
             (profile_id, revision, workspace_path, directory, prefix, interval_minutes, retention_days, retry_limit, next_at,
              sqlite_profile_id, postgres_profile_id, postgres_revision, postgres_tunnel, calendar, retry_delay_minutes, timeout_seconds)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision, workspace_path=excluded.workspace_path,
             directory=excluded.directory, prefix=excluded.prefix, interval_minutes=excluded.interval_minutes,
             retention_days=excluded.retention_days, retry_limit=excluded.retry_limit, retry_delay_minutes=excluded.retry_delay_minutes,
             next_at=excluded.next_at, retry_at=NULL, retry_attempt=1, timeout_seconds=excluded.timeout_seconds,
             postgres_revision=excluded.postgres_revision, postgres_tunnel=excluded.postgres_tunnel, calendar=excluded.calendar",
            params![profile_id, revision.unwrap_or(0) + 1, self.backup_workspace_path()?, directory,
                prefix, input.interval_minutes, input.retention_days, retry_limit, next_at,
                postgres.is_none().then_some(profile_id), postgres.is_some().then_some(profile_id), postgres.map(|profile| profile.revision), tunnel, calendar, retry_delay_minutes, timeout_seconds],
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
            .ok_or_else(|| "작업 공간의 동시 백업 실행 한도에 도달했습니다. 완료된 뒤 다시 시도하세요.".into())
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
                "UPDATE backup_plans SET revision=revision+1, next_at=NULL, retry_at=NULL, retry_attempt=1
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
        // Older app instances take this same lock exclusively. Hold a shared lock so they cannot
        // recover or run jobs while workers of this version are active.
        let Some(_compatibility_lock) = backup_lock(&Path::new(&workspace).with_extension("backup.lock"), true)? else {
            return Ok(None);
        };
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let slots = (1..=MAX_CONCURRENT_BACKUPS)
            .map(|slot| backup_lock(&worker_lock_path(Path::new(&workspace), slot), false))
            .collect::<Result<Vec<_>>>()?;
        recover_backup_runs(&tx, &workspace, now, &slots)?;
        let occupied = slots.iter().filter(|slot| slot.is_none()).count();
        let profile_id = match manual {
            Some((id, _, _)) => {
                let running: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM backup_runs WHERE profile_id=?1 AND workspace_path=?2 AND status='running')",
                    params![id, workspace], |row| row.get(0),
                ).map_err(db_error)?;
                if running {
                    tx.commit().map_err(db_error)?;
                    return Err("이 연결의 백업이 이미 실행 중입니다.".into());
                }
                id.to_owned()
            }
            None => match due_profile(&tx, &workspace, now)? {
                Some(id) => id,
                None => {
                    tx.commit().map_err(db_error)?;
                    return Ok(None);
                }
            },
        };
        if occupied >= usize::from(execution_policy(&tx)?.max_concurrent) {
            tx.commit().map_err(db_error)?;
            return Ok(None);
        }
        let (worker_slot, _worker_lock) = (1..=MAX_CONCURRENT_BACKUPS).zip(slots)
            .find_map(|(slot, lock)| lock.map(|lock| (slot, lock)))
            .ok_or("사용 가능한 백업 실행 잠금을 찾을 수 없습니다.")?;
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

        let calendar = plan.calendar.as_ref().map(CalendarSchedule::parse).transpose()?;
        if manual.is_none() {
            if let Some(schedule) = &calendar {
                if schedule.is_excluded(now)? {
                    let next_at = if plan.next_at.is_some() { schedule.next_after(now)?.map(|next| next.at) } else { None };
                    tx.execute("UPDATE backup_plans SET next_at=?2, retry_at=NULL, retry_attempt=1 WHERE profile_id=?1",
                        params![profile_id, next_at]).map_err(db_error)?;
                    tx.commit().map_err(db_error)?;
                    return Ok(None);
                }
            }
        }

        let (trigger_kind, retry_attempt) = if manual.is_some() {
            ("manual", None)
        } else if plan
            .retry_at
            .is_some_and(|at| at <= now && plan.next_at.is_none_or(|next| at <= next))
        {
            tx.execute(
                "UPDATE backup_plans SET retry_at=NULL, retry_attempt=1 WHERE profile_id=?1",
                [&profile_id],
            )
            .map_err(db_error)?;
            ("retry", plan.retry_attempt)
        } else {
            let due = plan.next_at.ok_or("실행할 예약을 찾을 수 없습니다.")?;
            let next_at = if let Some(schedule) = &calendar {
                schedule.next_after(now)?.map(|next| next.at)
            } else {
                plan.interval_minutes.map(|minutes| {
                    let period = minutes * 60;
                    due + ((now - due) / period + 1) * period
                })
            };
            tx.execute(
                "UPDATE backup_plans SET next_at=?2 WHERE profile_id=?1",
                params![profile_id, next_at],
            )
            .map_err(db_error)?;
            ("scheduled", None)
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
            "INSERT INTO backup_runs (id, profile_id, workspace_path, trigger_kind, status, started_at, path, retry_attempt, worker_slot)
             VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7, ?8)",
            params![id, profile_id, workspace, trigger_kind, now, path, retry_attempt.unwrap_or(1), worker_slot],
        ).map_err(db_error)?;
        let registration = self.backup_execution.start(&profile_id, &id, plan.timeout_seconds);
        let control = &registration.control;
        tx.commit().map_err(db_error)?;

        let result = if let Some(revision) = plan.postgres_revision {
            self.execute_postgres_backup(&profile_id, revision, &plan.directory, &path, &id, plan.tunnel.as_ref(), tunnels, control)
        } else { control.check()
            .and_then(|()| self.sqlite_backup_capacity_with(&profile_id, &plan.directory, Some(control)))
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
                let (report, evidence) = self.backup_sqlite_with(&profile_id, &path, Some(control),
                    |file| backup_artifact::measure(file, || control.check()))?;
                Ok((report.size_bytes, evidence, rusqlite::version().to_owned(), report.audit_warning))
            }) };
        let result = control.finish().and(result);
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
            Err(error) if control.stopped() == Some(Stop::Cancelled) => ("cancelled", None, None, Some(error), None),
            Err(error) => {
                let next_retry = match trigger_kind {
                    "scheduled" => Some(1),
                    "retry" => retry_attempt.map(|attempt| attempt.saturating_add(1)),
                    _ => None,
                };
                if let Some(attempt) = next_retry.filter(|attempt| *attempt <= plan.retry_limit) {
                    let retry_at = finished_at + i64::from(plan.retry_delay_minutes) * 60;
                    let excluded = calendar.as_ref().map(|rule| rule.is_excluded(retry_at)).transpose()?.unwrap_or(false);
                    if !excluded && matches!(destination.try_exists(), Ok(false)) {
                        tx.execute(
                            "UPDATE backup_plans SET retry_at=?3, retry_attempt=?4 WHERE profile_id=?1 AND revision=?2 AND retry_at IS NULL",
                            params![profile_id, plan.revision, retry_at, attempt],
                        ).map_err(db_error)?;
                    }
                }
                if control.stopped() == Some(Stop::TimedOut) {
                    ("timed_out", None, None, Some(format!("백업 실행 제한 시간({}초)을 초과했습니다.", plan.timeout_seconds)), None)
                } else {
                    ("failed", None, None, Some(error), None)
                }
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
            can_cancel: false,
            trigger_kind: trigger_kind.into(),
            retry_attempt,
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
    a.removal_started_at, a.removed_at, r.workspace_path = ?2, a.file_id IS NOT NULL, r.rowid, p.postgres_revision IS NOT NULL,
    CASE WHEN r.trigger_kind='retry' THEN r.retry_attempt END
    FROM backup_runs r JOIN backup_plans p ON p.profile_id=r.profile_id LEFT JOIN backup_artifacts a ON a.run_id = r.id";

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<BackupRun> {
    Ok(BackupRun {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        status: row.get(2)?,
        engine: engine_label(row.get(18)?),
        can_cancel: false,
        trigger_kind: row.get(3)?,
        retry_attempt: row.get(19)?,
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
        "SELECT revision, workspace_path, directory, prefix, interval_minutes, retention_days, retry_limit, next_at,
                retry_at, postgres_revision, postgres_tunnel, calendar, retry_delay_minutes, CASE WHEN retry_at IS NOT NULL THEN retry_attempt END, timeout_seconds
         FROM backup_plans WHERE profile_id=?1",
        [profile_id], |row| Ok(BackupPlan {
            revision: row.get(0)?, workspace_path: row.get(1)?, directory: row.get(2)?, prefix: row.get(3)?,
            interval_minutes: row.get(4)?, retention_days: row.get(5)?, retry_once: row.get::<_, u8>(6)? > 0,
            retry_limit: row.get(6)?, retry_delay_minutes: row.get(12)?, retry_attempt: row.get(13)?, timeout_seconds: row.get(14)?,
            next_at: row.get(7)?, retry_at: row.get(8)?, postgres_revision: row.get(9)?, requires_review: false,
            tunnel: row.get::<_, Option<String>>(10)?.map(|json| serde_json::from_str(&json)
                .map_err(|error| rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(error)))).transpose()?,
            calendar: row.get::<_, Option<String>>(11)?.map(|json| serde_json::from_str(&json)
                .map_err(|error| rusqlite::Error::FromSqlConversionFailure(11, rusqlite::types::Type::Text, Box::new(error)))).transpose()?,
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
         AND NOT EXISTS(SELECT 1 FROM backup_runs r WHERE r.profile_id=b.profile_id AND r.workspace_path=?1 AND r.status='running')
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

fn execution_policy(db: &Connection) -> Result<BackupExecutionPolicy> {
    db.query_row(
        "SELECT revision, max_concurrent FROM backup_execution_policy WHERE id=1",
        [], execution_policy_from_row,
    ).map_err(db_error)
}

fn execution_policy_from_row(row: &Row<'_>) -> rusqlite::Result<BackupExecutionPolicy> {
    Ok(BackupExecutionPolicy { revision: row.get(0)?, max_concurrent: row.get(1)?, max_supported: MAX_CONCURRENT_BACKUPS })
}

fn recover_backup_runs(db: &Connection, workspace: &str, now: i64, slots: &[Option<File>]) -> Result<()> {
    let mut statement = db.prepare("SELECT id, worker_slot FROM backup_runs WHERE workspace_path=?1 AND status='running'")
        .map_err(db_error)?;
    let candidates = statement.query_map([workspace], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<u8>>(1)?)))
        .map_err(db_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)?;
    for (id, slot) in candidates {
        // A slot lock we acquired proves that no worker owns the recorded run.
        let owner_absent = slot.and_then(|slot| slots.get(usize::from(slot.saturating_sub(1)))).is_none_or(Option::is_some);
        if owner_absent {
            db.execute("UPDATE backup_runs SET status='interrupted', finished_at=?1,
                message='이전 앱이 백업을 완료하기 전에 종료되었습니다. 생성된 파일이 있으면 별도로 검증하세요.' WHERE id=?2",
                params![now, id]).map_err(db_error)?;
        }
    }
    Ok(())
}

fn worker_lock_path(workspace: &Path, slot: u8) -> PathBuf {
    let mut path = workspace.as_os_str().to_owned();
    path.push(format!(".backup-worker-{slot}.lock"));
    path.into()
}

fn backup_lock(path: &Path, shared: bool) -> Result<Option<File>> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "백업 실행 잠금 파일을 열 수 없습니다.")?;
    let result = if shared { lock.try_lock_shared() } else { lock.try_lock() };
    match result {
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
                .save_sqlite_backup_plan(&self.profile_id, self.plan_input(first, interval))
                .unwrap();
        }

        fn plan_input(&self, first: i64, interval: Option<i64>) -> BackupPlanWrite {
            BackupPlanWrite {
                revision: None,
                directory: self.output.to_str().unwrap().into(),
                prefix: "fixture".into(),
                interval_minutes: interval,
                calendar: None,
                calendar_enabled: false,
                retention_days: 7,
                retry_once: true,
                retry_limit: None,
                retry_delay_minutes: None,
                timeout_seconds: None,
                next_at: Some(first),
            }
        }

        fn current(&self) -> BackupPlanState {
            self.store.sqlite_backup_plan(&self.profile_id).unwrap()
        }
    }

    fn wait_for_active(store: &Store, profile_id: &str) -> BackupRun {
        let started = std::time::Instant::now();
        loop {
            let state = store.sqlite_backup_plan(profile_id).unwrap();
            if let Some(run) = state.runs.into_iter().find(|run| run.can_cancel) {
                return run;
            }
            assert!(started.elapsed() < Duration::from_secs(3));
            std::thread::sleep(Duration::from_millis(10));
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
        let retry_delay = i64::from(DEFAULT_RETRY_DELAY_MINUTES) * 60;
        let first = unix_now().unwrap() + 120;
        f.plan(first, None);
        let gone = f.root.path().join("removed-backups");
        fs::rename(&f.output, &gone).unwrap();
        let run = f.store.process_backup(None, first, None).unwrap().unwrap();
        assert_eq!(run.status, "failed");
        let plan = f.current().plan.unwrap();
        assert_eq!(plan.next_at, None);
        assert_eq!(plan.retry_at, Some(first + retry_delay));
        assert!(f
            .store
            .process_backup(None, first + retry_delay - 1, None)
            .unwrap()
            .is_none());
        fs::rename(&gone, &f.output).unwrap();
        let retry = f
            .store
            .process_backup(None, first + retry_delay, None)
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
        let held = backup_lock(&Path::new(&scope).with_extension("backup.lock"), false).unwrap().unwrap();
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
    fn active_profiles_share_the_workspace_limit_and_only_abandoned_slots_are_recovered() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        f.plan(first, Some(60));
        let add_profile = |name, due| {
            let path = f.root.path().join(format!("{name}.sqlite"));
            let source = Connection::open(&path).unwrap();
            source.execute_batch("CREATE TABLE document(value TEXT); INSERT INTO document VALUES ('extra');").unwrap();
            let profile = f.store.create_sqlite_profile(&f.project_id, name, path.to_str().unwrap(), "DEV").unwrap();
            f.store.save_sqlite_backup_plan(&profile.id, f.plan_input(due, None)).unwrap();
            (profile.id, source)
        };
        let (second, second_source) = add_profile("second", first + 1);
        let (third, _third_source) = add_profile("third", first + 2);
        let other = Store::open(&f.workspace).unwrap();
        let policy = f.current().execution_policy;
        assert_eq!(policy.max_concurrent, 1);
        assert!(other.set_backup_concurrency(policy.revision, MAX_CONCURRENT_BACKUPS + 1).is_err());
        let enabled = other.set_backup_concurrency(policy.revision, 2).unwrap();
        assert!(f.store.set_backup_concurrency(policy.revision, 1).is_err());
        assert_eq!(f.current().execution_policy.max_concurrent, 2);

        f._source.execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;").unwrap();
        second_source.execute_batch("BEGIN EXCLUSIVE;").unwrap();
        let work = f.store.clone();
        let first_task = std::thread::spawn(move || work.process_backup(None, first + 2, None).unwrap().unwrap());
        let first_run = wait_for_active(&f.store, &f.profile_id);
        let work = f.store.clone();
        let second_task = std::thread::spawn(move || work.process_backup(None, first + 2, None).unwrap().unwrap());
        let second_run = wait_for_active(&f.store, &second);
        assert!(f.current().runs[0].can_cancel);
        assert!(!other.sqlite_backup_plan(&second).unwrap().runs[0].can_cancel);
        assert!(other.run_sqlite_backup_plan(&f.profile_id, 1).err().unwrap().contains("이미 실행 중"));
        assert!(other.run_sqlite_backup_plan(&third, 1).err().unwrap().contains("실행 한도"));

        let scope = f.store.backup_workspace_path().unwrap();
        other.connect().unwrap().execute(
            "INSERT INTO backup_runs (id, profile_id, workspace_path, trigger_kind, status, started_at, path, worker_slot)
             VALUES ('orphaned-slot', ?1, ?2, 'manual', 'running', ?3, 'missing.sqlite', 3)",
            params![third, scope, first],
        ).unwrap();
        assert!(other.process_backup(None, first + 2, None).unwrap().is_none());
        let waiting = other.sqlite_backup_plan(&third).unwrap();
        assert_eq!(waiting.runs[0].status, "interrupted");
        assert_eq!(waiting.plan.unwrap().next_at, Some(first + 2));
        assert_eq!(f.current().runs[0].status, "running");
        assert_eq!(other.sqlite_backup_plan(&second).unwrap().runs[0].status, "running");

        other.set_backup_concurrency(enabled.revision, 1).unwrap();
        assert!(f.store.cancel_backup_plan_run(&f.profile_id, &first_run.id));
        f._source.execute_batch("ROLLBACK").unwrap();
        assert_eq!(first_task.join().unwrap().status, "cancelled");
        assert!(other.process_backup(None, first + 2, None).unwrap().is_none());
        assert!(f.store.cancel_backup_plan_run(&second, &second_run.id));
        second_source.execute_batch("ROLLBACK").unwrap();
        assert_eq!(second_task.join().unwrap().status, "cancelled");
        let third_run = other.process_backup(None, first + 2, None).unwrap().unwrap();
        assert_eq!((third_run.profile_id, third_run.status.as_str()), (third, "succeeded"));
    }

    #[test]
    fn scheduled_cancellation_is_scoped_and_does_not_queue_a_retry() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        f.plan(first, Some(60));
        f._source.execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;").unwrap();
        let worker = f.store.clone();
        let task = std::thread::spawn(move || worker.process_backup(None, first, None).unwrap().unwrap());
        let active = wait_for_active(&f.store, &f.profile_id);
        let another_instance = Store::open(&f.workspace).unwrap();
        assert!(!another_instance.sqlite_backup_plan(&f.profile_id).unwrap().runs[0].can_cancel);
        assert!(!another_instance.cancel_backup_plan_run(&f.profile_id, &active.id));
        assert!(!f.store.cancel_backup_plan_run("other-profile", &active.id));
        assert!(f.store.cancel_backup_plan_run(&f.profile_id, &active.id));
        assert!(!f.store.cancel_backup_plan_run(&f.profile_id, &active.id));
        f._source.execute_batch("ROLLBACK").unwrap();
        let run = task.join().unwrap();
        assert_eq!(run.id, active.id);
        assert_eq!(run.status, "cancelled");
        assert!(run.artifact.is_none());
        assert_eq!(fs::read_dir(&f.output).unwrap().count(), 0);
        let reopened = Store::open(&f.workspace).unwrap().sqlite_backup_plan(&f.profile_id).unwrap();
        assert_eq!(reopened.runs[0].status, "cancelled");
        let plan = reopened.plan.unwrap();
        assert_eq!(plan.retry_at, None);
        assert_eq!(plan.next_at, Some(first + 3600));
    }

    #[test]
    fn scheduled_timeout_survives_an_older_plan_edit_and_retries_with_a_fresh_deadline() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        let mut input = f.plan_input(first, Some(60));
        input.timeout_seconds = Some(MAX_TIMEOUT_SECONDS + 1);
        assert!(f.store.save_sqlite_backup_plan(&f.profile_id, input).is_err());
        let mut input = f.plan_input(first, Some(60));
        input.timeout_seconds = Some(1);
        f.store.save_sqlite_backup_plan(&f.profile_id, input).unwrap();
        let mut legacy_edit = f.plan_input(first, Some(60));
        legacy_edit.revision = Some(1);
        let saved = f.store.save_sqlite_backup_plan(&f.profile_id, legacy_edit).unwrap();
        assert_eq!(saved.plan.unwrap().timeout_seconds, 1);

        f._source.execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;").unwrap();
        let started = std::time::Instant::now();
        let run = f.store.process_backup(None, first, None).unwrap().unwrap();
        f._source.execute_batch("ROLLBACK").unwrap();
        assert!(started.elapsed() < Duration::from_secs(4));
        assert_eq!(run.status, "timed_out");
        assert!(run.message.unwrap().contains("(1초)"));
        assert!(run.artifact.is_none());
        assert_eq!(fs::read_dir(&f.output).unwrap().count(), 0);
        assert!(!f.store.cancel_backup_plan_run(&f.profile_id, &run.id));

        let reopened = Store::open(&f.workspace).unwrap();
        let state = reopened.sqlite_backup_plan(&f.profile_id).unwrap();
        assert_eq!(state.runs[0].status, "timed_out");
        let plan = state.plan.unwrap();
        assert_eq!(plan.timeout_seconds, 1);
        assert_eq!(plan.next_at, Some(first + 3600));
        assert_eq!(plan.retry_at, Some(run.finished_at.unwrap() + 60));
        let retry = reopened.process_backup(None, plan.retry_at.unwrap(), None).unwrap().unwrap();
        assert_eq!((retry.status.as_str(), retry.trigger_kind.as_str()), ("succeeded", "retry"));
        assert!(retry.artifact.is_some());
        assert_eq!(reopened.sqlite_backup_plan(&f.profile_id).unwrap().plan.unwrap().retry_at, None);
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
    fn multiple_retries_respect_the_configured_delay_and_limit_after_reopen() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        let input = serde_json::from_value(serde_json::json!({
            "revision": null, "directory": f.output, "prefix": "retry", "retention_days": 7,
            "retry_limit": 2, "retry_delay_minutes": 3, "next_at": first
        })).unwrap();
        f.store.save_sqlite_backup_plan(&f.profile_id, input).unwrap();
        std::fs::rename(&f.output, f.root.path().join("unavailable")).unwrap();
        let failed = f.store.process_backup(None, first, None).unwrap().unwrap();
        assert_eq!(failed.retry_attempt, None);
        assert_eq!(failed.status, "failed");
        let first_retry = failed.finished_at.unwrap() + 180;
        let waiting = f.current().plan.unwrap();
        assert_eq!((waiting.retry_at, waiting.retry_attempt), (Some(first_retry), Some(1)));
        assert!(f.store.process_backup(None, first_retry - 1, None).unwrap().is_none());
        let retried = f.store.process_backup(None, first_retry, None).unwrap().unwrap();
        assert_eq!((retried.status.as_str(), retried.retry_attempt), ("failed", Some(1)));
        let second_retry = retried.finished_at.unwrap() + 180;
        let reopened = Store::open(&f.workspace).unwrap();
        let config = reopened.sqlite_backup_plan(&f.profile_id).unwrap().plan.unwrap();
        assert_eq!((config.retry_at, config.retry_attempt), (Some(second_retry), Some(2)));
        let last = reopened.process_backup(None, second_retry, None).unwrap().unwrap();
        assert_eq!((last.status.as_str(), last.retry_attempt), ("failed", Some(2)));
        assert!(reopened.process_backup(None, second_retry + 720, None).unwrap().is_none());
        let final_state = f.current();
        assert_eq!(final_state.runs.iter().map(|run| run.retry_attempt).collect::<Vec<_>>(), [Some(2), Some(1), None]);
        assert_eq!(final_state.plan.unwrap().retry_at, None);
    }

    #[test]
    fn migration_from_v26_keeps_pending_retries_and_marks_legacy_retry_history() {
        let f = Fixture::new();
        let due = unix_now().unwrap() + 120;
        f.plan(due, None);
        let db = f.store.connect().unwrap();
        db.execute("UPDATE backup_plans SET next_at=NULL, retry_at=?2 WHERE profile_id=?1",
            params![f.profile_id, due]).unwrap();
        db.execute("INSERT INTO backup_runs (id, profile_id, workspace_path, trigger_kind, status, started_at, path)
            VALUES ('retry-fixture', ?1, ?2, 'retry', 'failed', ?3, 'fixture')",
            params![f.profile_id, f.store.backup_workspace_path().unwrap(), due - 60]).unwrap();
        db.execute_batch("ALTER TABLE backup_plans RENAME COLUMN retry_limit TO retry_once;
            ALTER TABLE backup_plans DROP COLUMN retry_delay_minutes;
            ALTER TABLE backup_plans DROP COLUMN retry_attempt;
            ALTER TABLE backup_runs DROP COLUMN retry_attempt;
            PRAGMA user_version=26;").unwrap();
        drop(db);
        let migrated = Store::open(&f.workspace).unwrap();
        let state = migrated.sqlite_backup_plan(&f.profile_id).unwrap();
        let plan = state.plan.unwrap();
        assert_eq!((plan.retry_limit, plan.retry_delay_minutes, plan.retry_at, plan.retry_attempt), (1, 1, Some(due), Some(1)));
        assert_eq!(state.runs[0].retry_attempt, Some(1));
    }

    #[test]
    fn calendar_plan_reopens_and_advances_past_missed_minutes() {
        let f = Fixture::new();
        let input = serde_json::from_value(serde_json::json!({
            "revision": null, "directory": f.output, "prefix": "calendar", "retention_days": 7,
            "retry_once": true, "calendar_enabled": true,
            "calendar": { "expression": "* * * * *", "time_zone": "UTC" }
        })).unwrap();
        let saved = f.store.save_sqlite_backup_plan(&f.profile_id, input).unwrap().plan.unwrap();
        let first = saved.next_at.unwrap();
        let reopened = Store::open(&f.workspace).unwrap();
        let run = reopened.process_backup(None, first + 212, None).unwrap().unwrap();
        assert_eq!(run.status, "succeeded");
        assert_eq!(run.trigger_kind, "scheduled");
        assert!(reopened.process_backup(None, first + 212, None).unwrap().is_none());
        let current = f.current();
        assert_eq!(current.runs.len(), 1);
        assert_eq!(current.plan.unwrap().next_at, Some(first + 240));
        let paused = f.store.pause_sqlite_backup_plan(&f.profile_id, saved.revision).unwrap().plan.unwrap();
        assert!(paused.calendar.is_some());
        assert_eq!(paused.next_at, None);
    }

    #[test]
    fn calendar_exclusions_skip_overdue_jobs_and_retries_but_allow_an_explicit_run() {
        let f = Fixture::new();
        let holiday = (unix_now().unwrap().div_euclid(86_400) + 2) * 86_400;
        let date = DateTime::<Utc>::from_timestamp(holiday, 0).unwrap().format("%Y-%m-%d").to_string();
        let input = serde_json::from_value(serde_json::json!({
            "revision": null, "directory": f.output, "prefix": "calendar", "retention_days": 7,
            "retry_once": true, "calendar_enabled": true,
            "calendar": { "expression": "* * * * *", "time_zone": "UTC", "excluded_dates": [date] }
        })).unwrap();
        let saved = f.store.save_sqlite_backup_plan(&f.profile_id, input).unwrap().plan.unwrap();
        f.store.connect().unwrap().execute("UPDATE backup_plans SET retry_at=?2 WHERE profile_id=?1",
            params![f.profile_id, holiday - 30]).unwrap();
        assert!(f.store.process_backup(None, holiday + 120, None).unwrap().is_none());
        let state = f.current();
        assert!(state.runs.is_empty());
        let plan = state.plan.unwrap();
        assert_eq!(plan.retry_at, None);
        assert_eq!(plan.next_at, Some(holiday + 86_400));
        let run = f.store.process_backup(Some((&f.profile_id, saved.revision, None)), holiday + 120, None)
            .unwrap().unwrap();
        assert_eq!(run.trigger_kind, "manual");
        assert_eq!(run.status, "succeeded");
        assert_eq!(f.current().plan.unwrap().next_at, Some(holiday + 86_400));
    }

    #[test]
    fn v25_interval_plans_preserve_their_cadence() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        f.plan(first, Some(60));
        f.store.connect().unwrap().execute_batch("ALTER TABLE backup_plans DROP COLUMN calendar; PRAGMA user_version=25;").unwrap();
        let upgraded = Store::open(&f.workspace).unwrap();
        let plan = upgraded.sqlite_backup_plan(&f.profile_id).unwrap().plan.unwrap();
        assert!(plan.calendar.is_none());
        assert_eq!((plan.interval_minutes, plan.next_at), (Some(60), Some(first)));
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
                 directory, prefix, retention_days, retry_limit, next_at) VALUES (?1, ?1, ?2, 1, ?3, ?4, 'original', 7, 1, ?5)",
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
                interval_minutes, retention_days, retry_limit AS retry_once, next_at, retry_at FROM backup_plans;
                CREATE TEMP TABLE saved_runs AS SELECT rowid AS original_rowid, id, profile_id, workspace_path, trigger_kind,
                    status, started_at, finished_at, expires_at, path, size_bytes, message FROM backup_runs;
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

    #[test]
    fn v28_migration_preserves_cancelled_runs_retry_history_and_file_evidence() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        f.plan(first, Some(60));
        let run = f.store.run_sqlite_backup_plan(&f.profile_id, 1).unwrap();
        let postgres = f.store.create_postgres_profile(&f.project_id, crate::PostgresProfileInput {
            name: "기존 PostgreSQL 계획".into(), host: "localhost".into(), port: 5432,
            database: "postgres".into(), username: "test".into(), environment: "DEV".into(), ca_path: None,
        }).unwrap();
        {
            let db = f.store.connect().unwrap();
            db.execute(
                "INSERT INTO backup_plans (profile_id, postgres_profile_id, postgres_revision, revision, workspace_path,
                 directory, prefix, retention_days, retry_limit, next_at)
                 VALUES (?1, ?1, ?2, 1, ?3, ?4, 'original', 7, 1, ?5)",
                params![postgres.id, postgres.revision, f.store.backup_workspace_path().unwrap(), f.output.to_string_lossy(), first],
            ).unwrap();
            db.execute_batch("UPDATE backup_runs SET rowid=17, trigger_kind='retry', retry_attempt=3;
                INSERT INTO backup_runs (id, profile_id, workspace_path, trigger_kind, status, started_at, finished_at, path)
                SELECT 'cancelled-run', profile_id, workspace_path, 'manual', 'cancelled', started_at-2, started_at-1, 'cancelled.sqlite'
                    FROM backup_runs;
                UPDATE backup_plans SET retry_at=next_at+60, retry_attempt=4 WHERE sqlite_profile_id IS NOT NULL;
                CREATE TEMP TABLE saved_runs AS SELECT rowid AS original_rowid, id, profile_id, workspace_path, trigger_kind,
                    retry_attempt, status, started_at, finished_at, expires_at, path, size_bytes, message FROM backup_runs;
                CREATE TEMP TABLE saved_artifacts AS SELECT * FROM backup_artifacts;
                DROP TABLE backup_artifacts; DROP TABLE backup_runs;
                ALTER TABLE backup_plans DROP COLUMN timeout_seconds;").unwrap();
            db.execute_batch(&SCHEMA.replace(", 'timed_out'", "")).unwrap();
            db.execute_batch(backup_artifact::SCHEMA).unwrap();
            db.execute_batch("INSERT INTO backup_runs (rowid, id, profile_id, workspace_path, trigger_kind, retry_attempt,
                status, started_at, finished_at, expires_at, path, size_bytes, message) SELECT * FROM saved_runs;
                INSERT INTO backup_artifacts SELECT * FROM saved_artifacts;
                PRAGMA user_version=28;").unwrap();
        }
        let migrated = Store::open(&f.workspace).unwrap();
        let state = migrated.sqlite_backup_plan(&f.profile_id).unwrap();
        let plan = state.plan.unwrap();
        assert_eq!(plan.timeout_seconds, 0);
        assert_eq!((plan.next_at, plan.retry_at, plan.retry_attempt), (Some(first), Some(first + 60), Some(4)));
        let old_run = &state.runs[0];
        assert_eq!((old_run.id.as_str(), old_run.retry_attempt), (run.id.as_str(), Some(3)));
        assert_eq!(old_run.artifact.as_ref().unwrap().sha256, run.artifact.unwrap().sha256);
        assert_eq!((state.runs[1].id.as_str(), state.runs[1].status.as_str()), ("cancelled-run", "cancelled"));
        let postgres_plan = migrated.postgres_backup_plan(&postgres.id).unwrap().plan.unwrap();
        assert_eq!(postgres_plan.timeout_seconds, DEFAULT_POSTGRES_TIMEOUT_SECONDS);
        assert_eq!(postgres_plan.next_at, Some(first));
        let db = migrated.connect().unwrap();
        assert_eq!(db.query_row("SELECT rowid FROM backup_runs WHERE id=?1", [&run.id], |row| row.get::<_, i64>(0)).unwrap(), 17);
        assert_eq!(db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert!(migrated.verify_sqlite_backup_file(&f.profile_id, &run.id).is_ok());
    }

    #[test]
    fn v29_migration_defaults_to_one_worker_and_recovers_legacy_runs() {
        let f = Fixture::new();
        let first = unix_now().unwrap() + 120;
        f.plan(first, None);
        let completed = f.store.run_sqlite_backup_plan(&f.profile_id, 1).unwrap();
        let scope = f.store.backup_workspace_path().unwrap();
        {
            let db = f.store.connect().unwrap();
            db.execute("INSERT INTO backup_runs (id, profile_id, workspace_path, trigger_kind, status, started_at, path)
                VALUES ('previous-worker', ?1, ?2, 'manual', 'running', ?3, 'orphan.sqlite')",
                params![f.profile_id, scope, first - 10]).unwrap();
            db.execute_batch("DROP INDEX backup_running_slot; DROP INDEX backup_running_profile;
                ALTER TABLE backup_runs DROP COLUMN worker_slot;
                DROP TABLE backup_execution_policy; PRAGMA user_version=29;").unwrap();
        }
        let migrated = Store::open(&f.workspace).unwrap();
        assert!(migrated.process_backup(None, first - 1, None).unwrap().is_none());
        let state = migrated.sqlite_backup_plan(&f.profile_id).unwrap();
        assert_eq!(state.execution_policy.max_concurrent, 1);
        assert!(state.runs.iter().any(|run| run.id == "previous-worker" && run.status == "interrupted"));
        assert_eq!(state.plan.unwrap().next_at, Some(first));
        assert!(migrated.verify_sqlite_backup_file(&f.profile_id, &completed.id).is_ok());
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
