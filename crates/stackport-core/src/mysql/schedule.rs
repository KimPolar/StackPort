use super::{backup, profiles, read_message, tls, MysqlProfile, ReadError};
use crate::{
    backup_artifact::Evidence,
    backup_schedule::{active_profile, confirm_backup_directory, PlanEngine, RunControl, Stop},
    insert_audit, AuditRecord, Result, Store,
};
use mysql_async::{prelude::Queryable, Conn, OptsBuilder};
use std::{fs, path::Path, time::Duration};

pub(crate) fn scheduled_backup_source(
    store: &Store,
    profile: &MysqlProfile,
) -> Result<(String, u64)> {
    if profiles::find(&store.connect()?, &profile.id)? != *profile {
        return Err("MySQL 연결 설정이 변경되었습니다. 백업 계획을 다시 확인하세요.".into());
    }
    let password = store.saved_mysql_password(profile)?;
    source_details(profile, &password, None)
}

pub(crate) fn scheduled_backup_tools(directory: &str, version: &str) -> Result<String> {
    let maria = is_maria(version);
    let directory = tools_directory(directory)?;
    let executable = backup::dump_tool(&directory, maria)?;
    let scratch = tempfile::Builder::new()
        .prefix("stackport-mysql-tools-")
        .tempdir()
        .map_err(|_| "MySQL 백업 도구 확인용 임시 폴더를 만들 수 없습니다.")?;
    backup::find_version(&executable, scratch.path(), maria, version, &|| Ok(()))
}

pub(crate) fn tools_directory(directory: &str) -> Result<std::path::PathBuf> {
    let directory = Path::new(directory.trim());
    if !directory.is_absolute() {
        return Err("MySQL 백업 도구 폴더의 절대 경로를 지정하세요.".into());
    }
    fs::canonicalize(directory)
        .ok()
        .filter(|path| path.is_dir())
        .ok_or_else(|| "MySQL 백업 도구 폴더를 찾을 수 없습니다.".into())
}

impl Store {
    pub(crate) fn execute_mysql_backup(
        &self,
        profile_id: &str,
        revision: i64,
        directory: &str,
        tools: &str,
        path: &str,
        run_id: &str,
        control: &RunControl,
    ) -> Result<(u64, Evidence, String, Option<String>)> {
        let db = self.connect()?;
        let profile = profiles::find(&db, profile_id)?;
        let verify_profile = || -> Result<()> {
            if profile.revision != revision || profiles::find(&db, profile_id)? != profile {
                return Err(
                    "MySQL 연결 설정이 변경되었습니다. 백업 계획을 다시 저장하세요.".into(),
                );
            }
            if !active_profile(&db, profile_id, PlanEngine::Mysql)? {
                return Err("활성 프로젝트의 MySQL 연결을 선택하세요.".into());
            }
            Ok(())
        };
        let audit = |operation, outcome| {
            insert_audit(
                &db,
                AuditRecord {
                    correlation_id: run_id,
                    operation,
                    project_id: Some(&profile.project_id),
                    profile_id: Some(profile_id),
                    environment: Some(&profile.settings.environment),
                    object_name: None,
                    outcome,
                    affected_count: None,
                },
            )
        };
        audit("mysql.backup.schedule", "started")?;
        let result = (|| {
            control.check()?;
            verify_profile()?;
            confirm_backup_directory(directory)?;
            if tools_directory(tools)?.to_string_lossy() != tools {
                return Err(
                    "MySQL 백업 도구 폴더가 변경되었습니다. 계획을 다시 저장하세요.".into(),
                );
            }
            let database = backup_database(&profile)?;
            let password = self.saved_mysql_password(&profile)?;
            let (version, _) = source_details(&profile, &password, Some(control))?;
            let engine = if is_maria(&version) {
                "MariaDB"
            } else {
                "MySQL"
            };
            let input = backup::MysqlBackupInput {
                database: database.into(),
                table: None,
                contents: backup::Contents::All,
                directory: tools.into(),
                destination: path.into(),
                password,
                confirmation: String::new(),
            };
            verify_profile()?;
            backup::create(
                input,
                &profile.settings,
                engine,
                version,
                &|| control.check(),
                || {
                    verify_profile()?;
                    confirm_backup_directory(directory)?;
                    control.finish()
                },
            )
        })();
        let result = control.finish().and(result);
        let operation = match control.stopped() {
            Some(Stop::Cancelled) => "mysql.backup.schedule.cancel",
            Some(Stop::TimedOut) => "mysql.backup.schedule.timeout",
            None => "mysql.backup.schedule",
        };
        let warning = audit(
            operation,
            if result.is_ok() {
                "succeeded"
            } else {
                "failed"
            },
        )
        .err()
        .map(|_| "MySQL 백업 작업 기록을 저장할 수 없습니다.".into());
        result.map(|(report, evidence)| (report.size_bytes, evidence, report.tool_version, warning))
    }
}

