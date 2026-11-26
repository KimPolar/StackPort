use super::{
    edit, edit_audit, info_field,
    resp::{Failure, Wire},
    RedisManager, RedisProfile, UPDATE_UNKNOWN,
};
use crate::Result;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use uuid::Uuid;

const NOT_SUPPORTED: &str = "이 Redis 서버의 저장 상태를 확인할 수 없습니다.";
const ALREADY_RUNNING: &str =
    "Redis 서버에서 저장 또는 재작성이 진행 중입니다. 완료 후 다시 시도하세요.";
const OBSERVATION_LIMIT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RedisPersistenceKind {
    Rdb,
    Aof,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Running,
    Succeeded,
    Failed,
    Unconfirmed,
}

#[derive(Clone, Serialize)]
pub struct RedisPersistenceReport {
    kind: RedisPersistenceKind,
    status: Outcome,
    audit_warning: bool,
}

#[derive(Serialize)]
pub struct RedisPersistenceInfo {
    rdb_in_progress: bool,
    last_rdb_save: Option<u64>,
    last_rdb_ok: Option<bool>,
    aof_enabled: bool,
    aof_in_progress: bool,
    aof_scheduled: bool,
    last_aof_ok: Option<bool>,
    directory: Option<String>,
    rdb_filename: Option<String>,
    aof_directory: Option<String>,
    aof_filename: Option<String>,
    job: Option<RedisPersistenceReport>,
}

struct ServerState {
    rdb: Progress,
    rdb_saved_at: Option<u64>,
    aof: Progress,
    aof_enabled: bool,
    aof_scheduled: bool,
}

#[derive(Clone, Copy)]
struct Progress {
    running: bool,
    last_ok: Option<bool>,
    count: Option<u64>,
}

pub(super) struct Job {
    token: Uuid,
    started: Instant,
    baseline: ServerState,
    saw_running: bool,
    report: RedisPersistenceReport,
}

impl RedisManager {
    pub async fn persistence_info(&self, id: &str) -> Result<RedisPersistenceInfo> {
        let session = self.session(id)?;
        let mut info = self
            .run(id, &session, |state| Box::pin(read_info(&mut state.wire)))
            .await?;
        info.job = session
            .persistence
            .lock()
            .await
            .as_ref()
            .map(|job| job.report.clone());
        Ok(info)
    }

    pub async fn start_persistence(
        &self,
        id: &str,
        kind: RedisPersistenceKind,
        confirmed: bool,
        confirmation: &str,
    ) -> Result<RedisPersistenceReport> {
        let session = self.session(id)?;
        if !session.allow_persistence {
            return Err("Redis 백업 관리를 허용한 연결을 여세요.".into());
        }
        if !confirmed {
            return Err("전체 Redis 서버에 적용되는 저장 작업을 확인하세요.".into());
        }
        if session.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let mut slot = session.persistence.lock().await;
        if slot
            .as_ref()
            .is_some_and(|job| job.report.status == Outcome::Running)
        {
            return Err(ALREADY_RUNNING.into());
        }
        let token = Uuid::new_v4();
        self.audit_persistence(&session.profile, token, kind.operation(), "started", true)
            .await?;
        let baseline = self
            .run(id, &session, |state| Box::pin(start(state, kind)))
            .await;
        match baseline {
            Ok(baseline) => {
                let report = RedisPersistenceReport {
                    kind,
                    status: Outcome::Running,
                    audit_warning: false,
                };
                *slot = Some(Job {
                    token,
                    started: Instant::now(),
                    baseline,
                    saw_running: false,
                    report: report.clone(),
                });
                Ok(report)
            }
            Err(message) => {
                let unknown = message == UPDATE_UNKNOWN;
                let recorded = self
                    .audit_persistence(
                        &session.profile,
                        token,
                        if unknown {
                            kind.unconfirmed_operation()
                        } else {
                            kind.operation()
                        },
                        if unknown { "started" } else { "failed" },
                        false,
                    )
                    .await
                    .is_ok();
                if recorded {
                    Err(message)
                } else {
                    Err(format!("{message} 완료 작업 기록을 저장하지 못했습니다."))
                }
            }
        }
    }

