//! Cancellable, bounded read-only SQLite queries.

use super::{
    db_error, display_value, insert_audit, open_schema_db, open_user_db,
    result_export::{ExportFile, ExportFormat},
    set_read_authorizer,
    sql_statement::statement_ranges,
    AuditRecord, CsvOptions, ExportQuery, ExportReport, QueryMetrics, QueryPage, Result, Store,
    TableQuery, PAGE_SIZE,
};
use rusqlite::{params_from_iter, types::Value, Connection, InterruptHandle, StatementStatus};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    mem::size_of,
    path::Path,
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
const EXPORT_TIMEOUT: Duration = Duration::from_secs(300);
const PREPARE_LIFETIME: Duration = Duration::from_secs(60);
const MAX_PARAMETERS: usize = 32;
const MAX_PARAMETER_BYTES: usize = 16 * 1024;
const MAX_PLAN_STEPS: usize = 200;
const MAX_BATCH_SQL_BYTES: usize = 256 * 1024;
const MAX_BATCH_STATEMENTS: usize = 16;
const MAX_BATCH_RESULT_BYTES: usize = 8 * 1024 * 1024;
const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const TIMED_OUT: u8 = 2;
const PUBLISHING: u8 = 3;

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum QueryOutcome {
    Completed {
        result: QueryPage,
    },
    Plan {
        plan: QueryPlan,
    },
    Exported {
        report: ExportReport,
    },
    ParametersRequired {
        parameters: Vec<SqlParameter>,
    },
    Batch {
        total: usize,
        items: Vec<BatchResult>,
        stopped: Option<BatchStop>,
    },
    Cancelled,
    TimedOut,
}

#[derive(Debug, Serialize)]
pub struct BatchResult {
    start: usize,
    end: usize,
    elapsed_ms: u64,
    result: QueryPage,
}

