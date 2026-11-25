use super::{
    cell, require_identifier, Conn, Error, MysqlCell, MysqlManager, OptsBuilder, Queryable,
    Session, Value, CELL_BYTES, COLUMN_LIMIT, CONNECT, ROW_LIMIT,
};
use crate::Result;
use mysql_async::{consts::ColumnType, from_row_opt, Column, Params, Row, Statement};
use serde::{Deserialize, Serialize};
use std::{
    sync::{atomic::AtomicU64, Arc},
    time::{Duration, Instant},
};
use tokio::{sync::oneshot, time::timeout};
use uuid::Uuid;

const MAX_SQL: usize = 128 * 1024;
const MAX_PARAMETERS: usize = 64;
const PARAMETER_BYTES: usize = 64 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);
const STOPPED: &str = "MySQL 요청을 중단했습니다. 서버의 실행 중단 여부는 확인되지 않았습니다.";
const TIMED_OUT: &str =
    "MySQL 조회 시간이 초과되었습니다. 서버의 실행 중단 여부는 확인되지 않았습니다.";

#[derive(Clone, Copy, Default)]
pub(super) struct SqlMode {
    no_backslash: bool,
    ansi_quotes: bool,
}

impl SqlMode {
    pub(super) fn parse(mode: &str) -> Self {
        Self {
            no_backslash: mode
                .split(',')
                .any(|item| item.eq_ignore_ascii_case("NO_BACKSLASH_ESCAPES")),
            ansi_quotes: mode
                .split(',')
                .any(|item| item.eq_ignore_ascii_case("ANSI_QUOTES")),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MysqlSqlParameter {
    Text { value: String },
    Integer { value: String },
    Real { value: String },
    Null,
}

#[derive(Serialize)]
pub struct MysqlSqlResult {
    columns: Vec<SqlColumn>,
    rows: Vec<Vec<Option<MysqlCell>>>,
    more_rows: bool,
    more_columns: bool,
    elapsed_ms: u64,
}

#[derive(Serialize)]
struct SqlColumn {
    name: String,
    data_type: String,
}

pub(super) struct RunningSql {
    pub(super) id: Uuid,
    stop: Option<oneshot::Sender<()>>,
    pub(super) exported_rows: Option<Arc<AtomicU64>>,
}

pub(super) struct Request<'a> {
    session: &'a Session,
    id: Uuid,
}

impl<'a> Request<'a> {
    pub(super) fn claim(
        session: &'a Session,
        id: &str,
        exported_rows: Option<Arc<AtomicU64>>,
    ) -> Result<(Self, oneshot::Receiver<()>)> {
        let id = id.parse().map_err(|_| "MySQL 실행 ID를 확인하세요.")?;
        let (stop, stopped) = oneshot::channel();
        let mut slot = session
            .running_sql
            .lock()
            .map_err(|_| "MySQL 실행 상태를 읽을 수 없습니다.")?;
        if slot.is_some() {
            return Err("실행 중인 MySQL 요청이 있습니다.".into());
        }
        *slot = Some(RunningSql {
            id,
            stop: Some(stop),
            exported_rows,
        });
        Ok((Self { session, id }, stopped))
    }

    pub(super) fn begin_publication(&self) -> Result<bool> {
        let mut slot = self
            .session
            .running_sql
            .lock()
            .map_err(|_| "MySQL 실행 상태를 읽을 수 없습니다.")?;
        Ok(slot
            .as_mut()
            .filter(|active| active.id == self.id)
            .and_then(|active| active.stop.take())
            .is_some())
    }
}

impl Drop for Request<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.session.running_sql.lock() {
            if slot.as_ref().is_some_and(|other| other.id == self.id) {
                *slot = None;
            }
        }
    }
}

pub(super) fn stop_active(session: &Session, id: Option<Uuid>) -> Result<bool> {
    let mut slot = session
        .running_sql
        .lock()
        .map_err(|_| "MySQL 실행 상태를 읽을 수 없습니다.")?;
    let stop = slot
        .as_mut()
        .filter(|current| id.is_none_or(|id| current.id == id))
        .and_then(|current| current.stop.take());
    Ok(stop.is_some_and(|stop| stop.send(()).is_ok()))
}

