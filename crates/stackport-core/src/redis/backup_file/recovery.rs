use super::{local_process, CANCELLED};
use crate::{
    query::QueryGuard,
    redis::{
        info_field,
        monitor::{database_stats, DatabaseStats},
        resp::Wire,
    },
    Result,
};
use serde::Serialize;
use std::{
    net::Ipv4Addr,
    path::Path,
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncReadExt,
    net::{TcpListener, TcpStream},
    time::timeout,
};
use uuid::Uuid;
use zeroize::Zeroizing;

const FAILED: &str =
    "격리 Redis가 RDB를 열 수 없습니다. Redis 버전과 백업에 필요한 모듈을 확인하세요.";
const COUNTS: &str = "격리 Redis의 키 수를 검사한 RDB와 대조할 수 없습니다.";
const TIMED_OUT: &str = "격리 Redis 복원 검증 시간이 초과되었습니다.";

#[derive(Serialize)]
pub(super) struct RecoveryReport {
    server_version: String,
    loaded_keys: u64,
    expired_on_load: u64,
    live_keys: u64,
    databases: Vec<DatabaseStats>,
}

pub(super) async fn restore(
    tools: &Path,
    temporary: &Path,
    highest_database: u64,
    keys_in_rdb: u64,
    guard: &QueryGuard,
    deadline: Instant,
) -> Result<RecoveryReport> {
    let databases = i32::try_from(highest_database)
        .ok()
        .and_then(|id| id.checked_add(1))
        .ok_or("격리 Redis가 백업에 들어 있는 논리 DB 번호를 지원하지 않습니다.")?
        .max(16);
    let executable = tokio::fs::canonicalize(
        tools.join(format!("redis-server{}", std::env::consts::EXE_SUFFIX)),
    )
    .await
    .map_err(|_| "같은 도구 폴더에 redis-server를 지정하세요.")?;
    let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "격리 Redis에 사용할 로컬 포트를 예약할 수 없습니다.")?;
    let address = reservation
        .local_addr()
        .map_err(|_| "격리 Redis 주소를 확인할 수 없습니다.")?;
    let password = Zeroizing::new(format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    ));
    let config = Zeroizing::new(format!(concat!(
        "bind 127.0.0.1\nport {}\nprotected-mode yes\ndaemonize no\nlogfile \"\"\nloglevel notice\n",
        "dir .\npidfile ./restore.pid\ndbfilename backup.rdb\nsave \"\"\nappendonly no\ndatabases {}\n",
        "user default off\nuser stackport on >{} -@all +info\n"
    ), address.port(), databases, password.as_str()));
    tokio::fs::write(temporary.join("restore.conf"), config.as_bytes())
        .await
        .map_err(|_| "격리 Redis의 임시 설정을 기록할 수 없습니다.")?;
    drop(config);
    if guard.cancellation_check()() {
        return Err(CANCELLED.into());
    }
    if Instant::now() >= deadline {
        return Err(TIMED_OUT.into());
    }
    drop(reservation);
    let mut process = local_process(&executable, temporary, "./restore.conf")?;
    let mut stdout = process.child.stdout.take().ok_or(FAILED)?;
    let operation = async {
        ready(&mut stdout).await?;
        timeout(Duration::from_secs(12), async {
            let socket = TcpStream::connect(address).await.map_err(|_| FAILED)?;
            let mut wire = Wire::new(Box::new(socket));
            let auth = wire
                .command(&[b"AUTH", b"stackport", password.as_bytes()])
                .await
                .and_then(|reply| reply.bytes())
                .map_err(|_| FAILED)?;
            if auth != b"OK" {
                return Err(FAILED.into());
            }
            report(&mut wire, keys_in_rdb).await
        })
        .await
        .map_err(|_| TIMED_OUT.to_owned())?
    };
    let result = tokio::select! {
        biased;
        _ = guard.wait_cancelled() => Err(CANCELLED.into()),
        value = timeout(deadline.saturating_duration_since(Instant::now()), operation) =>
            value.map_err(|_| TIMED_OUT.to_owned()).and_then(|value| value),
    };
    if !process
        .child
        .try_wait()
        .is_ok_and(|status| status.is_some())
    {
        timeout(Duration::from_secs(5), process.child.kill())
            .await
            .ok()
            .and_then(std::result::Result::ok)
            .ok_or("격리 Redis를 종료할 수 없습니다.")?;
    }
    result
}

async fn ready(stdout: &mut tokio::process::ChildStdout) -> Result<()> {
    // Redis writes its ready message after binding listeners and loading persistence.
    let marker = b"Ready to accept connections";
    let mut retained = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let size = stdout.read(&mut buffer).await.map_err(|_| FAILED)?;
        if size == 0 {
            return Err(FAILED.into());
        }
        retained.extend_from_slice(&buffer[..size]);
        if retained.windows(marker.len()).any(|slice| slice == marker) {
            return Ok(());
        }
        let old = retained.len().saturating_sub(marker.len() - 1);
        retained.drain(..old);
    }
}

async fn read_info(wire: &mut Wire, section: &[u8]) -> Result<String> {
    let info = wire
        .command(&[b"INFO", section])
        .await
        .and_then(|reply| reply.bytes())
        .map_err(|_| FAILED)?;
    String::from_utf8(info).map_err(|_| FAILED.into())
}

async fn report(wire: &mut Wire, keys_in_rdb: u64) -> Result<RecoveryReport> {
    let server = read_info(wire, b"server").await?;
    let server_version = info_field(&server, "redis_version")
        .filter(|version| version.len() <= 48)
        .ok_or("격리 Redis의 서버 버전을 확인할 수 없습니다.")?
        .to_owned();
    let persistence = read_info(wire, b"persistence").await?;
    let count = |field| {
        info_field(&persistence, field)
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or("격리 복원 검증에는 RDB 로딩 키 수를 제공하는 Redis 7 이상이 필요합니다.")
    };
    let loaded_keys = count("rdb_last_load_keys_loaded")?;
    let expired_on_load = count("rdb_last_load_keys_expired")?;
    if loaded_keys.checked_add(expired_on_load) != Some(keys_in_rdb) {
        return Err(COUNTS.into());
    }

    let keyspace = read_info(wire, b"keyspace").await?;
    let mut databases: Vec<_> = keyspace
        .lines()
        .filter(|line| line.starts_with("db"))
        .map(|line| database_stats(line).ok_or(COUNTS))
        .collect::<std::result::Result<_, _>>()?;
    databases.sort_unstable_by_key(|stat| stat.database);
    let live_keys = databases
        .iter()
        .try_fold(0u64, |total, db| total.checked_add(db.keys))
        .ok_or(COUNTS)?;
    if live_keys > loaded_keys
        || databases
            .windows(2)
            .any(|pair| pair[0].database == pair[1].database)
        || databases
            .iter()
            .any(|db| db.expiring.is_none_or(|keys| keys > db.keys))
    {
        return Err(COUNTS.into());
    }
    Ok(RecoveryReport {
        server_version,
        loaded_keys,
        expired_on_load,
        live_keys,
        databases,
    })
}
