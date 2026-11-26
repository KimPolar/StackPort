use super::{connect, query_error, required_text, Manager, Session, SqlClient, TIMEOUT};
use crate::{insert_audit, AuditRecord, Result};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicI32, AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};
use tiberius::{error::Error, Row};
use tokio::{
    sync::Mutex as AsyncMutex,
    task::spawn_blocking,
    time::{sleep_until, timeout, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const PREVIEW_TTL: Duration = Duration::from_secs(300);
const JOB_TIME: Duration = Duration::from_secs(30 * 60);
const ATTENTION_TIME: Duration = Duration::from_secs(2);
const STATE: &str = "SQL Server 백업 상태를 읽을 수 없습니다.";
const REVIEW: &str = "SQL Server 백업 미리보기를 다시 확인하세요.";
const OPEN: &str = "SQL Server 연결이 닫혔습니다. 다시 연결하세요.";
const DISK: &str = "SQL Server 호스트의 로컬 디스크 절대 경로를 지정하세요.";
const STANDARD_EDITION_ID: i64 = -1534726760;
const STANDARD_DEVELOPER_EDITION_ID: i64 = -1785266663;

const CAPABILITIES: &str = "SELECT DB_NAME(), COALESCE(CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultBackupPath')), CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath'))),
    CONVERT(int, SERVERPROPERTY('EngineEdition')), d.database_id, d.state, d.source_database_id,
    CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'BACKUP DATABASE'), 0)),
    CONVERT(int, SERVERPROPERTY('ProductMajorVersion')), CONVERT(bigint, SERVERPROPERTY('EditionID'))
    FROM sys.databases AS d WHERE d.database_id = DB_ID()";

const BACKUP: &str = "BACKUP DATABASE @P1 TO DISK = @P2
    WITH COPY_ONLY, CHECKSUM, STOP_ON_ERROR, NOFORMAT, NOINIT, NOSKIP, NAME = @P3, MEDIANAME = @P3";

const PROGRESS: &str = "SELECT CONVERT(float, percent_complete) FROM sys.dm_exec_requests
    WHERE session_id = @P1 AND command LIKE @P2";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupOptions {
    directory: String,
    compression: bool,
}

#[derive(Clone, Serialize)]
pub struct BackupPreview {
    token: String,
    database: String,
    path: String,
    compression: bool,
    expires_seconds: u64,
}

#[derive(Serialize)]
pub struct BackupCapabilities {
    database: String,
    directory: Option<String>,
    disk_supported: bool,
    can_backup: bool,
    compression_supported: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyInput {
    path: String,
    position: i32,
    expected_name: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
struct BackupSet {
    id: Uuid,
    database: String,
    name: Option<String>,
    position: i32,
    backup_type: i16,
    source_version: String,
    has_checksums: bool,
    copy_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Unconfirmed,
}

#[derive(Serialize)]
pub struct BackupOutcome {
    path: String,
    backup_name: Option<String>,
    status: Status,
    set: Option<BackupSet>,
    error_code: Option<u32>,
    message: Option<String>,
    attention_confirmed: Option<bool>,
    audit_warning: bool,
}

#[derive(Clone, Copy)]
#[repr(u8)]
enum Phase {
    Preparing = 0,
    Writing = 1,
    Reading = 2,
    Verifying = 3,
}

#[derive(Serialize)]
pub struct BackupProgress {
    phase: &'static str,
    percent: Option<f64>,
}

struct Plan {
    preview: BackupPreview,
    backup_name: String,
    expires: Instant,
}

struct Active {
    id: Uuid,
    stop: CancellationToken,
    server_session: AtomicI32,
    phase: AtomicU8,
    monitor: AsyncMutex<Monitor>,
}

enum Monitor {
    New,
    Ready(SqlClient),
    Unavailable,
}

#[derive(Default)]
pub(super) struct State {
    pending: Option<Plan>,
    active: Option<Arc<Active>>,
}

struct Registration<'a>(&'a Session);

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.backup.lock() {
            state.active = None;
        }
    }
}