pub(crate) fn backup_database(profile: &MysqlProfile) -> Result<&str> {
    let database = profile
        .settings
        .database
        .as_deref()
        .ok_or("MySQL 연결 설정에 백업할 시작 데이터베이스를 지정하세요.")?;
    backup::require_user_database(database)?;
    Ok(database)
}

fn is_maria(version: &str) -> bool {
    version.to_ascii_lowercase().contains("mariadb")
}

fn source_details(
    profile: &MysqlProfile,
    password: &super::MysqlPassword,
    control: Option<&RunControl>,
) -> Result<(String, u64)> {
    let settings = &profile.settings;
    let database = backup_database(profile)?;
    let options = OptsBuilder::default()
        .ip_or_hostname(settings.host.clone())
        .tcp_port(settings.port)
        .user(Some(settings.username.clone()))
        .pass(Some(password.0.as_str()))
        .db_name(Some(database))
        .prefer_socket(false)
        .ssl_opts(settings.tls.then(|| tls::options(settings)).transpose()?)
        .init(vec![
            super::UTF8_SESSION,
            "SET SESSION TRANSACTION READ ONLY",
        ]);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "MySQL 백업 연결을 준비할 수 없습니다.")?;
    runtime.block_on(async {
        let read = tokio::time::timeout(Duration::from_secs(15), async {
            let mut conn = Conn::new(options).await.map_err(ReadError::from)?;
            let row = conn.exec_first::<(u64, u64, u64, String), _, _>(
                "SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME = BINARY ?),
                        COUNT(CASE WHEN ENGINE IS NULL OR ENGINE <> 'InnoDB' THEN 1 END),
                        CAST(COALESCE(SUM(COALESCE(DATA_LENGTH,0)+COALESCE(INDEX_LENGTH,0)),0) AS UNSIGNED), VERSION()
                 FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA = BINARY ? AND TABLE_TYPE = 'BASE TABLE'",
                (database, database),
            ).await?.ok_or(ReadError::Shape);
            let _ = conn.disconnect().await;
            row
        });
        let stopped = async {
            match control {
                Some(control) => control.wait_stopped().await,
                None => std::future::pending().await,
            }
        };
        let row = tokio::select! {
            biased;
            reason = stopped => return Err(reason.message().into()),
            result = read => result,
        }.map_err(|_| "MySQL 백업 연결 확인 시간이 초과되었습니다.")?
            .map_err(|error| read_message(&error).to_owned())?;
        let (exists, non_transactional, bytes, version) = row;
        if exists != 1 {
            return Err("백업할 MySQL 데이터베이스를 조회할 수 없습니다.".into());
        }
        if non_transactional > 0 {
            return Err("예약 백업의 데이터는 InnoDB 트랜잭션 스냅샷으로 읽을 수 있어야 합니다.".into());
        }
        Ok((version, bytes))
    })
}
