use super::{catalog::ident, connect, query_error, Manager, Session, CLOSED};
use crate::{insert_audit, AuditRecord, Result, Store};
use oracledb::{Connection, Error, DB_TYPE_NUMBER, DB_TYPE_VARCHAR};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

mod import;
pub use import::{PumpImportOptions, PumpImportOutcome, PumpImportPreview};

const STATE: &str = "Oracle Data Pump 작업 상태를 읽을 수 없습니다.";
const REVIEW: &str = "Oracle 백업 미리보기를 다시 확인하세요.";
const CREATE_TABLE: &str =
    "Oracle 계정에 CREATE TABLE 권한과 기본 테이블스페이스 할당량이 필요합니다.";
const REVIEW_TIME: Duration = Duration::from_secs(300);
const JOB_TIME: Duration = Duration::from_secs(30 * 60);

const DIRECTORIES: &str = "SELECT d.directory_name, d.directory_path,
    MAX(CASE WHEN p.privilege = 'READ' THEN 1 ELSE 0 END),
    MAX(CASE WHEN p.privilege = 'WRITE' THEN 1 ELSE 0 END)
    FROM all_directories d
    LEFT JOIN all_tab_privs p ON p.table_schema = 'SYS' AND p.table_name = d.directory_name
      AND p.type = 'DIRECTORY' AND (p.grantee IN (USER, 'PUBLIC') OR p.grantee IN (SELECT role FROM session_roles))
    WHERE (:directory IS NULL OR d.directory_name = :directory)
    GROUP BY d.directory_name, d.directory_path
    ORDER BY d.directory_name";

const START: &str = r"
DECLARE
    h NUMBER;
BEGIN
    h := SYS.DBMS_DATAPUMP.OPEN('EXPORT','SCHEMA',NULL,:job_name,'COMPATIBLE');
    SYS.DBMS_DATAPUMP.ADD_FILE(h,:file_name,:directory_name,
        filetype=>SYS.DBMS_DATAPUMP.KU$_FILE_TYPE_DUMP_FILE,reusefile=>0);
    SYS.DBMS_DATAPUMP.METADATA_FILTER(h,'SCHEMA_EXPR',:schema_filter);
    IF :include_metadata = 0 THEN
        SYS.DBMS_DATAPUMP.SET_PARAMETER(h,'INCLUDE_METADATA',0);
    END IF;
    IF :include_rows = 0 THEN
        SYS.DBMS_DATAPUMP.DATA_FILTER(h,'INCLUDE_ROWS',0);
    ELSE
        SYS.DBMS_DATAPUMP.SET_PARAMETER(h,'FLASHBACK_TIME','SYSTIMESTAMP');
    END IF;
    BEGIN
        SYS.DBMS_DATAPUMP.START_JOB(h);
    EXCEPTION WHEN OTHERS THEN
        IF SQLCODE != -31627 THEN RAISE; END IF;
    END;
    :job_handle := h;
EXCEPTION WHEN OTHERS THEN
    IF h IS NOT NULL THEN
        BEGIN SYS.DBMS_DATAPUMP.STOP_JOB(h,1,0,0); EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
    RAISE;
END;";

const STATUS: &str = r"
DECLARE
    job_state VARCHAR2(30);
    job_status SYS.KU$_STATUS;
    status_code VARCHAR2(5);
BEGIN
    SYS.DBMS_DATAPUMP.GET_STATUS(:job_handle, SYS.DBMS_DATAPUMP.KU$_STATUS_JOB_STATUS +
        SYS.DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR, 0, job_state, job_status);
    :job_state := job_state;
    :percent_done := NULL;
    :error_count := NULL;
    :error_code := NULL;
    IF job_status.job_status IS NOT NULL THEN
        :percent_done := TRUNC(job_status.job_status.percent_done);
        :error_count := job_status.job_status.error_count;
    END IF;
    IF job_status.error IS NOT NULL AND job_status.error.COUNT > 0 THEN
        status_code := REGEXP_SUBSTR(job_status.error(job_status.error.FIRST).logtext,'ORA-([0-9]{5})',1,1,NULL,1);
        :error_code := TO_NUMBER(status_code);
    END IF;
END;";

