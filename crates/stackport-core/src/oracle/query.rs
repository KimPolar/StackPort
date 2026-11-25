mod script;

use super::{connect, Manager, Session, IO_TIMEOUT};
use crate::{insert_audit, AuditRecord, Result};
use oracledb::{Connection, Error, ErrorKind};
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
    sql: String,
    first_line: u32,
    cursor_byte: Option<usize>,
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
        if input.sql.len() > SQL_LIMIT
            || input.sql.contains('\0')
            || !(1..=1_000_000).contains(&input.first_line)
        {
            return Err("Oracle SQL은 NUL 문자 없이 256 KiB 이내로 입력하세요.".into());
        }
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
            let statements = script::split(&input.sql, input.first_line, input.cursor_byte)?;
            let session = &registration.0;
            let mut outcome = execute(session, &job, &statements);
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

fn execute(session: &Session, job: &Job, statements: &[script::Statement<'_>]) -> QueryOutcome {
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
    let mut budget = preview::PREVIEW_BYTES;
    for statement in statements {
        match execute_statement(&connection, job, statement, &mut budget) {
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
                    outcome.error = Some(QueryError {
                        line: Some(statement.line),
                        code,
                        message: preview::limited_text(&error.to_string()),
                    });
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

fn execute_statement(
    connection: &Connection,
    job: &Job,
    statement: &script::Statement<'_>,
    budget: &mut usize,
) -> std::result::Result<StatementResult, Failure> {
    job.prepare_call(connection)?;
    let mut native = connection
        .statement(statement.sql)?
        .fetch_array_size(32)
        .prefetch_rows(1)
        .fetch_lobs()
        .exclude_from_cache()
        .build()?;
    let mut result = StatementResult {
        line: statement.line,
        rows_affected: None,
        data: None,
        warning: None,
    };
    job.prepare_call(connection)?;
    if native.is_query() {
        let cursor = native.query(&[])?;
        result.data = Some(preview::read(connection, cursor, job, budget)?);
    } else {
        let execution = native.execute(&[])?;
        result.rows_affected = native.is_dml().then(|| execution.rows_affected());
    }
    if job.stopped().is_none() {
        result.warning = connection
            .last_warning()
            .ok()
            .flatten()
            .map(|warning| preview::limited_text(&warning));
    }
    Ok(result)
}
