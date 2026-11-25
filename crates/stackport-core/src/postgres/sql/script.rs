use super::{await_query, Column};
use crate::postgres::{
    session::{Cell, COLUMN_SIZE, ROW_SIZE, VALUE_LENGTH},
    sql_range, PostgresSqlScope,
};
use futures_util::TryStreamExt;
use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use std::{
    ops::Range,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{sync::watch, time::timeout};
use tokio_postgres::{
    error::{DbError, ErrorPosition},
    Client, Error, SimpleQueryMessage,
};

const RUN_TIMEOUT: Duration = Duration::from_secs(45);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(4);
const PREVIEW_BUDGET: usize = 1024 * 1024;

#[derive(Deserialize)]
pub struct PostgresScriptInput {
    pub(in crate::postgres) source: String,
    pub(in crate::postgres) scope: PostgresSqlScope,
    pub(in crate::postgres) autocommit: bool,
    pub(in crate::postgres) confirmation: String,
}

#[derive(Serialize)]
pub struct PostgresScriptOutcome {
    pub(in crate::postgres) status: Status,
    statements: Vec<PartResult>,
    elapsed_ms: u64,
    error: Option<ScriptError>,
    server_confirmed: Option<bool>,
    transaction: Transaction,
    pub(in crate::postgres) connection_closed: bool,
    pub(in crate::postgres) audit_warning: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::postgres) enum Status {
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Transaction {
    NotStarted,
    CleanupConfirmed,
    Unknown,
}

#[derive(Serialize)]
struct ScriptError {
    line: Option<u32>,
    position: Option<usize>,
    sql_state: Option<String>,
    message: String,
}

#[derive(Serialize)]
struct PartResult {
    line: u32,
    elapsed_ms: u64,
    columns: Vec<Column>,
    total_columns: usize,
    rows: Vec<Vec<Cell>>,
    more_rows: bool,
    affected_rows: Option<u64>,
    notices: Vec<Notice>,
}

#[derive(Serialize)]
struct Notice {
    severity: String,
    sql_state: String,
    message: String,
}

#[derive(Clone, Default)]
pub(in crate::postgres) struct Notices {
    captured: Arc<Mutex<Option<Vec<Notice>>>>,
}

impl Notices {
    pub(in crate::postgres) fn collect(&self, notice: DbError) {
        if let Ok(mut state) = self.captured.lock() {
            if let Some(messages) = state.as_mut().filter(|messages| messages.len() < 16) {
                messages.push(Notice {
                    severity: notice.severity().chars().take(24).collect(),
                    sql_state: notice.code().code().into(),
                    message: short_text(notice.message()),
                });
            }
        }
    }

    fn capture(&self) -> Capture<'_> {
        if let Ok(mut state) = self.captured.lock() {
            *state = Some(Vec::new());
        }
        Capture(self)
    }
}

struct Capture<'a>(&'a Notices);

impl Capture<'_> {
    fn take(&self) -> Vec<Notice> {
        self.0
            .captured
            .lock()
            .ok()
            .and_then(|mut state| state.as_mut().map(std::mem::take))
            .unwrap_or_default()
    }
}

impl Drop for Capture<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.captured.lock() {
            *state = None;
        }
    }
}

enum Failure {
    Native(Error),
    Input(&'static str),
    NotSent,
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Native(error)
    }
}

impl PostgresScriptOutcome {
    fn new() -> Self {
        Self {
            status: Status::Succeeded,
            statements: Vec::new(),
            elapsed_ms: 0,
            error: None,
            server_confirmed: None,
            transaction: Transaction::NotStarted,
            connection_closed: false,
            audit_warning: false,
        }
    }

    pub(in crate::postgres) fn waiting_cancelled() -> Self {
        Self {
            status: Status::Cancelled,
            ..Self::new()
        }
    }

    pub(in crate::postgres) fn waiting_timeout() -> Self {
        Self {
            status: Status::TimedOut,
            ..Self::new()
        }
    }
}

pub(in crate::postgres) async fn run(
    client: &Client,
    input: &PostgresScriptInput,
    spans: &[Range<usize>],
    mut signal: watch::Receiver<bool>,
    tls: TlsConnector,
    notices: &Notices,
) -> PostgresScriptOutcome {
    let started = Instant::now();
    let mut outcome = PostgresScriptOutcome::new();
    if *signal.borrow() {
        outcome.status = Status::Cancelled;
        return outcome;
    }
    let capture = notices.capture();
    let run = execute(
        client,
        input,
        spans,
        &mut signal,
        tls,
        &capture,
        &mut outcome.statements,
    );
    let reusable = match timeout(RUN_TIMEOUT, run).await {
        Ok(Ok(())) => true,
        Ok(Err(failure)) => {
            outcome.status = failure.status;
            outcome.error = failure.error;
            outcome.server_confirmed = failure.server_confirmed;
            failure.reusable
        }
        Err(_) => {
            outcome.status = Status::TimedOut;
            outcome.server_confirmed = Some(false);
            false
        }
    };
    drop(capture);
    let cleaned = reusable
        && timeout(CLEANUP_TIMEOUT, async {
            client.batch_execute("ROLLBACK").await?;
            client.batch_execute("DISCARD ALL").await?;
            client
                .batch_execute("SET SESSION default_transaction_read_only = on")
                .await
        })
        .await
        .is_ok_and(|result| result.is_ok());
    outcome.elapsed_ms = started.elapsed().as_millis() as u64;
    outcome.connection_closed = !cleaned;
    outcome.transaction = if cleaned {
        Transaction::CleanupConfirmed
    } else {
        Transaction::Unknown
    };
    outcome
}