impl Session {
    pub(super) fn stop_backup(&self) {
        if let Ok(state) = self.backup.lock() {
            if let Some(active) = &state.active {
                active.stop.cancel();
            }
        }
    }
}

enum Work {
    Backup(Plan),
    Verify(VerifyInput),
}

impl Work {
    fn path(&self) -> &str {
        match self {
            Self::Backup(plan) => &plan.preview.path,
            Self::Verify(input) => &input.path,
        }
    }

    fn audit_operation(&self, unconfirmed: bool) -> &'static str {
        match (self, unconfirmed) {
            (Self::Backup(_), false) => "sql_server.backup",
            (Self::Backup(_), true) => "sql_server.backup.unconfirmed",
            (Self::Verify(_), _) => "sql_server.backup.verify",
        }
    }
}

impl Manager {
    pub async fn backup_capabilities(&self, id: &str) -> Result<BackupCapabilities> {
        capabilities(&exactly_one(self.rows(id, CAPABILITIES, &[]).await?)?)
    }

    pub async fn preview_backup(&self, id: &str, options: BackupOptions) -> Result<BackupPreview> {
        let session = self.session(id)?;
        let capability = self.backup_capabilities(id).await?;
        if !capability.disk_supported {
            return Err(
                "서버 디스크 백업은 SQL Server 2017 이상에서 온라인 상태인 일반 사용자 DB에 사용할 수 있습니다.".into(),
            );
        }
        if !capability.can_backup {
            return Err("현재 계정에 BACKUP DATABASE 권한이 없습니다.".into());
        }
        if options.compression && !capability.compression_supported {
            return Err("현재 SQL Server 에디션에서 압축 백업을 만들 수 없습니다.".into());
        }
        let directory = options.directory.trim();
        let separator = disk_path(directory, true)?;
        let token = Uuid::new_v4();
        let backup_name = format!("stackport-{}", Uuid::new_v4().simple());
        let path = format!(
            "{}{separator}{backup_name}.bak",
            directory.trim_end_matches(separator)
        );
        disk_path(&path, false)?;
        let preview = BackupPreview {
            token: token.to_string(),
            database: capability.database,
            path,
            compression: options.compression,
            expires_seconds: PREVIEW_TTL.as_secs(),
        };
        let mut state = session.backup.lock().map_err(|_| STATE)?;
        if session.closed.load(Ordering::Acquire) {
            return Err(OPEN.into());
        }
        if state.active.is_some() {
            return Err("이 연결에서 백업 작업을 실행 중입니다.".into());
        }
        state.pending = Some(Plan {
            preview: preview.clone(),
            backup_name,
            expires: Instant::now() + PREVIEW_TTL,
        });
        Ok(preview)
    }

    pub fn discard_backup(&self, id: &str, token: &str) -> Result<()> {
        let session = self.session(id)?;
        let mut state = session.backup.lock().map_err(|_| STATE)?;
        if state
            .pending
            .as_ref()
            .is_some_and(|plan| plan.preview.token == token)
        {
            state.pending.take();
        }
        Ok(())
    }

    pub async fn run_backup(
        &self,
        id: &str,
        request_id: &str,
        token: &str,
        approved: bool,
        confirmation: &str,
    ) -> Result<BackupOutcome> {
        let request_id = operation_id(request_id)?;
        let session = self.session(id)?;
        if session.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if !approved {
            return Err("백업할 DB와 서버 파일 경로를 확인하세요.".into());
        }
        let (active, plan) =
            {
                let mut state = session.backup.lock().map_err(|_| STATE)?;
                if !state.pending.as_ref().is_some_and(|plan| {
                    plan.preview.token == token && plan.expires > Instant::now()
                }) {
                    return Err(REVIEW.into());
                }
                let active = begin(&session, &mut state, request_id)?;
                (active, state.pending.take().ok_or(REVIEW)?)
            };
        self.run_backup_work(&session, &active, Work::Backup(plan))
            .await
    }

