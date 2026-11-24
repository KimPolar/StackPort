use super::session::{field, pg_error};
use crate::Result;
use serde::{Deserialize, Serialize};
use tokio_postgres::Client;

const PAGE_SIZE: usize = 50;
const BLOCKER_LIMIT: usize = 20;

#[derive(Deserialize)]
pub struct PostgresActivityInput {
    filter: ActivityFilter,
    slow_seconds: u32,
    page: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActivityFilter {
    All,
    Running,
    Blocked,
    Slow,
    IdleInTransaction,
}

#[derive(Serialize)]
pub struct PostgresActivitySnapshot {
    sampled_at_ms: i64,
    server_uptime_seconds: i64,
    database_backends: i32,
    max_connections: i32,
    commits: String,
    rollbacks: String,
    blocks_read: String,
    cache_hits: String,
    cache_hit_percent: Option<f64>,
    temp_bytes: String,
    deadlocks: String,
    stats_reset_ms: Option<i64>,
    track_counts: bool,
    sessions: Vec<ActivitySession>,
    has_next: bool,
}

#[derive(Serialize)]
struct ActivitySession {
    pid: i32,
    username: Option<String>,
    application: String,
    state: Option<String>,
    wait_type: Option<String>,
    wait_event: Option<String>,
    query_elapsed_ms: Option<i64>,
    transaction_elapsed_ms: Option<i64>,
    blocker_pids: Vec<i32>,
    more_blockers: bool,
    query: Option<String>,
    query_truncated: bool,
}

impl PostgresActivityInput {
    pub(super) fn validate(&self) -> Result<()> {
        if !(1..=3600).contains(&self.slow_seconds) {
            return Err("느린 쿼리 기준은 1초에서 3600초 사이로 입력하세요.".into());
        }
        Ok(())
    }
}

pub(super) async fn activity(
    client: &mut Client,
    input: PostgresActivityInput,
) -> Result<PostgresActivitySnapshot> {
    let tx = client
        .build_transaction()
        .read_only(true)
        .start()
        .await
        .map_err(pg_error)?;
    let totals = tx.query_one(
        "SELECT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint,
                EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - pg_catalog.pg_postmaster_start_time())::bigint,
                numbackends, pg_catalog.current_setting('max_connections')::int,
                xact_commit::text, xact_rollback::text, blks_read::text, blks_hit::text,
                100.0 * blks_hit::float8 / NULLIF(blks_hit::float8 + blks_read::float8, 0),
                temp_bytes::text, deadlocks::text, (EXTRACT(EPOCH FROM stats_reset) * 1000)::bigint,
                pg_catalog.current_setting('track_counts') = 'on'
         FROM pg_catalog.pg_stat_database WHERE datname = current_database()", &[],
    ).await.map_err(pg_error)?;
    let filter = match input.filter {
        ActivityFilter::All => "all",
        ActivityFilter::Running => "running",
        ActivityFilter::Blocked => "blocked",
        ActivityFilter::Slow => "slow",
        ActivityFilter::IdleInTransaction => "idle_in_transaction",
    };
    let slow_seconds = f64::from(input.slow_seconds);
    // PostgreSQL hides backend_type along with query and state for other roles.
    let rows = tx.query(
        "WITH sampled AS MATERIALIZED (
           SELECT pid, usename, COALESCE(application_name, '') AS application, state,
                  wait_event_type, wait_event, query_start, xact_start,
                  CASE WHEN state = 'active' THEN query END AS visible_query,
                  CASE WHEN wait_event_type = 'Lock' THEN 0 WHEN state = 'active' THEN 1 ELSE 2 END AS priority
           FROM pg_catalog.pg_stat_activity
           WHERE datname = current_database() AND (backend_type = 'client backend' OR backend_type IS NULL)
             AND pid <> pg_catalog.pg_backend_pid()
             AND CASE $1::text WHEN 'running' THEN state = 'active'
                  WHEN 'blocked' THEN wait_event_type = 'Lock'
                  WHEN 'slow' THEN state = 'active' AND query_start <= CURRENT_TIMESTAMP - pg_catalog.make_interval(secs => $2)
                  WHEN 'idle_in_transaction' THEN state IN ('idle in transaction', 'idle in transaction (aborted)')
                  ELSE true END
           ORDER BY priority, CASE WHEN state = 'active' THEN query_start END NULLS LAST, pid
           LIMIT $3 OFFSET $4
         )
         SELECT pid, usename::text, application, state, wait_event_type, wait_event,
                CASE WHEN state = 'active' AND query_start IS NOT NULL
                     THEN GREATEST((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - query_start) * 1000)::bigint, 0) END,
                CASE WHEN xact_start IS NOT NULL THEN GREATEST((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - xact_start) * 1000)::bigint, 0) END,
                CASE WHEN wait_event_type = 'Lock' THEN ARRAY(
                  SELECT DISTINCT blocker FROM pg_catalog.unnest(pg_catalog.pg_blocking_pids(pid)) AS blocking(blocker)
                  ORDER BY blocker LIMIT 21) ELSE ARRAY[]::int[] END,
                pg_catalog.left(visible_query, 2048), COALESCE(pg_catalog.length(visible_query) > 2048, false)
         FROM sampled ORDER BY priority, CASE WHEN state = 'active' THEN query_start END NULLS LAST, pid",
        &[&filter, &slow_seconds, &(PAGE_SIZE as i64 + 1), &(i64::from(input.page) * PAGE_SIZE as i64)],
    ).await.map_err(pg_error)?;
    tx.commit().await.map_err(pg_error)?;
    let sessions = rows
        .iter()
        .take(PAGE_SIZE)
        .map(|row| {
            let mut blocker_pids: Vec<i32> = field(row, 8)?;
            let more_blockers = blocker_pids.len() > BLOCKER_LIMIT;
            blocker_pids.truncate(BLOCKER_LIMIT);
            Ok(ActivitySession {
                pid: field(row, 0)?,
                username: field(row, 1)?,
                application: field(row, 2)?,
                state: field(row, 3)?,
                wait_type: field(row, 4)?,
                wait_event: field(row, 5)?,
                query_elapsed_ms: field(row, 6)?,
                transaction_elapsed_ms: field(row, 7)?,
                blocker_pids,
                more_blockers,
                query: field(row, 9)?,
                query_truncated: field(row, 10)?,
            })
        })
        .collect::<Result<_>>()?;
    Ok(PostgresActivitySnapshot {
        sampled_at_ms: field(&totals, 0)?,
        server_uptime_seconds: field(&totals, 1)?,
        database_backends: field(&totals, 2)?,
        max_connections: field(&totals, 3)?,
        commits: field(&totals, 4)?,
        rollbacks: field(&totals, 5)?,
        blocks_read: field(&totals, 6)?,
        cache_hits: field(&totals, 7)?,
        cache_hit_percent: field(&totals, 8)?,
        temp_bytes: field(&totals, 9)?,
        deadlocks: field(&totals, 10)?,
        stats_reset_ms: field(&totals, 11)?,
        track_counts: field(&totals, 12)?,
        sessions,
        has_next: rows.len() > PAGE_SIZE,
    })
}
