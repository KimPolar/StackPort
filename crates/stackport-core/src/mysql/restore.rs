mod snapshot;

use super::{
    backup::{client_command, configure_connection, find_version, run},
    query, quoted, require_identifier, MysqlManager, MysqlPassword, MysqlSettings, ReadError,
};
use crate::{insert_audit, AuditRecord, Result};
use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};
use snapshot::{Dump, FileInfo, Scope};
use std::{
    collections::BTreeSet,
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;

const EXPIRES: Duration = Duration::from_secs(300);
const TIME_LIMIT: Duration = Duration::from_secs(30 * 60);
const PREFIX_BYTES: usize = 2048;
const PREVIEW_OBJECTS: usize = 100;
const CANCELLED: &str = "MySQL 복원 작업이 중단되었습니다.";
const TIMED_OUT: &str = "MySQL 복원 시간이 초과되었습니다.";
const EXISTS: &str = "같은 이름의 데이터베이스가 있습니다. 새 DB 이름을 선택하세요.";
const PLAN_ERROR: &str = "복원 미리보기를 다시 확인하세요.";
const PLAN_LOCK: &str = "MySQL 복원 미리보기를 읽을 수 없습니다.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MysqlRestoreInput {
    source: String,
    schema: Option<String>,
    directory: String,
    database: String,
}

#[derive(Clone, Serialize)]
pub struct MysqlRestorePreview {
    token: String,
    database: String,
    source_database: String,
    target_version: String,
    tool_version: String,
    archive: FileInfo,
    schema: Option<FileInfo>,
    tables: Vec<String>,
    views: Vec<String>,
    table_count: usize,
    view_count: usize,
    data_only: bool,
    expires_seconds: u64,
}

pub(super) struct Plan {
    preview: MysqlRestorePreview,
    expires: Instant,
    replay: File,
    scratch: TempDir,
    executable: PathBuf,
    checkpoint: String,
    tables: BTreeSet<String>,
    views: BTreeSet<String>,
}

#[derive(Serialize)]
pub struct MysqlRestoreReport {
    database: String,
    archive_sha256: String,
    schema_sha256: Option<String>,
    status: Status,
    tables: Option<usize>,
    views: Option<usize>,
    rows: Option<u64>,
    message: Option<String>,
    audit_warning: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Verified,
    Unverified,
    Partial,
    Unconfirmed,
}

impl MysqlManager {
    pub async fn preview_restore(
        &self,
        id: &str,
        request: &str,
        input: MysqlRestoreInput,
    ) -> Result<MysqlRestorePreview> {
        let guard = self.store.queries.claim(request)?;
        let session = self.session(id)?;
        if session.tunnel.is_some() {
            return Err("MySQL 복원 도구는 직접 연결에서 사용할 수 있습니다.".into());
        }
        let database = input.database.trim().to_owned();
        require_identifier(&database)?;
        if database.chars().any(char::is_control)
            || ["mysql", "information_schema", "performance_schema", "sys"]
                .iter()
                .any(|name| database.eq_ignore_ascii_case(name))
        {
            return Err("복원할 새 사용자 데이터베이스 이름을 입력하세요.".into());
        }
        let target_version = self.check_restore_target(id, &database).await?;
        let maria = session.engine == "MariaDB";
        let cancelled = guard.cancellation_check();
        let closed = session.closed.subscribe();
        let plan = tokio::task::spawn_blocking(move || {
            let deadline = Instant::now() + TIME_LIMIT;
            prepare(input, database, target_version, maria, &|| {
                check_job(cancelled(), *closed.borrow(), deadline)
            })
        })
        .await
        .map_err(|_| PLAN_LOCK)??;
        self.session(id)?;
        let preview = plan.preview.clone();
        let mut pending = session.pending_restore.lock().map_err(|_| PLAN_LOCK)?;
        *pending = Some(plan);
        let expiry = preview.token.clone();
        let session = Arc::downgrade(&session);
        tokio::spawn(async move {
            tokio::time::sleep(EXPIRES).await;
            if let Some(session) = session.upgrade() {
                if let Ok(mut pending) = session.pending_restore.lock() {
                    if pending
                        .as_ref()
                        .is_some_and(|plan| plan.preview.token == expiry)
                    {
                        pending.take();
                    }
                }
            }
        });
        Ok(preview)
    }

    pub fn discard_restore(&self, id: &str, token: &str) -> Result<()> {
        let session = self.session(id)?;
        let mut pending = session.pending_restore.lock().map_err(|_| PLAN_LOCK)?;
        if pending
            .as_ref()
            .is_some_and(|plan| plan.preview.token == token)
        {
            pending.take();
        }
        Ok(())
    }

