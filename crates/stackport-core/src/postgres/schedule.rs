use super::{
    backup::{self, PostgresBackupContents, Source},
    session::{connect_error, connection_config, field, pg_error, tls_connector},
    PostgresPassword, PostgresProfile,
};
use crate::{
    backup_artifact::Evidence,
    backup_schedule::{active_profile, confirm_backup_directory},
    insert_audit, AuditRecord, Result, Store,
};
use postgres_native_tls::MakeTlsConnector;
use std::time::{Duration, Instant};

pub(crate) fn scheduled_backup_size(store: &Store, profile: &PostgresProfile) -> Result<u64> {
    let password = store.saved_postgres_password(profile)?;
    source_details(profile, &password, true).map(|(_, size)| size)
}

impl Store {
    pub(crate) fn execute_postgres_backup(
        &self,
        profile_id: &str,
        expected_revision: i64,
        directory: &str,
        path: &str,
        run_id: &str,
    ) -> Result<(u64, Evidence, String, Option<String>)> {
        let db = self.connect()?;
        let profile = super::find_profile(&db, profile_id)?;
        let verify_profile = || -> Result<()> {
            if super::find_profile(&db, profile_id)? != profile || profile.revision != expected_revision {
                return Err("PostgreSQL 연결 설정이 변경되었습니다. 백업 계획을 다시 저장하세요.".into());
            }
            if !active_profile(&db, profile_id, true)? {
                return Err("활성 프로젝트의 PostgreSQL 연결을 선택하세요.".into());
            }
            Ok(())
        };
        let audit = |outcome| insert_audit(&db, AuditRecord {
            correlation_id: run_id,
            operation: "postgres.backup.schedule",
            project_id: Some(&profile.project_id),
            profile_id: Some(profile_id),
            environment: Some(&profile.settings.environment),
            object_name: None,
            outcome,
            affected_count: None,
        });
        audit("started")?;
        let result = (|| {
            verify_profile()?;
            confirm_backup_directory(directory)?;
            let password = self.saved_postgres_password(&profile)?;
            let (major, _) = source_details(&profile, &password, false)?;
            verify_profile()?;
            let deadline = Instant::now() + backup::TIME_LIMIT;
            backup::create_with(
                &profile.settings,
                Source { major, selection: None, tunnel_port: None },
                password,
                PostgresBackupContents::All,
                path.to_owned(),
                || (Instant::now() < deadline).then_some(()).ok_or_else(|| "PostgreSQL 백업 실행 시간이 초과되었습니다.".into()),
                || {
                    verify_profile()?;
                    confirm_backup_directory(directory)
                },
            )
        })();
        let warning = audit(if result.is_ok() { "succeeded" } else { "failed" }).err()
            .map(|_| "PostgreSQL 백업 작업 기록을 저장할 수 없습니다.".into());
        result.map(|(report, evidence)| (report.size_bytes, evidence, report.tool_version, warning))
    }
}

fn source_details(profile: &PostgresProfile, password: &PostgresPassword, measure_size: bool) -> Result<(u32, u64)> {
    let settings = &profile.settings;
    let tls = MakeTlsConnector::new(tls_connector(settings.ca_path.as_deref())?);
    let mut config = connection_config(settings, password, None, "StackPort Backup Plan");
    config.options("-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=8000");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
        .map_err(|_| "PostgreSQL 백업 연결을 준비할 수 없습니다.")?;
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(15), async {
            let (client, connection) = config.connect(tls).await.map_err(connect_error)?;
            let driver = tokio::spawn(connection);
            let sql = if measure_size {
                "SELECT current_setting('server_version_num')::integer, pg_database_size(current_database())"
            } else {
                "SELECT current_setting('server_version_num')::integer, 0::bigint"
            };
            let row = client.query_one(sql, &[]).await.map_err(pg_error);
            driver.abort();
            let row = row?;
            let major = u32::try_from(field::<i32>(&row, 0)? / 10_000)
                .map_err(|_| "PostgreSQL 버전을 확인할 수 없습니다.")?;
            let size = u64::try_from(field::<i64>(&row, 1)?)
                .map_err(|_| "PostgreSQL 데이터베이스 크기를 확인할 수 없습니다.")?;
            Ok((major, size))
        }).await.map_err(|_| "PostgreSQL 백업 연결 확인 시간이 초과되었습니다.")?
    })
}
