use super::{
    audit, connect, inspect, principal, query_error, readable_directory, run_job, schema_filter,
    validate_filename, DumpHeader, Job, Manager, PumpContent, PumpOutcome, Status,
    WorkRegistration, CLOSED, CREATE_TABLE, REVIEW_TIME, STATE,
};
use crate::Result;
use oracledb::{Connection, DB_TYPE_NUMBER};
use serde::{Deserialize, Serialize};
use std::{sync::atomic::Ordering, time::Instant};
use uuid::Uuid;

const JOB_NAME: &str = "SP_STACKPORT_IMPORT";
const REVIEW: &str = "Oracle 가져오기 미리보기를 다시 확인하세요.";
const EMPTY: &str = "구조를 가져오려면 로그인한 대상 스키마에 기존 객체가 없어야 합니다.";
const CHANGED: &str = "검토한 덤프 또는 대상 스키마가 변경되었습니다. 다시 검토하세요.";

const START: &str = r"
DECLARE
    h NUMBER;
    existing NUMBER;
BEGIN
    IF SYS_CONTEXT('USERENV','SESSION_USER') != :target_schema THEN
        RAISE_APPLICATION_ERROR(-20003,'Target schema changed');
    END IF;
    h := SYS.DBMS_DATAPUMP.OPEN('IMPORT','SCHEMA',NULL,:job_name,'COMPATIBLE');
    SYS.DBMS_DATAPUMP.ADD_FILE(h,:file_name,:directory_name,
        filetype=>SYS.DBMS_DATAPUMP.KU$_FILE_TYPE_DUMP_FILE);
    SYS.DBMS_DATAPUMP.METADATA_FILTER(h,'SCHEMA_EXPR',:schema_filter);
    IF :source_schema != :target_schema THEN
        SYS.DBMS_DATAPUMP.METADATA_REMAP(h,'REMAP_SCHEMA',:source_schema,:target_schema);
    END IF;
    IF :data_only = 1 THEN
        SYS.DBMS_DATAPUMP.METADATA_FILTER(h,'NAME_EXPR',:table_filter,'TABLE');
        SYS.DBMS_DATAPUMP.SET_PARAMETER(h,'INCLUDE_METADATA',0);
        SYS.DBMS_DATAPUMP.SET_PARAMETER(h,'TABLE_EXISTS_ACTION','APPEND');
    ELSE
        SYS.DBMS_DATAPUMP.METADATA_FILTER(h,'EXCLUDE_PATH_EXPR',
            q'[IN ('USER','SYSTEM_GRANT','ROLE_GRANT','DEFAULT_ROLE','TABLESPACE_QUOTA','ON_USER_GRANT')]');
        SYS.DBMS_DATAPUMP.METADATA_TRANSFORM(h,'SEGMENT_ATTRIBUTES',0);
        SYS.DBMS_DATAPUMP.SET_PARAMETER(h,'TABLE_EXISTS_ACTION','SKIP');
        IF :include_rows = 0 THEN
            SYS.DBMS_DATAPUMP.DATA_FILTER(h,'INCLUDE_ROWS',0);
        END IF;
        SELECT COUNT(*) INTO existing FROM user_objects
        WHERE generated = 'N' AND NOT (object_type = 'TABLE' AND object_name = :job_name);
        IF existing != 0 THEN
            RAISE_APPLICATION_ERROR(-20003,'Objects appeared before import');
        END IF;
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PumpImportOptions {
    directory: String,
    filename: String,
    source: String,
    content: PumpContent,
}

#[derive(Clone, Serialize)]
pub struct PumpImportPreview {
    token: String,
    dump: DumpHeader,
    source: String,
    target: String,
    target_version: String,
    tablespace: String,
    content: PumpContent,
    tables: Vec<String>,
    expires_seconds: u64,
}

