use super::export::{self, PostgresExportOptions, StreamError};
use super::parameters::{metadata, Parameter, PostgresSqlBindings, Value, MAX_PARAMETERS};
use super::plan::{self, Plan};
use super::session::{preview_rows, Cell, COLUMN_SIZE, ROW_SIZE, VALUE_LENGTH};
use super::{PostgresProfile, PostgresSqlScope};
use crate::{
    insert_audit,
    result_export::{ExportReport, ReadyExport},
    AuditRecord, Result, Store,
};
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    ops::Range,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{sync::watch, time::timeout};
use tokio_postgres::{
    error::ErrorPosition, types::Type, CancelToken, Client, Error, Row, Transaction,
};
use uuid::Uuid;

pub(super) mod script;

const CANCEL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PostgresSqlMode {
    #[default]
    Query,
    Estimate,
    Analyze,
}

pub struct PostgresSqlInput {
    pub source: String,
    pub scope: PostgresSqlScope,
    pub mode: PostgresSqlMode,
    pub bindings: Option<PostgresSqlBindings>,
    pub export: Option<PostgresExportOptions>,
}

#[derive(Serialize)]
pub struct PostgresSqlOutcome {
    #[serde(flatten)]
    state: Outcome,
    connection_closed: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Outcome {
    Completed {
        columns: Vec<Column>,
        rows: Vec<Vec<Cell>>,
        more_rows: bool,
        total_columns: usize,
        elapsed_ms: u64,
    },
    Plan {
        plan: Plan,
    },
    Exported {
        report: ExportReport,
    },
    #[serde(skip)]
    ReadyToExport {
        file: ReadyExport,
        rows: u64,
    },
    Failed {
        error: String,
        position: Option<usize>,
    },
    ParametersRequired {
        parameters: Vec<Parameter>,
        error: Option<String>,
    },
    Interrupted {
        timed_out: bool,
        server_confirmed: bool,
    },
}

#[derive(Serialize)]
struct Column {
    name: String,
    data_type: String,
}

impl PostgresSqlOutcome {
    pub(super) fn interrupted(
        timed_out: bool,
        server_confirmed: bool,
        connection_closed: bool,
    ) -> Self {
        Self {
            state: Outcome::Interrupted {
                timed_out,
                server_confirmed,
            },
            connection_closed,
        }
    }

    pub(super) async fn publish(
        mut self,
        guard: &RunningSqlGuard<'_>,
        store: &Store,
        profile: &PostgresProfile,
        request: Uuid,
    ) -> Self {
        if let Outcome::ReadyToExport { file, rows } = self.state {
            self.state = if self.connection_closed {
                message("PostgreSQL 세션을 정리하지 못해 파일 저장을 완료할 수 없습니다.")
            } else if !guard.begin_publication() {
                cancelled(false)
            } else {
                let store = store.clone();
                let profile = profile.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let mut report = file.publish(rows)?;
                    let request = request.to_string();
                    let audit = AuditRecord {
                        correlation_id: &request,
                        operation: if report.format == "CSV" {
                            "postgres.export.csv"
                        } else {
                            "postgres.export.json"
                        },
                        project_id: Some(&profile.project_id),
                        profile_id: Some(&profile.id),
                        environment: Some(&profile.settings.environment),
                        object_name: None,
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
                    Ok::<_, String>(report)
                })
                .await;
                match result {
                    Ok(Ok(report)) => Outcome::Exported { report },
                    Ok(Err(error)) => message(&error),
                    Err(_) => message("PostgreSQL 내보내기 파일을 저장할 수 없습니다."),
                }
            };
        }
        self
    }
}

pub(super) struct RunningSql {
    request: Uuid,
    cancel: watch::Sender<bool>,
    progress: Option<Arc<AtomicU64>>,
    publishing: bool,
}

pub(super) struct RunningSqlGuard<'a>(&'a Mutex<Option<RunningSql>>);

