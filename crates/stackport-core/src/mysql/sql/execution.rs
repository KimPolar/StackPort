use super::{
    bind, open_request_connection, require_identifier, script, sql_cell, sql_error, type_name,
    Conn, Error, MysqlCell, MysqlManager, MysqlSqlParameter, OptsBuilder, Params, Queryable,
    Request, Row, Session, SqlColumn, SqlMode, COLUMN_LIMIT, ROW_LIMIT,
};
use crate::{insert_audit, AuditRecord, Result};
use mysql_async::{from_row_opt, prelude::Protocol, QueryResult};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::{sync::oneshot, task::spawn_blocking, time::timeout};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SCRIPT_TIMEOUT: Duration = Duration::from_secs(45);
const STOP_GRACE: Duration = Duration::from_secs(3);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const PREVIEW_BUDGET: usize = 1024 * 1024;
const MAX_RESULT_SETS: usize = 32;

#[derive(Deserialize)]
pub struct MysqlScriptInput {
    sql: String,
    scope: script::Scope,
    database: Option<String>,
    autocommit: bool,
    confirmation: String,
    #[serde(default)]
    parameters: Vec<MysqlSqlParameter>,
}

#[derive(Serialize)]
pub struct MysqlScriptOutcome {
    status: Status,
    statements: Vec<StatementResult>,
    elapsed_ms: u64,
    error: Option<ScriptError>,
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
    CleanupConfirmed,
    Unknown,
}

#[derive(Serialize)]
struct ScriptError {
    line: Option<u32>,
    code: Option<u16>,
    sql_state: Option<String>,
    message: String,
}

impl ScriptError {
    fn native(line: Option<u32>, error: Error) -> Self {
        let (code, sql_state) = match &error {
            Error::Server(details) => (Some(details.code), Some(details.state.clone())),
            _ => (None, None),
        };
        Self {
            line,
            code,
            sql_state,
            message: sql_error(error),
        }
    }

    fn input(line: Option<u32>, message: impl Into<String>) -> Self {
        Self {
            line,
            code: None,
            sql_state: None,
            message: message.into(),
        }
    }
}

#[derive(Serialize)]
struct StatementResult {
    line: u32,
    elapsed_ms: u64,
    sets: Vec<ScriptSet>,
    more_sets: bool,
}

#[derive(Serialize)]
struct ScriptSet {
    columns: Vec<SqlColumn>,
    rows: Vec<Vec<Option<MysqlCell>>>,
    more_rows: bool,
    more_columns: bool,
    affected_rows: Option<u64>,
    warnings: Option<u16>,
}

impl MysqlManager {
    pub fn script_parameters(&self, id: &str, sql: &str, scope: &script::Scope) -> Result<usize> {
        let parts = script::parts(sql, scope, self.session(id)?.sql_mode)?;
        Ok(script::parameter_count(&parts))
    }

