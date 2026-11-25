use super::{await_query, Column, RunningSqlGuard};
use crate::postgres::{
    export::EXPORT_TIMEOUT,
    parameters::{type_label, Value, MAX_PARAMETERS},
    session::{COLUMN_SIZE, ROW_SIZE, VALUE_LENGTH},
    sql_range, PostgresSqlScope,
};
use crate::{result_export::ExportReport, Result};
use futures_util::TryStreamExt;
use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ops::Range,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{sync::watch, time::timeout};
use tokio_postgres::{
    error::{DbError, ErrorPosition},
    types::Type,
    Client, Error, SimpleQueryMessage,
};

pub(in crate::postgres) mod export_io;
mod wire;
use export_io::{Message, Writer};
use wire::{PreviewCell, WireValue};

const RUN_TIMEOUT: Duration = Duration::from_secs(45);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(4);
const PREVIEW_BUDGET: usize = 1024 * 1024;

#[derive(Deserialize)]
pub struct PostgresScriptInput {
    pub(in crate::postgres) source: String,
    pub(in crate::postgres) scope: PostgresSqlScope,
    pub(in crate::postgres) autocommit: bool,
    pub(in crate::postgres) confirmation: String,
    pub(in crate::postgres) export_destination: Option<String>,
    bindings: Option<Vec<Binding>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    index: usize,
    value: Value,
}

pub(in crate::postgres) struct Plan {
    statements: Vec<ScriptStatement>,
    slots: BTreeSet<usize>,
}

struct ScriptStatement {
    span: Range<usize>,
    slots: BTreeSet<usize>,
}

impl Plan {
    pub(in crate::postgres) fn new(input: &PostgresScriptInput) -> Result<Self> {
        let mut slots = BTreeSet::new();
        let mut statements = Vec::new();
        for span in sql_range::script(&input.source, input.scope)? {
            let statement_slots =
                sql_range::script_slots(&input.source[span.clone()], MAX_PARAMETERS)?;
            slots.extend(statement_slots.iter().copied());
            statements.push(ScriptStatement {
                span,
                slots: statement_slots,
            });
        }
        Ok(Self { statements, slots })
    }

    pub(in crate::postgres) fn request_bindings(
        &self,
        input: &PostgresScriptInput,
    ) -> Result<Option<PostgresScriptOutcome>> {
        let Some(bindings) = &input.bindings else {
            return Ok((!self.slots.is_empty()).then(|| PostgresScriptOutcome {
                status: Status::ParametersRequired,
                parameter_indexes: self.slots.iter().copied().collect(),
                parameter_scope: Some(crate::sql_parameter_sets::fingerprint(
                    self.statements
                        .iter()
                        .map(|item| &input.source.as_bytes()[item.span.clone()]),
                )),
                ..PostgresScriptOutcome::new()
            }));
        };
        if !bindings
            .iter()
            .map(|binding| binding.index)
            .eq(self.slots.iter().copied())
        {
            return Err("PostgreSQL 스크립트 매개변수의 번호와 값을 확인하세요.".into());
        }
        for binding in bindings {
            binding.value.validate(binding.index)?;
        }
        Ok(None)
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::postgres) export_report: Option<ExportReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    export_error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    parameter_indexes: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameter_scope: Option<String>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::postgres) enum Status {
    ParametersRequired,
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
    rows: Vec<Vec<PreviewCell>>,
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
            export_report: None,
            export_error: None,
            parameter_indexes: Vec::new(),
            parameter_scope: None,
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

    pub(in crate::postgres) async fn finish_export(
        &mut self,
        writer: Writer,
        running: &RunningSqlGuard<'_>,
    ) {
        let complete = matches!(self.status, Status::Succeeded) && !self.connection_closed;
        let staged = timeout(Duration::from_secs(12), writer.finish(complete)).await;
        match staged {
            Ok(Ok(Some((file, rows)))) => {
                if !running.begin_publication() {
                    self.export_error = Some("결과 파일 저장을 중단했습니다.".into());
                    return;
                }
                match tokio::task::spawn_blocking(move || file.publish(rows)).await {
                    Ok(Ok(report)) => self.export_report = Some(report),
                    Ok(Err(error)) => self.export_error = Some(error),
                    Err(_) => {
                        self.export_error = Some("스크립트 결과 파일을 게시할 수 없습니다.".into())
                    }
                }
            }
            Ok(Ok(None)) if matches!(self.status, Status::Succeeded) => {
                self.export_error = Some(
                    "스크립트 연결의 정리를 확인할 수 없어 결과 파일을 게시하지 못했습니다.".into(),
                );
            }
            Ok(Ok(None)) => {}
            Ok(Err(error)) => self.export_error = Some(error),
            Err(_) => {
                self.export_error =
                    Some("스크립트 결과 파일을 마무리하는 시간이 초과되었습니다.".into())
            }
        }
    }
}