impl MysqlManager {
    pub fn sql_parameters(&self, id: &str, sql: &str) -> Result<usize> {
        analyze(sql, self.session(id)?.sql_mode)
    }

    pub fn cancel_sql(&self, id: &str, request_id: &str) -> Result<bool> {
        let id_to_stop = request_id
            .parse()
            .map_err(|_| "MySQL 실행 ID를 확인하세요.")?;
        stop_active(&*self.session(id)?, Some(id_to_stop))
    }

    pub async fn run_sql(
        &self,
        id: &str,
        request_id: String,
        database: Option<String>,
        sql: String,
        parameters: Vec<MysqlSqlParameter>,
    ) -> Result<MysqlSqlResult> {
        let session = self.session(id)?;
        let values = validate_input(&session, database.as_deref(), &sql, parameters)?;
        let (_request, mut stopped) = Request::claim(&session, &request_id, None)?;
        self.session(id)?;
        let options = OptsBuilder::from_opts(session.options.clone()).db_name(database);
        let mut connection = tokio::select! {
            biased;
            _ = &mut stopped => return Err(STOPPED.into()),
            opened = open_request_connection(options) => opened?,
        };
        let outcome = tokio::select! {
            biased;
            _ = &mut stopped => Err(STOPPED.into()),
            read = timeout(QUERY_TIMEOUT, execute(&mut connection, &sql, values)) => {
                read.unwrap_or_else(|_| Err(TIMED_OUT.into()))
            }
        };
        let _ = timeout(Duration::from_millis(500), connection.disconnect()).await;
        outcome
    }
}

pub(super) async fn open_request_connection(options: OptsBuilder) -> Result<Conn> {
    timeout(CONNECT, Conn::new(options))
        .await
        .map_err(|_| "MySQL 연결 시간이 초과되었습니다.")?
        .map_err(sql_error)
}

pub(super) fn validate_input(
    session: &Session,
    database: Option<&str>,
    sql: &str,
    parameters: Vec<MysqlSqlParameter>,
) -> Result<Vec<Value>> {
    let count = analyze(sql, session.sql_mode)?;
    if let Some(database) = database {
        require_identifier(database)?;
    }
    if parameters.len() != count {
        return Err("MySQL 매개변수 개수가 문장과 일치하지 않습니다.".into());
    }
    bind(parameters)
}

fn bind(parameters: Vec<MysqlSqlParameter>) -> Result<Vec<Value>> {
    let size = parameters
        .iter()
        .map(|item| match item {
            MysqlSqlParameter::Text { value }
            | MysqlSqlParameter::Integer { value }
            | MysqlSqlParameter::Real { value } => value.len(),
            MysqlSqlParameter::Null => 0,
        })
        .sum::<usize>();
    if size > PARAMETER_BYTES {
        return Err("MySQL 매개변수는 합계 64 KiB 이하여야 합니다.".into());
    }
    parameters
        .into_iter()
        .map(|parameter| match parameter {
            MysqlSqlParameter::Text { value } => Ok(Value::Bytes(value.into_bytes())),
            MysqlSqlParameter::Integer { value } => value
                .parse::<i64>()
                .map(Value::Int)
                .or_else(|_| value.parse::<u64>().map(Value::UInt))
                .map_err(|_| "정수 매개변수는 64비트 범위로 입력하세요.".into()),
            MysqlSqlParameter::Real { value } => value
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .map(Value::Double)
                .ok_or_else(|| "실수 매개변수는 유한한 수로 입력하세요.".into()),
            MysqlSqlParameter::Null => Ok(Value::NULL),
        })
        .collect()
}