#[derive(Serialize)]
pub struct PumpImportOutcome {
    #[serde(flatten)]
    outcome: PumpOutcome,
    target: String,
    changes_possible: bool,
    verification: Option<Verification>,
}

#[derive(Serialize)]
struct Verification {
    objects: u32,
    tables: u32,
    invalid: u32,
}

#[derive(PartialEq)]
struct Table {
    name: String,
    object_id: i64,
    data_object_id: i64,
    ddl_time: String,
}

struct Target {
    schema: String,
    version: String,
    tablespace: String,
}

pub(super) struct Plan {
    preview: PumpImportPreview,
    tables: Vec<Table>,
    expires: Instant,
}

impl Manager {
    pub async fn preview_pump_import(
        &self,
        id: &str,
        options: PumpImportOptions,
    ) -> Result<PumpImportPreview> {
        validate_filename(&options.filename)?;
        if options.source.is_empty()
            || options.source.len() > 128
            || options.source.chars().any(char::is_control)
        {
            return Err("덤프에 저장된 원본 Oracle 스키마 이름을 입력하세요.".into());
        }
        let session = self.session(id)?;
        let (preview, tables) = self
            .read(id, move |connection| {
                let (target, tables) = scope(connection, options.content)?;
                let directory = readable_directory(connection, &options.directory)?;
                let dump = inspect(connection, directory, options.filename, None)?;
                if dump.file_number.as_deref() != Some("1")
                    || dump.master_present.as_deref() != Some("1")
                    || dump
                        .master_pieces
                        .as_deref()
                        .is_some_and(|count| count != "1")
                {
                    return Err(
                        "마스터 정보가 포함된 단일 Data Pump 덤프 파일을 선택하세요.".into(),
                    );
                }
                if let (Some(source_major), Some(target_major)) = (
                    dump.source_version.as_deref().and_then(major_version),
                    major_version(&target.version),
                ) {
                    if source_major > target_major {
                        return Err("덤프 작업 버전이 대상 Oracle 서버보다 새 버전입니다.".into());
                    }
                }
                table_filter(&tables)?;
                Ok((
                    PumpImportPreview {
                        token: Uuid::new_v4().to_string(),
                        dump,
                        source: options.source,
                        target: target.schema,
                        target_version: target.version,
                        tablespace: target.tablespace,
                        content: options.content,
                        tables: tables.iter().map(|table| table.name.clone()).collect(),
                        expires_seconds: REVIEW_TIME.as_secs(),
                    },
                    tables,
                ))
            })
            .await?;
        let mut state = session.data_pump.lock().map_err(|_| STATE)?;
        if session.closed.load(Ordering::Acquire) {
            return Err(CLOSED.into());
        }
        if state.active.is_some() {
            return Err("이 연결에서 Oracle Data Pump 작업을 실행 중입니다.".into());
        }
        state.import = Some(Plan {
            preview: preview.clone(),
            tables,
            expires: Instant::now() + REVIEW_TIME,
        });
        Ok(preview)
    }

    pub fn discard_pump_import(&self, id: &str, token: &str) -> Result<()> {
        let session = self.session(id)?;
        let mut state = session.data_pump.lock().map_err(|_| STATE)?;
        if state
            .import
            .as_ref()
            .is_some_and(|plan| plan.preview.token == token)
        {
            state.import.take();
        }
        Ok(())
    }

