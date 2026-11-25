mod parameters;
mod script;

use super::{connect, Manager, Session, IO_TIMEOUT};
use crate::{insert_audit, AuditRecord, Result};
use oracledb::{Connection, Error, ErrorKind, Statement as NativeStatement};
use parameters::{Bindings, ParameterInput};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::task::spawn_blocking;
use uuid::Uuid;

mod preview;
use preview::ResultSet;

const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const SQL_LIMIT: usize = 256 * 1024;
const STATE_ERROR: &str = "Oracle SQL 실행 상태를 읽을 수 없습니다.";

#[derive(Deserialize)]
pub struct QueryInput {
    #[serde(flatten)]
    source: QuerySource,
    #[serde(default)]
    parameters: Vec<ParameterInput>,
    #[serde(default)]
    confirmation: String,
}

#[derive(Deserialize)]
pub struct QuerySource {
    sql: String,
    first_line: u32,
    cursor_byte: Option<usize>,
}

impl QuerySource {
    pub fn review(&self) -> Result<crate::SqlExecutionReview> {
        let statements = self.statements()?;
        let mut review = review_statements(&statements);
        if let Some(statement) = statements.first().filter(|_| self.cursor_byte.is_some()) {
            review.set_source_slice(&self.sql, statement.sql);
        }
        Ok(review)
    }

    fn statements(&self) -> Result<Vec<script::Statement<'_>>> {
        if self.sql.len() > SQL_LIMIT
            || self.sql.contains('\0')
            || !(1..=1_000_000).contains(&self.first_line)
        {
            return Err("Oracle SQL은 NUL 문자 없이 256 KiB 이내로 입력하세요.".into());
        }
        script::split(&self.sql, self.first_line, self.cursor_byte)
    }
}

fn review_statements(statements: &[script::Statement<'_>]) -> crate::SqlExecutionReview {
    crate::sql_risk::review(crate::sql_risk::Dialect::Oracle,
        statements.iter().map(|statement| (statement.sql, statement.line, 1)))
}

#[derive(Serialize)]
pub struct QueryOutcome {
    status: Status,
    statements: Vec<StatementResult>,
    elapsed_ms: u64,
    error: Option<QueryError>,
    server_interrupted: Option<bool>,
    transaction: Transaction,
    audit_warning: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Transaction {
    NotStarted,
    RolledBack,
    Unknown,
}

#[derive(Serialize)]
struct QueryError {
    line: Option<u32>,
    code: Option<usize>,
    message: String,
}

#[derive(Serialize)]
struct StatementResult {
    line: u32,
    rows_affected: Option<u64>,
    data: Option<ResultSet>,
    warning: Option<String>,
}

pub(super) struct ActiveQuery {
    id: Uuid,
    job: Arc<Job>,
}

struct Job {
    stop: AtomicBool,
    deadline: Instant,
}

enum Failure {
    Stopped(Status),
    Driver(Error),
    Value(String),
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Driver(error)
    }
}

impl Job {
    fn stopped(&self) -> Option<Status> {
        if self.stop.load(Ordering::Acquire) {
            Some(Status::Cancelled)
        } else if Instant::now() >= self.deadline {
            Some(Status::TimedOut)
        } else {
            None
        }
    }

    fn prepare_call(&self, connection: &Connection) -> std::result::Result<(), Failure> {
        if let Some(status) = self.stopped() {
            return Err(Failure::Stopped(status));
        }
        let remaining = self
            .deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        connection.set_call_timeout(Some(remaining.min(IO_TIMEOUT)))?;
        Ok(())
    }
}

struct Registration(Arc<Session>);

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.query.lock() {
            *slot = None;
        }
    }
}

impl Session {
    pub(super) fn stop_query(&self) {
        if let Ok(slot) = self.query.lock() {
            if let Some(active) = slot.as_ref() {
                active.job.stop.store(true, Ordering::Release);
            }
        }
    }
}

impl Manager {
    pub async fn query_parameters(&self, id: &str, input: QuerySource) -> Result<Vec<String>> {
        self.query_parameter_plan(id, input).await.map(|plan| plan.parameters)
    }