pub(super) async fn prepare_read_sql(
    connection: &mut Conn,
    sql: &str,
    count: usize,
) -> Result<Statement> {
    let row = connection
        .query_first::<Row, _>("SELECT @@SESSION.sql_mode")
        .await
        .map_err(sql_error)?
        .ok_or("MySQL SQL 모드를 읽을 수 없습니다.")?;
    let (mode,): (String,) = from_row_opt(row).map_err(|_| "MySQL SQL 모드를 읽을 수 없습니다.")?;
    if analyze(sql, SqlMode::parse(&mode))? != count {
        return Err("MySQL SQL 모드가 달라졌습니다. 문장과 매개변수를 다시 확인하세요.".into());
    }
    connection
        .query_drop("START TRANSACTION READ ONLY")
        .await
        .map_err(sql_error)?;
    let statement = connection.prep(sql).await.map_err(sql_error)?;
    if usize::from(statement.num_params()) != count {
        return Err("MySQL 서버가 확인한 매개변수 개수와 일치하지 않습니다.".into());
    }
    Ok(statement)
}

async fn execute(connection: &mut Conn, sql: &str, values: Vec<Value>) -> Result<MysqlSqlResult> {
    let statement = prepare_read_sql(connection, sql, values.len()).await?;
    let started = Instant::now();
    let mut result = connection
        .exec_iter(statement, Params::Positional(values))
        .await
        .map_err(sql_error)?;
    let metadata = result
        .columns()
        .ok_or("MySQL 서버에서 조회 열을 받지 못했습니다.")?;
    let columns = metadata
        .iter()
        .take(COLUMN_LIMIT)
        .map(|column| SqlColumn {
            name: column.name_str().chars().take(512).collect(),
            data_type: type_name(column),
        })
        .collect();
    let mut rows = Vec::new();
    let mut more_rows = false;
    while let Some(row) = result.next().await.map_err(sql_error)? {
        if rows.len() == ROW_LIMIT {
            more_rows = true;
            break;
        }
        rows.push(
            row.unwrap()
                .into_iter()
                .zip(metadata.iter())
                .take(COLUMN_LIMIT)
                .map(|(value, column)| sql_cell(value, column))
                .collect(),
        );
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if !more_rows {
        result.drop_result().await.map_err(sql_error)?;
        connection.query_drop("ROLLBACK").await.map_err(sql_error)?;
    }
    Ok(MysqlSqlResult {
        columns,
        rows,
        elapsed_ms,
        more_rows,
        more_columns: metadata.len() > COLUMN_LIMIT,
    })
}

fn sql_cell(value: Value, column: &Column) -> Option<MysqlCell> {
    let text = match result_value(value, column) {
        ResultValue::Null => return None,
        ResultValue::Bytes(bytes) => {
            return Some(cell(
                &bytes[..bytes.len().min(CELL_BYTES)],
                bytes.len() as u64,
                binary_column(column),
            ));
        }
        ResultValue::Text(text) => text,
    };
    let bytes = text.len() as u64;
    Some(MysqlCell {
        text,
        bytes,
        encoding: "utf8",
        truncated: false,
    })
}

pub(super) enum ResultValue {
    Null,
    Bytes(Vec<u8>),
    Text(String),
}

pub(super) fn type_name(column: &Column) -> String {
    format!("{:?}", column.column_type())
        .trim_start_matches("MYSQL_TYPE_")
        .into()
}

pub(super) fn binary_column(column: &Column) -> bool {
    column.character_set() == 63
        && matches!(
            column.column_type(),
            ColumnType::MYSQL_TYPE_STRING
                | ColumnType::MYSQL_TYPE_VAR_STRING
                | ColumnType::MYSQL_TYPE_VARCHAR
                | ColumnType::MYSQL_TYPE_BLOB
                | ColumnType::MYSQL_TYPE_TINY_BLOB
                | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
                | ColumnType::MYSQL_TYPE_LONG_BLOB
                | ColumnType::MYSQL_TYPE_BIT
                | ColumnType::MYSQL_TYPE_GEOMETRY
        )
}

pub(super) fn result_value(value: Value, column: &Column) -> ResultValue {
    let text = match value {
        Value::NULL => return ResultValue::Null,
        Value::Bytes(bytes) => return ResultValue::Bytes(bytes),
        Value::Int(value) => value.to_string(),
        Value::UInt(value) => value.to_string(),
        Value::Float(value) => value.to_string(),
        Value::Double(value) => value.to_string(),
        Value::Date(year, month, day, hour, minute, second, micro) => {
            let date = format!("{year:04}-{month:02}-{day:02}");
            if matches!(
                column.column_type(),
                ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE
            ) {
                date
            } else {
                format!("{date} {hour:02}:{minute:02}:{second:02}{}", micros(micro))
            }
        }
        Value::Time(negative, days, hour, minute, second, micro) => {
            let sign = if negative { "-" } else { "" };
            let hours = u64::from(days) * 24 + u64::from(hour);
            format!("{sign}{hours:02}:{minute:02}:{second:02}{}", micros(micro))
        }
    };
    ResultValue::Text(text)
}

fn micros(value: u32) -> String {
    if value == 0 {
        String::new()
    } else {
        format!(".{value:06}")
    }
}

pub(super) fn sql_error(error: Error) -> String {
    if let Error::Server(error) = &error {
        let message = match error.code {
            1064 => "SQL 구문을 확인하세요.",
            1054 => "열 이름이나 별칭을 확인하세요.",
            1146 => "테이블 또는 뷰를 찾을 수 없습니다.",
            1046 => "데이터베이스를 선택하세요.",
            1317 | 3024 => "서버에서 실행이 중단되었습니다.",
            _ => super::server_code_message(error.code),
        };
        return format!("MySQL 오류 {} · {message}", error.code);
    }
    super::server_message(&error).into()
}

fn analyze(sql: &str, mode: SqlMode) -> Result<usize> {
    const READ_ONLY: &str =
        "MySQL 읽기 전용 SQL은 SELECT, WITH의 SELECT, SHOW, DESCRIBE 또는 EXPLAIN으로 실행하세요.";
    if sql.len() > MAX_SQL || sql.contains('\0') {
        return Err("MySQL SQL은 NUL 문자 없이 128 KiB 이하로 입력하세요.".into());
    }
    let mut input = sql.as_bytes();
    let mut first: Option<&[u8]> = None;
    let mut previous: &[u8] = b"";
    let mut with_select = false;
    let mut depth = 0u32;
    let mut count = 0;
    let mut terminated = false;
    while let Some(&byte) = input.first() {
        if byte.is_ascii_whitespace() {
            input = &input[1..];
            continue;
        }
        if byte == b'#'
            || (input.starts_with(b"--")
                && input
                    .get(2)
                    .is_some_and(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control()))
        {
            let end = input
                .iter()
                .position(|byte| matches!(byte, b'\n' | b'\r'))
                .unwrap_or(input.len());
            input = &input[end..];
            continue;
        }
        if input.starts_with(b"/*") {
            if input.starts_with(b"/*!")
                || input.starts_with(b"/*M!")
                || input.starts_with(b"/*m!")
                || input.starts_with(b"/*+")
            {
                return Err(
                    "실행 주석과 옵티마이저 힌트는 MySQL 읽기 전용 편집기에서 사용할 수 없습니다."
                        .into(),
                );
            }
            let closed = input[2..]
                .windows(2)
                .position(|window| window == b"*/")
                .ok_or("SQL 블록 주석을 닫으세요.")?;
            if input[2..closed + 2]
                .windows(2)
                .any(|window| window == b"/*")
            {
                return Err("MySQL 읽기 전용 SQL에는 중첩 블록 주석을 사용할 수 없습니다.".into());
            }
            input = &input[closed + 4..];
            continue;
        }
        if terminated {
            return Err("MySQL SQL은 한 번에 한 문장만 실행하세요.".into());
        }
        if first.is_none() && !byte.is_ascii_alphabetic() {
            return Err(READ_ONLY.into());
        }
        match byte {
            b'\'' | b'"' | b'`' => {
                let escaped =
                    !mode.no_backslash && (byte == b'\'' || (byte == b'"' && !mode.ansi_quotes));
                input = after_quote(&input[1..], byte, escaped)?;
                previous = b"";
                continue;
            }
            b';' => terminated = true,
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            b'?' => count += 1,
            b':' if input.starts_with(b":=") => return Err(READ_ONLY.into()),
            byte if word_byte(byte) => {
                let end = input
                    .iter()
                    .position(|byte| !word_byte(*byte))
                    .unwrap_or(input.len());
                let word = &input[..end];
                let is = |other: &[u8]| word.eq_ignore_ascii_case(other);
                if first.is_none() {
                    if ![
                        b"SELECT".as_slice(),
                        b"WITH",
                        b"SHOW",
                        b"DESCRIBE",
                        b"DESC",
                        b"EXPLAIN",
                    ]
                    .iter()
                    .any(|other| is(other))
                    {
                        return Err(READ_ONLY.into());
                    }
                    first = Some(word);
                }
                let starts =
                    |other: &[u8]| first.is_some_and(|first| first.eq_ignore_ascii_case(other));
                if is(b"INTO")
                    || is(b"LOAD_FILE")
                    || is(b"GET_LOCK")
                    || is(b"RELEASE_LOCK")
                    || is(b"RELEASE_ALL_LOCKS")
                    || (previous.eq_ignore_ascii_case(b"FOR") && (is(b"UPDATE") || is(b"SHARE")))
                    || (previous.eq_ignore_ascii_case(b"LOCK") && is(b"IN"))
                    || (starts(b"EXPLAIN") && is(b"ANALYZE"))
                {
                    return Err(
                        "파일 입출력, 잠금 변경 또는 실제 실행 분석 명령은 사용할 수 없습니다."
                            .into(),
                    );
                }
                if starts(b"WITH") && depth == 0 {
                    if is(b"SELECT") {
                        with_select = true;
                    }
                    if [b"INSERT".as_slice(), b"UPDATE", b"DELETE", b"REPLACE"]
                        .iter()
                        .any(|other| is(other))
                    {
                        return Err(READ_ONLY.into());
                    }
                }
                previous = word;
                input = &input[end..];
                continue;
            }
            _ => {}
        }
        previous = b"";
        input = &input[1..];
    }
    if first.is_none() {
        return Err("실행할 MySQL SQL을 입력하세요.".into());
    }
    if first.is_some_and(|word| word.eq_ignore_ascii_case(b"WITH")) && !with_select {
        return Err(READ_ONLY.into());
    }
    if count > MAX_PARAMETERS {
        return Err("MySQL SQL에 매개변수는 최대 64개를 넣으세요.".into());
    }
    Ok(count)
}

fn word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$') || !byte.is_ascii()
}

