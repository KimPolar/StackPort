use super::{
    info_field,
    resp::{Failure, Reply, Wire},
};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

const KEYSPACE_LIMIT: usize = 256;

#[derive(Serialize)]
pub struct RedisServerSnapshot {
    sampled_at_seconds: u64,
    used_memory: Option<u64>,
    peak_memory: Option<u64>,
    max_memory: Option<u64>,
    connected_clients: Option<u64>,
    blocked_clients: Option<u64>,
    operations_per_second: Option<u64>,
    role: Option<&'static str>,
    connected_replicas: Option<u64>,
    upstream_link: Option<bool>,
    keyspace: Vec<DatabaseStats>,
    more_databases: bool,
    slow_log: SlowLog,
}

#[derive(Serialize)]
pub(super) struct DatabaseStats {
    pub(super) database: u32,
    pub(super) keys: u64,
    pub(super) expiring: Option<u64>,
    average_ttl_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum SlowLog {
    Available { entries: Vec<SlowEntry> },
    Unavailable { reason: &'static str },
}

#[derive(Serialize)]
struct SlowEntry {
    id: String,
    occurred_at_seconds: u64,
    duration_us: u64,
    command: Option<String>,
}

pub(super) async fn snapshot(wire: &mut Wire) -> Result<RedisServerSnapshot, Failure> {
    let info = wire.command(&[b"INFO"]).await?.bytes()?;
    let info = std::str::from_utf8(&info).map_err(|_| Failure::Protocol)?;
    let slow_log = match wire.command(&[b"SLOWLOG", b"GET", b"20"]).await {
        Ok(reply) => match reply
            .array()
            .and_then(|entries| entries.into_iter().take(20).map(slow_entry).collect())
        {
            Ok(entries) => SlowLog::Available { entries },
            Err(_) => SlowLog::Unavailable {
                reason: "이 서버의 슬로로그 응답을 읽을 수 없습니다.",
            },
        },
        Err(Failure::Server(reason)) => SlowLog::Unavailable { reason },
        Err(error) => return Err(error),
    };
    let stat = |name| info_field(info, name).and_then(|value| value.parse().ok());
    let mut keyspace = info
        .lines()
        .filter_map(database_stats)
        .take(KEYSPACE_LIMIT + 1)
        .collect::<Vec<_>>();
    let more_databases = keyspace.len() > KEYSPACE_LIMIT;
    keyspace.truncate(KEYSPACE_LIMIT);
    keyspace.sort_unstable_by_key(|item| item.database);
    Ok(RedisServerSnapshot {
        sampled_at_seconds: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        used_memory: stat("used_memory"),
        peak_memory: stat("used_memory_peak"),
        max_memory: stat("maxmemory"),
        connected_clients: stat("connected_clients"),
        blocked_clients: stat("blocked_clients"),
        operations_per_second: stat("instantaneous_ops_per_sec"),
        role: match info_field(info, "role") {
            Some("master") => Some("primary"),
            Some("slave" | "replica") => Some("replica"),
            _ => None,
        },
        connected_replicas: stat("connected_slaves"),
        upstream_link: match info_field(info, "master_link_status") {
            Some("up") => Some(true),
            Some("down") => Some(false),
            _ => None,
        },
        keyspace,
        more_databases,
        slow_log,
    })
}

pub(super) fn database_stats(line: &str) -> Option<DatabaseStats> {
    let (name, fields) = line.split_once(':')?;
    let database = name.strip_prefix("db")?.parse().ok()?;
    let stat = |name| {
        fields
            .split(',')
            .filter_map(|field| field.split_once('='))
            .find_map(|(key, value)| (key == name).then_some(value))?
            .parse()
            .ok()
    };
    Some(DatabaseStats {
        database,
        keys: stat("keys")?,
        expiring: stat("expires"),
        average_ttl_ms: stat("avg_ttl"),
    })
}

fn slow_entry(entry: Reply) -> Result<SlowEntry, Failure> {
    let mut fields = entry.array()?.into_iter();
    let id = fields
        .next()
        .ok_or(Failure::Protocol)?
        .integer()?
        .to_string();
    let occurred_at_seconds = u64::try_from(fields.next().ok_or(Failure::Protocol)?.integer()?)
        .map_err(|_| Failure::Protocol)?;
    let duration_us = u64::try_from(fields.next().ok_or(Failure::Protocol)?.integer()?)
        .map_err(|_| Failure::Protocol)?;
    let command = fields
        .next()
        .ok_or(Failure::Protocol)?
        .array()?
        .into_iter()
        .next()
        .and_then(|name| name.bytes().ok())
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 64
                && name
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
        .and_then(|name| String::from_utf8(name).ok())
        .map(|name| name.to_ascii_uppercase());
    Ok(SlowEntry {
        id,
        occurred_at_seconds,
        duration_us,
        command,
    })
}
