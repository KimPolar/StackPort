mod batches;
mod parameters;

use super::{connect, Manager, Session, SqlClient, TIMEOUT};
use crate::{insert_audit, AuditRecord, Result};
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use futures_util::{future::ready, TryStream, TryStreamExt};
use parameters::{Bindings, ParameterInput};
use serde::{Deserialize, Serialize};
use std::{fmt::Write, sync::atomic::Ordering, time::Duration};
use tiberius::{error::Error, ColumnData, CommandItem, FromSql, QueryItem};
use tokio::{
    task::spawn_blocking,
    time::{sleep_until, timeout, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SQL_LIMIT: usize = 256 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_RESULT_SETS: usize = 16;
const MAX_ROWS: usize = 100;
const MAX_COLUMNS: usize = 128;
const MAX_CELL_BYTES: usize = 2048;
const PREVIEW_BYTES: usize = 1024 * 1024;
const STATE_ERROR: &str = "SQL Server 실행 상태를 읽을 수 없습니다.";

#[derive(Deserialize)]
pub struct QueryInput {
    sql: String,
    first_line: u32,
    cursor_line: Option<u32>,
    parameters: Option<Vec<ParameterInput>>,
    #[serde(default)]
    confirmation: String,
}

impl QueryInput {
    fn batches(&self) -> Result<Vec<batches::Batch<'_>>> {
        if self.sql.len() > SQL_LIMIT
            || self.sql.contains('\0')
            || !(1..=1_000_000).contains(&self.first_line)
        {
            return Err("SQL은 NUL 문자 없이 256 KiB 이내로 입력하세요.".into());
        }
        batches::split(&self.sql, self.first_line, self.cursor_line)
    }

    pub fn parameter_indexes(&self) -> Result<Vec<u16>> {
        parameters::indexes(&self.batches()?)
    }

    pub fn review(&self) -> Result<crate::SqlExecutionReview> {
        Ok(review_batches(&self.batches()?))
    }

    pub fn parameter_plan(&self) -> Result<crate::SqlParameterPlan<Vec<u16>>> {
        let batches = self.batches()?;
        let indexes = parameters::indexes(&batches)?;
        crate::SqlParameterPlan::new(indexes, batches.iter().map(|part| part.sql.trim().as_bytes()))
    }
}

fn review_batches(batches: &[batches::Batch<'_>]) -> crate::SqlExecutionReview {
    crate::sql_risk::review(crate::sql_risk::Dialect::SqlServer,
        batches.iter().map(|batch| (batch.sql, batch.first_line, batch.repeat)))
}

#[derive(Serialize)]
pub struct QueryOutcome {
    status: Status,
    result_sets: Vec<ResultSet>,
    more_sets: bool,
    completed_batches: usize,
    elapsed_ms: u64,
    error: Option<QueryError>,
    attention: Option<Attention>,
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
enum Attention {
    NotSent,
    Confirmed,
    Unconfirmed,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Transaction {
    NotStarted,
    NoneOpen,
    RolledBack,
    Unknown,
}

#[derive(Serialize)]
struct QueryError {
    message: String,
    code: Option<u32>,
    line: Option<u32>,
    procedure: Option<String>,
}

#[derive(Serialize)]
struct ResultSet {
    columns: Vec<ResultColumn>,
    rows: Vec<Vec<Option<Cell>>>,
    rows_received: u64,
    more_columns: bool,
}

#[derive(Serialize)]
struct ResultColumn {
    name: String,
    data_type: String,
}

#[derive(Serialize)]
struct Cell {
    text: String,
    encoding: &'static str,
    bytes: usize,
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

impl Session {
    pub(super) fn stop_query(&self) {
        if let Ok(slot) = self.query.lock() {
            if let Some(active) = slot.as_ref() {
                active.stop.cancel();
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
        active.stop.cancel();
        Ok(true)
    }

    pub async fn run_query(
        &self,
        id: &str,
        request_id: &str,
        input: QueryInput,
    ) -> Result<QueryOutcome> {
        let query_id = query_id(request_id)?;
        let batches = input.batches()?;
        let bindings = input
            .parameters
            .as_deref()
            .map(|values| Bindings::new(&batches, values))
            .transpose()?;
        let session = self.session(id)?;
        if session.profile.settings.environment == "PROD" {
            review_batches(&batches).require_production_confirmation("PROD", &input.confirmation)?;
        }
        let stop = CancellationToken::new();
        {
            let mut slot = session.query.lock().map_err(|_| STATE_ERROR)?;
            if session.closed.load(Ordering::Acquire) {
                return Err("SQL Server 연결이 닫혔습니다. 다시 연결하세요.".into());
            }
            if slot.is_some() {
                return Err("이 연결에서 이미 SQL을 실행 중입니다.".into());
            }
            *slot = Some(ActiveQuery {
                id: query_id,
                stop: stop.clone(),
            });
        }
        let registration = Registration(&session);
        let start = Instant::now();
        let mut outcome = execute(&session, &stop, &batches, bindings.as_ref()).await?;
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
                        correlation_id: &query_id.to_string(),
                        operation: match status {
                            Status::Succeeded | Status::Failed => "sql_server.sql.execute",
                            Status::Cancelled => "sql_server.sql.execute.cancel",
                            Status::TimedOut => "sql_server.sql.execute.timeout",
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

fn query_id(request_id: &str) -> Result<Uuid> {
    Uuid::parse_str(request_id).map_err(|_| "유효한 SQL Server 실행 ID를 지정하세요.".into())
}

async fn execute(
    session: &Session,
    stop: &CancellationToken,
    batches: &[batches::Batch<'_>],
    bindings: Option<&Bindings<'_>>,
) -> Result<QueryOutcome> {
    let mut outcome = QueryOutcome {
        status: Status::Succeeded,
        result_sets: Vec::new(),
        more_sets: false,
        completed_batches: 0,
        elapsed_ms: 0,
        error: None,
        attention: None,
        transaction: Transaction::NotStarted,
        audit_warning: false,
    };
    let Some(auth) = session.operation_auth()? else {
        outcome.status = Status::Cancelled;
        outcome.attention = Some(Attention::NotSent);
        return Ok(outcome);
    };
    let mut client = tokio::select! {
        biased;
        _ = stop.cancelled() => {
            outcome.status = Status::Cancelled;
            outcome.attention = Some(Attention::NotSent);
            return Ok(outcome);
        },
        open = timeout(TIMEOUT, connect(&session.profile.settings, auth)) => match open {
            Ok(Ok(client)) => client,
            Ok(Err(message)) => {
                outcome.status = Status::Failed;
                outcome.error = Some(QueryError { message, code: None, line: None, procedure: None });
                return Ok(outcome);
            },
            Err(_) => {
                outcome.status = Status::TimedOut;
                outcome.attention = Some(Attention::NotSent);
                return Ok(outcome);
            }
        }
    };
    let mut preview_budget = PREVIEW_BYTES;
    let deadline = Instant::now() + QUERY_TIMEOUT;
    'script: for batch in batches {
        'repeat: for _ in 0..batch.repeat {
            let mut in_flight = false;
            let run = async {
                in_flight = true;
                stream_batch(
                    &mut client,
                    batch.sql,
                    bindings,
                    &mut outcome,
                    &mut preview_budget,
                )
                .await
            };
            // Check interruption before sending each batch, including GO repetitions.
            outcome.status = tokio::select! {
                biased;
                _ = stop.cancelled() => Status::Cancelled,
                _ = sleep_until(deadline) => Status::TimedOut,
                result = run => {
                    outcome.transaction = Transaction::Unknown;
                    match result {
                        Ok(()) => { outcome.completed_batches += 1; continue 'repeat; }
                        Err(error) => {
                            outcome.status = Status::Failed;
                            outcome.error = Some(sql_error(error, batch.first_line, bindings.is_some_and(|binding| binding.masked)));
                            break 'script;
                        }
                    }
                },
            };
            outcome.attention = Some(if in_flight {
                outcome.transaction = Transaction::Unknown;
                // Dropping a TDS read can leave a partial token. This connection is discarded in all cases.
                if matches!(
                    timeout(CANCEL_TIMEOUT, client.cancel_query()).await,
                    Ok(Ok(()))
                ) {
                    Attention::Confirmed
                } else {
                    Attention::Unconfirmed
                }
            } else {
                Attention::NotSent
            });
            break 'script;
        }
    }
    if matches!(outcome.status, Status::Succeeded) {
        outcome.transaction = timeout(CANCEL_TIMEOUT, finish_transaction(&mut client))
            .await
            .ok()
            .and_then(std::result::Result::ok)
            .unwrap_or(Transaction::Unknown);
    }
    Ok(outcome)
}

async fn finish_transaction(client: &mut SqlClient) -> tiberius::Result<Transaction> {
    let row = client.simple_query(
        "IF @@TRANCOUNT > 0 BEGIN ROLLBACK TRANSACTION; SELECT CAST(1 AS bit); END ELSE SELECT CAST(0 AS bit);",
    ).await?.into_row().await?;
    match row.and_then(|row| row.try_get::<bool, _>(0).ok().flatten()) {
        Some(true) => Ok(Transaction::RolledBack),
        Some(false) => Ok(Transaction::NoneOpen),
        None => Ok(Transaction::Unknown),
    }
}

async fn stream_batch(
    client: &mut SqlClient,
    sql: &str,
    bindings: Option<&Bindings<'_>>,
    outcome: &mut QueryOutcome,
    budget: &mut usize,
) -> tiberius::Result<()> {
    if let Some(bindings) = bindings {
        let stream = bindings
            .command(sql)
            .exec(client)
            .await?
            .try_filter_map(|item| {
                ready(Ok(match item {
                    CommandItem::Metadata(meta) => Some(QueryItem::Metadata(meta)),
                    CommandItem::Row(row) => Some(QueryItem::Row(row)),
                    _ => None,
                }))
            });
        return read_preview(stream, outcome, budget).await;
    }
    read_preview(client.simple_query(sql).await?, outcome, budget).await
}

async fn read_preview(
    mut stream: impl TryStream<Ok = QueryItem, Error = Error> + Unpin,
    outcome: &mut QueryOutcome,
    budget: &mut usize,
) -> tiberius::Result<()> {
    let mut active = None;
    while let Some(item) = stream.try_next().await? {
        match item {
            QueryItem::Metadata(meta) if outcome.result_sets.len() < MAX_RESULT_SETS => {
                outcome.result_sets.push(ResultSet {
                    columns: meta
                        .columns()
                        .iter()
                        .take(MAX_COLUMNS)
                        .map(|column| ResultColumn {
                            name: column.name().to_owned(),
                            data_type: format!("{:?}", column.column_type()),
                        })
                        .collect(),
                    rows: Vec::new(),
                    rows_received: 0,
                    more_columns: meta.columns().len() > MAX_COLUMNS,
                });
                active = Some(outcome.result_sets.len() - 1);
            }
            QueryItem::Metadata(_) => {
                outcome.more_sets = true;
                active = None;
            }
            QueryItem::Row(row) => {
                let Some(index) = active else { continue };
                let set = &mut outcome.result_sets[index];
                set.rows_received += 1;
                if set.rows.len() == MAX_ROWS || *budget == 0 {
                    continue;
                }
                let cells = row
                    .cells()
                    .take(MAX_COLUMNS)
                    .map(|(_, value)| cell(value))
                    .collect::<tiberius::Result<Vec<_>>>()?;
                let size = cells
                    .iter()
                    .map(|cell| 32 + cell.as_ref().map_or(0, |cell| cell.text.len()))
                    .sum::<usize>();
                if size > *budget {
                    *budget = 0;
                    continue;
                }
                *budget -= size;
                set.rows.push(cells);
            }
        }
    }
    Ok(())
}

fn sql_error(error: Error, first_line: u32, masked: bool) -> QueryError {
    if let Error::Server(error) = error {
        let procedure = (!error.procedure().is_empty()).then(|| error.procedure().to_owned());
        let line = match (error.line(), procedure.is_some()) {
            (0, _) => None,
            (line, true) => Some(line),
            (line, false) => Some(first_line.saturating_add(line - 1)),
        };
        QueryError {
            message: if masked {
                "숨긴 매개변수가 포함된 실행의 서버 오류 상세를 숨겼습니다.".into()
            } else {
                text_cell(error.message()).text
            },
            code: Some(error.code()),
            line,
            procedure: if masked { None } else { procedure },
        }
    } else {
        QueryError {
            message:
                "SQL Server 실행 응답을 읽을 수 없습니다. 연결과 반환 데이터 형식을 확인하세요."
                    .into(),
            code: None,
            line: None,
            procedure: None,
        }
    }
}

fn cell(value: &ColumnData<'static>) -> tiberius::Result<Option<Cell>> {
    let value = match value {
        ColumnData::U8(value) => value.map(display_cell),
        ColumnData::I16(value) => value.map(display_cell),
        ColumnData::I32(value) => value.map(display_cell),
        ColumnData::I64(value) => value.map(display_cell),
        ColumnData::F32(value) => value.map(display_cell),
        ColumnData::F64(value) => value.map(display_cell),
        ColumnData::Bit(value) => value.map(display_cell),
        ColumnData::String(value) => value.as_deref().map(text_cell),
        ColumnData::Guid(value) => value.map(display_cell),
        ColumnData::Numeric(value) => value.map(|value| {
            if value.scale() == 0 {
                display_cell(value.value())
            } else {
                display_cell(value)
            }
        }),
        ColumnData::Xml(value) => value.as_deref().map(|value| text_cell(value.as_ref())),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            NaiveDateTime::from_sql(value)?.map(display_cell)
        }
        ColumnData::Time(_) => NaiveTime::from_sql(value)?.map(display_cell),
        ColumnData::Date(_) => NaiveDate::from_sql(value)?.map(display_cell),
        ColumnData::DateTimeOffset(_) => {
            DateTime::<FixedOffset>::from_sql(value)?.map(display_cell)
        }
        ColumnData::Binary(value) => value.as_deref().map(|value| {
            let preview = &value[..value.len().min(MAX_CELL_BYTES / 2)];
            let mut text = String::with_capacity(preview.len() * 2);
            for byte in preview {
                let _ = write!(text, "{byte:02X}");
            }
            Cell {
                text,
                encoding: "hex",
                bytes: value.len(),
                truncated: preview.len() < value.len(),
            }
        }),
    };
    Ok(value)
}

fn display_cell(value: impl std::fmt::Display) -> Cell {
    text_cell(&value.to_string())
}

fn text_cell(text: &str) -> Cell {
    let end = text.floor_char_boundary(MAX_CELL_BYTES.min(text.len()));
    Cell {
        text: text[..end].to_owned(),
        encoding: "utf8",
        bytes: text.len(),
        truncated: end < text.len(),
    }
}