#[derive(Debug, Serialize)]
pub struct BatchStop {
    start: usize,
    end: usize,
    status: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct QueryPlan {
    steps: Vec<PlanStep>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct PlanStep {
    id: i64,
    parent: i64,
    detail: String,
    kind: &'static str,
}

enum QueryOutput {
    Rows(QueryPage),
    Plan(QueryPlan),
    Export(ExportReport),
}

#[derive(Debug, Serialize)]
pub struct SqlParameter {
    pub index: usize,
    pub name: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SqlParameterValue {
    Null,
    Text(String),
    Integer(String),
    Real(String),
    Blob(String),
}

impl SqlParameterValue {
    fn sqlite_value(&self) -> Result<Value> {
        match self {
            Self::Null => Ok(Value::Null),
            Self::Text(text) if text.len() <= MAX_PARAMETER_BYTES => Ok(Value::Text(text.clone())),
            Self::Text(_) => Err("텍스트 값은 16 KiB까지 입력할 수 있습니다.".into()),
            Self::Integer(text) => text
                .trim()
                .parse::<i64>()
                .map(Value::Integer)
                .map_err(|_| "64비트 정수를 입력하세요.".into()),
            Self::Real(text) => text
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .map(Value::Real)
                .ok_or_else(|| "유한한 실수를 입력하세요.".into()),
            Self::Blob(text) => {
                let text = text.trim();
                if text.len() > MAX_PARAMETER_BYTES
                    || text.len() % 2 != 0
                    || !text.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err("BLOB은 최대 16 KiB의 짝수 자리 16진수로 입력하세요.".into());
                }
                let mut bytes = Vec::with_capacity(text.len() / 2);
                for index in (0..text.len()).step_by(2) {
                    let value = u8::from_str_radix(&text[index..index + 2], 16)
                        .map_err(|_| "BLOB에 16진수를 입력하세요.")?;
                    bytes.push(value);
                }
                Ok(Value::Blob(bytes))
            }
        }
    }
}

#[derive(Default)]
struct QueryControl {
    reason: AtomicU8,
    interrupt: Mutex<Option<InterruptHandle>>,
    exported_rows: AtomicU64,
}

impl QueryControl {
    fn cancel(&self) -> Result<bool> {
        // The first interruption wins, so a later cancel cannot disguise a timeout.
        if self
            .reason
            .compare_exchange(RUNNING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
            == Err(PUBLISHING)
        {
            return Ok(false);
        }
        if let Some(handle) = self
            .interrupt
            .lock()
            .map_err(|_| "쿼리 중단 상태를 사용할 수 없습니다.".to_string())?
            .as_ref()
        {
            handle.interrupt();
        }
        Ok(true)
    }

    fn attach(&self, db: &Connection) -> std::result::Result<(), QueryFailure> {
        let mut handle = self
            .interrupt
            .lock()
            .map_err(|_| QueryFailure::Error("쿼리 중단 상태를 사용할 수 없습니다.".into()))?;
        self.check()?;
        *handle = Some(db.get_interrupt_handle());
        Ok(())
    }

    fn check(&self) -> std::result::Result<(), QueryFailure> {
        match self.reason.load(Ordering::SeqCst) {
            CANCELLED => Err(QueryFailure::Cancelled),
            TIMED_OUT => Err(QueryFailure::TimedOut),
            _ => Ok(()),
        }
    }

    fn check_deadline(&self, deadline: Instant) -> std::result::Result<(), QueryFailure> {
        if Instant::now() >= deadline {
            let _ = self.reason.compare_exchange(
                RUNNING,
                TIMED_OUT,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
        self.check()
    }

    fn publishing(&self) -> std::result::Result<(), QueryFailure> {
        match self
            .reason
            .compare_exchange(RUNNING, PUBLISHING, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => Ok(()),
            Err(_) => self.check(),
        }
    }

    fn sqlite_error(&self, error: rusqlite::Error) -> QueryFailure {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) {
            if let Err(reason) = self.check() {
                return reason;
            }
        }
        QueryFailure::Error(db_error(error))
    }
}

struct QueryEntry {
    control: Arc<QueryControl>,
    created: Instant,
    started: bool,
}

#[derive(Default)]
pub(crate) struct QueryManager {
    entries: Mutex<HashMap<String, QueryEntry>>,
}

struct QueryGuard {
    manager: Arc<QueryManager>,
    token: String,
    control: Arc<QueryControl>,
}

impl Drop for QueryGuard {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.manager.entries.lock() {
            entries.remove(&self.token);
        }
    }
}

impl QueryManager {
    fn prepare(&self) -> Result<String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "쿼리 상태를 사용할 수 없습니다.")?;
        // A window may close between preparation and execution. These entries
        // contain no SQL or results and are discarded on the next preparation.
        entries.retain(|_, entry| entry.started || entry.created.elapsed() < PREPARE_LIFETIME);
        let token = Uuid::new_v4().to_string();
        entries.insert(
            token.clone(),
            QueryEntry {
                control: Arc::new(QueryControl::default()),
                created: Instant::now(),
                started: false,
            },
        );
        Ok(token)
    }

    fn claim(self: &Arc<Self>, token: &str) -> Result<QueryGuard> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "쿼리 상태를 사용할 수 없습니다.")?;
        let entry = entries
            .get_mut(token)
            .ok_or("쿼리 요청이 없거나 만료되었습니다.")?;
        if entry.started {
            return Err("이미 실행 중인 쿼리 요청입니다.".into());
        }
        if entry.created.elapsed() >= PREPARE_LIFETIME {
            entries.remove(token);
            return Err("쿼리 요청이 만료되었습니다. 다시 실행하세요.".into());
        }
        entry.started = true;
        Ok(QueryGuard {
            manager: Arc::clone(self),
            token: token.to_owned(),
            control: Arc::clone(&entry.control),
        })
    }

    fn cancel(&self, token: &str) -> Result<bool> {
        let control = self
            .entries
            .lock()
            .map_err(|_| "쿼리 상태를 사용할 수 없습니다.")?
            .get(token)
            .map(|entry| Arc::clone(&entry.control));
        if let Some(control) = control {
            control.cancel()
        } else {
            Ok(false)
        }
    }

    fn read_export_progress(&self, token: &str) -> Result<Option<u64>> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| "내보내기 상태를 사용할 수 없습니다.")?;
        Ok(entries
            .get(token)
            .map(|entry| entry.control.exported_rows.load(Ordering::Relaxed)))
    }
}

enum QueryFailure {
    Cancelled,
    TimedOut,
    ParametersRequired(Vec<SqlParameter>),
    Error(String),
}

enum QuerySource<'a> {
    Sql {
        sql: &'a str,
        parameters: Option<&'a [SqlParameterValue]>,
        explain: bool,
    },
    Object(&'a TableQuery),
}