    pub async fn verify_backup(
        &self,
        id: &str,
        request_id: &str,
        mut input: VerifyInput,
    ) -> Result<BackupOutcome> {
        let request_id = operation_id(request_id)?;
        let session = self.session(id)?;
        input.path = input.path.trim().to_owned();
        disk_path(&input.path, false)?;
        if !(1..=32767).contains(&input.position)
            || input
                .expected_name
                .as_ref()
                .is_some_and(|name| name.encode_utf16().count() > 128 || name.contains('\0'))
        {
            return Err("백업 세트의 위치와 이름을 확인하세요.".into());
        }
        let active = {
            let mut state = session.backup.lock().map_err(|_| STATE)?;
            begin(&session, &mut state, request_id)?
        };
        self.run_backup_work(&session, &active, Work::Verify(input))
            .await
    }

    pub async fn backup_progress(
        &self,
        id: &str,
        request_id: &str,
    ) -> Result<Option<BackupProgress>> {
        let session = self.session(id)?;
        let Some(active) = active_job(&session, operation_id(request_id)?)? else {
            return Ok(None);
        };
        let (phase, command) = match active.phase.load(Ordering::Acquire) {
            phase if phase == Phase::Writing as u8 => ("writing", Some("BACKUP%")),
            phase if phase == Phase::Verifying as u8 => ("verifying", Some("RESTORE%")),
            phase if phase == Phase::Reading as u8 => ("reading", None),
            _ => ("preparing", None),
        };
        let spid = active.server_session.load(Ordering::Acquire);
        let percent = if let Some(command) = command {
            // A cancelled DMV read may leave unread TDS data, so monitoring has its own connection.
            if let Ok(mut monitor) = active.monitor.try_lock() {
                if matches!(*monitor, Monitor::New) {
                    let connection = match session.operation_auth() {
                        Ok(Some(auth)) => timeout(
                            Duration::from_secs(3),
                            connect(&session.profile.settings, auth),
                        )
                        .await
                        .ok()
                        .and_then(std::result::Result::ok),
                        _ => None,
                    };
                    *monitor = connection.map_or(Monitor::Unavailable, Monitor::Ready);
                }
                match &mut *monitor {
                    Monitor::Ready(connection) => match timeout(Duration::from_secs(3), async {
                        connection
                            .query(PROGRESS, &[&spid, &command])
                            .await?
                            .into_row()
                            .await
                    })
                    .await
                    {
                        Ok(Ok(row)) => row
                            .and_then(|row| row.try_get::<f64, _>(0).ok().flatten())
                            .filter(|percent| (0.0..=100.0).contains(percent)),
                        _ => {
                            *monitor = Monitor::Unavailable;
                            None
                        }
                    },
                    _ => None,
                }
            } else {
                None
            }
        } else {
            None
        };
        Ok(Some(BackupProgress { phase, percent }))
    }

    pub fn cancel_backup(&self, id: &str, request_id: &str) -> Result<bool> {
        let session = self.session(id)?;
        let Some(active) = active_job(&session, operation_id(request_id)?)? else {
            return Ok(false);
        };
        active.stop.cancel();
        Ok(true)
    }