    pub async fn persistence_report(&self, id: &str) -> Result<RedisPersistenceReport> {
        let session = self.session(id)?;
        let mut slot = session.persistence.lock().await;
        let job = slot
            .as_mut()
            .ok_or("이 연결에서 요청한 Redis 저장 작업이 없습니다.")?;
        if job.report.status == Outcome::Running {
            let state = self
                .run(id, &session, |state| Box::pin(read_state(&mut state.wire)))
                .await;
            job.report.status = state.map_or(Outcome::Unconfirmed, |state| job.observe(&state));
            let kind = job.report.kind;
            let audit = match job.report.status {
                Outcome::Running => None,
                Outcome::Succeeded => Some((kind.operation(), "succeeded")),
                Outcome::Failed => Some((kind.operation(), "failed")),
                Outcome::Unconfirmed => Some((kind.unconfirmed_operation(), "started")),
            };
            if let Some((operation, outcome)) = audit {
                job.report.audit_warning = self
                    .audit_persistence(&session.profile, job.token, operation, outcome, false)
                    .await
                    .is_err();
            }
        }
        Ok(job.report.clone())
    }

    async fn audit_persistence(
        &self,
        profile: &RedisProfile,
        token: Uuid,
        operation: &'static str,
        outcome: &'static str,
        verify_profile: bool,
    ) -> Result<()> {
        let store = self.store.clone();
        let profile = profile.clone();
        tokio::task::spawn_blocking(move || {
            if verify_profile {
                store.redis_profile(&profile.id, profile.revision)?;
            }
            edit_audit(&store, &profile, token, operation, outcome, None)
        })
        .await
        .map_err(|_| "Redis 저장 작업 기록을 저장할 수 없습니다.")?
    }
}

impl RedisPersistenceKind {
    fn operation(self) -> &'static str {
        match self {
            Self::Rdb => "redis.persistence.rdb",
            Self::Aof => "redis.persistence.aof",
        }
    }
    fn unconfirmed_operation(self) -> &'static str {
        match self {
            Self::Rdb => "redis.persistence.rdb.unconfirmed",
            Self::Aof => "redis.persistence.aof.unconfirmed",
        }
    }

    fn progress(self, state: &ServerState) -> Progress {
        match self {
            Self::Rdb => state.rdb,
            Self::Aof => state.aof,
        }
    }
}

impl Job {
    fn observe(&mut self, state: &ServerState) -> Outcome {
        if self.started.elapsed() >= OBSERVATION_LIMIT {
            return Outcome::Unconfirmed;
        }
        let kind = self.report.kind;
        let before = kind.progress(&self.baseline);
        let after = kind.progress(state);
        if after.running {
            self.saw_running = true;
            return Outcome::Running;
        }
        if matches!(kind, RedisPersistenceKind::Aof) && state.aof_scheduled {
            return Outcome::Running;
        }
        let observed = match (before.count, after.count) {
            (Some(before), Some(after)) => {
                if before.abs_diff(after) > 1 || after < before {
                    return Outcome::Unconfirmed;
                }
                after > before
            }
            _ => {
                self.saw_running
                    || (matches!(kind, RedisPersistenceKind::Rdb)
                        && state.rdb_saved_at > self.baseline.rdb_saved_at)
            }
        };
        if observed {
            match after.last_ok {
                Some(true) => Outcome::Succeeded,
                Some(false) => Outcome::Failed,
                None => Outcome::Unconfirmed,
            }
        } else if self.started.elapsed() < Duration::from_secs(2) {
            Outcome::Running
        } else {
            Outcome::Unconfirmed
        }
    }
}