    pub async fn import_pump(
        &self,
        id: &str,
        request: &str,
        token: &str,
        target: &str,
        approved: bool,
        confirmation: &str,
    ) -> Result<PumpImportOutcome> {
        let session = self.session(id)?;
        let job = Job::new(request)?;
        if session.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if !approved {
            return Err("원본 덤프와 대상 스키마, 적용 방식을 확인하세요.".into());
        }
        let config = session.operation_config()?;
        let plan = {
            let mut state = session.data_pump.lock().map_err(|_| STATE)?;
            if session.closed.load(Ordering::Acquire) {
                return Err(CLOSED.into());
            }
            if state.active.is_some() {
                return Err("이 연결에서 Oracle Data Pump 작업을 실행 중입니다.".into());
            }
            let plan = state
                .import
                .as_ref()
                .filter(|plan| plan.preview.token == token && plan.expires > Instant::now())
                .ok_or(REVIEW)?;
            if plan.preview.target != target {
                return Err("미리보기에 표시된 대상 스키마 이름을 입력하세요.".into());
            }
            let plan = state.import.take().ok_or(REVIEW)?;
            state.active = Some(job.clone());
            plan
        };
        let registration = WorkRegistration(session);
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let profile = &registration.0.profile;
            store.oracle_profile(&profile.id, profile.revision)?;
            let (connection, _wallet) = connect(&profile.settings, config)?;
            let preview = plan.preview;
            let (target, tables) = scope(&connection, preview.content)?;
            let dir = readable_directory(&connection, &preview.dump.directory.name)?;
            let header = inspect(&connection, dir, preview.dump.filename.clone(), None)?;
            if header != preview.dump
                || target.schema != preview.target
                || target.version != preview.target_version
                || target.tablespace != preview.tablespace
                || tables != plan.tables
            {
                return Err(CHANGED.into());
            }
            let tables = table_filter(&tables)?;
            let id = job.id.to_string();
            audit(&store, profile, &id, "oracle.pump.import", "started")?;
            let mut outcome = run_import(&connection, preview, &tables, &job);
            let (operation, state) = match outcome.outcome.status {
                Status::Succeeded => ("oracle.pump.import", "succeeded"),
                Status::Unconfirmed => ("oracle.pump.import.unconfirmed", "failed"),
                _ => ("oracle.pump.import", "failed"),
            };
            outcome.outcome.audit_warning = audit(&store, profile, &id, operation, state).is_err();
            Ok(outcome)
        })
        .await
        .map_err(|_| "Oracle Data Pump 가져오기를 마치지 못했습니다.")?
    }
}