    async fn run_backup_work(
        &self,
        session: &Session,
        active: &Active,
        work: Work,
    ) -> Result<BackupOutcome> {
        let _registration = Registration(session);
        let store = self.store.clone();
        let profile = session.profile.clone();
        let request = active.id.to_string();
        let auth = session.operation_auth()?.ok_or(OPEN)?;
        let check = profile.clone();
        spawn_blocking({
            let store = store.clone();
            move || store.sql_server_profile(&check.id, check.revision)
        })
        .await
        .map_err(|_| STATE)??;
        let mut client = tokio::select! {
            biased;
            _ = active.stop.cancelled() => return Err("SQL Server 백업 작업이 시작 전에 중단되었습니다.".into()),
            ready = timeout(TIMEOUT, connect(&session.profile.settings, auth)) =>
                ready.map_err(|_| "SQL Server 백업 연결 시간이 초과되었습니다.")??,
        };
        let spid = timeout(TIMEOUT, async {
            client
                .simple_query("SELECT CONVERT(int, @@SPID)")
                .await?
                .into_row()
                .await
        })
        .await
        .map_err(|_| "SQL Server 백업 연결 정보를 읽는 시간이 초과되었습니다.")?
        .map_err(query_error)?
        .and_then(|row| row.try_get::<i32, _>(0).ok().flatten())
        .ok_or(STATE)?;
        active.server_session.store(spid, Ordering::Release);
        audit(
            &store,
            &profile,
            &request,
            work.audit_operation(false),
            "started",
        )
        .await?;
        let mut outcome = BackupOutcome {
            path: work.path().to_owned(),
            backup_name: match &work {
                Work::Backup(plan) => Some(plan.backup_name.clone()),
                Work::Verify(_) => None,
            },
            status: Status::Succeeded,
            set: None,
            error_code: None,
            message: None,
            attention_confirmed: None,
            audit_warning: false,
        };
        let deadline = Instant::now() + JOB_TIME;
        let result = tokio::select! {
            biased;
            _ = active.stop.cancelled() => Err(Interruption::Cancelled),
            _ = sleep_until(deadline) => Err(Interruption::TimedOut),
            result = execute(&mut client, active, &work) => Ok(result),
        };
        match result {
            Ok(Ok(set)) => outcome.set = set,
            Ok(Err(Failure::Input(message))) => {
                outcome.status = Status::Failed;
                outcome.message = Some(message.into());
            }
            Ok(Err(Failure::Server(error))) => {
                let in_flight = active.phase.load(Ordering::Acquire) == Phase::Writing as u8;
                outcome.status = if in_flight && !matches!(error, Error::Server(_)) {
                    Status::Unconfirmed
                } else {
                    Status::Failed
                };
                outcome.error_code = error.code();
                outcome.message =
                    Some(server_message(error.code(), matches!(work, Work::Verify(_))).into());
            }
            Err(interruption) => {
                let phase = active.phase.load(Ordering::Acquire);
                let confirmed = matches!(
                    timeout(ATTENTION_TIME, client.cancel_query()).await,
                    Ok(Ok(()))
                );
                outcome.attention_confirmed =
                    (phase != Phase::Preparing as u8).then_some(confirmed);
                outcome.status = if phase == Phase::Writing as u8 && !confirmed {
                    Status::Unconfirmed
                } else {
                    match interruption {
                        Interruption::Cancelled => Status::Cancelled,
                        Interruption::TimedOut => Status::TimedOut,
                    }
                };
                outcome.message = Some(
                    if phase == Phase::Writing as u8 {
                        "백업 중단 뒤 서버의 .bak 파일 상태를 확인하세요."
                    } else {
                        "SQL Server 작업이 끝나기 전에 중단되었습니다."
                    }
                    .into(),
                );
            }
        }
        let result = if matches!(outcome.status, Status::Succeeded) {
            "succeeded"
        } else {
            "failed"
        };
        outcome.audit_warning = audit(
            &store,
            &profile,
            &request,
            work.audit_operation(matches!(outcome.status, Status::Unconfirmed)),
            result,
        )
        .await
        .is_err();
        Ok(outcome)
    }
}

fn operation_id(id: &str) -> Result<Uuid> {
    Uuid::parse_str(id).map_err(|_| "유효한 SQL Server 백업 작업 ID를 지정하세요.".into())
}