async fn start(
    state: &mut edit::State,
    kind: RedisPersistenceKind,
) -> std::result::Result<ServerState, Failure> {
    let baseline = read_state(&mut state.wire).await?;
    if baseline.rdb.running || baseline.aof.running || baseline.aof_scheduled {
        return Err(Failure::Server(ALREADY_RUNNING));
    }
    if matches!(kind, RedisPersistenceKind::Aof) && !baseline.aof_enabled {
        return Err(Failure::Server("이 Redis 서버에서 AOF가 꺼져 있습니다."));
    }
    let command: &[u8] = match kind {
        RedisPersistenceKind::Rdb => b"BGSAVE",
        RedisPersistenceKind::Aof => b"BGREWRITEAOF",
    };
    state.committing = true;
    let response = match state.wire.command(&[command]).await {
        Err(error @ Failure::Server(_)) => {
            state.committing = false;
            return Err(error);
        }
        other => other?.bytes()?,
    };
    let accepted = match kind {
        RedisPersistenceKind::Rdb => response == b"Background saving started",
        RedisPersistenceKind::Aof => matches!(
            response.as_slice(),
            b"Background append only file rewriting started"
                | b"Background append only file rewriting scheduled"
        ),
    };
    if !accepted {
        return Err(Failure::Protocol);
    }
    state.committing = false;
    Ok(baseline)
}

async fn read_state(wire: &mut Wire) -> std::result::Result<ServerState, Failure> {
    let bytes = wire.command(&[b"INFO", b"persistence"]).await?.bytes()?;
    let text = std::str::from_utf8(&bytes).map_err(|_| Failure::Protocol)?;
    let number = |field| info_field(text, field).and_then(|value| value.parse::<u64>().ok());
    let flag = |field| match info_field(text, field) {
        Some("1") => Ok(true),
        Some("0") => Ok(false),
        _ => Err(Failure::Server(NOT_SUPPORTED)),
    };
    let status = |field| match info_field(text, field) {
        Some("ok") => Some(true),
        Some("err") => Some(false),
        _ => None,
    };
    Ok(ServerState {
        rdb: Progress {
            running: flag("rdb_bgsave_in_progress")?,
            last_ok: status("rdb_last_bgsave_status"),
            count: number("rdb_saves"),
        },
        rdb_saved_at: number("rdb_last_save_time"),
        aof: Progress {
            running: flag("aof_rewrite_in_progress")?,
            last_ok: status("aof_last_bgrewrite_status"),
            count: number("aof_rewrites"),
        },
        aof_enabled: flag("aof_enabled")?,
        aof_scheduled: flag("aof_rewrite_scheduled")?,
    })
}

async fn read_info(wire: &mut Wire) -> std::result::Result<RedisPersistenceInfo, Failure> {
    let state = read_state(wire).await?;
    Ok(RedisPersistenceInfo {
        rdb_in_progress: state.rdb.running,
        last_rdb_save: state.rdb_saved_at,
        last_rdb_ok: state.rdb.last_ok,
        aof_enabled: state.aof_enabled,
        aof_in_progress: state.aof.running,
        aof_scheduled: state.aof_scheduled,
        last_aof_ok: state.aof.last_ok,
        directory: config(wire, b"dir").await?,
        rdb_filename: config(wire, b"dbfilename").await?,
        aof_directory: config(wire, b"appenddirname").await?,
        aof_filename: config(wire, b"appendfilename").await?,
        job: None,
    })
}

async fn config(wire: &mut Wire, name: &[u8]) -> std::result::Result<Option<String>, Failure> {
    let mut entries = match wire.command(&[b"CONFIG", b"GET", name]).await {
        Ok(reply) => reply.array()?.into_iter(),
        Err(Failure::Server(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    if entries.len() != 2 || entries.next().ok_or(Failure::Protocol)?.bytes()? != name {
        return Ok(None);
    }
    let value = entries.next().ok_or(Failure::Protocol)?.bytes()?;
    Ok(String::from_utf8(value)
        .ok()
        .filter(|path| !path.is_empty() && !path.chars().any(char::is_control)))
}