pub(in crate::postgres) async fn run(
    client: &Client,
    input: &PostgresScriptInput,
    plan: &Plan,
    mut signal: watch::Receiver<bool>,
    tls: TlsConnector,
    notices: &Notices,
    writer: Option<&Writer>,
) -> PostgresScriptOutcome {
    let started = Instant::now();
    let mut outcome = PostgresScriptOutcome::new();
    if *signal.borrow() {
        outcome.status = Status::Cancelled;
        return outcome;
    }
    let capture = plan.slots.is_empty().then(|| notices.capture());
    let run = execute(
        client,
        input,
        plan,
        &mut signal,
        tls,
        capture.as_ref(),
        &mut outcome.statements,
        writer,
    );
    let limit = if writer.is_some() {
        EXPORT_TIMEOUT
    } else {
        RUN_TIMEOUT
    };
    let reusable = match timeout(limit, run).await {
        Ok(Ok(())) => true,
        Ok(Err(failure)) => {
            outcome.status = failure.status;
            outcome.error = failure.error;
            if let Some(error) = outcome
                .error
                .as_mut()
                .filter(|error| !plan.slots.is_empty() && error.sql_state.is_some())
            {
                error.message = "PostgreSQL이 매개변수가 있는 스크립트에서 오류를 반환했습니다. 문장과 값의 형식을 확인하세요.".into();
            }
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
    plan: &Plan,
    signal: &mut watch::Receiver<bool>,
    tls: TlsConnector,
    capture: Option<&Capture<'_>>,
    results: &mut Vec<PartResult>,
    writer: Option<&Writer>,
) -> std::result::Result<(), Halt> {
    if *signal.borrow() {
        return Err(halt(Failure::NotSent, None, false));
    }
    let settings = if writer.is_some() {
        "SET SESSION default_transaction_read_only = off; SET SESSION idle_in_transaction_session_timeout = 15000; SET SESSION statement_timeout = 300000"
    } else {
        "SET SESSION default_transaction_read_only = off; SET SESSION idle_in_transaction_session_timeout = 15000"
    };
    let (ready, cancelled) = await_query(
        client.batch_execute(settings),
        signal,
        client.cancel_token(),
        tls.clone(),
    )
    .await;
    ready.map_err(|error| halt(error.into(), None, cancelled))?;
    if cancelled {
        return Err(halt(Failure::NotSent, None, true));
    }
    let mut in_transaction = false;
    let mut budget = PREVIEW_BUDGET;
    for statement in &plan.statements {
        if *signal.borrow() {
            return Err(halt(Failure::NotSent, None, false));
        }
        let span = &statement.span;
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
        let _ = capture.map(Capture::take);
        let stop = signal.clone();
        let work = execute_part(
            client,
            sql,
            statement,
            input.bindings.as_deref().unwrap_or_default(),
            begin,
            &stop,
            &mut part,
            &mut budget,
            writer,
        );
        let (result, cancelled) =
            await_query(work, signal, client.cancel_token(), tls.clone()).await;
        part.elapsed_ms = started.elapsed().as_millis() as u64;
        part.notices = capture.map(Capture::take).unwrap_or_default();
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
    statement: &ScriptStatement,
    bindings: &[Binding],
    begin: bool,
    stop: &watch::Receiver<bool>,
    part: &mut PartResult,
    budget: &mut usize,
    writer: Option<&Writer>,
) -> std::result::Result<(), Failure> {
    if begin {
        client.batch_execute("BEGIN").await?;
    }
    if *stop.borrow() {
        return Err(Failure::NotSent);
    }
    // Parse enforces a single statement and infers types using the live schema.
    let last = statement.slots.last().copied().unwrap_or(0);
    let types: Vec<_> = (1..=last)
        .map(|index| {
            if statement.slots.contains(&index) {
                Type::UNKNOWN
            } else {
                Type::TEXT
            }
        })
        .collect();
    let prepared = client.prepare_typed(sql, &types).await?;
    if prepared.params().len() != last {
        return Err(Failure::Input("PostgreSQL 서버가 실행 전에 확인한 것과 다른 매개변수를 인식했습니다. 문장과 문자열 인용을 확인하세요."));
    }
    if *stop.borrow() {
        return Err(Failure::NotSent);
    }
    if last != 0 {
        let values = (0..last).map(|offset| {
            let index = offset + 1;
            statement
                .slots
                .get(&index)
                .and_then(|index| bindings.binary_search_by_key(index, |item| item.index).ok())
                .map_or(&Value::Null, |offset| &bindings[offset].value)
        });
        let stream = client.query_raw(&prepared, values).await?;
        if let Some(writer) = writer {
            let columns = prepared
                .columns()
                .iter()
                .map(|column| Column {
                    name: column.name().into(),
                    data_type: type_label(column.type_()),
                })
                .collect();
            writer.send(Message::Start(part.line, columns)).await;
        }
        part.describe(
            prepared
                .columns()
                .iter()
                .map(|column| (column.name(), column.type_().name())),
            budget,
        );
        tokio::pin!(stream);
        while let Some(row) = stream.try_next().await? {
            part.preview_row(budget, |index| {
                let value: Option<WireValue<'_>> = row.try_get(index)?;
                Ok(value.map_or_else(
                    || PreviewCell::text(None),
                    |value| value.preview(prepared.columns()[index].type_()),
                ))
            })?;
            if let Some(writer) = writer {
                writer.send(Message::Bound(row)).await;
            }
        }
        part.affected_rows = stream.rows_affected();
    } else {
        let stream = client.simple_query_raw(sql).await?;
        tokio::pin!(stream);
        let mut described = false;
        while let Some(message) = stream.try_next().await? {
            match message {
                SimpleQueryMessage::RowDescription(columns) => {
                    if let Some(writer) = writer {
                        let output = columns
                            .iter()
                            .enumerate()
                            .map(|(index, column)| Column {
                                name: column.name().into(),
                                data_type: prepared.columns().get(index).map_or_else(
                                    || "text".into(),
                                    |column| type_label(column.type_()),
                                ),
                            })
                            .collect();
                        writer.send(Message::Start(part.line, output)).await;
                        described = true;
                    }
                    part.describe(
                        columns.iter().enumerate().map(|(index, column)| {
                            let data_type = prepared
                                .columns()
                                .get(index)
                                .map_or("text", |column| column.type_().name());
                            (column.name(), data_type)
                        }),
                        budget,
                    );
                }
                SimpleQueryMessage::Row(row) => {
                    part.preview_row(budget, |index| row.try_get(index).map(PreviewCell::text))?;
                    if let Some(writer) = writer {
                        writer.send(Message::Text(row)).await;
                    }
                }
                SimpleQueryMessage::CommandComplete(rows) => part.affected_rows = Some(rows),
                _ => {}
            }
        }
        if let Some(writer) = writer.filter(|_| !described) {
            writer.send(Message::Start(part.line, Vec::new())).await;
        }
    }
    if let Some(writer) = writer {
        if !writer.end(part.affected_rows).await {
            return Err(Failure::Input(
                "결과 파일을 기록하는 중 오류가 발생해 이후 문장의 실행을 중단했습니다.",
            ));
        }
    }
    Ok(())
}

impl PartResult {
    fn describe<'a>(
        &mut self,
        columns: impl ExactSizeIterator<Item = (&'a str, &'a str)>,
        budget: &mut usize,
    ) {
        self.total_columns = columns.len();
        for (name, data_type) in columns.take(COLUMN_SIZE) {
            let size = name.len() + data_type.len() + 64;
            if size > *budget {
                break;
            }
            *budget -= size;
            self.columns.push(Column {
                name: name.into(),
                data_type: data_type.into(),
            });
        }
    }

    fn preview_row(
        &mut self,
        budget: &mut usize,
        mut cell: impl FnMut(usize) -> std::result::Result<PreviewCell, Error>,
    ) -> std::result::Result<(), Error> {
        if self.rows.len() == ROW_SIZE || self.more_rows || self.columns.is_empty() {
            self.more_rows = true;
            return Ok(());
        }
        let cells: Vec<_> = (0..self.columns.len())
            .map(&mut cell)
            .collect::<std::result::Result<_, _>>()?;
        let size = cells
            .iter()
            .map(|cell| 32 + cell.value.as_ref().map_or(0, String::len))
            .sum::<usize>();
        if size > *budget {
            self.more_rows = true;
        } else {
            *budget -= size;
            self.rows.push(cells);
        }
        Ok(())
    }
}

fn short_text(value: &str) -> String {
    value.chars().take(VALUE_LENGTH).collect()
}

pub(in crate::postgres) fn line_at(source: &str, offset: usize) -> u32 {
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