fn begin(session: &Session, state: &mut State, request_id: Uuid) -> Result<Arc<Active>> {
    if session.closed.load(Ordering::Acquire) {
        return Err(OPEN.into());
    }
    if state.active.is_some() {
        return Err("이 연결에서 백업 작업을 실행 중입니다.".into());
    }
    let active = Arc::new(Active {
        id: request_id,
        stop: CancellationToken::new(),
        server_session: AtomicI32::new(0),
        phase: AtomicU8::new(Phase::Preparing as u8),
        monitor: AsyncMutex::new(Monitor::New),
    });
    state.active = Some(active.clone());
    Ok(active)
}

fn active_job(session: &Session, id: Uuid) -> Result<Option<Arc<Active>>> {
    Ok(session
        .backup
        .lock()
        .map_err(|_| STATE)?
        .active
        .as_ref()
        .filter(|active| active.id == id)
        .cloned())
}

fn disk_path(path: &str, directory: bool) -> Result<char> {
    if path.encode_utf16().count() > 260 || path.chars().any(char::is_control) {
        return Err(DISK.into());
    }
    let (separator, tail) = match path.as_bytes() {
        [drive, b':', b'\\', ..] if drive.is_ascii_alphabetic() => ('\\', &path[3..]),
        [b'/', ..] if !path.starts_with("//") => ('/', &path[1..]),
        _ => return Err(DISK.into()),
    };
    let parts = if directory {
        tail.trim_end_matches(separator)
    } else {
        tail
    };
    if (!directory && parts.is_empty())
        || (!parts.is_empty()
            && parts.split(separator).any(|part| {
                part.is_empty()
                    || part == "."
                    || part == ".."
                    || (separator == '\\' && !crate::local_file::valid_windows_filename(part))
            }))
    {
        return Err(DISK.into());
    }
    Ok(separator)
}

fn exactly_one(rows: Vec<Row>) -> Result<Row> {
    if rows.len() != 1 {
        return Err("SQL Server가 백업 정보를 한 건으로 반환하지 않았습니다.".into());
    }
    rows.into_iter().next().ok_or_else(|| STATE.into())
}

fn capabilities(row: &Row) -> Result<BackupCapabilities> {
    let edition = row.try_get::<i32, _>(2).map_err(query_error)?.unwrap_or(-1);
    let edition_id = row.try_get::<i64, _>(8).map_err(query_error)?;
    let user_database = row
        .try_get::<i32, _>(3)
        .map_err(query_error)?
        .is_some_and(|id| id > 4)
        && row.try_get::<u8, _>(4).map_err(query_error)? == Some(0)
        && row.try_get::<i32, _>(5).map_err(query_error)?.is_none();
    Ok(BackupCapabilities {
        database: required_text(row, 0)?.to_owned(),
        directory: row
            .try_get::<&str, _>(1)
            .map_err(query_error)?
            .map(str::to_owned),
        disk_supported: matches!(edition, 2..=4)
            && row
                .try_get::<i32, _>(7)
                .map_err(query_error)?
                .is_some_and(|major| major >= 14)
            && user_database,
        can_backup: row
            .try_get::<bool, _>(6)
            .map_err(query_error)?
            .unwrap_or(false),
        compression_supported: edition == 3
            || matches!(
                edition_id,
                Some(STANDARD_EDITION_ID | STANDARD_DEVELOPER_EDITION_ID)
            ),
    })
}

enum Failure {
    Input(&'static str),
    Server(Error),
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Server(error)
    }
}

enum Interruption {
    Cancelled,
    TimedOut,
}

