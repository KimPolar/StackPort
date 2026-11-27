use super::{
    backup_file::{checker_at, download::{download_snapshot, replication_connection}},
    info, info_field, RedisAuthentication, RedisBackupFileFormat, RedisPassword, RedisProfile,
    READ_TIMEOUT,
};
use crate::{
    backup_artifact::Evidence,
    backup_schedule::{active_profile, confirm_backup_directory, PlanEngine, RunControl, Stop},
    insert_audit, local_file::NewFile, AuditRecord, Result, Store,
};
use std::path::{Path, PathBuf};
use tokio::{runtime::Runtime, time::timeout};
use zeroize::Zeroizing;

fn runtime() -> Result<Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Redis 백업 실행을 준비할 수 없습니다.".into())
}

fn authentication(profile: &RedisProfile, use_saved: bool) -> Result<RedisAuthentication> {
    if use_saved {
        return Ok(RedisAuthentication::Saved);
    }
    if !profile.settings.username.is_empty() {
        return Err("ACL 사용자 이름이 지정된 Redis 연결은 Windows 저장 암호를 사용하세요.".into());
    }
    Ok(RedisPassword(Zeroizing::new(String::new())).into())
}

pub(crate) fn validate_scheduled_authentication(store: &Store, profile: &RedisProfile, use_saved: bool) -> Result<()> {
    authentication(profile, use_saved)?;
    if use_saved && !store.redis_credential_status(&profile.id, profile.revision)?.usable {
        return Err("예약 백업에는 이 Redis 연결의 Windows 자격 증명이 필요합니다.".into());
    }
    Ok(())
}

pub(crate) fn tools_directory(directory: &str) -> Result<PathBuf> {
    let directory = Path::new(directory.trim());
    if !directory.is_absolute() {
        return Err("Redis 검사 도구 폴더의 절대 경로를 지정하세요.".into());
    }
    directory.canonicalize().ok()
        .filter(|directory| directory.join(RedisBackupFileFormat::Rdb.tool_executable()).is_file())
        .ok_or_else(|| "선택한 폴더에서 Redis 검사 도구를 찾을 수 없습니다.".into())
}

pub(crate) fn scheduled_backup_tools(directory: &str) -> Result<String> {
    let directory = tools_directory(directory)?;
    runtime()?.block_on(async {
        let (_, version) = checker_at(&directory, RedisBackupFileFormat::Rdb).await?;
        Ok(version)
    })
}

pub(crate) fn scheduled_backup_source(store: &Store, profile: &RedisProfile, use_saved: bool) -> Result<(String, u64)> {
    if store.redis_profile(&profile.id, profile.revision)? != *profile {
        return Err("Redis 연결 설정이 변경되었습니다. 백업 계획을 다시 확인하세요.".into());
    }
    let (password, _) = store.redis_password(profile, authentication(profile, use_saved)?)?;
    runtime()?.block_on(async {
        let (engine, version, mut wire) = replication_connection(profile, &password).await?;
        let memory = timeout(READ_TIMEOUT, info(&mut wire, b"memory"))
            .await.map_err(|_| "Redis 메모리 정보를 읽는 시간이 초과되었습니다.")??;
        let bytes = info_field(&memory, "used_memory").and_then(|value| value.parse().ok())
            .ok_or("Redis 메모리 크기를 확인할 수 없습니다.")?;
        Ok((format!("{engine} {version}"), bytes))
    })
}

impl Store {
    pub(crate) fn execute_redis_backup(
        &self,
        profile_id: &str,
        revision: i64,
        directory: &str,
        tools: &str,
        use_saved: bool,
        destination: &str,
        run_id: &str,
        control: &RunControl,
    ) -> Result<(u64, Evidence, String, Option<String>)> {
        let db = self.connect()?;
        let profile = super::profiles::find(&db, profile_id)?;
        let verify_profile = || -> Result<()> {
            if profile.revision != revision || super::profiles::current(&db, profile_id, revision)? != profile {
                return Err("Redis 연결 설정이 변경되었습니다. 백업 계획을 다시 저장하세요.".into());
            }
            if !active_profile(&db, profile_id, PlanEngine::Redis)? {
                return Err("활성 프로젝트의 Redis 연결을 선택하세요.".into());
            }
            Ok(())
        };
        let audit = |operation, outcome| insert_audit(&db, AuditRecord {
            correlation_id: run_id,
            operation,
            project_id: Some(&profile.project_id),
            profile_id: Some(profile_id),
            environment: Some(&profile.settings.environment),
            object_name: None,
            outcome,
            affected_count: None,
        });
        audit("redis.backup.schedule", "started")?;
        let result = (|| {
            control.check()?;
            verify_profile()?;
            confirm_backup_directory(directory)?;
            let tools_path = tools_directory(tools)?;
            if tools_path != Path::new(tools) {
                return Err("Redis 검사 도구 폴더가 변경되었습니다. 계획을 다시 저장하세요.".into());
            }
            let (password, _) = self.redis_password(&profile, authentication(&profile, use_saved)?)?;
            let staged = NewFile::stage(destination, Some("rdb"), ".stackport-redis-")?;
            let check = control.clone();
            let (report, evidence) = runtime()?.block_on(async {
                tokio::select! {
                    biased;
                    reason = control.wait_stopped() => Err(reason.message().into()),
                    result = download_snapshot(&profile, &password, &staged, destination.to_owned(), &tools_path, move || check.check()) => result,
                }
            })?;
            verify_profile()?;
            confirm_backup_directory(directory)?;
            control.finish()?;
            staged.publish()?;
            Ok((report.bytes, evidence, format!("{} {}", report.engine, report.engine_version)))
        })();
        let result = control.finish().and(result);
        let operation = match control.stopped() {
            Some(Stop::Cancelled) => "redis.backup.schedule.cancel",
            Some(Stop::TimedOut) => "redis.backup.schedule.timeout",
            None => "redis.backup.schedule",
        };
        let warning = audit(operation, if result.is_ok() { "succeeded" } else { "failed" })
            .err().map(|_| "Redis 백업 작업 기록을 저장할 수 없습니다.".into());
        result.map(|(bytes, evidence, version)| (bytes, evidence, version, warning))
    }
}