const INSPECT: &str = r"
DECLARE
    header SYS.KU$_DUMPFILE_INFO;
    file_type NUMBER;
    file_exists BOOLEAN;
    file_bytes NUMBER;
    block_bytes BINARY_INTEGER;
    i PLS_INTEGER;
BEGIN
    SYS.UTL_FILE.FGETATTR(:directory_name,:file_name,file_exists,file_bytes,block_bytes);
    IF NOT file_exists OR file_bytes <= 0 THEN
        RAISE_APPLICATION_ERROR(-20001,'File missing or empty');
    END IF;
    SYS.DBMS_DATAPUMP.GET_DUMPFILE_INFO(:file_name,:directory_name,header,file_type);
    :file_type := file_type;
    :size_bytes := TO_CHAR(file_bytes,'FM999999999999999999999999999999999999990');
    :dump_guid := NULL;
    :dump_version := NULL;
    :source_version := NULL;
    :job_name := NULL;
    :created := NULL;
    :master_pieces := NULL;
    :file_number := NULL;
    :master_present := NULL;
    IF header IS NOT NULL THEN
        i := header.FIRST;
        WHILE i IS NOT NULL LOOP
            CASE header(i).item_code
              WHEN SYS.DBMS_DATAPUMP.KU$_DFHDR_GUID THEN :dump_guid := header(i).value;
              WHEN SYS.DBMS_DATAPUMP.KU$_DFHDR_FILE_VERSION THEN :dump_version := header(i).value;
              WHEN SYS.DBMS_DATAPUMP.KU$_DFHDR_DB_VERSION THEN :source_version := header(i).value;
              WHEN SYS.DBMS_DATAPUMP.KU$_DFHDR_JOB_NAME THEN :job_name := header(i).value;
              WHEN SYS.DBMS_DATAPUMP.KU$_DFHDR_CREATION_DATE THEN :created := header(i).value;
              WHEN SYS.DBMS_DATAPUMP.KU$_DFHDR_MASTER_PIECE_COUNT THEN :master_pieces := header(i).value;
              WHEN SYS.DBMS_DATAPUMP.KU$_DFHDR_FILE_NUMBER THEN :file_number := header(i).value;
              WHEN SYS.DBMS_DATAPUMP.KU$_DFHDR_MASTER_PRESENT THEN :master_present := header(i).value;
              ELSE NULL;
            END CASE;
            i := header.NEXT(i);
        END LOOP;
    END IF;
END;";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Directory {
    name: String,
    path: String,
    readable: bool,
    writable: bool,
}

#[derive(Serialize)]
pub struct PumpCapabilities {
    schema: String,
    create_table: bool,
    directories: Vec<Directory>,
}

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum PumpContent {
    All,
    Metadata,
    Data,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PumpExportOptions {
    directory: String,
    content: PumpContent,
}

#[derive(Clone, Serialize)]
pub struct PumpPreview {
    token: String,
    schema: String,
    directory: Directory,
    filename: String,
    job: String,
    content: PumpContent,
    expires_seconds: u64,
}

#[derive(Clone, PartialEq, Serialize)]
pub struct DumpHeader {
    directory: Directory,
    filename: String,
    size_bytes: String,
    guid: String,
    dump_version: Option<String>,
    source_version: Option<String>,
    job: Option<String>,
    created: Option<String>,
    master_pieces: Option<String>,
    file_number: Option<String>,
    master_present: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Succeeded,
    CompletedWithErrors,
    Failed,
    Cancelled,
    TimedOut,
    Unconfirmed,
}

#[derive(Serialize)]
pub struct PumpOutcome {
    status: Status,
    directory: Directory,
    filename: String,
    job: String,
    error_code: Option<usize>,
    error_count: i32,
    message: Option<&'static str>,
    audit_warning: bool,
}

impl PumpOutcome {
    fn new(directory: Directory, filename: String, job: String) -> Self {
        Self {
            status: Status::Failed,
            directory,
            filename,
            job,
            error_code: None,
            error_count: 0,
            message: None,
            audit_warning: false,
        }
    }
}

struct Plan {
    preview: PumpPreview,
    expires: Instant,
}

#[derive(Default)]
pub(super) struct State {
    pending: Option<Plan>,
    import: Option<import::Plan>,
    active: Option<Arc<Job>>,
}

struct Job {
    id: Uuid,
    stop: AtomicBool,
    started: AtomicBool,
    percent: AtomicI32,
}

impl Job {
    fn new(request: &str) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            id: request_id(request)?,
            stop: AtomicBool::new(false),
            started: AtomicBool::new(false),
            percent: AtomicI32::new(-1),
        }))
    }
}