async fn execute(
    client: &mut SqlClient,
    active: &Active,
    work: &Work,
) -> std::result::Result<Option<BackupSet>, Failure> {
    match work {
        Work::Backup(plan) => {
            let row = client
                .simple_query(CAPABILITIES)
                .await?
                .into_row()
                .await?
                .ok_or(Failure::Input("현재 DB의 백업 권한을 확인할 수 없습니다."))?;
            let capability = capabilities(&row)
                .map_err(|_| Failure::Input("현재 DB의 백업 권한을 확인할 수 없습니다."))?;
            if capability.database != plan.preview.database
                || !capability.disk_supported
                || !capability.can_backup
            {
                return Err(Failure::Input(
                    "백업할 DB나 BACKUP DATABASE 권한이 바뀌었습니다. 다시 검토하세요.",
                ));
            }
            let path = &plan.preview.path;
            let row = client
                .query(
                    "SELECT file_exists, file_is_a_directory, parent_directory_exists FROM sys.dm_os_file_exists(@P1)",
                    &[path],
                )
                .await?
                .into_row()
                .await?
                .ok_or(Failure::Input(
                    "SQL Server의 백업 경로를 확인할 수 없습니다.",
                ))?;
            let flag = |index| row.try_get::<u8, _>(index).map(|value| value == Some(1));
            if flag(0)? || flag(1)? {
                return Err(Failure::Input(
                    "서버에 같은 이름의 파일이나 폴더가 있습니다. 백업을 다시 준비하세요.",
                ));
            }
            if !flag(2)? {
                return Err(Failure::Input("SQL Server가 백업 폴더를 찾을 수 없습니다. 서버 경로와 서비스 계정 권한을 확인하세요."));
            }
            let sql = if plan.preview.compression {
                format!("{BACKUP}, COMPRESSION")
            } else {
                format!("{BACKUP}, NO_COMPRESSION")
            };
            active.phase.store(Phase::Writing as u8, Ordering::Release);
            client
                .query(sql, &[&plan.preview.database, path, &plan.backup_name])
                .await?
                .into_results()
                .await?;
            Ok(None)
        }
        Work::Verify(input) => {
            active.phase.store(Phase::Reading as u8, Ordering::Release);
            let before = read_set(client, input).await?;
            active
                .phase
                .store(Phase::Verifying as u8, Ordering::Release);
            let base = "RESTORE VERIFYONLY FROM DISK = @P1 WITH FILE = @P2, STOP_ON_ERROR";
            let sql = if before.has_checksums {
                format!("{base}, CHECKSUM")
            } else {
                base.to_owned()
            };
            client
                .query(sql, &[&input.path, &input.position])
                .await?
                .into_results()
                .await?;
            active.phase.store(Phase::Reading as u8, Ordering::Release);
            if before != read_set(client, input).await? {
                return Err(Failure::Input(
                    "검증하는 동안 백업 세트가 변경되었습니다. 파일을 다시 선택하세요.",
                ));
            }
            Ok(Some(before))
        }
    }
}