impl RunningSqlGuard<'_> {
    fn begin_publication(&self) -> bool {
        if let Ok(mut running) = self.0.lock() {
            if let Some(run) = running.as_mut().filter(|run| !*run.cancel.borrow()) {
                run.publishing = true;
                return true;
            }
        }
        false
    }
}

impl Drop for RunningSqlGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }
}

impl RunningSql {
    pub(super) fn register(
        slot: &Mutex<Option<Self>>,
        request: Uuid,
        cancel: watch::Sender<bool>,
        progress: Option<Arc<AtomicU64>>,
    ) -> Result<RunningSqlGuard<'_>> {
        let mut running = slot
            .lock()
            .map_err(|_| "SQL 실행 상태를 읽을 수 없습니다.")?;
        if running.is_some() {
            return Err("이 연결에서 PostgreSQL 쿼리가 실행 중입니다.".into());
        }
        *running = Some(Self {
            request,
            cancel,
            progress,
            publishing: false,
        });
        Ok(RunningSqlGuard(slot))
    }

    pub(super) fn cancel(slot: &Mutex<Option<Self>>, request: Uuid) -> Result<bool> {
        let running = slot
            .lock()
            .map_err(|_| "SQL 실행 상태를 읽을 수 없습니다.")?;
        Ok(running
            .as_ref()
            .filter(|run| run.request == request && !run.publishing)
            .is_some_and(|run| !run.cancel.send_replace(true)))
    }

    pub(super) fn export_progress(
        slot: &Mutex<Option<Self>>,
        request: Uuid,
    ) -> Result<Option<u64>> {
        let running = slot
            .lock()
            .map_err(|_| "내보내기 진행률을 읽을 수 없습니다.")?;
        Ok(running
            .as_ref()
            .filter(|run| run.request == request)
            .and_then(|run| run.progress.as_ref())
            .map(|progress| progress.load(Ordering::Relaxed)))
    }

    pub(super) fn stop_session(slot: &Mutex<Option<Self>>) {
        if let Ok(running) = slot.lock() {
            if let Some(run) = running.as_ref().filter(|run| !run.publishing) {
                run.cancel.send_replace(true);
            }
        }
    }
}

pub(super) async fn query(
    client: &mut Client,
    request: Request<'_>,
    mut signal: watch::Receiver<bool>,
    tls: TlsConnector,
) -> (PostgresSqlOutcome, bool) {
    let started = Instant::now();
    let cancel = client.cancel_token();
    let tx = match client.build_transaction().read_only(true).start().await {
        Ok(tx) => tx,
        Err(error) => {
            let outcome = PostgresSqlOutcome {
                state: failed(error, None),
                connection_closed: false,
            };
            return (outcome, true);
        }
    };
    if request.export.is_some() {
        if let Err(error) = tx
            .batch_execute("SET LOCAL statement_timeout = '300s'")
            .await
        {
            let reusable = tx.rollback().await.is_ok();
            return (
                PostgresSqlOutcome {
                    state: failed(error, None),
                    connection_closed: !reusable,
                },
                reusable,
            );
        }
    }
    let (state, sent_cancel, executed) =
        preview(&tx, request, &mut signal, cancel, tls, started).await;
    // Roll back even after a successful SELECT. Session-level effects such as
    // advisory locks and LISTEN registrations are cleared before reusing the client.
    let reusable = !sent_cancel
        || matches!(
            state,
            Outcome::Interrupted {
                server_confirmed: true,
                ..
            }
        );
    let reusable = reusable
        && tx.rollback().await.is_ok()
        && (!executed || client.batch_execute("DISCARD ALL").await.is_ok());
    (
        PostgresSqlOutcome {
            state,
            connection_closed: !reusable,
        },
        reusable,
    )
}

pub(super) struct Request<'a> {
    pub source: &'a str,
    pub span: Range<usize>,
    pub bindings: Option<&'a PostgresSqlBindings>,
    pub mode: PostgresSqlMode,
    pub export: Option<ExportRequest<'a>>,
}

pub(super) struct ExportRequest<'a> {
    pub options: &'a PostgresExportOptions,
    pub progress: Arc<AtomicU64>,
}

