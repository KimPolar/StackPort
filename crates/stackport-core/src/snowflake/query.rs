mod script;

use super::{
    api::{
        check_handle, finish_handle, partition_rows, read_payload, successful, Api, Payload, Row,
        StatementStats, BAD_RESPONSE,
    },
    Manager, Session,
};
use crate::{insert_audit, AuditRecord, Result};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};
use tokio::{
    task::spawn_blocking,
    time::{sleep_until, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SQL_LIMIT: usize = 256 * 1024;
const MAX_ROWS: usize = 100;
const MAX_COLUMNS: usize = 128;
const MAX_CELL_BYTES: usize = 2048;
const PREVIEW_BYTES: usize = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(45);
const STATE_ERROR: &str = "Snowflake SQL 실행 상태를 읽을 수 없습니다.";

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
    server_completed: bool,
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
struct QueryError {
    line: Option<u32>,
    code: Option<String>,
    sql_state: Option<String>,
    message: String,
    query_id: Option<Uuid>,
}

#[derive(Serialize)]
struct StatementResult {
    line: u32,
    data: Option<ResultSet>,
    warning: Option<String>,
    query_id: Option<Uuid>,
    stats: Option<StatementStats>,
}

#[derive(Serialize)]
struct ResultSet {
    columns: Vec<ResultColumn>,
    rows: Vec<Vec<Option<Cell>>>,
    rows_received: usize,
    more_columns: bool,
}

#[derive(Serialize)]
struct ResultColumn {
    name: String,
    data_type: String,
    binary: bool,
}

#[derive(Serialize)]
struct Cell {
    text: String,
    encoding: &'static str,
    bytes: Option<usize>,
    truncated: bool,
}

pub(super) struct ActiveQuery {
    id: Uuid,
    stop: CancellationToken,
}

struct Registration<'a>(&'a Session);

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.query.lock() {
            *slot = None;
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
        active.stop.cancel();
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
            return Err("Snowflake SQL은 NUL 문자 없이 256 KiB 이내로 입력하세요.".into());
        }
        let statements = script::split(&input.sql, input.first_line, input.cursor_byte)?;
        let session = self.session(id)?;
        let _permit = session.operation()?;
        let stop = session.api.operation_token();
        {
            let mut slot = session.query.lock().map_err(|_| STATE_ERROR)?;
            if stop.is_cancelled() {
                return Err(super::CLOSED.into());
            }
            if slot.is_some() {
                return Err("이 Snowflake 연결에서 이미 SQL을 실행 중입니다.".into());
            }
            *slot = Some(ActiveQuery {
                id: request_id,
                stop: stop.clone(),
            });
        }
        let registration = Registration(&session);
        let start = Instant::now();
        let mut outcome = execute(
            &session.api,
            request_id,
            &statements,
            &stop,
            start + DEADLINE,
        )
        .await;
        drop(registration);
        outcome.elapsed_ms = start.elapsed().as_millis() as u64;
        let store = self.store.clone();
        let profile = session.profile.clone();
        let status = outcome.status;
        outcome.audit_warning = !spawn_blocking(move || {
            store.connect().and_then(|db| {
                insert_audit(
                    &db,
                    AuditRecord {
                        correlation_id: &request_id.to_string(),
                        operation: match status {
                            Status::Succeeded | Status::Failed => "snowflake.sql.execute",
                            Status::Cancelled => "snowflake.sql.execute.cancel",
                            Status::TimedOut => "snowflake.sql.execute.timeout",
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
        })
        .await
        .is_ok_and(|result| result.is_ok());
        Ok(outcome)
    }
}

fn query_id(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| "유효한 Snowflake SQL 실행 ID를 지정하세요.".into())
}

async fn execute(
    api: &Api,
    request_id: Uuid,
    statements: &[script::Statement<'_>],
    stop: &CancellationToken,
    deadline: Instant,
) -> QueryOutcome {
    let mut outcome = QueryOutcome {
        status: Status::Succeeded,
        statements: Vec::new(),
        elapsed_ms: 0,
        error: None,
        server_interrupted: None,
        server_completed: false,
        audit_warning: false,
    };
    let mut pending = None;
    let mut submitted = false;
    let mut response_received = false;
    let sql = statements
        .iter()
        .map(|statement| statement.sql)
        .collect::<Vec<_>>()
        .join("\n;\n");
    let run = async {
        submitted = true;
        let response = api
            .submit_script(
                &sql,
                request_id,
                statements.len(),
                MAX_ROWS + 1,
                &mut pending,
            )
            .await?;
        response_received = true;
        let status = response.status();
        if status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::REQUEST_TIMEOUT {
            let problem = read_payload(response).await.unwrap_or_default();
            check_handle(pending, problem.statement_handle)?;
            let handle = pending.take().or(problem.statement_handle);
            outcome.status = if status == StatusCode::REQUEST_TIMEOUT {
                Status::TimedOut
            } else if problem.sql_state.as_deref() == Some("57014") {
                Status::Cancelled
            } else {
                Status::Failed
            };
            if matches!(outcome.status, Status::Cancelled | Status::TimedOut) {
                outcome.server_interrupted = Some(true);
            }
            outcome.error = Some(server_error(problem, statements, handle));
            return Ok(());
        }
        let response = successful(response).await?;
        outcome.server_completed = true;
        let first = read_payload(response).await?;
        let handle = finish_handle(&mut pending, first.statement_handle)?;
        let mut budget = PREVIEW_BYTES;
        if statements.len() == 1 {
            if first
                .statement_handles
                .as_ref()
                .is_some_and(|handles| !handles.is_empty())
            {
                return Err(BAD_RESPONSE.into());
            }
            let result = preview(api, handle, first, statements[0].line, &mut budget).await?;
            outcome.statements.push(result);
        } else {
            let children = first.statement_handles.unwrap_or_default();
            if children.len() != statements.len()
                || children.iter().any(|child| Some(*child) == handle)
                || children.iter().collect::<HashSet<_>>().len() != children.len()
            {
                return Err(BAD_RESPONSE.into());
            }
            for (statement, child) in statements.iter().zip(children) {
                let payload = api.script_result(child).await?;
                outcome
                    .statements
                    .push(preview(api, Some(child), payload, statement.line, &mut budget).await?);
            }
        }
        Ok::<(), String>(())
    };
    let result = tokio::select! {
        biased;
        _ = stop.cancelled() => Err(Status::Cancelled),
        _ = sleep_until(deadline) => Err(Status::TimedOut),
        result = run => Ok(result),
    };
    match result {
        Ok(Ok(())) => {}
        Ok(Err(mut message)) => {
            outcome.status = Status::Failed;
            if pending.is_some() && !outcome.server_completed {
                outcome.server_interrupted = Some(api.cancel_pending(pending).await);
            }
            if submitted && !response_received && outcome.server_interrupted != Some(true) {
                message.push_str("\n서버의 실행 결과를 확인하지 못했습니다.");
            }
            outcome.error = Some(QueryError {
                line: None,
                code: None,
                sql_state: None,
                message,
                query_id: pending,
            });
        }
        Err(status) => {
            outcome.status = status;
            if submitted && !outcome.server_completed {
                outcome.server_interrupted = Some(api.cancel_pending(pending).await);
            }
        }
    }
    outcome
}

fn server_error(
    payload: Payload,
    statements: &[script::Statement<'_>],
    query_id: Option<Uuid>,
) -> QueryError {
    QueryError {
        line: (statements.len() == 1).then_some(statements[0].line),
        code: payload.code.filter(|code| {
            (1..=12).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_digit())
        }),
        sql_state: payload.sql_state.filter(|state| {
            state.len() == 5 && state.bytes().all(|byte| byte.is_ascii_alphanumeric())
        }),
        message: payload
            .message
            .as_deref()
            .map(limited_text)
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "Snowflake가 SQL 실행을 완료하지 못했습니다.".into()),
        query_id,
    }
}

async fn preview(
    api: &Api,
    handle: Option<Uuid>,
    payload: Payload,
    line: u32,
    budget: &mut usize,
) -> Result<StatementResult> {
    let mut result = StatementResult {
        line,
        query_id: handle,
        stats: payload.stats,
        data: None,
        warning: payload
            .message
            .as_deref()
            .filter(|message| *message != "Statement executed successfully.")
            .map(limited_text),
    };
    let Some(meta) = payload.result_set_meta_data else {
        if payload.data.is_some_and(|rows| !rows.is_empty()) {
            return Err(BAD_RESPONSE.into());
        }
        return Ok(result);
    };
    meta.validate(None)?;
    let columns = meta.row_type.unwrap_or_default();
    let width = columns.len();
    if width == 0 && meta.num_rows > 0 {
        return Err(BAD_RESPONSE.into());
    }
    let mut data = ResultSet {
        columns: columns
            .iter()
            .take(MAX_COLUMNS)
            .map(|column| {
                let base = column.data_type.to_ascii_uppercase();
                let data_type = match (base.as_str(), column.precision, column.scale) {
                    ("FIXED", Some(precision @ 1..=38), Some(scale @ 0..=37)) => {
                        format!("NUMBER({precision},{scale})")
                    }
                    _ => base,
                };
                ResultColumn {
                    name: column.name.clone(),
                    data_type,
                    binary: column.data_type.eq_ignore_ascii_case("binary"),
                }
            })
            .collect(),
        rows: Vec::new(),
        rows_received: meta.num_rows,
        more_columns: width > MAX_COLUMNS,
    };
    let first_count = meta
        .partition_info
        .first()
        .map_or(0, |partition| partition.row_count);
    push_rows(
        &mut data,
        width,
        partition_rows(payload.data, first_count)?,
        budget,
    )?;
    for (index, partition) in meta.partition_info.into_iter().enumerate().skip(1) {
        if data.rows.len() == MAX_ROWS || *budget == 0 {
            break;
        }
        if partition.row_count == 0 {
            continue;
        }
        let response = api
            .partition(handle.ok_or(BAD_RESPONSE)?, index, Duration::from_secs(12))
            .await?;
        let payload = read_payload(response).await?;
        check_handle(handle, payload.statement_handle)?;
        push_rows(
            &mut data,
            width,
            partition_rows(payload.data, partition.row_count)?,
            budget,
        )?;
    }
    result.data = Some(data);
    Ok(result)
}

fn push_rows(data: &mut ResultSet, width: usize, rows: Vec<Row>, budget: &mut usize) -> Result<()> {
    for row in rows {
        if row.len() != width {
            return Err(BAD_RESPONSE.into());
        }
        if data.rows.len() == MAX_ROWS || *budget == 0 {
            continue;
        }
        let cells = row
            .into_iter()
            .zip(&data.columns)
            .map(|(value, column)| value.map(|value| cell(&value, column.binary)).transpose())
            .collect::<Result<Vec<_>>>()?;
        let size = cells
            .iter()
            .map(|cell| 32 + cell.as_ref().map_or(0, |cell| cell.text.len()))
            .sum::<usize>();
        if size > *budget {
            *budget = 0;
            continue;
        }
        *budget -= size;
        data.rows.push(cells);
    }
    Ok(())
}

fn cell(value: &str, binary: bool) -> Result<Cell> {
    if binary
        && (!value.len().is_multiple_of(2) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("Snowflake 바이너리 결과의 HEX 형식을 읽을 수 없습니다.".into());
    }
    let text = limited_text(value);
    Ok(Cell {
        truncated: text.len() < value.len(),
        text,
        encoding: if binary { "hex" } else { "utf8" },
        bytes: Some(if binary { value.len() / 2 } else { value.len() }),
    })
}

fn limited_text(value: &str) -> String {
    value[..value.floor_char_boundary(value.len().min(MAX_CELL_BYTES))].to_owned()
}