#[derive(Serialize)]
pub struct PumpProgress {
    started: bool,
    percent: Option<i32>,
}

struct WorkRegistration(Arc<Session>);

impl Drop for WorkRegistration {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.data_pump.lock() {
            state.active = None;
        }
    }
}

impl Session {
    pub(super) fn stop_data_pump(&self) -> Result<()> {
        if let Some(job) = &self.data_pump.lock().map_err(|_| STATE)?.active {
            job.stop.store(true, Ordering::Release);
        }
        Ok(())
    }
}

impl Manager {
    pub async fn pump_capabilities(&self, id: &str) -> Result<PumpCapabilities> {
        self.read(id, |connection| {
            let (schema, create_table) = principal(connection)?;
            Ok(PumpCapabilities {
                schema,
                create_table,
                directories: directories(connection, None)?,
            })
        })
        .await
    }

    pub async fn preview_pump_export(
        &self,
        id: &str,
        options: PumpExportOptions,
    ) -> Result<PumpPreview> {
        let session = self.session(id)?;
        let (schema, directory) = self
            .read(id, move |connection| {
                export_scope(connection, &options.directory)
            })
            .await?;
        let name = Uuid::new_v4().simple().to_string();
        let preview = PumpPreview {
            token: Uuid::new_v4().to_string(),
            schema,
            directory,
            filename: format!("stackport-{name}.dmp"),
            job: format!("SP_EXP_{}", &name[..22]).to_ascii_uppercase(),
            content: options.content,
            expires_seconds: REVIEW_TIME.as_secs(),
        };
        let mut state = session.data_pump.lock().map_err(|_| STATE)?;
        if session.closed.load(Ordering::Acquire) {
            return Err(CLOSED.into());
        }
        if state.active.is_some() {
            return Err("이 연결에서 Oracle Data Pump 작업을 실행 중입니다.".into());
        }
        state.pending = Some(Plan {
            preview: preview.clone(),
            expires: Instant::now() + REVIEW_TIME,
        });
        Ok(preview)
    }

    pub fn discard_pump_export(&self, id: &str, token: &str) -> Result<()> {
        let session = self.session(id)?;
        let mut state = session.data_pump.lock().map_err(|_| STATE)?;
        if state
            .pending
            .as_ref()
            .is_some_and(|plan| plan.preview.token == token)
        {
            state.pending.take();
        }
        Ok(())
    }

