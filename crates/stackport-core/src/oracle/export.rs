use super::{
    catalog::{data_suffix, find_object, ident, read_columns},
    connect, query_error, Column, ExportOptions, ExportOutcome, Manager, Session,
};
use crate::{
    insert_audit,
    result_export::{ExportFile, ReadyExport, TypedExportColumn, TypedExportValue},
    AuditRecord, Result, TableQueryClauses,
};
use oracledb::{
    Connection, FromDbValue, Lob, OracleIntervalDS, OracleIntervalYM, OracleTimestamp, Row,
};
use std::{
    fmt::Display,
    io::{self, Read},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const EXPORT_TIME: Duration = Duration::from_secs(300);
const MAX_COLUMNS: i64 = 4096;
const MAX_ROW_BYTES: usize = 32 * 1024 * 1024;
const ROW_TOO_LARGE: &str = "Oracle 내보내기에서 한 행의 값이 32 MiB를 초과합니다.";
const STATE_ERROR: &str = "Oracle 내보내기 상태를 읽을 수 없습니다.";

#[derive(Default)]
pub(super) struct State {
    active: Option<ActiveExport>,
}

struct ActiveExport {
    id: Uuid,
    job: Arc<Job>,
    publishing: bool,
}

struct Job {
    stop: AtomicBool,
    rows: AtomicU64,
    deadline: Instant,
}

impl Job {
    fn outcome(&self) -> Option<ExportOutcome> {
        if self.stop.load(Ordering::Acquire) {
            Some(ExportOutcome::Cancelled)
        } else if Instant::now() >= self.deadline {
            Some(ExportOutcome::TimedOut)
        } else {
            None
        }
    }

    fn check(&self) -> Result<()> {
        match self.outcome() {
            Some(_) => Err("Oracle 내보내기가 종료되었습니다.".into()),
            None => Ok(()),
        }
    }
}

struct Registration(Arc<Session>);

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.export.lock() {
            state.active = None;
        }
    }
}

impl Session {
    pub(super) fn stop_export(&self) -> Result<()> {
        let state = self.export.lock().map_err(|_| STATE_ERROR)?;
        if let Some(active) = state.active.as_ref().filter(|active| !active.publishing) {
            active.job.stop.store(true, Ordering::Release);
        }
        Ok(())
    }
}

impl Manager {
    pub fn export_progress(&self, id: &str, request_id: &str) -> Result<Option<u64>> {
        let request_id = export_id(request_id)?;
        let session = self.session(id)?;
        let state = session.export.lock().map_err(|_| STATE_ERROR)?;
        Ok(state
            .active
            .as_ref()
            .filter(|active| active.id == request_id)
            .map(|active| active.job.rows.load(Ordering::Relaxed)))
    }

    pub fn cancel_export(&self, id: &str, request_id: &str) -> Result<bool> {
        let request_id = export_id(request_id)?;
        let session = self.session(id)?;
        let state = session.export.lock().map_err(|_| STATE_ERROR)?;
        let Some(active) = state
            .active
            .as_ref()
            .filter(|active| active.id == request_id && !active.publishing)
        else {
            return Ok(false);
        };
        active.job.stop.store(true, Ordering::Release);
        Ok(true)
    }