async fn preview(
    tx: &Transaction<'_>,
    request: Request<'_>,
    signal: &mut watch::Receiver<bool>,
    cancel: CancelToken,
    tls: TlsConnector,
    started: Instant,
) -> (Outcome, bool, bool) {
    if *signal.borrow() {
        return (cancelled(false), false, false);
    }
    let Request {
        source,
        span,
        bindings,
        mode,
        export,
    } = request;
    let sql = &source[span.clone()];
    // The server parses the original single statement before it can be embedded
    // in a SELECT expression. The extended protocol rejects stacked statements.
    let described = match tx.prepare(sql).await {
        Ok(statement) => statement,
        Err(error) => {
            return (
                failed(error, Some((&source[..span.start], sql))),
                false,
                false,
            )
        }
    };
    if mode == PostgresSqlMode::Query && export.is_none() && described.columns().is_empty() {
        return (
            message("PostgreSQL 읽기 전용 조회 문장을 입력하세요."),
            false,
            false,
        );
    }
    let types = described.params();
    if types.len() > MAX_PARAMETERS {
        return (
            message("PostgreSQL 쿼리의 매개변수는 32개까지 사용할 수 있습니다."),
            false,
            false,
        );
    }
    let total_columns = described.columns().len();
    let columns: Vec<_> = described
        .columns()
        .iter()
        .take(COLUMN_SIZE)
        .map(|column| Column {
            name: column.name().into(),
            data_type: column.type_().name().into(),
        })
        .collect();
    // Parse as a subquery before allowing EXPLAIN of the original statement.
    // This rejects utility statements and data-modifying CTEs for either mode.
    let read_sql = if export.is_some() {
        text_projection(sql, total_columns, false)
    } else if mode == PostgresSqlMode::Query {
        text_projection(sql, columns.len(), true)
    } else {
        format!("SELECT 1 FROM (\n{sql}\n) AS stackport_source LIMIT 0")
    };
    let prepared = match tx.prepare_typed(&read_sql, types).await {
        Ok(statement) => statement,
        Err(error) => {
            let state = if matches!(
                error.code().map(|code| code.code()),
                Some("42601" | "0A000")
            ) {
                message("PostgreSQL 읽기 전용 조회로 실행할 수 없는 문장입니다.")
            } else {
                failed(error, None)
            };
            return (state, false, false);
        }
    };
    if *signal.borrow() {
        return (cancelled(false), false, false);
    }
    let values = match values_for(bindings, types) {
        Ok(values) => values,
        Err(state) => return (state, false, false),
    };
    let statement = match mode {
        PostgresSqlMode::Query => prepared,
        PostgresSqlMode::Estimate | PostgresSqlMode::Analyze => {
            let analyze = if mode == PostgresSqlMode::Analyze {
                "ANALYZE TRUE, BUFFERS TRUE, "
            } else {
                ""
            };
            let explain =
                format!("EXPLAIN ({analyze}FORMAT JSON, VERBOSE TRUE, SUMMARY TRUE)\n{sql}");
            match tx.prepare_typed(&explain, types).await {
                Ok(statement) => statement,
                Err(error) => return (failed(error, None), false, false),
            }
        }
    };
    if *signal.borrow() {
        return (cancelled(false), false, false);
    }
    if statement.params() != types {
        return (
            message("PostgreSQL 매개변수 형식을 확인할 수 없습니다."),
            false,
            false,
        );
    }
    if let Some(export) = export {
        let writer = match export::Writer::open(
            export.options,
            export::columns(&described),
            export.progress,
        )
        .await
        {
            Ok(writer) => writer,
            Err(error) => return (message(&error), false, false),
        };
        if *signal.borrow() {
            let _ = writer.finish(false).await;
            return (cancelled(false), false, false);
        }
        let (result, sent_cancel) = await_query(
            writer.stream(tx, &statement, values, signal.clone()),
            signal,
            cancel,
            tls,
        )
        .await;
        let ready = writer
            .finish(matches!(result, Ok(true)) && !*signal.borrow())
            .await;
        let state = match result {
            Ok(_) => match ready {
                Ok(Some((file, rows))) => Outcome::ReadyToExport { file, rows },
                Ok(None) => cancelled(false),
                Err(error) => message(&error),
            },
            Err(StreamError::WriterClosed) => {
                let error = ready
                    .err()
                    .unwrap_or_else(|| "PostgreSQL 내보내기 파일을 기록할 수 없습니다.".into());
                return (message(&error), true, true);
            }
            Err(StreamError::Query(error) | StreamError::Bind(error))
                if sent_cancel && error.code().is_some_and(|code| code.code() == "57014") =>
            {
                cancelled(true)
            }
            Err(StreamError::Bind(error)) => binding_failed(error, types),
            Err(StreamError::Query(error)) => failed(error, None),
        };
        return (state, sent_cancel, true);
    }
    let cancellation = signal.clone();
    let running = async {
        if values.is_empty() {
            return tx
                .query(&statement, &[])
                .await
                .map(Some)
                .map_err(|error| (error, false));
        }
        let portal = tx
            .bind_raw(&statement, values.iter())
            .await
            .map_err(|error| (error, true))?;
        if *cancellation.borrow() {
            return Ok(None);
        }
        tx.query_portal(&portal, (ROW_SIZE + 1) as i32)
            .await
            .map(Some)
            .map_err(|error| (error, false))
    };
    let (result, sent_cancel) = await_query(running, signal, cancel, tls).await;
    let state = match result {
        Ok(Some(rows)) if mode == PostgresSqlMode::Query => {
            completed(rows, columns, total_columns, started)
        }
        Ok(Some(rows)) => match plan::read(&rows, mode == PostgresSqlMode::Analyze) {
            Ok(plan) => Outcome::Plan { plan },
            Err(error) => Outcome::Failed {
                error,
                position: None,
            },
        },
        Ok(None) => cancelled(false),
        Err((error, _))
            if sent_cancel && error.code().is_some_and(|code| code.code() == "57014") =>
        {
            cancelled(true)
        }
        Err((error, true)) => binding_failed(error, types),
        Err((error, _)) => failed(error, None),
    };
    (state, sent_cancel, true)
}