enum QueryDelivery<'a> {
    Page(u32),
    BatchPage(&'a mut usize),
    Export {
        destination: &'a str,
        format: ExportFormat,
    },
}

fn query_outcome(result: std::result::Result<QueryOutput, QueryFailure>) -> Result<QueryOutcome> {
    match result {
        Ok(QueryOutput::Rows(result)) => Ok(QueryOutcome::Completed { result }),
        Ok(QueryOutput::Plan(plan)) => Ok(QueryOutcome::Plan { plan }),
        Ok(QueryOutput::Export(report)) => Ok(QueryOutcome::Exported { report }),
        Err(QueryFailure::Cancelled) => Ok(QueryOutcome::Cancelled),
        Err(QueryFailure::TimedOut) => Ok(QueryOutcome::TimedOut),
        Err(QueryFailure::ParametersRequired(parameters)) => {
            Ok(QueryOutcome::ParametersRequired { parameters })
        }
        Err(QueryFailure::Error(error)) => Err(error),
    }
}

impl Store {
    /// Prepare a one-use request before execution so cancellation cannot race
    /// ahead of registration. No SQL or database data is held by the manager.
    pub fn prepare_query(&self) -> Result<String> {
        self.queries.prepare()
    }

    /// Request cancellation; the eventual query outcome confirms whether the
    /// read was stopped or had already completed.
    pub fn cancel_query(&self, token: &str) -> Result<bool> {
        self.queries.cancel(token)
    }

    pub fn csv_export_progress(&self, token: &str) -> Result<Option<u64>> {
        self.result_export_progress(token)
    }

    pub fn result_export_progress(&self, token: &str) -> Result<Option<u64>> {
        self.queries.read_export_progress(token)
    }

    pub fn export_csv_prepared(
        &self,
        token: &str,
        profile_id: &str,
        query: &ExportQuery,
        options: &CsvOptions,
    ) -> Result<QueryOutcome> {
        self.export_prepared(
            token,
            profile_id,
            query,
            &options.destination,
            ExportFormat::Csv {
                include_header: options.include_header,
                spreadsheet_safe: options.spreadsheet_safe,
            },
        )
    }

    pub fn export_json_prepared(
        &self,
        token: &str,
        profile_id: &str,
        query: &ExportQuery,
        destination: &str,
    ) -> Result<QueryOutcome> {
        self.export_prepared(token, profile_id, query, destination, ExportFormat::Json)
    }

    fn export_prepared(
        &self,
        token: &str,
        profile_id: &str,
        query: &ExportQuery,
        destination: &str,
        format: ExportFormat,
    ) -> Result<QueryOutcome> {
        let guard = self.queries.claim(token)?;
        if let Err(reason) = guard.control.check() {
            return query_outcome(Err(reason));
        }
        let profile = self.profile(profile_id)?;
        let correlation_id = Uuid::new_v4().to_string();
        let audit = |outcome, affected_count| AuditRecord {
            correlation_id: &correlation_id,
            operation: format.audit_operation(),
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(&profile.environment),
            object_name: None,
            outcome,
            affected_count,
        };
        insert_audit(&self.connect()?, audit("started", None))?;
        let source = match query {
            ExportQuery::Sql { sql, parameters } => QuerySource::Sql {
                sql,
                parameters: parameters.as_deref(),
                explain: false,
            },
            ExportQuery::Table { request } => QuerySource::Object(request),
        };
        let mut result = self.query_inner(
            profile_id,
            source,
            QueryDelivery::Export {
                destination,
                format,
            },
            &guard.control,
            EXPORT_TIMEOUT,
        );
        if matches!(result, Err(QueryFailure::ParametersRequired(_))) {
            result = Err(QueryFailure::Error(
                "먼저 매개변수 값을 입력하고 쿼리를 실행하세요.".into(),
            ));
        }
        let (outcome, count) = match &result {
            Ok(QueryOutput::Export(report)) => ("succeeded", i64::try_from(report.rows).ok()),
            _ => ("failed", None),
        };
        if self
            .connect()
            .and_then(|db| insert_audit(&db, audit(outcome, count)))
            .is_err()
        {
            match &mut result {
                Ok(QueryOutput::Export(report)) => {
                    report.audit_warning =
                        Some("파일을 저장했지만 완료 작업 기록을 저장하지 못했습니다.".into())
                }
                Err(QueryFailure::Error(error)) => {
                    error.push_str(" 완료 작업 기록도 저장하지 못했습니다.")
                }
                _ => {
                    return Err(format!(
                        "{} 파일을 저장하지 않았으며 완료 작업 기록도 저장하지 못했습니다.",
                        format.label()
                    ))
                }
            }
        }
        query_outcome(result)
    }