    pub async fn apply_restore(
        &self,
        id: &str,
        request: String,
        token: &str,
        database_confirmation: &str,
        trusted: bool,
        password: MysqlPassword,
        confirmation: &str,
    ) -> Result<MysqlRestoreReport> {
        let guard = self.store.queries.claim(&request)?;
        let session = self.session(id)?;
        if session.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if password.0.len() > 4096 || password.0.contains('\0') {
            return Err("MySQL 복원 암호를 확인하세요.".into());
        }
        let plan = {
            let mut pending = session.pending_restore.lock().map_err(|_| PLAN_LOCK)?;
            let plan = pending
                .as_ref()
                .filter(|plan| plan.preview.token == token && Instant::now() < plan.expires)
                .ok_or(PLAN_ERROR)?;
            if !trusted || plan.preview.database != database_confirmation {
                return Err("백업 출처와 새 DB 이름을 확인하세요.".into());
            }
            pending.take().ok_or(PLAN_ERROR)?
        };
        let database = plan.preview.database.clone();
        let archive_sha256 = plan.preview.archive.sha256.clone();
        let schema_sha256 = plan.preview.schema.as_ref().map(|file| file.sha256.clone());
        let target_version = self.check_restore_target(id, &database).await?;
        if target_version != plan.preview.target_version {
            return Err("서버 버전이 바뀌었습니다. 복원을 다시 검토하세요.".into());
        }
        let store = self.store.clone();
        let closed = session.closed.subscribe();
        let cancelled = guard.cancellation_check();
        let maria = session.engine == "MariaDB";
        let (tables, views, execution) = tokio::task::spawn_blocking({
            let store = store.clone();
            let session = Arc::clone(&session);
            let request = request.clone();
            move || {
                let deadline = Instant::now() + TIME_LIMIT;
                let check = || check_job(cancelled(), *closed.borrow(), deadline);
                check()?;
                let profile = store.mysql_profile(&session.profile_id, session.profile_revision)?;
                let tool = find_version(&plan.executable, plan.scratch.path(), maria, &plan.preview.target_version, &check)?;
                if tool != plan.preview.tool_version {
                    return Err("복원 도구 버전이 바뀌었습니다. 복원을 다시 검토하세요.".into());
                }
                let (command, output) = restore_command(&plan, &profile.settings, &password, maria)?;
                drop(password);
                check()?;
                audit(&store, &session, &request, "started")?;
                let execution = run(command, &check, "SQL 복원이 중단되었습니다. 계정의 생성 권한, 참조 객체와 DEFINER를 확인하세요.");
                let started = checkpoint_seen(output, &plan.checkpoint).unwrap_or(false);
                Ok::<_, String>((plan.tables, plan.views, (execution, started)))
            }
        }).await.map_err(|_| "MySQL 복원 결과를 확인할 수 없습니다.")??;
        let mut report = MysqlRestoreReport {
            database: database.clone(),
            archive_sha256,
            schema_sha256,
            status: Status::Unconfirmed,
            tables: None,
            views: None,
            rows: None,
            message: None,
            audit_warning: false,
        };
        let outcome = match execution {
            (Ok(()), true) => match self.verify_restored(id, database, tables, views).await {
                Ok((tables, views, rows)) => {
                    report.status = Status::Verified;
                    report.tables = Some(tables);
                    report.views = Some(views);
                    report.rows = Some(rows);
                    "succeeded"
                }
                Err(error) => {
                    report.status = Status::Unverified;
                    report.message = Some(error);
                    "unconfirmed"
                }
            },
            (Err(error), true) => {
                report.status = Status::Partial;
                report.message = Some(format!(
                    "{error} 새 DB에 일부 데이터가 남아 있을 수 있습니다."
                ));
                "partial"
            }
            (result, false) => {
                let error = result
                    .err()
                    .unwrap_or_else(|| "새 DB 생성 확인 신호를 읽을 수 없습니다.".into());
                report.message = Some(format!(
                    "{error} 재시도 전에 대상 DB의 존재 여부를 확인하세요."
                ));
                "unconfirmed"
            }
        };
        report.audit_warning = tokio::task::spawn_blocking(move || {
            audit(&store, &session, &request, outcome).is_err()
        })
        .await
        .unwrap_or(true);
        Ok(report)
    }