    pub async fn export_pump(
        &self,
        id: &str,
        request: &str,
        token: &str,
        approved: bool,
        confirmation: &str,
    ) -> Result<PumpOutcome> {
        let session = self.session(id)?;
        let job = Job::new(request)?;
        if session.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if !approved {
            return Err("내보낼 스키마와 서버 파일 경로를 확인하세요.".into());
        }
        let config = session.operation_config()?;
        let preview =
            {
                let mut state = session.data_pump.lock().map_err(|_| STATE)?;
                if session.closed.load(Ordering::Acquire) {
                    return Err(CLOSED.into());
                }
                if state.active.is_some() {
                    return Err("이 연결에서 Oracle Data Pump 작업을 실행 중입니다.".into());
                }
                if !state.pending.as_ref().is_some_and(|plan| {
                    plan.preview.token == token && plan.expires > Instant::now()
                }) {
                    return Err(REVIEW.into());
                }
                let plan = state.pending.take().ok_or(REVIEW)?;
                state.active = Some(Arc::clone(&job));
                plan.preview
            };
        let registration = WorkRegistration(session);
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let profile = &registration.0.profile;
            store.oracle_profile(&profile.id, profile.revision)?;
            let (connection, _wallet) = connect(&profile.settings, config)?;
            let (schema, directory) = export_scope(&connection, &preview.directory.name)?;
            if schema != preview.schema || directory.path != preview.directory.path {
                return Err(
                    "Oracle 스키마 또는 디렉터리 경로가 변경되었습니다. 다시 검토하세요.".into(),
                );
            }
            let id = job.id.to_string();
            audit(&store, profile, &id, "oracle.pump.export", "started")?;
            let mut outcome = run_export(&connection, preview, &job);
            let (operation, state) = match outcome.status {
                Status::Succeeded => ("oracle.pump.export", "succeeded"),
                Status::Unconfirmed => ("oracle.pump.export.unconfirmed", "failed"),
                _ => ("oracle.pump.export", "failed"),
            };
            outcome.audit_warning = audit(&store, profile, &id, operation, state).is_err();
            Ok(outcome)
        })
        .await
        .map_err(|_| "Oracle Data Pump 작업을 마치지 못했습니다.")?
    }

    pub fn pump_progress(&self, id: &str, request: &str) -> Result<Option<PumpProgress>> {
        Ok(self.pump_job(id, request)?.map(|job| {
            let value = job.percent.load(Ordering::Acquire);
            PumpProgress {
                started: job.started.load(Ordering::Acquire),
                percent: (0..=100).contains(&value).then_some(value),
            }
        }))
    }

    pub fn cancel_pump(&self, id: &str, request: &str) -> Result<bool> {
        let Some(job) = self.pump_job(id, request)? else {
            return Ok(false);
        };
        job.stop.store(true, Ordering::Release);
        Ok(true)
    }

    fn pump_job(&self, id: &str, request: &str) -> Result<Option<Arc<Job>>> {
        let request = request_id(request)?;
        let session = self.session(id)?;
        let state = session.data_pump.lock().map_err(|_| STATE)?;
        Ok(state
            .active
            .as_ref()
            .filter(|job| job.id == request)
            .cloned())
    }

    pub async fn inspect_pump_dump(
        &self,
        id: &str,
        directory: String,
        filename: String,
        expected_job: Option<String>,
    ) -> Result<DumpHeader> {
        validate_filename(&filename)?;
        self.read(id, move |connection| {
            let directory = readable_directory(connection, &directory)?;
            inspect(connection, directory, filename, expected_job)
        })
        .await
    }
}

fn validate_filename(filename: &str) -> Result<()> {
    if filename.is_empty()
        || filename.len() > 255
        || filename.trim() != filename
        || filename.ends_with('.')
        || filename.contains(['/', '\\', ':'])
        || filename.chars().any(char::is_control)
    {
        return Err("디렉터리 아래의 덤프 파일 이름만 입력하세요.".into());
    }
    Ok(())
}

fn request_id(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| "Oracle Data Pump 작업 ID를 확인하세요.".into())
}

fn principal(connection: &Connection) -> Result<(String, bool)> {
    let row = connection
        .query_row(
            "SELECT SYS_CONTEXT('USERENV','SESSION_USER'),
         (SELECT COUNT(*) FROM session_privs WHERE privilege = 'CREATE TABLE') FROM dual",
            &[],
        )
        .map_err(query_error)?;
    Ok((
        row.get(0).map_err(query_error)?,
        row.get::<i32>(1).map_err(query_error)? != 0,
    ))
}

fn directories(connection: &Connection, name: Option<&str>) -> Result<Vec<Directory>> {
    let rows = connection
        .query_named(DIRECTORIES, &[("directory", &name)])
        .map_err(query_error)?;
    rows.into_iter()
        .map(|row| {
            let row = row.map_err(query_error)?;
            Ok(Directory {
                name: row.get(0).map_err(query_error)?,
                path: row.get(1).map_err(query_error)?,
                readable: row.get::<i32>(2).map_err(query_error)? != 0,
                writable: row.get::<i32>(3).map_err(query_error)? != 0,
            })
        })
        .collect()
}

fn visible_directory(connection: &Connection, name: &str) -> Result<Directory> {
    directories(connection, Some(name))?
        .into_iter()
        .next()
        .ok_or_else(|| "현재 계정에 공개된 Oracle 디렉터리를 선택하세요.".into())
}

fn readable_directory(connection: &Connection, name: &str) -> Result<Directory> {
    let directory = visible_directory(connection, name)?;
    if !directory.readable {
        return Err("선택한 Oracle 디렉터리에 READ 권한이 필요합니다.".into());
    }
    Ok(directory)
}