    pub fn query_prepared(
        &self,
        token: &str,
        profile_id: &str,
        sql: &str,
        page: u32,
    ) -> Result<QueryOutcome> {
        self.query_prepared_with_parameters(token, profile_id, sql, page, None)
    }

    pub fn query_prepared_with_parameters(
        &self,
        token: &str,
        profile_id: &str,
        sql: &str,
        page: u32,
        parameters: Option<&[SqlParameterValue]>,
    ) -> Result<QueryOutcome> {
        self.execute_prepared(
            token,
            profile_id,
            QuerySource::Sql {
                sql,
                parameters,
                explain: false,
            },
            page,
        )
    }

    pub fn query_document_prepared(
        &self,
        token: &str,
        profile_id: &str,
        sql: &str,
        parameters: Option<&[SqlParameterValue]>,
    ) -> Result<QueryOutcome> {
        let guard = self.queries.claim(token)?;
        let control = &guard.control;
        if sql.contains('\0') {
            return Err("NUL 문자가 있는 SQL은 실행할 수 없습니다.".into());
        }
        let ranges: Vec<_> = statement_ranges(sql)
            .take(MAX_BATCH_STATEMENTS + 1)
            .collect();
        if ranges.len() < 2 {
            return query_outcome(self.query_inner(
                profile_id,
                QuerySource::Sql {
                    sql,
                    parameters,
                    explain: false,
                },
                QueryDelivery::Page(0),
                control,
                QUERY_TIMEOUT,
            ));
        }
        if sql.len() > MAX_BATCH_SQL_BYTES || ranges.len() > MAX_BATCH_STATEMENTS {
            return Err("일괄 실행은 UTF-8로 256 KiB 이하, 최대 16개 문장을 지원합니다.".into());
        }
        if parameters.is_some() {
            return Err("일괄 실행에서 매개변수가 있는 SQL은 문장별로 실행하세요.".into());
        }
        let execute = || {
            let deadline = Instant::now() + QUERY_TIMEOUT;
            control.check()?;
            let profile = self.profile(profile_id).map_err(QueryFailure::Error)?;
            let db = open_user_db(Path::new(&profile.path)).map_err(QueryFailure::Error)?;
            configure_query(&db, control, deadline)?;
            let total = ranges.len();
            let mut items = Vec::with_capacity(total);
            let mut budget = MAX_BATCH_RESULT_BYTES;
            let mut stopped = None;
            for range in ranges {
                let start = sql[..range.start].encode_utf16().count();
                let end = start + sql[range.clone()].encode_utf16().count();
                let began = Instant::now();
                let outcome = Self::query_on_connection(
                    &db,
                    QuerySource::Sql {
                        sql: &sql[range],
                        parameters: None,
                        explain: false,
                    },
                    QueryDelivery::BatchPage(&mut budget),
                    control,
                    deadline,
                );
                match outcome {
                    Ok(QueryOutput::Rows(result)) => items.push(BatchResult {
                        start,
                        end,
                        elapsed_ms: began.elapsed().as_millis() as u64,
                        result,
                    }),
                    outcome => {
                        let (status, message) = match outcome {
                            Err(QueryFailure::Cancelled) => {
                                ("cancelled", "일괄 실행을 중단했습니다.".into())
                            }
                            Err(QueryFailure::TimedOut) => {
                                ("timed_out", "일괄 실행이 10초를 초과했습니다.".into())
                            }
                            Err(QueryFailure::ParametersRequired(_)) => (
                                "parameters_required",
                                "매개변수가 있는 문장은 현재 문장으로 실행해 값을 입력하세요."
                                    .into(),
                            ),
                            Err(QueryFailure::Error(error)) => ("error", error),
                            Ok(_) => ("error", "이 문장의 조회 결과를 받을 수 없습니다.".into()),
                        };
                        stopped = Some(BatchStop {
                            start,
                            end,
                            status,
                            message,
                        });
                        break;
                    }
                }
            }
            Ok(QueryOutcome::Batch {
                total,
                items,
                stopped,
            })
        };
        match execute() {
            Ok(outcome) => Ok(outcome),
            Err(error) => query_outcome(Err(error)),
        }
    }

