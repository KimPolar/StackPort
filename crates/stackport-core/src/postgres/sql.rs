use super::session::{preview_rows, Cell, COLUMN_SIZE, ROW_SIZE, VALUE_LENGTH};
use crate::Result;
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use serde::Serialize;
use std::{
    ops::Range,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{sync::watch, time::timeout};
use tokio_postgres::{error::ErrorPosition, CancelToken, Client, Error, Row, Transaction};
use uuid::Uuid;

const CANCEL_TIMEOUT: Duration = Duration::from_secs(3);

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
    Failed {
        error: String,
        position: Option<usize>,
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
}

pub(super) struct RunningSql {
    request: Uuid,
    cancel: watch::Sender<bool>,
}

pub(super) struct RunningSqlGuard<'a>(&'a Mutex<Option<RunningSql>>);

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
    ) -> Result<RunningSqlGuard<'_>> {
        let mut running = slot
            .lock()
            .map_err(|_| "SQL 실행 상태를 읽을 수 없습니다.")?;
        if running.is_some() {
            return Err("이 연결에서 PostgreSQL 쿼리가 실행 중입니다.".into());
        }
        *running = Some(Self { request, cancel });
        Ok(RunningSqlGuard(slot))
    }

    pub(super) fn cancel(slot: &Mutex<Option<Self>>, request: Uuid) -> Result<bool> {
        let running = slot
            .lock()
            .map_err(|_| "SQL 실행 상태를 읽을 수 없습니다.")?;
        Ok(running
            .as_ref()
            .filter(|run| run.request == request)
            .is_some_and(|run| run.cancel.send(true).is_ok()))
    }
}

pub(super) async fn query(
    client: &mut Client,
    source: &str,
    span: Range<usize>,
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
    let (state, sent_cancel, executed) =
        preview(&tx, source, span, &mut signal, cancel, tls, started).await;
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

async fn preview(
    tx: &Transaction<'_>,
    source: &str,
    span: Range<usize>,
    signal: &mut watch::Receiver<bool>,
    cancel: CancelToken,
    tls: TlsConnector,
    started: Instant,
) -> (Outcome, bool, bool) {
    if *signal.borrow() {
        return (cancelled(false), false, false);
    }
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
    if described.columns().is_empty() {
        return (
            message("PostgreSQL 읽기 전용 조회 문장을 입력하세요."),
            false,
            false,
        );
    }
    if !described.params().is_empty() {
        return (
            message("이 실행에서는 PostgreSQL 바인딩 변수를 사용할 수 없습니다."),
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
    let aliases: Vec<_> = (0..columns.len())
        .map(|column| format!("c{column}"))
        .collect();
    let projection = aliases
        .iter()
        .map(|alias| {
            format!(
                "pg_catalog.left(stackport_result.{alias}::pg_catalog.text, {})",
                VALUE_LENGTH + 1
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let bounded = format!(
        "SELECT {projection} FROM (\n{sql}\n) AS stackport_result({}) LIMIT {}",
        aliases.join(", "),
        ROW_SIZE + 1
    );
    let statement = match tx.prepare(&bounded).await {
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
    let mut running = std::pin::pin!(tx.query(&statement, &[]));
    let (result, sent_cancel) = tokio::select! {
        biased;
        result = &mut running => (result, false),
        _ = signal.changed() => {
            let _ = timeout(CANCEL_TIMEOUT, cancel.cancel_query(MakeTlsConnector::new(tls))).await;
            (running.await, true)
        }
    };
    let state = match result {
        Ok(rows) => completed(rows, columns, total_columns, started),
        Err(error) if sent_cancel && error.code().is_some_and(|code| code.code() == "57014") => {
            cancelled(true)
        }
        Err(error) => failed(error, None),
    };
    (state, sent_cancel, true)
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