async fn read_set(
    client: &mut SqlClient,
    input: &VerifyInput,
) -> std::result::Result<BackupSet, Failure> {
    let rows = client
        .query("RESTORE HEADERONLY FROM DISK = @P1", &[&input.path])
        .await?
        .into_first_result()
        .await?;
    let mut selected = None;
    for row in rows {
        if row.try_get::<i16, _>("Position")?.map(i32::from) == Some(input.position) {
            selected = Some(row);
            break;
        }
    }
    let row = selected.ok_or(Failure::Input(
        "지정한 위치의 백업 세트를 찾을 수 없습니다.",
    ))?;
    let malformed =
        || Failure::Input("SQL Server가 백업 세트의 필수 머리글을 반환하지 않았습니다.");
    let id = row
        .try_get::<Uuid, _>("BackupSetGUID")?
        .filter(|id| !id.is_nil())
        .ok_or_else(malformed)?;
    if row.try_get::<bool, _>("IsDamaged")? == Some(true) {
        return Err(Failure::Input(
            "SQL Server가 이 백업 세트를 손상된 상태로 표시합니다.",
        ));
    }
    let name = row.try_get::<&str, _>("BackupName")?.map(str::to_owned);
    if input
        .expected_name
        .as_ref()
        .is_some_and(|expected| name.as_ref() != Some(expected))
    {
        return Err(Failure::Input(
            "이 파일의 백업 세트 이름이 생성한 백업과 다릅니다.",
        ));
    }
    let major = row
        .try_get::<i32, _>("SoftwareVersionMajor")?
        .ok_or_else(malformed)?;
    let minor = row
        .try_get::<i32, _>("SoftwareVersionMinor")?
        .ok_or_else(malformed)?;
    let build = row
        .try_get::<i32, _>("SoftwareVersionBuild")?
        .ok_or_else(malformed)?;
    Ok(BackupSet {
        id,
        name,
        position: input.position,
        database: row
            .try_get::<&str, _>("DatabaseName")?
            .ok_or_else(malformed)?
            .to_owned(),
        backup_type: row
            .try_get::<u8, _>("BackupType")
            .map(|value| value.map(i16::from))
            .or_else(|_| row.try_get::<i16, _>("BackupType"))?
            .ok_or_else(malformed)?,
        source_version: format!("{major}.{minor}.{build}"),
        has_checksums: row
            .try_get::<bool, _>("HasBackupChecksums")?
            .ok_or_else(malformed)?,
        copy_only: row
            .try_get::<bool, _>("IsCopyOnly")?
            .ok_or_else(malformed)?,
    })
}

fn server_message(code: Option<u32>, verify: bool) -> &'static str {
    match code {
        Some(229 | 262 | 297 | 15247) => if verify {
            "백업 머리글과 검증에는 CREATE DATABASE 권한이 필요합니다."
        } else { "현재 SQL Server 계정에 백업 또는 서버 경로 검사 권한이 없습니다." },
        Some(3201 | 3202 | 3203 | 3234) => "SQL Server가 백업 파일을 읽거나 쓸 수 없습니다. 서버 경로와 서비스 계정 권한을 확인하세요.",
        Some(3241 | 3242 | 3243 | 3183 | 3187 | 3189) => "SQL Server가 백업 미디어나 체크섬을 읽지 못했습니다.",
        _ if verify => "SQL Server 백업 검증에 실패했습니다. 백업 위치, 파일 상태와 계정 권한을 확인하세요.",
        _ => "SQL Server 백업 완료를 확인할 수 없습니다. 서버 상태와 백업 파일을 확인하세요.",
    }
}

async fn audit(
    store: &crate::Store,
    profile: &super::Profile,
    request: &str,
    operation: &'static str,
    outcome: &'static str,
) -> Result<()> {
    let store = store.clone();
    let profile = profile.clone();
    let request = request.to_owned();
    spawn_blocking(move || {
        insert_audit(
            &store.connect()?,
            AuditRecord {
                correlation_id: &request,
                operation,
                project_id: Some(&profile.project_id),
                profile_id: Some(&profile.id),
                environment: Some(&profile.settings.environment),
                object_name: None,
                outcome,
                affected_count: None,
            },
        )
    })
    .await
    .map_err(|_| "SQL Server 백업 감사 기록을 저장할 수 없습니다.")?
}

#[cfg(test)]
mod tests {
    use super::disk_path;

    #[test]
    fn validates_server_disk_paths_independently_of_the_client_platform() {
        assert_eq!(disk_path(r"D:\백업 폴더\", true), Ok('\\'));
        assert_eq!(disk_path("/var/opt/mssql/backup/", true), Ok('/'));
        assert_eq!(disk_path("/var/opt/mssql/o'Brien.bak", false), Ok('/'));
        for path in [
            r"\\outside\share\backup.bak",
            "//outside/share/backup.bak",
            r"C:\backup\..\other.bak",
            r"C:\backup\LPT1.bak",
            r"C:\backup\backup.bak:stream",
            "/var/../backup.bak",
            "/",
            r"C:backup.bak",
        ] {
            assert!(disk_path(path, false).is_err(), "{path}");
        }
    }
}
