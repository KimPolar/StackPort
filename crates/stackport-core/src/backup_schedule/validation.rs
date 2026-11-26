use super::{
    active_profile, backup_directory, confirm_mysql, confirm_postgres, effective_file_name_template, file_name,
    free_space, read_plan, sqlite_backup_source_size, unix_now, BackupPlanWrite, CalendarSchedule,
    DEFAULT_RETRY_DELAY_MINUTES, LATEST_START, MAX_RETRIES, MAX_TIMEOUT_SECONDS,
    NO_CALENDAR_OCCURRENCE, PlanEngine,
};
use crate::{mysql, postgres, BackupTunnelRoute, PostgresProfile, Result, SshTunnelManager, Store};
use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub(super) struct ValidatedSettings<'a> {
    pub(super) prefix: &'a str,
    pub(super) retry_limit: u8,
    pub(super) retry_delay_minutes: u16,
    pub(super) next_at: Option<i64>,
    pub(super) next_excluded_at: Option<i64>,
}

pub(super) fn validate_settings(
    input: &BackupPlanWrite,
    now: i64,
) -> Result<ValidatedSettings<'_>> {
    let prefix = input.prefix.trim();
    file_name::validate_prefix(prefix)?;
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
    let retry_delay_minutes = input
        .retry_delay_minutes
        .unwrap_or(DEFAULT_RETRY_DELAY_MINUTES);
    if retry_limit > MAX_RETRIES || !(1..=1_440).contains(&retry_delay_minutes) {
        return Err("재시도는 최대 5회, 간격은 1~1,440분으로 입력하세요.".into());
    }
    if input
        .timeout_seconds
        .is_some_and(|seconds| seconds > MAX_TIMEOUT_SECONDS)
    {
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
    let (next_at, next_excluded_at) = match &input.calendar {
        Some(calendar) => {
            let schedule = CalendarSchedule::parse(calendar)?;
            let next = schedule.next_after(now)?.ok_or(NO_CALENDAR_OCCURRENCE)?;
            if input.calendar_enabled {
                (
                    Some(next.at),
                    schedule.excluded_after(now)?.first().copied(),
                )
            } else {
                (None, None)
            }
        }
        None => (input.next_at, None),
    };
    Ok(ValidatedSettings {
        prefix,
        retry_limit,
        retry_delay_minutes,
        next_at,
        next_excluded_at,
    })
}

#[derive(Default, Serialize)]
pub struct BackupPlanValidation {
    checks: Vec<Check>,
    next_at: Option<i64>,
    estimated_bytes: Option<u64>,
    available_bytes: Option<u64>,
}

#[derive(Serialize)]
struct Check {
    step: &'static str,
    status: &'static str,
    message: String,
}

impl BackupPlanValidation {
    fn push(&mut self, step: &'static str, status: &'static str, message: impl Into<String>) {
        self.checks.push(Check {
            step,
            status,
            message: message.into(),
        });
    }

    fn check<T>(
        &mut self,
        step: &'static str,
        result: Result<T>,
        describe: impl FnOnce(&T) -> String,
    ) -> Option<T> {
        match result {
            Ok(value) => {
                self.push(step, "passed", describe(&value));
                Some(value)
            }
            Err(message) => {
                self.push(step, "failed", message);
                None
            }
        }
    }
}

impl Store {
    pub fn validate_sqlite_backup_plan(
        &self,
        profile_id: &str,
        input: &BackupPlanWrite,
    ) -> BackupPlanValidation {
        self.validate_backup_plan(profile_id, PlanEngine::Sqlite, input, |report| {
            let source = self
                .profile(profile_id)
                .and_then(|profile| sqlite_backup_source_size(Path::new(&profile.path), None));
            report.check("source", source, |_| {
                "SQLite 원본을 읽을 수 있습니다.".into()
            })
        })
    }

    pub fn validate_postgres_backup_plan(
        &self,
        profile: &PostgresProfile,
        confirmation: &str,
        input: &BackupPlanWrite,
        route: Option<(&SshTunnelManager, &BackupTunnelRoute)>,
    ) -> BackupPlanValidation {
        self.validate_backup_plan(&profile.id, PlanEngine::Postgres, input, |report| {
            let source = confirm_postgres(profile, confirmation)
                .and_then(|()| postgres::scheduled_backup_source(self, profile, route));
            let (major, size) = report.check("source", source, |(major, _)| {
                let path = if route.is_some() {
                    "SSH 경유 TLS"
                } else {
                    "직접 TLS"
                };
                format!("{path}로 PostgreSQL {major}에 연결했습니다.")
            })?;
            report.check(
                "tools",
                postgres::scheduled_backup_tools_version(profile, major),
                |version| format!("pg_dump와 pg_restore {version} 버전을 확인했습니다."),
            );
            Some(size)
        })
    }

    pub fn validate_mysql_backup_plan(
        &self,
        profile_id: &str,
        revision: i64,
        confirmation: &str,
        tools: &str,
        input: &BackupPlanWrite,
    ) -> BackupPlanValidation {
        self.validate_backup_plan(profile_id, PlanEngine::Mysql, input, |report| {
            let source = self.mysql_profile(profile_id, revision).and_then(|profile| {
                confirm_mysql(&profile, confirmation)?;
                mysql::scheduled_backup_source(self, &profile)
            });
            let (server, size) = report.check("source", source, |(version, _)| {
                format!("MySQL 계열 서버 {version}에 연결해 시작 데이터베이스를 확인했습니다.")
            })?;
            report.check("tools", mysql::scheduled_backup_tools(tools, &server), |version| {
                format!("덤프 도구 {version}을 확인했습니다.")
            });
            Some(size)
        })
    }

