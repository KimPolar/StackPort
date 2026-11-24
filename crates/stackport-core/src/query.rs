//! Cancellable, bounded read-only SQLite queries.

use super::{
    db_error, display_value, open_schema_db, open_user_db, set_read_authorizer, QueryPage, Result,
    Store, TableQuery, PAGE_SIZE,
};
use rusqlite::{params_from_iter, types::Value, Connection, InterruptHandle};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
const PREPARE_LIFETIME: Duration = Duration::from_secs(60);
const MAX_PARAMETERS: usize = 32;
const MAX_PARAMETER_BYTES: usize = 16 * 1024;
const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const TIMED_OUT: u8 = 2;

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum QueryOutcome {
    Completed { result: QueryPage },
    ParametersRequired { parameters: Vec<SqlParameter> },
    Cancelled,
    TimedOut,
}

#[derive(Debug, Serialize)]
pub struct SqlParameter {
    pub index: usize,
    pub name: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SqlParameterValue {
    Null,
    Text(String),
    Integer(String),
    Real(String),
    Blob(String),
}

impl SqlParameterValue {
    fn sqlite_value(&self) -> Result<Value> {
        match self {
            Self::Null => Ok(Value::Null),
            Self::Text(text) if text.len() <= MAX_PARAMETER_BYTES => Ok(Value::Text(text.clone())),
            Self::Text(_) => Err("텍스트 값은 16 KiB까지 입력할 수 있습니다.".into()),
            Self::Integer(text) => text
                .trim()
                .parse::<i64>()
                .map(Value::Integer)
                .map_err(|_| "64비트 정수를 입력하세요.".into()),
            Self::Real(text) => text
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .map(Value::Real)
                .ok_or_else(|| "유한한 실수를 입력하세요.".into()),
            Self::Blob(text) => {
                let text = text.trim();
                if text.len() > MAX_PARAMETER_BYTES
                    || text.len() % 2 != 0
                    || !text.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err("BLOB은 최대 16 KiB의 짝수 자리 16진수로 입력하세요.".into());
                }
                let mut bytes = Vec::with_capacity(text.len() / 2);
                for index in (0..text.len()).step_by(2) {
                    let value = u8::from_str_radix(&text[index..index + 2], 16)
                        .map_err(|_| "BLOB에 16진수를 입력하세요.")?;
                    bytes.push(value);
                }
                Ok(Value::Blob(bytes))
            }
        }
    }
}

#[derive(Default)]
struct QueryControl {
    reason: AtomicU8,
    interrupt: Mutex<Option<InterruptHandle>>,
}

impl QueryControl {
    fn cancel(&self) -> Result<()> {
        // The first interruption wins, so a later cancel cannot disguise a timeout.
        let _ =
            self.reason
                .compare_exchange(RUNNING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst);
        if let Some(handle) = self
            .interrupt
            .lock()
            .map_err(|_| "쿼리 중단 상태를 사용할 수 없습니다.".to_string())?
            .as_ref()
        {
            handle.interrupt();
        }
        Ok(())
    }

    fn attach(&self, db: &Connection) -> std::result::Result<(), QueryFailure> {
        let mut handle = self
            .interrupt
            .lock()
            .map_err(|_| QueryFailure::Error("쿼리 중단 상태를 사용할 수 없습니다.".into()))?;
        self.check()?;
        *handle = Some(db.get_interrupt_handle());
        Ok(())
    }

    fn check(&self) -> std::result::Result<(), QueryFailure> {
        match self.reason.load(Ordering::SeqCst) {
            CANCELLED => Err(QueryFailure::Cancelled),
            TIMED_OUT => Err(QueryFailure::TimedOut),
            _ => Ok(()),
        }
    }

    fn sqlite_error(&self, error: rusqlite::Error) -> QueryFailure {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) {
            if let Err(reason) = self.check() {
                return reason;
            }
        }
        QueryFailure::Error(db_error(error))
    }
}

