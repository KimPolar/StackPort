use super::{
    from_row_opt, query, read_message, sql::open_request_connection, Conn, Error, MysqlManager,
    OptsBuilder, Params, Queryable, ReadError, ReadResult, Row, Value, READ,
};
use crate::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::timeout;
use uuid::Uuid;

const PAGE_SIZE: usize = 50;
const QUERY_CHARS: usize = 2048;
const LOCK_PAIR_LIMIT: usize = 1000;
const BLOCKER_LIMIT: usize = 16;
const MONITOR_CLOSED: &str = "MySQL 모니터 연결이 닫혔습니다. 다시 연결하세요.";
const MONITOR_BUSY: &str = "앞선 MySQL 모니터 작업이 끝날 때까지 기다려 주세요.";
const WAIT_STATE: &str =
    "COALESCE(STATE LIKE 'Waiting for%lock%' OR STATE LIKE '%lock wait%' OR STATE = 'Locked', FALSE)";
const RUNNING: &str = "COMMAND NOT IN ('Sleep', 'Daemon') AND INFO IS NOT NULL";

pub(super) struct MonitorConnection {
    id: Uuid,
    connection: Conn,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MysqlActivityInput {
    filter: ActivityFilter,
    slow_seconds: u32,
    page: u32,
    #[serde(default)]
    include_sql: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActivityFilter {
    All,
    Running,
    Blocked,
    Slow,
}

#[derive(Serialize)]
pub struct MysqlActivitySnapshot {
    sampled_at_ms: u64,
    server: ServerInfo,
    counters: ServerCounters,
    lock_metadata: LockMetadata,
    lock_pairs_truncated: bool,
    sessions: Vec<ActivitySession>,
    has_next: bool,
}

#[derive(Serialize)]
struct ServerInfo {
    version: String,
    charset: String,
    time_zone: String,
    system_time_zone: String,
    default_engine: String,
    max_connections: String,
    slow_query_threshold: String,
    performance_schema: bool,
}

#[derive(Serialize)]
struct ServerCounters {
    uptime: Option<String>,
    connected: Option<String>,
    running: Option<String>,
    connections: Option<String>,
    aborted_connects: Option<String>,
    peak_connections: Option<String>,
    questions: Option<String>,
    slow_queries: Option<String>,
    bytes_received: Option<String>,
    bytes_sent: Option<String>,
    row_lock_waits: Option<String>,
    deadlocks: Option<String>,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum LockMetadata {
    Available,
    Restricted,
    Unavailable,
}

#[derive(Serialize)]
struct ActivitySession {
    id: String,
    username: String,
    database: Option<String>,
    command: String,
    state: Option<String>,
    state_seconds: i64,
    lock_wait: bool,
    blocker_ids: Vec<String>,
    more_blockers: bool,
    hidden_blocker: bool,
    sql: Option<String>,
    sql_truncated: bool,
}

#[derive(Default)]
struct Waiters {
    visible: BTreeSet<u64>,
    hidden: bool,
}

struct LockGraph {
    metadata: LockMetadata,
    waiters: BTreeMap<u64, Waiters>,
    truncated: bool,
}

impl MysqlManager {
    pub async fn open_server_monitor(&self, id: &str) -> Result<String> {
        let session = self.session(id)?;
        let mut slot = timeout(READ, session.monitor.lock())
            .await
            .map_err(|_| MONITOR_BUSY)?;
        let options = OptsBuilder::from_opts(session.options.clone()).db_name(None::<String>);
        let connection = open_request_connection(&session, options).await?;
        self.session(id)?;
        let monitor_id = Uuid::new_v4();
        *slot = Some(MonitorConnection {
            id: monitor_id,
            connection,
        });
        Ok(monitor_id.to_string())
    }

    pub async fn close_server_monitor(&self, id: &str, monitor_id: &str) -> Result<()> {
        let monitor_id = parse_monitor_id(monitor_id)?;
        let Ok(session) = self.session(id) else {
            return Ok(());
        };
        let mut slot = timeout(READ + Duration::from_secs(1), session.monitor.lock())
            .await
            .map_err(|_| MONITOR_BUSY)?;
        if slot
            .as_ref()
            .is_some_and(|monitor| monitor.id == monitor_id)
        {
            *slot = None;
        }
        Ok(())
    }

    pub async fn server_activity(
        &self,
        id: &str,
        monitor_id: &str,
        input: MysqlActivityInput,
    ) -> Result<MysqlActivitySnapshot> {
        if !(1..=3600).contains(&input.slow_seconds) {
            return Err("느린 실행 기준은 1~3,600초로 입력하세요.".into());
        }
        let monitor_id = parse_monitor_id(monitor_id)?;
        let session = self.session(id)?;
        let mut slot = timeout(READ, session.monitor.lock())
            .await
            .map_err(|_| MONITOR_BUSY)?;
        let monitor = slot
            .as_mut()
            .filter(|entry| entry.id == monitor_id)
            .ok_or(MONITOR_CLOSED)?;
        match timeout(
            READ,
            snapshot(&mut monitor.connection, session.engine, input),
        )
        .await
        {
            Ok(Ok(value)) => {
                self.session(id)?;
                Ok(value)
            }
            Ok(Err(error)) => {
                let message = read_message(&error);
                if matches!(&error, ReadError::Server(error) if error.is_fatal())
                    || matches!(error, ReadError::Shape)
                {
                    *slot = None;
                    Err(format!("{message} {MONITOR_CLOSED}"))
                } else {
                    Err(message.into())
                }
            }
            Err(_) => {
                *slot = None;
                Err(format!(
                    "MySQL 모니터의 조회 시간이 초과되었습니다. {MONITOR_CLOSED}"
                ))
            }
        }
    }
}

fn parse_monitor_id(value: &str) -> Result<Uuid> {
    value
        .parse()
        .map_err(|_| "MySQL 모니터 ID를 확인하세요.".into())
}

async fn snapshot(
    connection: &mut Conn,
    engine: &str,
    input: MysqlActivityInput,
) -> ReadResult<MysqlActivitySnapshot> {
    let server = server_info(connection).await?;
    let counters = server_counters(connection).await?;
    let locks = lock_graph(connection, engine, server.performance_schema).await?;
    let mut sessions = sessions(connection, &input, &locks).await?;
    let has_next = sessions.len() > PAGE_SIZE;
    sessions.truncate(PAGE_SIZE);
    let sampled_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(MysqlActivitySnapshot {
        sampled_at_ms,
        server,
        counters,
        lock_metadata: locks.metadata,
        lock_pairs_truncated: locks.truncated,
        sessions,
        has_next,
    })
}

async fn server_info(connection: &mut Conn) -> ReadResult<ServerInfo> {
    type Info = (String, String, String, String, String, String, String, bool);
    let row = connection.query_first::<Row, _>(
        "SELECT VERSION(), @@GLOBAL.character_set_server, @@GLOBAL.time_zone, @@GLOBAL.system_time_zone,
                @@GLOBAL.default_storage_engine, CAST(@@GLOBAL.max_connections AS CHAR),
                CAST(@@GLOBAL.long_query_time AS CHAR), CAST(@@GLOBAL.performance_schema AS UNSIGNED)",
    ).await?;
    let (
        version,
        charset,
        time_zone,
        system_time_zone,
        default_engine,
        max_connections,
        slow_query_threshold,
        performance_schema,
    ): Info = from_row_opt(row.ok_or(ReadError::Shape)?).map_err(|_| ReadError::Shape)?;
    Ok(ServerInfo {
        version,
        charset,
        time_zone,
        system_time_zone,
        default_engine,
        max_connections,
        slow_query_threshold,
        performance_schema,
    })
}

async fn server_counters(connection: &mut Conn) -> ReadResult<ServerCounters> {
    let rows = connection.query::<Row, _>(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Threads_running',
         'Connections', 'Aborted_connects', 'Max_used_connections', 'Questions', 'Slow_queries',
         'Bytes_received', 'Bytes_sent', 'Innodb_row_lock_current_waits', 'Innodb_deadlocks')",
    ).await?;
    let mut counters = HashMap::new();
    for row in rows {
        let (key, value): (String, String) = from_row_opt(row).map_err(|_| ReadError::Shape)?;
        counters.insert(key.to_ascii_lowercase(), value);
    }
    Ok(ServerCounters {
        uptime: counters.remove("uptime"),
        connected: counters.remove("threads_connected"),
        running: counters.remove("threads_running"),
        connections: counters.remove("connections"),
        aborted_connects: counters.remove("aborted_connects"),
        peak_connections: counters.remove("max_used_connections"),
        questions: counters.remove("questions"),
        slow_queries: counters.remove("slow_queries"),
        bytes_received: counters.remove("bytes_received"),
        bytes_sent: counters.remove("bytes_sent"),
        row_lock_waits: counters.remove("innodb_row_lock_current_waits"),
        deadlocks: counters.remove("innodb_deadlocks"),
    })
}

async fn lock_graph(
    connection: &mut Conn,
    engine: &str,
    performance_schema: bool,
) -> ReadResult<LockGraph> {
    // Both engines may show lock information to users whose processlist is restricted.
    // Recheck visibility for the waiting and blocking sessions before returning it.
    let source = if engine == "MariaDB" {
        "FROM information_schema.INNODB_LOCK_WAITS waits
         JOIN information_schema.INNODB_TRX requester ON requester.trx_id = waits.requesting_trx_id
         JOIN information_schema.INNODB_TRX holder ON holder.trx_id = waits.blocking_trx_id
         JOIN information_schema.PROCESSLIST waiting ON waiting.ID = requester.trx_mysql_thread_id
         LEFT JOIN information_schema.PROCESSLIST blocking ON blocking.ID = holder.trx_mysql_thread_id"
    } else if performance_schema {
        "FROM performance_schema.data_lock_waits waits
         JOIN performance_schema.threads requester ON requester.THREAD_ID = waits.REQUESTING_THREAD_ID
         LEFT JOIN performance_schema.threads holder ON holder.THREAD_ID = waits.BLOCKING_THREAD_ID
         JOIN information_schema.PROCESSLIST waiting ON waiting.ID = requester.PROCESSLIST_ID
         LEFT JOIN information_schema.PROCESSLIST blocking ON blocking.ID = holder.PROCESSLIST_ID"
    } else {
        return Ok(empty_locks(LockMetadata::Unavailable));
    };
    let sql = format!(
        "SELECT DISTINCT waiting.ID, blocking.ID {source}
         WHERE waiting.ID <> CONNECTION_ID() ORDER BY waiting.ID, blocking.ID LIMIT {}",
        LOCK_PAIR_LIMIT + 1
    );
    let rows = match connection.query::<Row, _>(sql).await {
        Ok(rows) => rows,
        Err(Error::Server(error)) if matches!(error.code, 1044 | 1142 | 1143 | 1227) => {
            return Ok(empty_locks(LockMetadata::Restricted));
        }
        Err(Error::Server(error)) if matches!(error.code, 1054 | 1109 | 1146 | 1289) => {
            return Ok(empty_locks(LockMetadata::Unavailable));
        }
        Err(error) => return Err(error.into()),
    };
    let mut graph = empty_locks(LockMetadata::Available);
    graph.truncated = rows.len() > LOCK_PAIR_LIMIT;
    for row in rows.into_iter().take(LOCK_PAIR_LIMIT) {
        let (waiter, blocker): (u64, Option<u64>) =
            from_row_opt(row).map_err(|_| ReadError::Shape)?;
        let waiters = graph.waiters.entry(waiter).or_default();
        if let Some(blocker) = blocker {
            waiters.visible.insert(blocker);
        } else {
            waiters.hidden = true;
        }
    }
    Ok(graph)
}

fn empty_locks(metadata: LockMetadata) -> LockGraph {
    LockGraph {
        metadata,
        waiters: BTreeMap::new(),
        truncated: false,
    }
}

async fn sessions(
    connection: &mut Conn,
    input: &MysqlActivityInput,
    locks: &LockGraph,
) -> ReadResult<Vec<ActivitySession>> {
    let mut params = Vec::new();
    let filter = match input.filter {
        ActivityFilter::All => "TRUE".into(),
        ActivityFilter::Running => RUNNING.into(),
        ActivityFilter::Slow => {
            params.push(Value::UInt(u64::from(input.slow_seconds)));
            format!("{RUNNING} AND TIME >= ?")
        }
        ActivityFilter::Blocked if locks.waiters.is_empty() => WAIT_STATE.into(),
        ActivityFilter::Blocked => {
            params.extend(locks.waiters.keys().map(|id| Value::UInt(*id)));
            let placeholders = vec!["?"; locks.waiters.len()].join(", ");
            format!("{WAIT_STATE} OR ID IN ({placeholders})")
        }
    };
    let (sql, truncated) = if input.include_sql {
        (
            format!("LEFT(INFO, {QUERY_CHARS})"),
            format!("COALESCE(CHAR_LENGTH(INFO) > {QUERY_CHARS}, FALSE)"),
        )
    } else {
        ("NULL".into(), "FALSE".into())
    };
    let text = format!(
        "SELECT ID, COALESCE(LEFT(USER, 128), ''), LEFT(DB, 128), COALESCE(LEFT(COMMAND, 64), ''), LEFT(STATE, 256),
                COALESCE(TIME, 0), {WAIT_STATE}, {sql}, {truncated}
         FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() AND ({filter})
         ORDER BY ID LIMIT {} OFFSET ?", PAGE_SIZE + 1
    );
    params.push(Value::UInt(u64::from(input.page) * PAGE_SIZE as u64));
    type Activity = (
        u64,
        String,
        Option<String>,
        String,
        Option<String>,
        i64,
        bool,
        Option<String>,
        bool,
    );
    let rows: Vec<Activity> = query(connection, &text, Params::Positional(params)).await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                username,
                database,
                command,
                state,
                state_seconds,
                state_wait,
                sql,
                sql_truncated,
            )| {
                let lock = locks.waiters.get(&id);
                ActivitySession {
                    id: id.to_string(),
                    username,
                    database,
                    command,
                    state,
                    state_seconds,
                    lock_wait: state_wait || lock.is_some(),
                    blocker_ids: lock
                        .into_iter()
                        .flat_map(|waiters| &waiters.visible)
                        .take(BLOCKER_LIMIT)
                        .map(u64::to_string)
                        .collect(),
                    more_blockers: lock
                        .is_some_and(|waiters| waiters.visible.len() > BLOCKER_LIMIT),
                    hidden_blocker: lock.is_some_and(|waiters| waiters.hidden),
                    sql,
                    sql_truncated,
                }
            },
        )
        .collect())
}