    pub async fn export(
        &self,
        id: &str,
        request_id: String,
        object: i64,
        clauses: TableQueryClauses,
        options: ExportOptions,
    ) -> Result<ExportOutcome> {
        let request = export_id(&request_id)?;
        let session = self.session(id)?;
        let job = Arc::new(Job {
            rows: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            deadline: Instant::now() + EXPORT_TIME,
        });
        {
            let mut state = session.export.lock().map_err(|_| STATE_ERROR)?;
            if session.closed.load(Ordering::Acquire) {
                return Ok(ExportOutcome::Cancelled);
            }
            if state.active.is_some() {
                return Err("이 연결의 내보내기가 이미 실행 중입니다.".into());
            }
            state.active = Some(ActiveExport {
                id: request,
                job: Arc::clone(&job),
                publishing: false,
            });
        }
        let registration = Registration(session);
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let registration = registration;
            let session = &registration.0;
            let result = collect(session, object, &clauses, options, &job);
            let (file, target, rows) = {
                let mut state = session.export.lock().map_err(|_| STATE_ERROR)?;
                if session.closed.load(Ordering::Acquire) {
                    return Ok(ExportOutcome::Cancelled);
                }
                if let Some(outcome) = job.outcome() {
                    return Ok(outcome);
                }
                let ready = result?;
                state.active.as_mut().ok_or(STATE_ERROR)?.publishing = true;
                ready
            };
            let mut report = file.publish(rows)?;
            let audit = AuditRecord {
                correlation_id: &request.to_string(),
                operation: if report.format == "CSV" {
                    "oracle.export.csv"
                } else {
                    "oracle.export.json"
                },
                project_id: Some(&session.profile.project_id),
                profile_id: Some(&session.profile.id),
                environment: Some(&session.profile.settings.environment),
                object_name: Some(&target),
                outcome: "succeeded",
                affected_count: i64::try_from(rows).ok(),
            };
            if store
                .connect()
                .and_then(|db| insert_audit(&db, audit))
                .is_err()
            {
                report.audit_warning =
                    Some("파일은 저장됐지만 작업 기록을 저장할 수 없습니다.".into());
            }
            Ok(ExportOutcome::Exported { report })
        })
        .await
        .map_err(|_| "Oracle 내보내기 작업을 마치지 못했습니다.")?
    }
}

fn export_id(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| "Oracle 내보내기 요청 ID가 올바르지 않습니다.".into())
}

fn collect(
    session: &Session,
    object: i64,
    clauses: &TableQueryClauses,
    options: ExportOptions,
    job: &Job,
) -> Result<(ReadyExport, String, u64)> {
    job.check()?;
    let file = ExportFile::open(&options.destination, options.format())?;
    let settings = &session.profile.settings;
    let config = session.operation_config()?;
    job.check()?;
    let (connection, wallet) = connect(settings, config)?;
    let result = write_rows(&connection, object, clauses, file, job);
    drop(connection);
    drop(wallet);
    result
}

fn write_rows(
    connection: &Connection,
    object: i64,
    clauses: &TableQueryClauses,
    mut file: ExportFile,
    job: &Job,
) -> Result<(ReadyExport, String, u64)> {
    job.check()?;
    let target = find_object(connection, object)?;
    job.check()?;
    let columns = read_columns(connection, &target, MAX_COLUMNS + 1)?;
    if columns.is_empty() || columns.len() > MAX_COLUMNS as usize {
        return Err("내보내려면 읽을 수 있는 Oracle 열이 1개 이상 4,096개 이하여야 합니다.".into());
    }
    job.check()?;
    let (suffix, parameters, _) = data_suffix(connection, &target, &columns, clauses)?;
    let table = format!("{}.{}", ident(&target.schema), ident(&target.name));
    let (mut expressions, mut types, mut typed) = (Vec::new(), Vec::new(), Vec::new());
    let mut batch_width = 0;
    for (index, column) in columns.iter().enumerate() {
        let (expression, kind) = projection(column)?;
        expressions.push(format!("{expression} AS sp_value_{index}"));
        types.push(kind);
        typed.push(TypedExportColumn {
            name: column.name.clone(),
            data_type: column.data_type.clone(),
            encoding: matches!(kind, Kind::Raw | Kind::Blob).then_some("hex"),
            numeric: matches!(
                column.native_type.as_str(),
                "NUMBER" | "FLOAT" | "BINARY_FLOAT" | "BINARY_DOUBLE"
            ),
        });
        batch_width += column.byte_length.clamp(128, 32767) as u32 * 4;
    }
    file.typed_header("stackport.oracle-results", &typed)?;
    let sql = format!(
        "SELECT {} FROM {table} sp_source{suffix}",
        expressions.join(", ")
    );
    let bindings: Vec<_> = parameters.iter().map(|value| value.bound()).collect();
    let batch_rows = (1024 * 1024 / batch_width).clamp(1, 16);
    job.check()?;
    let mut cursor = connection
        .statement(&sql)
        .map_err(query_error)?
        .fetch_lobs()
        .prefetch_rows(batch_rows)
        .fetch_array_size(batch_rows)
        .build()
        .map_err(query_error)?
        .query(&bindings)
        .map_err(query_error)?;
    let mut count = 0;
    loop {
        job.check()?;
        let Some(row) = cursor.next() else { break };
        let mut row = row.map_err(query_error)?;
        let mut remaining = MAX_ROW_BYTES;
        let values = types
            .iter()
            .enumerate()
            .map(|(index, kind)| cell(&mut row, index, *kind, &mut remaining, job))
            .collect::<Result<Vec<_>>>()?;
        job.check()?;
        file.write_typed_row(
            values.iter().map(|value| {
                value
                    .as_ref()
                    .map_or(TypedExportValue::Null, Cell::borrowed)
            }),
            &typed,
            count,
        )?;
        count += 1;
        job.rows.store(count, Ordering::Relaxed);
    }
    job.check()?;
    Ok((file.finish()?, table, count))
}

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Float,
    Double,
    Timestamp,
    IntervalDS,
    IntervalYM,
    Bool,
    Raw,
    TextLob,
    Blob,
}