    pub async fn query_parameter_plan(&self, id: &str, input: QuerySource) -> Result<crate::SqlParameterPlan<Vec<String>>> {
        self.read(id, move |connection| {
            let statements = input.statements()?;
            let prepared = prepare(connection, &statements, false).map_err(|error| {
                format!(
                    "문장 시작 {}행 · {}",
                    error.line.unwrap_or(input.first_line),
                    error.message
                )
            })?;
            let names = parameters::names(&prepared)?
                .into_iter()
                .map(str::to_owned)
                .collect();
            crate::SqlParameterPlan::new(names, statements.iter().map(|part| part.sql.trim().as_bytes()))
        })
        .await
    }

    pub fn cancel_query(&self, id: &str, request_id: &str) -> Result<bool> {
        let request_id = query_id(request_id)?;
        let session = self.session(id)?;
        let slot = session.query.lock().map_err(|_| STATE_ERROR)?;
        let Some(active) = slot.as_ref().filter(|active| active.id == request_id) else {
            return Ok(false);
        };
        active.job.stop.store(true, Ordering::Release);
        Ok(true)
    }

    pub async fn run_query(
        &self,
        id: &str,
        request_id: &str,
        input: QueryInput,
    ) -> Result<QueryOutcome> {
        let request_id = query_id(request_id)?;
        let session = self.session(id)?;
        let start = Instant::now();
        let job = Arc::new(Job {
            stop: AtomicBool::new(false),
            deadline: start + QUERY_TIMEOUT,
        });
        {
            let mut slot = session.query.lock().map_err(|_| STATE_ERROR)?;
            if session.closed.load(Ordering::Acquire) {
                return Err(super::CLOSED.into());
            }
            if slot.is_some() {
                return Err("이 Oracle 연결에서 이미 SQL을 실행 중입니다.".into());
            }
            *slot = Some(ActiveQuery {
                id: request_id,
                job: Arc::clone(&job),
            });
        }
        let registration = Registration(session);
        let store = self.store.clone();
        spawn_blocking(move || {
            let registration = registration;
            let statements = input.source.statements()?;
            let bindings = Bindings::new(&input.parameters)?;
            let session = &registration.0;
            if session.profile.settings.environment == "PROD" {
                review_statements(&statements).require_production_confirmation("PROD", &input.confirmation)?;
            }
            let mut outcome = execute(session, &job, &statements, &bindings);
            outcome.elapsed_ms = start.elapsed().as_millis() as u64;
            let profile = session.profile.clone();
            drop(registration);
            let status = outcome.status;
            outcome.audit_warning = store
                .connect()
                .and_then(|db| {
                    insert_audit(
                        &db,
                        AuditRecord {
                            correlation_id: &request_id.to_string(),
                            operation: match status {
                                Status::Succeeded | Status::Failed => "oracle.sql.execute",
                                Status::Cancelled => "oracle.sql.execute.cancel",
                                Status::TimedOut => "oracle.sql.execute.timeout",
                            },
                            project_id: Some(&profile.project_id),
                            profile_id: Some(&profile.id),
                            environment: Some(&profile.settings.environment),
                            object_name: None,
                            outcome: if matches!(status, Status::Succeeded) {
                                "succeeded"
                            } else {
                                "failed"
                            },
                            affected_count: None,
                        },
                    )
                })
                .is_err();
            Ok(outcome)
        })
        .await
        .map_err(|_| "Oracle SQL 실행 작업을 마치지 못했습니다.")?
    }
}

fn query_id(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| "유효한 Oracle SQL 실행 ID를 지정하세요.".into())
}