fn export_scope(connection: &Connection, name: &str) -> Result<(String, Directory)> {
    let (schema, create_table) = principal(connection)?;
    if !create_table {
        return Err(CREATE_TABLE.into());
    }
    let directory = visible_directory(connection, name)?;
    if !directory.writable {
        return Err("선택한 Oracle 디렉터리에 WRITE 권한이 필요합니다.".into());
    }
    Ok((schema, directory))
}

fn run_export(connection: &Connection, preview: PumpPreview, job: &Job) -> PumpOutcome {
    let outcome = PumpOutcome::new(preview.directory, preview.filename, preview.job);
    let schema_filter = schema_filter(&preview.schema);
    let metadata = i32::from(preview.content != PumpContent::Data);
    let rows = i32::from(preview.content != PumpContent::Metadata);
    run_job(connection, job, outcome, |outcome| {
        let mut result = connection.execute_named(
            START,
            &[
                ("job_name", &outcome.job),
                ("file_name", &outcome.filename),
                ("directory_name", &outcome.directory.name),
                ("schema_filter", &schema_filter),
                ("include_metadata", &metadata),
                ("include_rows", &rows),
                ("job_handle", &DB_TYPE_NUMBER),
            ],
        )?;
        result.out_bind_data().get::<i32>("job_handle")
    })
}

fn schema_filter(schema: &str) -> String {
    format!("IN ('{}')", schema.replace('\'', "''"))
}

fn run_job(
    connection: &Connection,
    job: &Job,
    mut outcome: PumpOutcome,
    start: impl FnOnce(&PumpOutcome) -> std::result::Result<i32, Error>,
) -> PumpOutcome {
    if job.stop.load(Ordering::Acquire) {
        outcome.status = Status::Cancelled;
        return outcome;
    }
    let started = connection
        .set_call_timeout(Some(Duration::from_secs(25)))
        .and_then(|_| start(&outcome));
    let handle = match started {
        Ok(handle) => handle,
        Err(error) => {
            outcome.error_code = error.db_error_code();
            outcome.status = if outcome.error_code.is_none() {
                Status::Unconfirmed
            } else {
                Status::Failed
            };
            outcome.message = Some(pump_error(&error));
            return outcome;
        }
    };
    job.started.store(true, Ordering::Release);
    let deadline = Instant::now() + JOB_TIME;
    loop {
        let cancelled = job.stop.load(Ordering::Acquire);
        if cancelled || Instant::now() >= deadline {
            match connection.execute(
                "BEGIN SYS.DBMS_DATAPUMP.STOP_JOB(:1,1,0,0); END;",
                &[&handle],
            ) {
                Ok(_) => {
                    outcome.status = if cancelled {
                        Status::Cancelled
                    } else {
                        Status::TimedOut
                    }
                }
                Err(error) => {
                    outcome.status = Status::Unconfirmed;
                    outcome.error_code = error.db_error_code();
                    outcome.message = Some(pump_error(&error));
                }
            }
            break;
        }
        match job_status(connection, handle) {
            Ok((state, percent, errors, code)) => {
                job.percent.store(percent.unwrap_or(-1), Ordering::Release);
                outcome.error_count = outcome.error_count.max(errors.unwrap_or(0));
                if let Some(code) = code.and_then(|value| usize::try_from(value).ok()) {
                    outcome.error_code = Some(code);
                }
                if state == "COMPLETED" {
                    outcome.status = if outcome.error_count > 0 || outcome.error_code.is_some() {
                        Status::CompletedWithErrors
                    } else {
                        Status::Succeeded
                    };
                    break;
                }
                if matches!(state.as_str(), "STOPPED" | "NOT RUNNING") {
                    outcome.message = Some("Oracle 서버가 Data Pump 작업을 중단했습니다.");
                    break;
                }
            }
            Err(error) => {
                outcome.status = Status::Unconfirmed;
                outcome.error_code = error.db_error_code();
                outcome.message = Some(pump_error(&error));
                break;
            }
        }
        thread::sleep(Duration::from_millis(650));
    }
    outcome
}

