use super::session::{field, pg_error};
use crate::{quote_identifier, Result};
use serde::{Deserialize, Serialize};
use tokio_postgres::{error::SqlState, Client};

const PAGE_SIZE: usize = 40;

#[derive(Deserialize)]
pub struct PostgresStatementStatsInput {
    order: StatementOrder,
    own_only: bool,
    minimum_ms: u32,
    page: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum StatementOrder {
    Mean,
    Maximum,
    Total,
    Calls,
}

impl StatementOrder {
    fn column(self) -> &'static str {
        match self {
            Self::Mean => "mean_exec_time",
            Self::Maximum => "max_exec_time",
            Self::Total => "total_exec_time",
            Self::Calls => "calls",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PostgresStatementStatsUnavailable {
    NotInstalled,
    NotLoaded,
    PermissionDenied,
    IncompatibleView,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PostgresStatementStats {
    Available {
        version: String,
        sampled_at_ms: i64,
        stats_reset_ms: Option<i64>,
        evictions: Option<String>,
        tracking: Option<String>,
        rows: Vec<PostgresStatementStatsRow>,
        has_next: bool,
    },
    Unavailable {
        reason: PostgresStatementStatsUnavailable,
    },
}

#[derive(Serialize)]
pub struct PostgresStatementStatsRow {
    username: Option<String>,
    query_id: Option<String>,
    query: Option<String>,
    query_truncated: bool,
    top_level: bool,
    calls: String,
    rows: String,
    mean_ms: f64,
    max_ms: f64,
    total_ms: f64,
    shared_hits: String,
    shared_reads: String,
    temp_reads: String,
    temp_writes: String,
}

pub(super) async fn stats(
    client: &Client,
    input: PostgresStatementStatsInput,
) -> Result<PostgresStatementStats> {
    use PostgresStatementStatsUnavailable as Unavailable;
    let extension = client.query_opt(
        "WITH extension AS (
           SELECT oid, extversion, extnamespace FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements'
         ), owned_views AS (
           SELECT c.oid, c.relname
           FROM extension e JOIN pg_catalog.pg_depend d ON d.refobjid = e.oid
           JOIN pg_catalog.pg_class c ON c.oid = d.objid AND c.relnamespace = e.extnamespace
           WHERE d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.classid = 'pg_catalog.pg_class'::regclass
             AND d.deptype = 'e' AND d.objsubid = 0 AND d.refobjsubid = 0 AND c.relkind = 'v'
         )
         SELECT n.nspname::text, e.extversion,
                EXISTS (SELECT FROM owned_views WHERE relname = 'pg_stat_statements'),
                EXISTS (SELECT FROM owned_views WHERE relname = 'pg_stat_statements_info'
                         AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND pg_catalog.has_table_privilege(oid, 'SELECT')),
                (EXTRACT(EPOCH FROM pg_catalog.statement_timestamp()) * 1000)::bigint,
                NULLIF(pg_catalog.current_setting('pg_stat_statements.track', true), '')
         FROM extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace", &[],
    ).await.map_err(pg_error)?;
    let Some(extension) = extension else {
        return Ok(PostgresStatementStats::Unavailable {
            reason: Unavailable::NotInstalled,
        });
    };
    if !field::<bool>(&extension, 2)? {
        return Ok(PostgresStatementStats::Unavailable {
            reason: Unavailable::IncompatibleView,
        });
    }

    // The catalog-provided schema is quoted, the order is fixed by the enum, and inputs are bound.
    let schema = quote_identifier(&field::<String>(&extension, 0)?);
    let order = input.order.column();
    let sql = format!(
        "SELECT roles.rolname::text, s.queryid::text,
                CASE WHEN s.queryid IS NOT NULL THEN pg_catalog.left(s.query, 2048) END,
                COALESCE(s.queryid IS NOT NULL AND pg_catalog.length(s.query) > 2048, false),
                s.toplevel, s.calls::text, s.rows::text, s.mean_exec_time, s.max_exec_time, s.total_exec_time,
                s.shared_blks_hit::text, s.shared_blks_read::text, s.temp_blks_read::text, s.temp_blks_written::text
         FROM {schema}.pg_stat_statements s LEFT JOIN pg_catalog.pg_roles roles ON roles.oid = s.userid
         WHERE s.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
           AND s.calls > 0 AND s.max_exec_time >= $1 AND (NOT $2 OR roles.rolname = current_user)
         ORDER BY s.{order} DESC, s.userid, s.queryid NULLS LAST, s.toplevel DESC,
                  s.calls DESC, s.total_exec_time DESC, s.mean_exec_time DESC, s.max_exec_time DESC, s.rows DESC,
                  s.shared_blks_hit DESC, s.shared_blks_read DESC, s.temp_blks_read DESC, s.temp_blks_written DESC
         LIMIT $3 OFFSET $4"
    );
    let result = client
        .query(
            &sql,
            &[
                &f64::from(input.minimum_ms),
                &input.own_only,
                &(PAGE_SIZE as i64 + 1),
                &(i64::from(input.page) * PAGE_SIZE as i64),
            ],
        )
        .await;
    let result = match result {
        Ok(rows) => rows,
        Err(error) => {
            let reason = match error.code() {
                Some(&SqlState::OBJECT_NOT_IN_PREREQUISITE_STATE) => Unavailable::NotLoaded,
                Some(&SqlState::INSUFFICIENT_PRIVILEGE) => Unavailable::PermissionDenied,
                Some(&SqlState::UNDEFINED_TABLE | &SqlState::UNDEFINED_COLUMN) => {
                    Unavailable::IncompatibleView
                }
                _ => return Err(pg_error(error)),
            };
            return Ok(PostgresStatementStats::Unavailable { reason });
        }
    };
    let metadata = if field(&extension, 3)? {
        let sql = format!("SELECT (EXTRACT(EPOCH FROM stats_reset) * 1000)::bigint, dealloc::text FROM {schema}.pg_stat_statements_info");
        match client.query_opt(&sql, &[]).await {
            Ok(row) => row,
            Err(error)
                if matches!(
                    error.code(),
                    Some(
                        &SqlState::INSUFFICIENT_PRIVILEGE
                            | &SqlState::UNDEFINED_TABLE
                            | &SqlState::UNDEFINED_COLUMN
                    )
                ) =>
            {
                None
            }
            Err(error) => return Err(pg_error(error)),
        }
    } else {
        None
    };
    let (stats_reset_ms, evictions) = match metadata {
        Some(row) => (field(&row, 0)?, field(&row, 1)?),
        None => (None, None),
    };
    let rows = result
        .iter()
        .take(PAGE_SIZE)
        .map(|row| {
            Ok(PostgresStatementStatsRow {
                username: field(row, 0)?,
                query_id: field(row, 1)?,
                query: field(row, 2)?,
                query_truncated: field(row, 3)?,
                top_level: field(row, 4)?,
                calls: field(row, 5)?,
                rows: field(row, 6)?,
                mean_ms: field(row, 7)?,
                max_ms: field(row, 8)?,
                total_ms: field(row, 9)?,
                shared_hits: field(row, 10)?,
                shared_reads: field(row, 11)?,
                temp_reads: field(row, 12)?,
                temp_writes: field(row, 13)?,
            })
        })
        .collect::<Result<_>>()?;
    Ok(PostgresStatementStats::Available {
        version: field(&extension, 1)?,
        sampled_at_ms: field(&extension, 4)?,
        tracking: field(&extension, 5)?,
        stats_reset_ms,
        evictions,
        rows,
        has_next: result.len() > PAGE_SIZE,
    })
}