    async fn check_restore_target(&self, id: &str, database: &str) -> Result<String> {
        let database = database.to_owned();
        let (exists, version) = self.read(id, |connection| Box::pin(async move {
            connection.exec_first::<(bool, String), _, _>(
                "SELECT EXISTS (SELECT 1 FROM information_schema.SCHEMATA
                    WHERE BINARY SCHEMA_NAME = BINARY ? OR (@@lower_case_table_names <> 0 AND BINARY LOWER(SCHEMA_NAME) = BINARY LOWER(?))), VERSION()",
                (database.clone(), database),
            ).await?.ok_or(ReadError::Shape)
        })).await?;
        if exists {
            return Err(EXISTS.into());
        }
        Ok(version)
    }

    async fn verify_restored(
        &self,
        id: &str,
        database: String,
        tables: BTreeSet<String>,
        views: BTreeSet<String>,
    ) -> Result<(usize, usize, u64)> {
        self.read(id, |connection| Box::pin(async move {
            let objects: Vec<(String, String)> = query(connection,
                "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
                 WHERE BINARY TABLE_SCHEMA = BINARY ? OR (@@lower_case_table_names <> 0 AND BINARY LOWER(TABLE_SCHEMA) = BINARY LOWER(?))",
                (database.clone(), database.clone()),
            ).await?;
            let (actual_views, actual_tables): (Vec<_>, Vec<_>) = objects.into_iter().partition(|(_, kind)| kind == "VIEW");
            if !tables.iter().map(String::as_str).eq(actual_tables.iter().map(|(name, _)| name.as_str()).collect::<BTreeSet<_>>())
                || !views.iter().map(String::as_str).eq(actual_views.iter().map(|(name, _)| name.as_str()).collect::<BTreeSet<_>>())
            {
                return Err(ReadError::InvalidQuery("복원한 테이블과 뷰를 백업 목록과 대조할 수 없습니다.".into()));
            }
            let mut rows = 0u64;
            for (table, kind) in &actual_tables {
                if kind == "SEQUENCE" { continue; }
                let count = connection.query_first::<u64, _>(format!("SELECT COUNT(*) FROM {}.{}", quoted(&database), quoted(table)))
                    .await?.ok_or(ReadError::Shape)?;
                rows = rows.checked_add(count).ok_or(ReadError::Shape)?;
            }
            Ok((actual_tables.len(), actual_views.len(), rows))
        })).await
    }
}

fn prepare(
    input: MysqlRestoreInput,
    database: String,
    target_version: String,
    maria: bool,
    check: &impl Fn() -> Result<()>,
) -> Result<Plan> {
    check()?;
    let scratch = tempfile::Builder::new()
        .prefix("stackport-mysql-restore-")
        .tempdir()
        .map_err(|_| "복원 임시 폴더를 만들 수 없습니다.")?;
    let directory = Path::new(input.directory.trim());
    if !directory.is_absolute() {
        return Err("복원 도구 폴더의 절대 경로를 지정하세요.".into());
    }
    let tool = if maria { "mariadb" } else { "mysql" };
    let executable = fs::canonicalize(directory.join(format!("{tool}{}", env::consts::EXE_SUFFIX)))
        .map_err(|_| format!("선택한 폴더에서 {tool} 실행 파일을 찾을 수 없습니다."))?;
    let tool_version = find_version(&executable, scratch.path(), maria, &target_version, check)?;
    let mut replay =
        tempfile::tempfile_in(scratch.path()).map_err(|_| "복원 임시 사본을 만들 수 없습니다.")?;
    replay
        .seek(SeekFrom::Start(PREFIX_BYTES as u64))
        .map_err(|_| "복원 임시 사본을 열 수 없습니다.")?;
    let schema = input
        .schema
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(|path| snapshot::append(path, &mut replay, maria, &target_version, check))
        .transpose()?;
    let archive = snapshot::append(&input.source, &mut replay, maria, &target_version, check)?;
    let data_only = archive.scope.data_only();
    let expected = restore_scope(&archive, schema.as_ref(), data_only)?;
    if !archive.scope.data.is_subset(&expected.tables) {
        return Err("데이터가 들어 있는 모든 테이블의 구조가 백업에 필요합니다.".into());
    }
    let defaults = expected.database_options(&database)?;
    let checkpoint = Uuid::new_v4().simple().to_string();
    let prefix = format!(
        "CREATE DATABASE {}{defaults};\nUSE {};\nSELECT '{checkpoint}';\n",
        quoted(&database),
        quoted(&database)
    );
    if prefix.len() >= PREFIX_BYTES {
        return Err("복원할 데이터베이스 설정을 읽을 수 없습니다.".into());
    }
    replay
        .seek(SeekFrom::Start(0))
        .and_then(|_| replay.write_all(prefix.as_bytes()))
        .and_then(|_| replay.write_all(&vec![b'\n'; PREFIX_BYTES - prefix.len()]))
        .and_then(|_| replay.seek(SeekFrom::Start(0)))
        .map_err(|_| "확인한 SQL 사본을 준비할 수 없습니다.")?;
    let tables = expected.tables.clone();
    let views = expected.views.clone();
    Ok(Plan {
        preview: MysqlRestorePreview {
            token: Uuid::new_v4().to_string(),
            database,
            source_database: archive.scope.database,
            target_version,
            tool_version,
            archive: archive.info,
            schema: schema.map(|source| source.info),
            tables: tables.iter().take(PREVIEW_OBJECTS).cloned().collect(),
            views: views.iter().take(PREVIEW_OBJECTS).cloned().collect(),
            table_count: tables.len(),
            view_count: views.len(),
            data_only,
            expires_seconds: EXPIRES.as_secs(),
        },
        expires: Instant::now() + EXPIRES,
        replay,
        scratch,
        executable,
        checkpoint,
        tables,
        views,
    })
}