fn job_status(
    connection: &Connection,
    handle: i32,
) -> std::result::Result<(String, Option<i32>, Option<i32>, Option<i32>), Error> {
    let mut result = connection.execute_named(
        STATUS,
        &[
            ("job_handle", &handle),
            ("job_state", &DB_TYPE_VARCHAR),
            ("percent_done", &DB_TYPE_NUMBER),
            ("error_count", &DB_TYPE_NUMBER),
            ("error_code", &DB_TYPE_NUMBER),
        ],
    )?;
    let out = result.out_bind_data();
    Ok((
        out.get("job_state")?,
        out.get("percent_done")?,
        out.get("error_count")?,
        out.get("error_code")?,
    ))
}

fn inspect(
    connection: &Connection,
    directory: Directory,
    filename: String,
    expected: Option<String>,
) -> Result<DumpHeader> {
    let mut result = connection
        .execute_named(
            INSPECT,
            &[
                ("directory_name", &directory.name),
                ("file_name", &filename),
                ("file_type", &DB_TYPE_NUMBER),
                ("size_bytes", &DB_TYPE_VARCHAR),
                ("dump_guid", &DB_TYPE_VARCHAR),
                ("dump_version", &DB_TYPE_VARCHAR),
                ("source_version", &DB_TYPE_VARCHAR),
                ("job_name", &DB_TYPE_VARCHAR),
                ("created", &DB_TYPE_VARCHAR),
                ("master_pieces", &DB_TYPE_VARCHAR),
                ("file_number", &DB_TYPE_VARCHAR),
                ("master_present", &DB_TYPE_VARCHAR),
            ],
        )
        .map_err(|error| pump_error(&error))?;
    let out = result.out_bind_data();
    if out.get::<i32>("file_type").map_err(query_error)? != 1 {
        return Err("Oracle Data Pump 덤프 파일을 선택하세요.".into());
    }
    let guid = out
        .get::<Option<String>>("dump_guid")
        .map_err(query_error)?
        .filter(|guid| !guid.is_empty())
        .ok_or("Oracle 덤프 헤더에서 덤프 세트 ID를 읽을 수 없습니다.")?;
    let job: Option<String> = out.get("job_name").map_err(query_error)?;
    if let Some(expected) = expected {
        let (schema, _) = principal(connection)?;
        let qualified = format!("{}.{}", ident(&schema), ident(&expected));
        if !job
            .as_deref()
            .is_some_and(|reported| reported == qualified || reported == expected)
        {
            return Err("이 파일의 헤더가 선택한 Oracle 내보내기 작업과 일치하지 않습니다.".into());
        }
    }
    Ok(DumpHeader {
        directory,
        filename,
        guid,
        job,
        size_bytes: out.get("size_bytes").map_err(query_error)?,
        dump_version: out.get("dump_version").map_err(query_error)?,
        source_version: out.get("source_version").map_err(query_error)?,
        created: out.get("created").map_err(query_error)?,
        master_pieces: out.get("master_pieces").map_err(query_error)?,
        file_number: out.get("file_number").map_err(query_error)?,
        master_present: out.get("master_present").map_err(query_error)?,
    })
}

fn pump_error(error: &Error) -> &'static str {
    match error.db_error_code() {
        Some(1031 | 31631 | 39109) => "Oracle 계정의 Data Pump 권한을 확인하세요.",
        Some(1950 | 1536) => CREATE_TABLE,
        Some(31623 | 31626) => "Oracle 서버에서 Data Pump 작업 상태를 확인하세요.",
        Some(27038 | 31641 | 39070) => {
            "Oracle 서버의 파일 경로와 서비스 계정의 접근 권한을 확인하세요."
        }
        Some(20001 | 29283 | 39000 | 39001 | 39143 | 39209) => {
            "Oracle 디렉터리와 Data Pump 파일 상태를 확인하세요."
        }
        _ => "Oracle Data Pump 작업을 확인할 수 없습니다. 서버의 작업 상태를 확인하세요.",
    }
}

fn audit(
    store: &Store,
    profile: &super::Profile,
    id: &str,
    operation: &'static str,
    outcome: &'static str,
) -> Result<()> {
    insert_audit(
        &store.connect()?,
        AuditRecord {
            correlation_id: id,
            operation,
            outcome,
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(&profile.settings.environment),
            object_name: None,
            affected_count: None,
        },
    )
}