    pub fn explain_prepared(
        &self,
        token: &str,
        profile_id: &str,
        sql: &str,
        parameters: Option<&[SqlParameterValue]>,
    ) -> Result<QueryOutcome> {
        self.execute_prepared(
            token,
            profile_id,
            QuerySource::Sql {
                sql,
                parameters,
                explain: true,
            },
            0,
        )
    }

    pub fn query_object_prepared(
        &self,
        token: &str,
        profile_id: &str,
        request: &TableQuery,
        page: u32,
    ) -> Result<QueryOutcome> {
        self.execute_prepared(token, profile_id, QuerySource::Object(request), page)
    }

    fn execute_prepared(
        &self,
        token: &str,
        profile_id: &str,
        source: QuerySource<'_>,
        page: u32,
    ) -> Result<QueryOutcome> {
        let guard = self.queries.claim(token)?;
        query_outcome(self.query_inner(
            profile_id,
            source,
            QueryDelivery::Page(page),
            &guard.control,
            QUERY_TIMEOUT,
        ))
    }

    /// Read-only query helper for callers which do not need cancellation.
    pub fn query(&self, profile_id: &str, sql: &str, page: u32) -> Result<QueryPage> {
        match self.query_inner(
            profile_id,
            QuerySource::Sql {
                sql,
                parameters: None,
                explain: false,
            },
            QueryDelivery::Page(page),
            &Arc::new(QueryControl::default()),
            QUERY_TIMEOUT,
        ) {
            Ok(QueryOutput::Rows(result)) => Ok(result),
            Ok(_) => Err("조회 결과를 받을 수 없습니다.".into()),
            Err(QueryFailure::Cancelled) => Err("쿼리가 중단되었습니다.".into()),
            Err(QueryFailure::TimedOut) => Err("쿼리 실행 시간이 초과되어 중단되었습니다.".into()),
            Err(QueryFailure::ParametersRequired(_)) => {
                Err("쿼리 매개변수 값을 입력하세요.".into())
            }
            Err(QueryFailure::Error(error)) => Err(error),
        }
    }

    fn query_inner(
        &self,
        profile_id: &str,
        source: QuerySource<'_>,
        delivery: QueryDelivery<'_>,
        control: &Arc<QueryControl>,
        timeout: Duration,
    ) -> std::result::Result<QueryOutput, QueryFailure> {
        let deadline = Instant::now() + timeout;
        control.check()?;
        let profile = self.profile(profile_id).map_err(QueryFailure::Error)?;
        control.check()?;
        let path = Path::new(&profile.path);
        let db = match source {
            QuerySource::Sql { .. } => open_user_db(path),
            QuerySource::Object(_) => open_schema_db(path),
        }
        .map_err(QueryFailure::Error)?;
        configure_query(&db, control, deadline)?;
        Self::query_on_connection(&db, source, delivery, control, deadline)
    }