struct QueryEntry {
    control: Arc<QueryControl>,
    created: Instant,
    started: bool,
}

#[derive(Default)]
pub(crate) struct QueryManager {
    entries: Mutex<HashMap<String, QueryEntry>>,
}

struct QueryGuard {
    manager: Arc<QueryManager>,
    token: String,
    control: Arc<QueryControl>,
}

impl Drop for QueryGuard {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.manager.entries.lock() {
            entries.remove(&self.token);
        }
    }
}

impl QueryManager {
    fn prepare(&self) -> Result<String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "쿼리 상태를 사용할 수 없습니다.")?;
        // A window may close between preparation and execution. These entries
        // contain no SQL or results and are discarded on the next preparation.
        entries.retain(|_, entry| entry.started || entry.created.elapsed() < PREPARE_LIFETIME);
        let token = Uuid::new_v4().to_string();
        entries.insert(
            token.clone(),
            QueryEntry {
                control: Arc::new(QueryControl::default()),
                created: Instant::now(),
                started: false,
            },
        );
        Ok(token)
    }

    fn claim(self: &Arc<Self>, token: &str) -> Result<QueryGuard> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "쿼리 상태를 사용할 수 없습니다.")?;
        let entry = entries
            .get_mut(token)
            .ok_or("쿼리 요청이 없거나 만료되었습니다.")?;
        if entry.started {
            return Err("이미 실행 중인 쿼리 요청입니다.".into());
        }
        if entry.created.elapsed() >= PREPARE_LIFETIME {
            entries.remove(token);
            return Err("쿼리 요청이 만료되었습니다. 다시 실행하세요.".into());
        }
        entry.started = true;
        Ok(QueryGuard {
            manager: Arc::clone(self),
            token: token.to_owned(),
            control: Arc::clone(&entry.control),
        })
    }

    fn cancel(&self, token: &str) -> Result<bool> {
        let control = self
            .entries
            .lock()
            .map_err(|_| "쿼리 상태를 사용할 수 없습니다.")?
            .get(token)
            .map(|entry| Arc::clone(&entry.control));
        if let Some(control) = control {
            control.cancel()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

enum QueryFailure {
    Cancelled,
    TimedOut,
    ParametersRequired(Vec<SqlParameter>),
    Error(String),
}

enum QuerySource<'a> {
    Sql(&'a str, Option<&'a [SqlParameterValue]>),
    Object(&'a TableQuery),
}

impl Store {
    /// Prepare a one-use request before execution so cancellation cannot race
    /// ahead of registration. No SQL or database data is held by the manager.
    pub fn prepare_query(&self) -> Result<String> {
        self.queries.prepare()
    }

    /// Request cancellation; the eventual query outcome confirms whether the
    /// read was stopped or had already completed.
    pub fn cancel_query(&self, token: &str) -> Result<bool> {
        self.queries.cancel(token)
    }

    pub fn query_prepared(
        &self,
        token: &str,
        profile_id: &str,
        sql: &str,
        page: u32,
    ) -> Result<QueryOutcome> {
        self.query_prepared_with_parameters(token, profile_id, sql, page, None)
    }

    pub fn query_prepared_with_parameters(
        &self,
        token: &str,
        profile_id: &str,
        sql: &str,
        page: u32,
        parameters: Option<&[SqlParameterValue]>,
    ) -> Result<QueryOutcome> {
        self.execute_prepared(token, profile_id, QuerySource::Sql(sql, parameters), page)
    }

    pub fn query_object_prepared(
        &self,
        token: &str,
        profile_id: &str,
        request: &TableQuery,
        page: u32,
    ) -> Result<QueryOutcome> {
        self.execute_prepared(token, profile_id, QuerySource::Object(request), page)
    }

    fn execute_prepared(
        &self,
        token: &str,
        profile_id: &str,
        source: QuerySource<'_>,
        page: u32,
    ) -> Result<QueryOutcome> {
        let guard = self.queries.claim(token)?;
        match self.query_inner(profile_id, source, page, &guard.control, QUERY_TIMEOUT) {
            Ok(result) => Ok(QueryOutcome::Completed { result }),
            Err(QueryFailure::Cancelled) => Ok(QueryOutcome::Cancelled),
            Err(QueryFailure::TimedOut) => Ok(QueryOutcome::TimedOut),
            Err(QueryFailure::ParametersRequired(parameters)) => {
                Ok(QueryOutcome::ParametersRequired { parameters })
            }
            Err(QueryFailure::Error(error)) => Err(error),
        }
    }

    /// Read-only query helper for callers which do not need cancellation.
    pub fn query(&self, profile_id: &str, sql: &str, page: u32) -> Result<QueryPage> {
        match self.query_inner(
            profile_id,
            QuerySource::Sql(sql, None),
            page,
            &Arc::new(QueryControl::default()),
            QUERY_TIMEOUT,
        ) {
            Ok(result) => Ok(result),
            Err(QueryFailure::Cancelled) => Err("쿼리가 중단되었습니다.".into()),
            Err(QueryFailure::TimedOut) => Err("쿼리 실행 시간이 초과되어 중단되었습니다.".into()),
            Err(QueryFailure::ParametersRequired(_)) => {
                Err("쿼리 매개변수 값을 입력하세요.".into())
            }
            Err(QueryFailure::Error(error)) => Err(error),
        }
    }

    fn query_inner(
        &self,
        profile_id: &str,
        source: QuerySource<'_>,
        page: u32,
        control: &Arc<QueryControl>,
        timeout: Duration,
    ) -> std::result::Result<QueryPage, QueryFailure> {
        let started = Instant::now();
        control.check()?;
        let profile = self.profile(profile_id).map_err(QueryFailure::Error)?;
        control.check()?;
        let path = Path::new(&profile.path);
        let db = match source {
            QuerySource::Sql(_, _) => open_user_db(path),
            QuerySource::Object(_) => open_schema_db(path),
        }
        .map_err(QueryFailure::Error)?;
        control.attach(&db)?;
        let progress = Arc::clone(control);
        db.progress_handler(
            1_000,
            Some(move || {
                if progress.reason.load(Ordering::SeqCst) != RUNNING {
                    return true;
                }
                if started.elapsed() >= timeout {
                    let _ = progress.reason.compare_exchange(
                        RUNNING,
                        TIMED_OUT,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                    return true;
                }
                false
            }),
        );
        control.check()?;
        let offset = i64::from(page) * PAGE_SIZE as i64;
        let page_clause = format!("LIMIT {} OFFSET {offset}", PAGE_SIZE + 1);
        let (bounded_sql, values, show_sql) = match source {
            QuerySource::Sql(sql, parameters) => {
                let sql = sql.trim().trim_end_matches(';').trim_end();
                if sql.is_empty() {
                    return Err(QueryFailure::Error("조회할 SQL을 입력하세요.".into()));
                }
                // Prepare before pagination to retain the authorizer's useful errors.
                let original = db.prepare(sql).map_err(|e| control.sqlite_error(e))?;
                if !original.readonly() || original.column_count() == 0 {
                    return Err(QueryFailure::Error(
                        "이 연결에서는 결과를 반환하는 읽기 전용 쿼리만 실행할 수 있습니다.".into(),
                    ));
                }
                let count = original.parameter_count();
                if count > MAX_PARAMETERS {
                    return Err(QueryFailure::Error(
                        "쿼리 매개변수는 최대 32개까지 사용할 수 있습니다.".into(),
                    ));
                }
                control.check()?;
                let values = match parameters {
                    None if count > 0 => {
                        let slots = (1..=count)
                            .map(|index| SqlParameter {
                                index,
                                name: original.parameter_name(index).map(str::to_owned),
                            })
                            .collect();
                        return Err(QueryFailure::ParametersRequired(slots));
                    }
                    Some(values) if values.len() == count => values
                        .iter()
                        .enumerate()
                        .map(|(index, value)| {
                            value.sqlite_value().map_err(|reason| {
                                QueryFailure::Error(format!("매개변수 {}: {reason}", index + 1))
                            })
                        })
                        .collect::<std::result::Result<_, _>>()?,
                    Some(_) => {
                        return Err(QueryFailure::Error(
                            "쿼리의 매개변수 개수와 입력 값 개수가 다릅니다.".into(),
                        ))
                    }
                    None => Vec::new(),
                };
                (
                    format!("SELECT * FROM (\n{sql}\n) {page_clause}"),
                    values,
                    false,
                )
            }
            QuerySource::Object(request) => {
                let generated = request.sql(&db);
                control.check()?;
                let (sql, values) = generated.map_err(QueryFailure::Error)?;
                // Schema PRAGMAs are only needed for the fixed metadata queries.
                set_read_authorizer(&db, false);
                (format!("{sql}\n{page_clause}"), values, true)
            }
        };
        control.check()?;
        let mut stmt = db
            .prepare(&bounded_sql)
            .map_err(|e| control.sqlite_error(e))?;
        if !stmt.readonly() {
            return Err(QueryFailure::Error(
                "이 연결에서는 읽기 전용 쿼리만 실행할 수 있습니다.".into(),
            ));
        }
        if stmt.parameter_count() != values.len() {
            return Err(QueryFailure::Error(
                "페이지를 구성하는 동안 쿼리 매개변수가 변경되었습니다.".into(),
            ));
        }
        let columns = stmt
            .column_names()
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let mut cursor = stmt
            .query(params_from_iter(&values))
            .map_err(|e| control.sqlite_error(e))?;
        let mut rows = Vec::with_capacity(PAGE_SIZE + 1);
        while let Some(row) = cursor.next().map_err(|e| control.sqlite_error(e))? {
            control.check()?;
            let mut cells = Vec::with_capacity(row.as_ref().column_count());
            for index in 0..row.as_ref().column_count() {
                cells.push(display_value(
                    row.get_ref(index).map_err(|e| control.sqlite_error(e))?,
                ));
            }
            rows.push(cells);
        }
        control.check()?;
        let has_more = rows.len() > PAGE_SIZE;
        if has_more {
            rows.pop();
        }
        Ok(QueryPage {
            columns,
            rows,
            page,
            has_more,
            generated_sql: show_sql.then_some(bounded_sql),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_deadline_interrupts_a_running_statement() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.sqlite");
        Connection::open(&source)
            .unwrap()
            .execute("CREATE TABLE data (id INTEGER)", [])
            .unwrap();
        let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
        let project = store.create_project("test").unwrap();
        let profile = store
            .create_sqlite_profile(&project.id, "test", source.to_str().unwrap(), "DEV")
            .unwrap();
        let control = Arc::new(QueryControl::default());
        let result = store.query_inner(
            &profile.id,
            QuerySource::Sql("WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT sum(n) FROM numbers", None),
            0,
            &control,
            Duration::from_millis(5),
        );
        assert!(matches!(result, Err(QueryFailure::TimedOut)));
        assert!(matches!(control.check(), Err(QueryFailure::TimedOut)));
        control.cancel().unwrap();
        assert!(matches!(control.check(), Err(QueryFailure::TimedOut)));
    }

    #[test]
    fn a_running_request_cannot_be_claimed_twice() {
        let manager = Arc::new(QueryManager::default());
        let token = manager.prepare().unwrap();
        let guard = manager.claim(&token).unwrap();
        assert!(manager.claim(&token).is_err());
        drop(guard);
        assert!(!manager.cancel(&token).unwrap());
    }
}