struct Halt {
    status: Status,
    error: Option<ScriptError>,
    server_confirmed: Option<bool>,
    reusable: bool,
}

fn halt(failure: Failure, scope: Option<(&str, Range<usize>)>, sent_cancel: bool) -> Halt {
    let state = match &failure {
        Failure::Native(error) => error.code().map(|code| code.code()),
        _ => None,
    };
    let confirmed = state == Some("57014");
    let status = if sent_cancel || matches!(&failure, Failure::NotSent) {
        Status::Cancelled
    } else if confirmed {
        Status::TimedOut
    } else {
        Status::Failed
    };
    let reusable = (!sent_cancel || confirmed)
        && !matches!(&failure, Failure::Native(error) if error.as_db_error().is_none());
    let server_confirmed = (sent_cancel || confirmed).then_some(confirmed);
    let error = match failure {
        Failure::NotSent => None,
        Failure::Input(message) => Some(ScriptError {
            line: scope
                .as_ref()
                .map(|(source, span)| line_at(source, span.start)),
            position: None,
            sql_state: None,
            message: message.into(),
        }),
        Failure::Native(error) => {
            let native = error.as_db_error();
            let position = scope.as_ref().and_then(|(source, span)| {
                let ErrorPosition::Original(offset) = native?.position()? else {
                    return None;
                };
                let prefix = source[..span.start].encode_utf16().count();
                let offset = source[span.clone()]
                    .chars()
                    .take(offset.saturating_sub(1) as usize)
                    .map(char::len_utf16)
                    .sum::<usize>();
                Some(prefix + offset)
            });
            Some(ScriptError {
                line: scope
                    .as_ref()
                    .map(|(source, span)| line_at(source, span.start)),
                position,
                sql_state: native.map(|error| error.code().code().into()),
                message: native.map_or_else(
                    || "PostgreSQL 스크립트 응답을 계속 읽을 수 없습니다.".into(),
                    |error| short_text(error.message()),
                ),
            })
        }
    };
    Halt {
        status,
        error,
        server_confirmed,
        reusable,
    }
}

async fn execute(
    client: &Client,
    input: &PostgresScriptInput,
    spans: &[Range<usize>],
    signal: &mut watch::Receiver<bool>,
    tls: TlsConnector,
    capture: &Capture<'_>,
    results: &mut Vec<PartResult>,
) -> std::result::Result<(), Halt> {
    if *signal.borrow() {
        return Err(halt(Failure::NotSent, None, false));
    }
    let (ready, cancelled) = await_query(client.batch_execute("SET SESSION default_transaction_read_only = off; SET SESSION idle_in_transaction_session_timeout = 15000"), signal, client.cancel_token(), tls.clone()).await;
    ready.map_err(|error| halt(error.into(), None, cancelled))?;
    if cancelled {
        return Err(halt(Failure::NotSent, None, true));
    }
    let mut in_transaction = false;
    let mut budget = PREVIEW_BUDGET;
    for span in spans {
        if *signal.borrow() {
            return Err(halt(Failure::NotSent, None, false));
        }
        let sql = &input.source[span.clone()];
        let action = transaction_action(sql);
        let begin = !input.autocommit && !in_transaction && action == Action::Other;
        let started = Instant::now();
        let mut part = PartResult {
            line: line_at(&input.source, span.start),
            elapsed_ms: 0,
            columns: Vec::new(),
            total_columns: 0,
            rows: Vec::new(),
            more_rows: false,
            affected_rows: None,
            notices: Vec::new(),
        };
        let _ = capture.take();
        let stop = signal.clone();
        let work = execute_part(client, sql, begin, &stop, &mut part, &mut budget);
        let (result, cancelled) =
            await_query(work, signal, client.cancel_token(), tls.clone()).await;
        part.elapsed_ms = started.elapsed().as_millis() as u64;
        part.notices = capture.take();
        if result.is_ok()
            || part.affected_rows.is_some()
            || !part.columns.is_empty()
            || !part.notices.is_empty()
        {
            results.push(part);
        }
        if let Err(error) = result {
            return Err(halt(error, Some((&input.source, span.clone())), cancelled));
        }
        if cancelled {
            return Err(halt(Failure::NotSent, None, true));
        }
        in_transaction = match action {
            Action::Open => true,
            Action::Close => false,
            Action::Other | Action::Keep => in_transaction || begin,
        };
    }
    Ok(())
}