    fn query_on_connection(
        db: &Connection,
        source: QuerySource<'_>,
        delivery: QueryDelivery<'_>,
        control: &QueryControl,
        deadline: Instant,
    ) -> std::result::Result<QueryOutput, QueryFailure> {
        let started = Instant::now();
        control.check_deadline(deadline)?;
        let page = match &delivery {
            QueryDelivery::Page(page) => Some(*page),
            QueryDelivery::BatchPage(_) => Some(0),
            QueryDelivery::Export { .. } => None,
        };
        let page_clause = page
            .map(|index| {
                let offset = i64::from(index) * PAGE_SIZE as i64;
                format!("\nLIMIT {} OFFSET {offset}", PAGE_SIZE + 1)
            })
            .unwrap_or_default();
        let (bounded_sql, values, show_sql, explain) = match source {
            QuerySource::Sql {
                sql,
                parameters,
                explain,
            } => {
                if sql.contains('\0') {
                    return Err(QueryFailure::Error(
                        "NUL 문자가 있는 SQL은 실행할 수 없습니다.".into(),
                    ));
                }
                let mut statements = statement_ranges(sql);
                let range = statements
                    .next()
                    .ok_or_else(|| QueryFailure::Error("조회할 SQL을 입력하세요.".into()))?;
                if statements.next().is_some() {
                    return Err(QueryFailure::Error(
                        "이 작업은 SQL 문장 하나만 지원합니다.".into(),
                    ));
                }
                let sql = sql[range].trim_end().trim_end_matches(';').trim_end();
                // Prepare before pagination to retain the authorizer's useful errors.
                let original = db.prepare(sql).map_err(|e| control.sqlite_error(e))?;
                if !original.readonly() || original.column_count() == 0 {
                    return Err(QueryFailure::Error(
                        "이 연결에서는 결과를 반환하는 읽기 전용 쿼리만 실행할 수 있습니다.".into(),
                    ));
                }
                let count = original.parameter_count();
                if count > MAX_PARAMETERS {
                    return Err(QueryFailure::Error(
                        "쿼리 매개변수는 최대 32개까지 사용할 수 있습니다.".into(),
                    ));
                }
                control.check()?;
                let values = match parameters {
                    None if count > 0 => {
                        let slots = (1..=count)
                            .map(|index| SqlParameter {
                                index,
                                name: original.parameter_name(index).map(str::to_owned),
                            })
                            .collect();
                        return Err(QueryFailure::ParametersRequired(slots));
                    }
                    Some(values) if values.len() == count => values
                        .iter()
                        .enumerate()
                        .map(|(index, value)| {
                            value.sqlite_value().map_err(|reason| {
                                QueryFailure::Error(format!("매개변수 {}: {reason}", index + 1))
                            })
                        })
                        .collect::<std::result::Result<_, _>>()?,
                    Some(_) => {
                        return Err(QueryFailure::Error(
                            "쿼리의 매개변수 개수와 입력 값 개수가 다릅니다.".into(),
                        ))
                    }
                    None => Vec::new(),
                };
                let prefix = if explain { "EXPLAIN QUERY PLAN " } else { "" };
                (
                    format!("{prefix}SELECT * FROM (\n{sql}\n){page_clause}"),
                    values,
                    false,
                    explain,
                )
            }
            QuerySource::Object(request) => {
                let generated = request.sql(db);
                control.check()?;
                let (sql, values) = generated.map_err(QueryFailure::Error)?;
                // Schema PRAGMAs are only needed for the fixed metadata queries.
                set_read_authorizer(db, false);
                (format!("{sql}{page_clause}"), values, true, false)
            }
        };
        control.check()?;
        let mut stmt = db
            .prepare(&bounded_sql)
            .map_err(|e| control.sqlite_error(e))?;
        if !stmt.readonly() {
            return Err(QueryFailure::Error(
                "이 연결에서는 읽기 전용 쿼리만 실행할 수 있습니다.".into(),
            ));
        }
        if stmt.parameter_count() != values.len() {
            return Err(QueryFailure::Error(
                "페이지를 구성하는 동안 쿼리 매개변수가 변경되었습니다.".into(),
            ));
        }
        let columns: Vec<String> = stmt
            .column_names()
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let mut cursor = stmt
            .query(params_from_iter(&values))
            .map_err(|e| control.sqlite_error(e))?;
        if explain {
            return read_plan(&mut cursor, control).map(QueryOutput::Plan);
        }
        if let QueryDelivery::Export {
            destination,
            format,
        } = delivery
        {
            let mut file =
                ExportFile::create(destination, format, &columns).map_err(QueryFailure::Error)?;
            let mut rows = 0;
            while let Some(row) = cursor.next().map_err(|error| control.sqlite_error(error))? {
                control.check_deadline(deadline)?;
                file.write_row(row, rows).map_err(QueryFailure::Error)?;
                rows += 1;
                control.exported_rows.store(rows, Ordering::Relaxed);
            }
            control.check_deadline(deadline)?;
            let ready = file.finish().map_err(QueryFailure::Error)?;
            control.check_deadline(deadline)?;
            control.publishing()?;
            return ready
                .publish(rows)
                .map(QueryOutput::Export)
                .map_err(QueryFailure::Error);
        }
        let mut budget = match delivery {
            QueryDelivery::BatchPage(bytes) => Some(bytes),
            _ => None,
        };
        charge_batch_result(
            &mut budget,
            columns
                .iter()
                .map(|name| name.len() + size_of::<String>())
                .sum(),
        )?;
        let mut rows = Vec::with_capacity(PAGE_SIZE + 1);
        while let Some(row) = cursor.next().map_err(|e| control.sqlite_error(e))? {
            control.check_deadline(deadline)?;
            let mut cells = Vec::with_capacity(row.as_ref().column_count());
            for index in 0..row.as_ref().column_count() {
                let cell = display_value(row.get_ref(index).map_err(|e| control.sqlite_error(e))?);
                charge_batch_result(&mut budget, cell.display.len() + size_of::<crate::Cell>())?;
                cells.push(cell);
            }
            rows.push(cells);
        }
        control.check_deadline(deadline)?;
        drop(cursor);
        let rows_read = rows.len();
        let has_more = rows_read > PAGE_SIZE;
        if has_more {
            rows.pop();
        }
        let count = |status| u32::try_from(stmt.get_status(status)).ok();
        Ok(QueryOutput::Rows(QueryPage {
            columns,
            rows,
            page: page.unwrap_or_default(),
            has_more,
            metrics: QueryMetrics {
                elapsed_micros: started.elapsed().as_micros() as u64,
                rows_read,
                fullscan_steps: count(StatementStatus::FullscanStep),
                sort_operations: count(StatementStatus::Sort),
                autoindex_rows: count(StatementStatus::AutoIndex),
                vm_steps: count(StatementStatus::VmStep),
            },
            generated_sql: show_sql.then_some(bounded_sql),
        }))
    }
}