fn major_version(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

fn scope(connection: &Connection, content: PumpContent) -> Result<(Target, Vec<Table>)> {
    let (schema, create_table) = principal(connection)?;
    if !create_table {
        return Err(CREATE_TABLE.into());
    }
    let user = connection
        .query_row(
            "SELECT oracle_maintained, default_tablespace FROM user_users",
            &[],
        )
        .map_err(query_error)?;
    if user.get::<&str>(0).map_err(query_error)? != "N" {
        return Err(
            "Oracle 시스템 계정에는 가져올 수 없습니다. 대상 사용자 스키마로 연결하세요.".into(),
        );
    }
    let target = Target {
        schema,
        version: connection.version().map_err(query_error)?.to_string(),
        tablespace: user.get(1).map_err(query_error)?,
    };
    if content != PumpContent::Data {
        let row = connection
            .query_row("SELECT COUNT(*) FROM user_objects", &[])
            .map_err(query_error)?;
        if row.get::<u32>(0).map_err(query_error)? != 0 {
            return Err(EMPTY.into());
        }
        return Ok((target, Vec::new()));
    }
    let rows = connection.query(
        "SELECT o.object_name, o.object_id, NVL(o.data_object_id,0), TO_CHAR(o.last_ddl_time,'YYYYMMDDHH24MISS')
         FROM user_objects o JOIN user_tables t ON t.table_name = o.object_name
         WHERE o.object_type = 'TABLE' AND o.subobject_name IS NULL
           AND t.nested = 'NO' AND t.secondary = 'N' AND t.dropped = 'NO'
           AND o.object_name != :1 ORDER BY o.object_name",
        &[&JOB_NAME],
    ).map_err(query_error)?;
    let tables = rows
        .into_iter()
        .map(|row| {
            let row = row.map_err(query_error)?;
            Ok(Table {
                name: row.get(0).map_err(query_error)?,
                object_id: row.get(1).map_err(query_error)?,
                data_object_id: row.get(2).map_err(query_error)?,
                ddl_time: row.get(3).map_err(query_error)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if tables.is_empty() {
        return Err(
            "데이터만 가져오려면 대상 스키마에 호환되는 테이블 구조가 있어야 합니다.".into(),
        );
    }
    Ok((target, tables))
}

fn table_filter(tables: &[Table]) -> Result<String> {
    if tables.is_empty() {
        return Ok(String::new());
    }
    let quoted = tables
        .iter()
        .map(|table| format!("'{}'", table.name.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    if quoted.len() > 32_760 || tables.len() > 1_000 {
        return Err(
            "대상 테이블 목록이 한 번에 적용할 수 있는 Oracle 필터 한도를 초과했습니다.".into(),
        );
    }
    Ok(format!("IN ({quoted})"))
}

fn run_import(
    connection: &Connection,
    preview: PumpImportPreview,
    tables: &str,
    job: &Job,
) -> PumpImportOutcome {
    let outcome = PumpOutcome::new(
        preview.dump.directory,
        preview.dump.filename,
        JOB_NAME.into(),
    );
    let source_filter = schema_filter(&preview.source);
    let data_only = i32::from(preview.content == PumpContent::Data);
    let include_rows = i32::from(preview.content != PumpContent::Metadata);
    let mut outcome = run_job(connection, job, outcome, |outcome| {
        let mut result = connection.execute_named(
            START,
            &[
                ("job_name", &outcome.job),
                ("file_name", &outcome.filename),
                ("directory_name", &outcome.directory.name),
                ("source_schema", &preview.source),
                ("target_schema", &preview.target),
                ("schema_filter", &source_filter),
                ("data_only", &data_only),
                ("include_rows", &include_rows),
                ("table_filter", &tables),
                ("job_handle", &DB_TYPE_NUMBER),
            ],
        )?;
        result.out_bind_data().get::<i32>("job_handle")
    });
    if outcome.error_code == Some(20_003) {
        outcome.message = Some(CHANGED);
    }
    if outcome.error_code == Some(31_634) {
        outcome.message =
            Some("대상 스키마에서 같은 Oracle 가져오기 작업이 진행 중이거나 서버에 남아 있습니다.");
    }
    let changes_possible =
        job.started.load(Ordering::Acquire) || matches!(outcome.status, Status::Unconfirmed);
    let verification = if matches!(
        outcome.status,
        Status::Succeeded | Status::CompletedWithErrors
    ) {
        match verify_target(connection) {
            Ok(result) => {
                if preview.content != PumpContent::Data
                    && (result.objects == 0 || result.invalid > 0)
                {
                    outcome.status = Status::CompletedWithErrors;
                    outcome.message =
                        Some("가져온 객체가 없거나 Oracle에서 유효하지 않은 객체를 발견했습니다.");
                }
                Some(result)
            }
            Err(_) => {
                outcome.status = Status::Unconfirmed;
                outcome.message =
                    Some("Oracle 가져오기 작업은 끝났지만 대상 객체를 확인할 수 없습니다.");
                None
            }
        }
    } else {
        None
    };
    PumpImportOutcome {
        outcome,
        target: preview.target,
        changes_possible,
        verification,
    }
}

fn verify_target(connection: &Connection) -> Result<Verification> {
    let query = "SELECT COUNT(*), COUNT(CASE WHEN object_type = 'TABLE' THEN 1 END),
         COUNT(CASE WHEN status = 'INVALID' THEN 1 END) FROM user_objects
         WHERE subobject_name IS NULL AND generated = 'N' AND object_name != :1";
    let row = connection
        .query_row(query, &[&JOB_NAME])
        .map_err(query_error)?;
    Ok(Verification {
        objects: row.get(0).map_err(query_error)?,
        tables: row.get(1).map_err(query_error)?,
        invalid: row.get(2).map_err(query_error)?,
    })
}