fn after_quote(mut input: &[u8], quote: u8, escaped: bool) -> Result<&[u8]> {
    while let Some((&byte, rest)) = input.split_first() {
        input = rest;
        if byte == quote {
            if input.first() != Some(&quote) {
                return Ok(input);
            }
            input = &input[1..];
        } else if escaped && byte == b'\\' && !input.is_empty() {
            input = &input[1..];
        }
    }
    Err("SQL 문자열이나 식별자의 따옴표를 닫으세요.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_lexer_counts_actual_markers_including_server_sql_modes() {
        let normal = SqlMode::default();
        assert_eq!(
            analyze(
                "# ?\n WITH t AS (SELECT ';?' AS v) SELECT ?, `?` FROM t; -- ?",
                normal
            )
            .unwrap(),
            1
        );
        assert_eq!(
            analyze(r#"SELECT 'x\'?', "?", ?, 2--1"#, normal).unwrap(),
            1
        );
        let mode = SqlMode::parse("ANSI_QUOTES,NO_BACKSLASH_ESCAPES");
        assert_eq!(analyze(r#"SELECT 'x\', "a\""b?", ?"#, mode).unwrap(), 1);
    }

    #[test]
    fn rejects_non_read_or_executable_sql_and_multiple_statements() {
        for text in [
            "SELECT 1; SELECT 2",
            "/*! SELECT 1 */",
            "/*M! SELECT 1 */",
            "SELECT /*+ MAX_EXECUTION_TIME(0) */ 1",
            "SELECT 1 INTO @value",
            "SELECT GET_LOCK('x', 1)",
            "SELECT * FROM t FOR /* gap */ UPDATE",
            "SELECT * FROM t LOCK IN SHARE MODE",
            "EXPLAIN ANALYZE SELECT 1",
            "WITH t AS (SELECT 1) DELETE FROM x",
            "SELECT @val := 1",
            "SET sql_mode = ''",
        ] {
            assert!(analyze(text, SqlMode::default()).is_err(), "{text}");
        }
    }
}