async fn execute_part(
    client: &Client,
    sql: &str,
    begin: bool,
    stop: &watch::Receiver<bool>,
    part: &mut PartResult,
    budget: &mut usize,
) -> std::result::Result<(), Failure> {
    if begin {
        client.batch_execute("BEGIN").await?;
    }
    if *stop.borrow() {
        return Err(Failure::NotSent);
    }
    // The backend enforces a single statement before the same SQL is sent in text format.
    let prepared = client.prepare(sql).await?;
    if !prepared.params().is_empty() {
        return Err(Failure::Input("이 스크립트 문장에는 값이 필요한 매개변수가 있습니다. 매개변수 조회는 읽기 전용 모드에서 실행하세요."));
    }
    if *stop.borrow() {
        return Err(Failure::NotSent);
    }
    let stream = client.simple_query_raw(sql).await?;
    tokio::pin!(stream);
    while let Some(message) = stream.try_next().await? {
        match message {
            SimpleQueryMessage::RowDescription(columns) => {
                part.total_columns = columns.len();
                for (index, column) in columns.iter().take(COLUMN_SIZE).enumerate() {
                    let data_type = prepared
                        .columns()
                        .get(index)
                        .map_or("text", |column| column.type_().name());
                    let size = column.name().len() + data_type.len() + 64;
                    if size > *budget {
                        break;
                    }
                    *budget -= size;
                    part.columns.push(Column {
                        name: column.name().into(),
                        data_type: data_type.into(),
                    });
                }
            }
            SimpleQueryMessage::Row(row) => {
                if part.rows.len() == ROW_SIZE || part.more_rows || part.columns.is_empty() {
                    part.more_rows = true;
                    continue;
                }
                let mut cells = Vec::with_capacity(part.columns.len());
                let mut size = 0;
                for index in 0..part.columns.len() {
                    let value = row.try_get(index)?;
                    let text = value.map(short_text);
                    let truncated = text
                        .as_deref()
                        .zip(value)
                        .is_some_and(|(text, value)| text.len() != value.len());
                    size += 32 + text.as_ref().map_or(0, String::len);
                    cells.push(Cell {
                        value: text,
                        truncated,
                    });
                }
                if size > *budget {
                    part.more_rows = true;
                } else {
                    *budget -= size;
                    part.rows.push(cells);
                }
            }
            SimpleQueryMessage::CommandComplete(rows) => part.affected_rows = Some(rows),
            _ => {}
        }
    }
    Ok(())
}

fn short_text(value: &str) -> String {
    value.chars().take(VALUE_LENGTH).collect()
}

fn line_at(source: &str, offset: usize) -> u32 {
    source[..offset]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count() as u32
        + 1
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    Open,
    Close,
    Keep,
    Other,
}

fn transaction_action(sql: &str) -> Action {
    let mut words = sql_range::head_words(sql);
    let first = words.next().unwrap_or_default();
    let second = words.next().unwrap_or_default();
    if first.eq_ignore_ascii_case(b"BEGIN")
        || first.eq_ignore_ascii_case(b"START") && second.eq_ignore_ascii_case(b"TRANSACTION")
    {
        return Action::Open;
    }
    if first.eq_ignore_ascii_case(b"PREPARE") && second.eq_ignore_ascii_case(b"TRANSACTION") {
        return Action::Close;
    }
    if [b"COMMIT".as_slice(), b"END", b"ROLLBACK", b"ABORT"]
        .iter()
        .any(|word| first.eq_ignore_ascii_case(word))
    {
        let tail = if second.eq_ignore_ascii_case(b"WORK")
            || second.eq_ignore_ascii_case(b"TRANSACTION")
        {
            words.next().unwrap_or_default()
        } else {
            second
        };
        if tail.eq_ignore_ascii_case(b"TO") {
            return Action::Keep;
        }
        if tail.eq_ignore_ascii_case(b"AND")
            && words
                .next()
                .is_some_and(|word| word.eq_ignore_ascii_case(b"CHAIN"))
        {
            return Action::Open;
        }
        return Action::Close;
    }
    Action::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_mode_tracks_transaction_boundaries_and_savepoints() {
        for (command, action) in [
            ("BEGIN READ WRITE", Action::Open),
            ("START TRANSACTION", Action::Open),
            ("COMMIT /* keep mode */ AND CHAIN", Action::Open),
            ("END WORK AND NO CHAIN", Action::Close),
            ("ROLLBACK TRANSACTION TO SAVEPOINT x", Action::Keep),
            ("ABORT", Action::Close),
            ("PREPARE TRANSACTION 'x'", Action::Close),
            ("PREPARE named AS SELECT 1", Action::Other),
        ] {
            assert_eq!(transaction_action(command), action);
        }
    }
}