fn projection(column: &Column) -> Result<(String, Kind)> {
    let name = format!("sp_source.{}", ident(&column.name));
    let result = match column.native_type.as_str() {
        "CHAR" | "VARCHAR2" | "NCHAR" | "NVARCHAR2" | "NUMBER" | "FLOAT" => (name, Kind::Text),
        "BINARY_FLOAT" => (name, Kind::Float),
        "BINARY_DOUBLE" => (name, Kind::Double),
        "BOOLEAN" => (name, Kind::Bool),
        "RAW" => (name, Kind::Raw),
        "BLOB" => (name, Kind::Blob),
        "CLOB" | "NCLOB" => (name, Kind::TextLob),
        "JSON" => (format!("JSON_SERIALIZE({name} RETURNING BLOB)"), Kind::TextLob),
        "XMLTYPE" => (format!("XMLSERIALIZE(CONTENT {name} AS CLOB)"), Kind::TextLob),
        "ROWID" => (format!("ROWIDTOCHAR({name})"), Kind::Text),
        "DATE" => (name, Kind::Timestamp),
        native if native.starts_with("TIMESTAMP") && native.ends_with("WITH LOCAL TIME ZONE") => (
            format!("TRIM(TO_CHAR(SYS_EXTRACT_UTC(CAST({name} AS TIMESTAMP(9) WITH TIME ZONE)), 'SYYYY-MM-DD\"T\"HH24:MI:SS.FF9\"Z\"'))"),
            Kind::Text,
        ),
        native if native.starts_with("TIMESTAMP") && native.ends_with("WITH TIME ZONE") => {
            let region = format!("TRIM(TO_CHAR({name}, 'TZR'))");
            let offset = format!("TO_CHAR({name}, 'TZH:TZM')");
            (format!("TRIM(TO_CHAR({name}, 'SYYYY-MM-DD\"T\"HH24:MI:SS.FF9TZH:TZM')) || CASE WHEN {region} <> {offset} THEN '[' || {region} || ']' END"), Kind::Text)
        }
        native if native.starts_with("TIMESTAMP") => (name, Kind::Timestamp),
        native if native.starts_with("INTERVAL DAY") => (name, Kind::IntervalDS),
        native if native.starts_with("INTERVAL YEAR") => (name, Kind::IntervalYM),
        _ => return Err(format!("Oracle의 ‘{}’ 열({})은 내보내기에서 지원하지 않습니다.", column.name, column.data_type)),
    };
    Ok(result)
}