async fn await_query<F: Future>(
    running: F,
    signal: &mut watch::Receiver<bool>,
    cancel: CancelToken,
    tls: TlsConnector,
) -> (F::Output, bool) {
    let mut running = std::pin::pin!(running);
    tokio::select! {
        biased;
        result = &mut running => (result, false),
        _ = signal.changed() => {
            let _ = timeout(CANCEL_TIMEOUT, cancel.cancel_query(MakeTlsConnector::new(tls))).await;
            (running.await, true)
        }
    }
}

fn binding_failed(error: Error, types: &[Type]) -> Outcome {
    if let Some(code) = error
        .code()
        .map(|code| code.code())
        .filter(|code| code.starts_with("22") || code.starts_with("23"))
    {
        parameters_required(types, Some(format!(
            "PostgreSQL이 매개변수 값을 받는 단계에서 오류를 반환했습니다. 표시된 타입과 값을 확인하세요. (SQLSTATE {code})"
        )))
    } else {
        failed(error, None)
    }
}

fn text_projection(sql: &str, columns: usize, preview: bool) -> String {
    if columns == 0 {
        return format!("SELECT NULL::pg_catalog.text FROM (\n{sql}\n) AS stackport_result");
    }
    let aliases: Vec<_> = (0..columns).map(|column| format!("c{column}")).collect();
    let projection = aliases
        .iter()
        .map(|alias| {
            let field = format!("stackport_result.{alias}::pg_catalog.text");
            if preview {
                format!("pg_catalog.left({field}, {})", VALUE_LENGTH + 1)
            } else {
                field
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let limit = if preview {
        format!(" LIMIT {}", ROW_SIZE + 1)
    } else {
        String::new()
    };
    format!(
        "SELECT {projection} FROM (\n{sql}\n) AS stackport_result({}){limit}",
        aliases.join(", ")
    )
}

fn values_for<'a>(
    bindings: Option<&'a PostgresSqlBindings>,
    types: &[Type],
) -> std::result::Result<&'a [Value], Outcome> {
    match bindings {
        Some(bindings) if bindings.matches(types) => Ok(&bindings.values),
        Some(_) if types.is_empty() => Err(message("이 SQL에는 바인딩할 매개변수가 없습니다.")),
        Some(_) => Err(parameters_required(
            types,
            Some("서버가 확인한 매개변수 타입이 달라졌습니다. 값을 다시 확인하세요.".into()),
        )),
        None if types.is_empty() => Ok(&[]),
        None => Err(parameters_required(types, None)),
    }
}

fn parameters_required(types: &[Type], error: Option<String>) -> Outcome {
    Outcome::ParametersRequired {
        parameters: metadata(types),
        error,
    }
}

fn completed(
    rows: Vec<Row>,
    columns: Vec<Column>,
    total_columns: usize,
    started: Instant,
) -> Outcome {
    match preview_rows(&rows, columns.len()) {
        Ok(preview) => Outcome::Completed {
            columns,
            rows: preview,
            more_rows: rows.len() > ROW_SIZE,
            total_columns,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        Err(error) => Outcome::Failed {
            error,
            position: None,
        },
    }
}

fn cancelled(server_confirmed: bool) -> Outcome {
    Outcome::Interrupted {
        timed_out: false,
        server_confirmed,
    }
}

fn message(error: &str) -> Outcome {
    Outcome::Failed {
        error: error.into(),
        position: None,
    }
}

fn failed(error: Error, submitted: Option<(&str, &str)>) -> Outcome {
    let code = error.code().map(|code| code.code());
    if code == Some("57014") {
        return Outcome::Interrupted {
            timed_out: true,
            server_confirmed: true,
        };
    }
    let position = submitted.and_then(|(prefix, sql)| {
        let ErrorPosition::Original(position) = error.as_db_error()?.position()? else {
            return None;
        };
        let offset: usize = sql
            .chars()
            .take(position.saturating_sub(1) as usize)
            .map(char::len_utf16)
            .sum();
        Some(prefix.encode_utf16().count() + offset)
    });
    let description = match code {
        Some("42601") => "PostgreSQL SQL 구문을 확인하세요.",
        Some("42501") => "PostgreSQL이 조회 권한을 거부했습니다.",
        Some("42P01") => "테이블 또는 뷰를 찾을 수 없습니다. 스키마와 객체 이름을 확인하세요.",
        Some("42703") => "열 이름을 찾을 수 없습니다.",
        Some("42P08" | "42P18") => {
            "PostgreSQL 매개변수 타입을 추론할 수 없습니다. 매개변수에 타입 캐스트를 지정하세요."
        }
        Some("25006") => "PostgreSQL 읽기 전용 트랜잭션에서 허용되지 않는 작업입니다.",
        Some("55P03") => "PostgreSQL 잠금 대기 제한을 초과했습니다.",
        _ => "PostgreSQL 쿼리를 실행할 수 없습니다.",
    };
    let error = code.map_or_else(
        || description.to_owned(),
        |code| format!("{description} (SQLSTATE {code})"),
    );
    Outcome::Failed { error, position }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_publication_and_cancellation_have_a_single_winner() {
        let slot = Mutex::default();
        let request = Uuid::new_v4();
        let (cancel, signal) = watch::channel(false);
        let guard = RunningSql::register(&slot, request, cancel, None).unwrap();
        drop(signal);
        assert!(RunningSql::cancel(&slot, request).unwrap());
        assert!(!guard.begin_publication());
        drop(guard);

        let (cancel, signal) = watch::channel(false);
        let guard = RunningSql::register(&slot, request, cancel, None).unwrap();
        assert!(guard.begin_publication());
        assert!(!RunningSql::cancel(&slot, request).unwrap());
        RunningSql::stop_session(&slot);
        assert!(!*signal.borrow());
    }
}