    pub async fn run_script(
        &self,
        id: &str,
        request_id: &str,
        mut input: MysqlScriptInput,
    ) -> Result<MysqlScriptOutcome> {
        let session = self.session(id)?;
        if session.environment == "PROD" && input.confirmation != "PROD" {
            return Err("운영 환경에서 스크립트를 실행하려면 PROD를 입력하세요.".into());
        }
        if let Some(database) = &input.database {
            require_identifier(database)?;
        }
        let parts = script::parts(&input.sql, &input.scope, session.sql_mode)?;
        if script::parameter_count(&parts) != input.parameters.len() {
            return Err("실행 범위의 ? 개수와 입력한 값을 확인하세요.".into());
        }
        let values = bind(std::mem::take(&mut input.parameters))?;
        let (request, stopped) = Request::claim(&session, request_id, None)?;
        self.session(id)?;
        let started = Instant::now();
        let mut outcome = run(&session, &input, &parts, values, stopped).await;
        outcome.elapsed_ms = started.elapsed().as_millis() as u64;
        drop(request);
        let store = self.store.clone();
        let request_id = request_id.to_owned();
        let status = outcome.status;
        outcome.audit_warning = !spawn_blocking(move || {
            let db = store.connect()?;
            insert_audit(
                &db,
                AuditRecord {
                    correlation_id: &request_id,
                    operation: match status {
                        Status::Succeeded | Status::Failed => "mysql.sql.script",
                        Status::Cancelled => "mysql.sql.script.cancel",
                        Status::TimedOut => "mysql.sql.script.timeout",
                    },
                    project_id: Some(&session.project_id),
                    profile_id: Some(&session.profile_id),
                    environment: Some(&session.environment),
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
        .await
        .is_ok_and(|result| result.is_ok());
        Ok(outcome)
    }
}

async fn run(
    session: &Session,
    input: &MysqlScriptInput,
    parts: &[script::Part<'_>],
    values: Vec<super::Value>,
    mut stopped: oneshot::Receiver<()>,
) -> MysqlScriptOutcome {
    let mut outcome = MysqlScriptOutcome {
        status: Status::Succeeded,
        statements: Vec::new(),
        elapsed_ms: 0,
        error: None,
        server_interrupted: None,
        transaction: Transaction::NotStarted,
        audit_warning: false,
    };
    let options = OptsBuilder::from_opts(session.options.clone())
        .db_name(input.database.clone())
        .stmt_cache_size(0)
        .init(vec![super::super::UTF8_SESSION]);
    let mut connection = tokio::select! {
        biased;
        _ = &mut stopped => { outcome.status = Status::Cancelled; return outcome; }
        opened = open_request_connection(session, options) => match opened {
            Ok(connection) => connection,
            Err(message) => {
                outcome.status = Status::Failed;
                outcome.error = Some(ScriptError::input(None, message));
                return outcome;
            }
        }
    };
    let server_id = connection.id();
    let marker = format!("/* StackPort {} */", Uuid::new_v4());
    let stop = CancellationToken::new();
    let ready_for_cleanup = {
        let execution = execute(
            &mut connection,
            input,
            parts,
            values,
            &mut outcome.statements,
            &stop,
            &marker,
        );
        tokio::pin!(execution);
        let interrupted = tokio::select! {
            biased;
            result = &mut execution => {
                if let Err(error) = result {
                    outcome.status = match error.code { Some(1969 | 3024) => Status::TimedOut, Some(1317) => Status::Cancelled, _ => Status::Failed };
                    if matches!(error.code, Some(1317 | 1969 | 3024)) { outcome.server_interrupted = Some(true); }
                    outcome.error = Some(error);
                }
                None
            }
            _ = &mut stopped => Some(Status::Cancelled),
            _ = tokio::time::sleep(SCRIPT_TIMEOUT) => Some(Status::TimedOut),
        };
        if let Some(status) = interrupted {
            stop.cancel();
            let (_, result) = tokio::join!(
                timeout(STOP_GRACE, kill_query(session, server_id, &marker)),
                timeout(STOP_GRACE, &mut execution)
            );
            outcome.status = status;
            outcome.server_interrupted =
                Some(matches!(&result, Ok(Err(error)) if error.code == Some(1317)));
            result.is_ok()
        } else {
            true
        }
    };
    outcome.transaction = if ready_for_cleanup
        && timeout(
            CLEANUP_TIMEOUT,
            connection.query_drop("ROLLBACK AND NO CHAIN NO RELEASE"),
        )
        .await
        .is_ok_and(|result| result.is_ok())
    {
        Transaction::CleanupConfirmed
    } else {
        Transaction::Unknown
    };
    if ready_for_cleanup {
        let _ = timeout(CLEANUP_TIMEOUT, connection.disconnect()).await;
    }
    outcome
}

async fn kill_query(session: &Session, server_id: u32, marker: &str) -> Result<()> {
    let options = OptsBuilder::from_opts(session.options.clone()).db_name(None::<String>);
    let mut control = open_request_connection(session, options).await?;
    // A proxy can route the control connection to a different server with the same connection ID.
    let current: Option<u32> = control
        .exec_first(
            "SELECT ID FROM information_schema.PROCESSLIST WHERE ID = ? AND LOCATE(?, INFO) > 0",
            (server_id, marker),
        )
        .await
        .map_err(sql_error)?;
    if current != Some(server_id) {
        return Ok(());
    }
    control
        .query_drop(format!("KILL QUERY {server_id}"))
        .await
        .map_err(sql_error)
}

async fn execute(
    connection: &mut Conn,
    input: &MysqlScriptInput,
    parts: &[script::Part<'_>],
    values: Vec<super::Value>,
    results: &mut Vec<StatementResult>,
    stop: &CancellationToken,
    marker: &str,
) -> std::result::Result<(), ScriptError> {
    let row = connection
        .query_first::<Row, _>("SELECT @@SESSION.sql_mode")
        .await
        .map_err(|error| ScriptError::native(None, error))?
        .ok_or_else(|| ScriptError::input(None, "MySQL SQL 모드를 읽을 수 없습니다."))?;
    let (mode,): (String,) = from_row_opt(row)
        .map_err(|_| ScriptError::input(None, "MySQL SQL 모드를 읽을 수 없습니다."))?;
    if script::parts(&input.sql, &input.scope, SqlMode::parse(&mode)).as_deref() != Ok(parts) {
        return Err(ScriptError::input(
            None,
            "서버의 SQL 모드가 달라졌습니다. 연결을 갱신하고 문장을 다시 확인하세요.",
        ));
    }
    if stop.is_cancelled() {
        return Ok(());
    }
    connection
        .query_drop(if input.autocommit {
            "SET SESSION autocommit = 1"
        } else {
            "SET SESSION autocommit = 0"
        })
        .await
        .map_err(|error| ScriptError::native(None, error))?;
    let mut values = values.into_iter();
    let mut budget = PREVIEW_BUDGET;
    for part in parts {
        if stop.is_cancelled() {
            break;
        }
        let started = Instant::now();
        let mut result = StatementResult {
            line: part.line,
            elapsed_ms: 0,
            sets: Vec::new(),
            more_sets: false,
        };
        let bindings = values.by_ref().take(part.parameters).collect::<Vec<_>>();
        let query = format!("{marker}\n{}", part.sql);
        let executed =
            execute_part(connection, &query, bindings, &mut result, &mut budget, stop).await;
        result.elapsed_ms = started.elapsed().as_millis() as u64;
        if matches!(executed, Ok(true)) || !result.sets.is_empty() {
            results.push(result);
        }
        if !executed? {
            break;
        }
    }
    Ok(())
}

async fn execute_part(
    connection: &mut Conn,
    query: &str,
    bindings: Vec<super::Value>,
    result: &mut StatementResult,
    budget: &mut usize,
    stop: &CancellationToken,
) -> std::result::Result<bool, ScriptError> {
    let line = result.line;
    let native_error = |error| ScriptError::native(Some(line), error);
    match connection.prep(query).await {
        Ok(native) => {
            if usize::from(native.num_params()) != bindings.len() {
                return Err(ScriptError::input(
                    Some(line),
                    "서버가 확인한 매개변수 개수가 문장과 일치하지 않습니다.",
                ));
            }
            if stop.is_cancelled() {
                return Ok(false);
            }
            let stream = connection
                .exec_iter(&native, Params::Positional(bindings))
                .await
                .map_err(native_error)?;
            collect(stream, result, budget)
                .await
                .map_err(native_error)?;
            connection.close(native).await.map_err(native_error)?;
        }
        // Error 1295 follows a single-statement parse in prepare mode.
        Err(Error::Server(error)) if error.code == 1295 && bindings.is_empty() => {
            if stop.is_cancelled() {
                return Ok(false);
            }
            let stream = connection.query_iter(query).await.map_err(native_error)?;
            collect(stream, result, budget)
                .await
                .map_err(native_error)?;
        }
        Err(error) => return Err(native_error(error)),
    }
    Ok(true)
}

async fn collect<P: Protocol>(
    mut stream: QueryResult<'_, '_, P>,
    result: &mut StatementResult,
    budget: &mut usize,
) -> mysql_async::Result<()> {
    while let Some(metadata) = stream.columns() {
        if result.sets.len() == MAX_RESULT_SETS {
            result.more_sets = true;
            return stream.drop_result().await;
        }
        let mut set = ScriptSet {
            columns: metadata
                .iter()
                .take(COLUMN_LIMIT)
                .map(|column| SqlColumn {
                    name: column.name_str().chars().take(512).collect(),
                    data_type: type_name(column),
                })
                .collect(),
            rows: Vec::new(),
            more_rows: false,
            more_columns: metadata.len() > COLUMN_LIMIT,
            affected_rows: metadata.is_empty().then(|| stream.affected_rows()),
            warnings: metadata.is_empty().then(|| stream.warnings()),
        };
        let column_bytes: usize = set
            .columns
            .iter()
            .map(|column| 64 + column.name.len() + column.data_type.len())
            .sum();
        if column_bytes > *budget {
            result.more_sets = true;
            return stream.drop_result().await;
        }
        *budget -= column_bytes;
        let finished = loop {
            let row = match stream.next().await {
                Ok(Some(row)) => row,
                Ok(None) => break Ok(()),
                Err(error) => {
                    set.more_rows = true;
                    break Err(error);
                }
            };
            if set.rows.len() == ROW_LIMIT || set.more_rows || *budget == 0 {
                set.more_rows = true;
                continue;
            }
            let cells = row
                .unwrap()
                .into_iter()
                .zip(metadata.iter())
                .take(COLUMN_LIMIT)
                .map(|(value, column)| sql_cell(value, column))
                .collect::<Vec<_>>();
            let size = cells
                .iter()
                .map(|cell| 32 + cell.as_ref().map_or(0, |cell| cell.text.len()))
                .sum::<usize>();
            if size > *budget {
                set.more_rows = true;
            } else {
                *budget -= size;
                set.rows.push(cells);
            }
        };
        result.sets.push(set);
        finished?;
    }
    Ok(())
}