enum Cell {
    Text(String),
    Binary(Vec<u8>),
}

impl Cell {
    fn borrowed(&self) -> TypedExportValue<'_> {
        match self {
            Self::Text(value) => TypedExportValue::Text(value),
            Self::Binary(value) => TypedExportValue::Binary(value),
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::Text(value) => value.len(),
            Self::Binary(value) => value.len(),
        }
    }
}

fn formatted<T: for<'a> FromDbValue<'a> + Display>(
    row: &Row,
    index: usize,
) -> Result<Option<Cell>> {
    Ok(row
        .get::<Option<T>>(index)
        .map_err(query_error)?
        .map(|value| Cell::Text(value.to_string())))
}

fn cell(
    row: &mut Row,
    index: usize,
    kind: Kind,
    remaining: &mut usize,
    job: &Job,
) -> Result<Option<Cell>> {
    let value = match kind {
        Kind::Text => row
            .take::<Option<String>>(index)
            .map_err(query_error)?
            .map(Cell::Text),
        Kind::Raw => row
            .take::<Option<Vec<u8>>>(index)
            .map_err(query_error)?
            .map(Cell::Binary),
        Kind::Float => formatted::<f32>(row, index)?,
        Kind::Double => formatted::<f64>(row, index)?,
        Kind::Bool => formatted::<bool>(row, index)?,
        Kind::Timestamp => formatted::<OracleTimestamp>(row, index)?,
        Kind::IntervalDS => formatted::<OracleIntervalDS>(row, index)?,
        Kind::IntervalYM => formatted::<OracleIntervalYM>(row, index)?,
        Kind::TextLob | Kind::Blob => {
            let Some(lob) = row.take::<Option<Lob>>(index).map_err(query_error)? else {
                return Ok(None);
            };
            let bytes = read_lob(lob, *remaining, job)?;
            if matches!(kind, Kind::TextLob) {
                Some(Cell::Text(String::from_utf8(bytes).map_err(|_| {
                    "Oracle 텍스트의 UTF-8 인코딩을 읽을 수 없습니다."
                })?))
            } else {
                Some(Cell::Binary(bytes))
            }
        }
    };
    if let Some(value) = &value {
        *remaining = remaining.checked_sub(value.len()).ok_or(ROW_TOO_LARGE)?;
    }
    Ok(value)
}

fn read_lob(mut lob: Lob, limit: usize, job: &Job) -> Result<Vec<u8>> {
    let size = lob.get_size().map_err(query_error)?;
    if size > limit {
        return Err(ROW_TOO_LARGE.into());
    }
    let mut output = Vec::with_capacity(size.min(64 * 1024));
    let mut buffer = [0; 64 * 1024];
    loop {
        job.check()?;
        let read = read_lob_chunk(&mut lob, &mut buffer)
            .map_err(|_| "Oracle의 큰 텍스트 또는 바이너리 값을 읽을 수 없습니다.")?;
        if read == 0 {
            return Ok(output);
        }
        if output.len() + read > limit {
            return Err(ROW_TOO_LARGE.into());
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

pub(super) fn read_lob_chunk(lob: &mut Lob, buffer: &mut [u8]) -> io::Result<usize> {
    match lob.read(buffer) {
        Err(error)
            if error.kind() == io::ErrorKind::InvalidData
                || error
                    .get_ref()
                    .and_then(|source| source.downcast_ref::<oracledb::Error>())
                    .and_then(oracledb::Error::db_error_code)
                    == Some(22831) =>
        {
            // A CLOB read can stop between the UTF-16 halves of a character.
            // The driver has kept its offset. Reduce the request by one UTF-16 unit.
            let shorter = buffer.len() - 3;
            lob.read(&mut buffer[..shorter])
        }
        result => result,
    }
}