fn restore_scope<'a>(
    archive: &'a Dump,
    schema: Option<&'a Dump>,
    data_only: bool,
) -> Result<&'a Scope> {
    match (data_only, schema) {
        (false, None) => Ok(&archive.scope),
        (false, Some(_)) => Err("구조 파일은 데이터 전용 SQL을 복원할 때 선택하세요.".into()),
        (true, None) => {
            Err("데이터 전용 SQL과 함께 같은 원본 DB의 구조 전용 SQL을 선택하세요.".into())
        }
        (true, Some(schema))
            if schema.scope.data.is_empty()
                && schema.scope.database == archive.scope.database
                && archive.scope.data.is_subset(&schema.scope.tables) =>
        {
            Ok(&schema.scope)
        }
        (true, Some(_)) => {
            Err("구조 전용 SQL에 데이터 파일의 원본 DB와 모든 테이블이 있어야 합니다.".into())
        }
    }
}

fn restore_command(
    plan: &Plan,
    settings: &MysqlSettings,
    password: &MysqlPassword,
    maria: bool,
) -> Result<(std::process::Command, File)> {
    let scratch = plan.scratch.path();
    let mut command = client_command(&plan.executable, scratch, maria);
    configure_connection(&mut command, settings, password, scratch, maria)?;
    let output =
        tempfile::tempfile_in(scratch).map_err(|_| "복원 실행 상태를 기록할 수 없습니다.")?;
    command
        .args([
            "--batch",
            "--binary-mode",
            "--skip-column-names",
            "--skip-reconnect",
            "--local-infile=0",
            "--unbuffered",
        ])
        .stdin(Stdio::from(
            plan.replay
                .try_clone()
                .map_err(|_| "확인한 SQL 사본을 열 수 없습니다.")?,
        ))
        .stdout(Stdio::from(
            output
                .try_clone()
                .map_err(|_| "복원 실행 상태를 기록할 수 없습니다.")?,
        ));
    Ok((command, output))
}

fn checkpoint_seen(mut output: File, marker: &str) -> std::io::Result<bool> {
    output.seek(SeekFrom::Start(0))?;
    let mut line = Vec::new();
    output.take(256).read_to_end(&mut line)?;
    Ok(line
        .split(|byte| *byte == b'\n')
        .any(|line| line.strip_suffix(b"\r").unwrap_or(line) == marker.as_bytes()))
}

fn check_job(cancelled: bool, closed: bool, deadline: Instant) -> Result<()> {
    if cancelled || closed {
        return Err(CANCELLED.into());
    }
    if Instant::now() >= deadline {
        return Err(TIMED_OUT.into());
    }
    Ok(())
}

fn audit(
    store: &crate::Store,
    session: &super::Session,
    request: &str,
    outcome: &'static str,
) -> Result<()> {
    let (operation, outcome) = match outcome {
        "partial" => ("mysql.restore.partial", "failed"),
        "unconfirmed" => ("mysql.restore.unconfirmed", "failed"),
        outcome => ("mysql.restore", outcome),
    };
    insert_audit(
        &store.connect()?,
        AuditRecord {
            correlation_id: request,
            operation,
            project_id: Some(&session.project_id),
            profile_id: Some(&session.profile_id),
            environment: Some(&session.environment),
            object_name: None,
            outcome,
            affected_count: None,
        },
    )
}