    fn validate_backup_plan(
        &self,
        profile_id: &str,
        engine: PlanEngine,
        input: &BackupPlanWrite,
        read_source: impl FnOnce(&mut BackupPlanValidation) -> Option<u64>,
    ) -> BackupPlanValidation {
        let mut report = BackupPlanValidation::default();
        let settings = (|| {
            let settings = validate_settings(input, unix_now()?)?;
            let db = self.connect()?;
            if !active_profile(&db, profile_id, engine)? {
                return Err("활성 프로젝트의 연결을 선택하세요.".into());
            }
            let previous = read_plan(&db, profile_id)?;
            if previous.as_ref().map(|plan| plan.revision) != input.revision {
                return Err(
                    "다른 창에서 백업 계획을 수정했습니다. 새로고침하고 다시 검증하세요.".into(),
                );
            }
            file_name::validate_template(
                effective_file_name_template(input, previous.as_ref()),
                settings.prefix,
            )?;
            Ok(settings)
        })();
        let Some(settings) = report.check("settings", settings, |_| {
            "예약과 백업 설정을 확인했습니다.".into()
        }) else {
            return report;
        };
        report.next_at = settings.next_at;

        let folder = report.check("folder", probe_backup_directory(&input.directory), |_| {
            "저장 폴더에서 임시 파일을 만들고 지웠습니다.".into()
        });
        report.estimated_bytes = read_source(&mut report);
        if let Some(folder) = folder {
            match free_space(&folder) {
                Ok(available) => {
                    report.available_bytes = available;
                    match (available, report.estimated_bytes) {
                        (Some(available), Some(estimated)) if available < estimated && engine != PlanEngine::Sqlite => {
                            report.push("space", "warning", "여유 공간이 원본 크기보다 작습니다. 원본 크기와 백업 파일 크기는 달라질 수 있습니다.");
                        }
                        (Some(available), Some(estimated)) if available < estimated => {
                            report.push(
                                "space",
                                "failed",
                                "백업 폴더의 여유 공간이 SQLite 예상 백업 크기보다 작습니다.",
                            );
                        }
                        (Some(_), Some(_)) => {
                            report.push("space", "passed", "여유 공간이 현재 원본 크기 이상입니다.")
                        }
                        (None, _) => report.push(
                            "space",
                            "warning",
                            "이 운영체제에서 사용 가능한 공간을 확인할 수 없습니다.",
                        ),
                        (_, None) => {}
                    }
                }
                Err(message) => report.push("space", "failed", message),
            }
        }
        report
    }
}

fn probe_backup_directory(value: &str) -> Result<PathBuf> {
    let directory = backup_directory(value)?;
    let mut probe = tempfile::Builder::new()
        .prefix(".stackport-backup-check-")
        .tempfile_in(&directory)
        .map_err(|_| "저장 폴더에 임시 파일을 만들 수 없습니다. 쓰기 권한을 확인하세요.")?;
    let written = probe.write_all(b"StackPort backup plan check");
    probe
        .close()
        .map_err(|_| "저장 폴더에서 검증용 임시 파일을 지울 수 없습니다.")?;
    written.map_err(|_| "저장 폴더의 임시 파일에 쓸 수 없습니다.")?;
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn sqlite_validation_checks_the_draft_and_cleans_the_probe_without_saving() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("source.sqlite");
        let output = fixture.path().join("output");
        std::fs::create_dir(&output).unwrap();
        Connection::open(&source)
            .unwrap()
            .execute_batch("CREATE TABLE example(value TEXT);")
            .unwrap();
        let store = Store::open(fixture.path().join("workspace.sqlite")).unwrap();
        let project = store.create_project("백업 검증").unwrap();
        let profile = store
            .create_sqlite_profile(&project.id, "SQLite 원본", source.to_str().unwrap(), "DEV")
            .unwrap();
        let next_at = unix_now().unwrap() + 600;
        let mut input: BackupPlanWrite = serde_json::from_value(serde_json::json!({
            "directory": output, "prefix": "dry-run", "retention_days": 7, "next_at": next_at
        }))
        .unwrap();
        let result = store.validate_sqlite_backup_plan(&profile.id, &input);
        assert_eq!(result.next_at, Some(next_at));
        assert!(result.estimated_bytes.unwrap() > 0);
        for step in ["settings", "folder", "source"] {
            assert!(result
                .checks
                .iter()
                .any(|check| check.step == step && check.status == "passed"));
        }
        assert_eq!(std::fs::read_dir(&output).unwrap().count(), 0);
        let db = store.connect().unwrap();
        for table in ["backup_plans", "backup_runs"] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }

        input.directory = fixture
            .path()
            .join("missing")
            .to_string_lossy()
            .into_owned();
        let missing = store.validate_sqlite_backup_plan(&profile.id, &input);
        assert!(missing
            .checks
            .iter()
            .any(|check| check.step == "folder" && check.status == "failed"));
        assert!(missing
            .checks
            .iter()
            .any(|check| check.step == "source" && check.status == "passed"));
        std::fs::remove_file(&source).unwrap();
        let removed = store.validate_sqlite_backup_plan(&profile.id, &input);
        assert!(removed
            .checks
            .iter()
            .any(|check| check.step == "source" && check.status == "failed"));

        input.prefix = "bad prefix".into();
        let invalid = store.validate_sqlite_backup_plan(&profile.id, &input);
        assert_eq!(invalid.checks.len(), 1);
        assert_eq!(
            (invalid.checks[0].step, invalid.checks[0].status),
            ("settings", "failed")
        );
        let saved = store
            .save_sqlite_backup_plan(&profile.id, input)
            .err()
            .unwrap();
        assert_eq!(saved, invalid.checks[0].message);
    }
}
