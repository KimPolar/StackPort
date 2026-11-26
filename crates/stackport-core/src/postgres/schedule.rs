use super::{
    backup::{self, PostgresBackupContents, Source},
    session::{connect_error, connection_config, field, pg_error, tls_connector},
    PostgresPassword, PostgresProfile,
};
use crate::{
    backup_artifact::Evidence,
    backup_schedule::{active_profile, confirm_backup_directory, RunControl, Stop},
    insert_audit, ssh_tunnel::DatabaseTunnel, AuditRecord, BackupTunnelRoute, Result, SshTunnelManager, Store,
};
use postgres_native_tls::MakeTlsConnector;
use std::time::{Duration, Instant};

const TUNNEL_STOPPED: &str = "백업 계획의 SSH 터널이 중단되었습니다. 터널을 시작한 뒤 다시 시도하세요.";

pub(crate) fn scheduled_backup_source(store: &Store, profile: &PostgresProfile, route: Option<(&SshTunnelManager, &BackupTunnelRoute)>) -> Result<(u32, u64)> {
    let password = store.saved_postgres_password(profile)?;
    let tunnel = route.map(|(manager, reviewed)| {
        reviewed.verify_saved(&store.connect()?, &profile.project_id, &profile.settings.host, profile.settings.port)?;
        manager.backup_tunnel(reviewed, &profile.project_id, &profile.settings.host, profile.settings.port)
    }).transpose()?;
    source_details(profile, &password, true, tunnel.as_ref(), None)
}

pub(crate) fn scheduled_backup_tools_version(profile: &PostgresProfile, major: u32) -> Result<String> {
    let deadline = Instant::now() + Duration::from_secs(16);
    let check = || {
        (Instant::now() < deadline).then_some(())
            .ok_or_else(|| "PostgreSQL 백업 도구 확인 시간이 초과되었습니다.".into())
    };
    backup::tools_for(&profile.settings, major, &check).map(|tools| tools.version)
}

impl Store {
    pub(crate) fn execute_postgres_backup(
        &self,
        profile_id: &str,
        expected_revision: i64,
        directory: &str,
        path: &str,
        run_id: &str,
        route: Option<&BackupTunnelRoute>,
        tunnels: Option<&SshTunnelManager>,
        control: &RunControl,
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
            if let Some(route) = route {
                route.verify_saved(&db, &profile.project_id, &profile.settings.host, profile.settings.port)?;
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
        audit("postgres.backup.schedule", "started")?;
        let result = (|| {
            control.check()?;
            verify_profile()?;
            confirm_backup_directory(directory)?;
            let tunnel = route.map(|reviewed| {
                tunnels.ok_or(TUNNEL_STOPPED)?.backup_tunnel(reviewed, &profile.project_id, &profile.settings.host, profile.settings.port)
            }).transpose()?;
            let password = self.saved_postgres_password(&profile)?;
            let (major, _) = source_details(&profile, &password, false, tunnel.as_ref(), Some(control))?;
            verify_profile()?;
            backup::create_with(
                &profile.settings,
                Source { major, selection: None, tunnel_port: tunnel.as_ref().map(|route| route.endpoint().port) },
                password,
                PostgresBackupContents::All,
                path.to_owned(),
                || {
                    control.check()?;
                    ensure_tunnel_running(tunnel.as_ref())
                },
                || {
                    verify_profile()?;
                    confirm_backup_directory(directory)?;
                    ensure_tunnel_running(tunnel.as_ref())?;
                    control.finish()
                },
            )
        })();
        let result = control.finish().and(result);
        let operation = match control.stopped() {
            Some(Stop::Cancelled) => "postgres.backup.schedule.cancel",
            Some(Stop::TimedOut) => "postgres.backup.schedule.timeout",
            None => "postgres.backup.schedule",
        };
        let warning = audit(operation, if result.is_ok() { "succeeded" } else { "failed" }).err()
            .map(|_| "PostgreSQL 백업 작업 기록을 저장할 수 없습니다.".into());
        result.map(|(report, evidence)| (report.size_bytes, evidence, report.tool_version, warning))
    }
}

fn ensure_tunnel_running(tunnel: Option<&DatabaseTunnel>) -> Result<()> {
    if tunnel.is_some_and(|route| !route.running()) { return Err(TUNNEL_STOPPED.into()); }
    Ok(())
}

fn source_details(profile: &PostgresProfile, password: &PostgresPassword, measure_size: bool, tunnel: Option<&DatabaseTunnel>, control: Option<&RunControl>) -> Result<(u32, u64)> {
    ensure_tunnel_running(tunnel)?;
    let settings = &profile.settings;
    let tls = MakeTlsConnector::new(tls_connector(settings.ca_path.as_deref())?);
    let mut config = connection_config(settings, password, tunnel.map(|route| route.endpoint().port), "StackPort Backup Plan");
    config.options("-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=8000");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
        .map_err(|_| "PostgreSQL 백업 연결을 준비할 수 없습니다.")?;
    runtime.block_on(async {
        let read = tokio::time::timeout(Duration::from_secs(15), async {
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
        });
        let stopped = async {
            match control {
                Some(control) => control.wait_stopped().await,
                None => std::future::pending().await,
            }
        };
        let tunnel_ended = async {
            match tunnel {
                Some(route) => route.ended().await,
                None => std::future::pending().await,
            }
        };
        let result = tokio::select! {
            biased;
            reason = stopped => return Err(reason.message().into()),
            _ = tunnel_ended => return Err(TUNNEL_STOPPED.into()),
            response = read => response,
        };
        ensure_tunnel_running(tunnel)?;
        result.map_err(|_| "PostgreSQL 백업 연결 확인 시간이 초과되었습니다.")?
    })
}