fn execute(
    session: &Session,
    job: &Job,
    statements: &[script::Statement<'_>],
    bindings: &Bindings<'_>,
) -> QueryOutcome {
    let mut outcome = QueryOutcome {
        status: Status::Succeeded,
        statements: Vec::new(),
        elapsed_ms: 0,
        error: None,
        server_interrupted: None,
        transaction: Transaction::NotStarted,
        audit_warning: false,
    };
    if let Some(status) = job.stopped() {
        outcome.status = status;
        return outcome;
    }
    let settings = &session.profile.settings;
    let opened = session
        .operation_config()
        .and_then(|config| connect(settings, config));
    let (connection, wallet) = match opened {
        Ok(opened) => opened,
        Err(message) => {
            if let Some(status) = job.stopped() {
                outcome.status = status;
            } else {
                outcome.status = Status::Failed;
                outcome.error = Some(QueryError {
                    line: None,
                    code: None,
                    message,
                });
            }
            return outcome;
        }
    };
    match prepare(&connection, statements, bindings.masked).and_then(|prepared| {
        bindings.validate(&prepared).map_err(|message| QueryError {
            line: None,
            code: None,
            message,
        })?;
        Ok(prepared)
    }) {
        Ok(prepared) => run_statements(
            &connection,
            job,
            statements,
            prepared,
            bindings,
            &mut outcome,
        ),
        Err(error) => {
            outcome.status = Status::Failed;
            outcome.error = Some(error);
        }
    }
    outcome.transaction = if connection
        .set_call_timeout(Some(IO_TIMEOUT))
        .and_then(|()| connection.rollback())
        .is_ok()
    {
        Transaction::RolledBack
    } else {
        Transaction::Unknown
    };
    drop(connection);
    drop(wallet);
    outcome
}

fn prepare(
    connection: &Connection,
    statements: &[script::Statement<'_>],
    masked: bool,
) -> std::result::Result<Vec<NativeStatement>, QueryError> {
    statements
        .iter()
        .map(|statement| {
            connection
                .statement(statement.sql)
                .and_then(|builder| {
                    builder
                        .fetch_array_size(32)
                        .prefetch_rows(1)
                        .fetch_lobs()
                        .exclude_from_cache()
                        .build()
                })
                .map_err(|error| driver_error(statement.line, error, masked))
        })
        .collect()
}

fn driver_error(line: u32, error: Error, masked: bool) -> QueryError {
    QueryError {
        line: Some(line),
        code: error.db_error_code(),
        message: if masked {
            "숨긴 값이 있어 Oracle 오류 상세를 표시하지 않습니다.".into()
        } else {
            preview::limited_text(&error.to_string())
        },
    }
}

fn run_statements(
    connection: &Connection,
    job: &Job,
    statements: &[script::Statement<'_>],
    prepared: Vec<NativeStatement>,
    bindings: &Bindings<'_>,
    outcome: &mut QueryOutcome,
) {
    let mut budget = preview::PREVIEW_BYTES;
    for (statement, native) in statements.iter().zip(prepared) {
        match execute_statement(
            connection,
            job,
            native,
            statement.line,
            bindings,
            &mut budget,
        ) {
            Ok(result) => {
                outcome.statements.push(result);
                if let Some(status) = job.stopped() {
                    outcome.status = status;
                    break;
                }
            }
            Err(Failure::Stopped(status)) => {
                outcome.status = status;
                break;
            }
            Err(Failure::Driver(error)) => {
                let code = error.db_error_code();
                let timed_out = matches!(error.kind(), ErrorKind::CallTimeoutExceeded);
                outcome.status = match (job.stopped(), timed_out, code) {
                    (Some(Status::Cancelled), _, _) | (_, false, Some(1013)) => Status::Cancelled,
                    (_, true, _) | (Some(Status::TimedOut), _, _) => Status::TimedOut,
                    _ => Status::Failed,
                };
                if matches!(outcome.status, Status::Cancelled | Status::TimedOut) {
                    outcome.server_interrupted = Some(code == Some(1013));
                } else {
                    outcome.error = Some(driver_error(statement.line, error, bindings.masked));
                }
                break;
            }
            Err(Failure::Value(message)) => {
                outcome.status = Status::Failed;
                outcome.error = Some(QueryError {
                    line: Some(statement.line),
                    code: None,
                    message,
                });
                break;
            }
        }
    }
}

fn execute_statement(
    connection: &Connection,
    job: &Job,
    mut native: NativeStatement,
    line: u32,
    bindings: &Bindings<'_>,
    budget: &mut usize,
) -> std::result::Result<StatementResult, Failure> {
    let mut result = StatementResult {
        line,
        rows_affected: None,
        data: None,
        warning: None,
    };
    job.prepare_call(connection)?;
    let values = bindings.for_statement(&native);
    if native.is_query() {
        let cursor = native.query_named(&values)?;
        result.data = Some(preview::read(connection, cursor, job, budget)?);
    } else {
        let execution = native.execute_named(&values)?;
        result.rows_affected = native.is_dml().then(|| execution.rows_affected());
    }
    if job.stopped().is_none() && !bindings.masked {
        result.warning = connection
            .last_warning()
            .ok()
            .flatten()
            .map(|warning| preview::limited_text(&warning));
    }
    Ok(result)
}