fn configure_query(
    db: &Connection,
    control: &Arc<QueryControl>,
    deadline: Instant,
) -> std::result::Result<(), QueryFailure> {
    control.attach(db)?;
    let progress = Arc::clone(control);
    db.progress_handler(
        1_000,
        Some(move || progress.check_deadline(deadline).is_err()),
    );
    control.check_deadline(deadline)
}

fn charge_batch_result(
    budget: &mut Option<&mut usize>,
    cost: usize,
) -> std::result::Result<(), QueryFailure> {
    if let Some(remaining) = budget {
        **remaining = remaining.checked_sub(cost).ok_or_else(|| {
            QueryFailure::Error(
                "일괄 결과의 메모리 한도에 도달했습니다. 문장을 나누어 실행하세요.".into(),
            )
        })?;
    }
    Ok(())
}

fn read_plan(
    cursor: &mut rusqlite::Rows<'_>,
    control: &QueryControl,
) -> std::result::Result<QueryPlan, QueryFailure> {
    let mut steps = Vec::new();
    let mut truncated = false;
    while let Some(row) = cursor.next().map_err(|error| control.sqlite_error(error))? {
        control.check()?;
        if steps.len() == MAX_PLAN_STEPS {
            truncated = true;
            break;
        }
        let detail: String = row.get(3).map_err(|error| control.sqlite_error(error))?;
        let kind = if detail.starts_with("SCAN ") {
            "scan"
        } else if detail.starts_with("SEARCH ") {
            "search"
        } else if detail.starts_with("USE TEMP B-TREE") {
            "temporary"
        } else {
            "other"
        };
        steps.push(PlanStep {
            id: row.get(0).map_err(|error| control.sqlite_error(error))?,
            parent: row.get(1).map_err(|error| control.sqlite_error(error))?,
            detail,
            kind,
        });
    }
    control.check()?;
    Ok(QueryPlan { steps, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_deadline_interrupts_a_running_statement() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.sqlite");
        Connection::open(&source)
            .unwrap()
            .execute("CREATE TABLE data (id INTEGER)", [])
            .unwrap();
        let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
        let project = store.create_project("test").unwrap();
        let profile = store
            .create_sqlite_profile(&project.id, "test", source.to_str().unwrap(), "DEV")
            .unwrap();
        let control = Arc::new(QueryControl::default());
        let result = store.query_inner(
            &profile.id,
            QuerySource::Sql {
                sql: "WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT sum(n) FROM numbers",
                parameters: None,
                explain: false,
            },
            QueryDelivery::Page(0),
            &control,
            Duration::from_millis(5),
        );
        assert!(matches!(result, Err(QueryFailure::TimedOut)));
        assert!(matches!(control.check(), Err(QueryFailure::TimedOut)));
        control.cancel().unwrap();
        assert!(matches!(control.check(), Err(QueryFailure::TimedOut)));
    }

    #[test]
    fn a_running_request_cannot_be_claimed_twice() {
        let manager = Arc::new(QueryManager::default());
        let token = manager.prepare().unwrap();
        let guard = manager.claim(&token).unwrap();
        assert!(manager.claim(&token).is_err());
        drop(guard);
        assert!(!manager.cancel(&token).unwrap());
    }
}
