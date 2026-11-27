use super::{checker, checker_at, rdb_result, read_rdb_version, RdbDetails, RedisBackupFileFormat, TIME_LIMIT};
use crate::{
    backup_artifact, insert_audit, local_file::NewFile,
    redis::{connector, establish, resp, verify_status, RedisAuthentication, RedisPassword, RedisProfile, CONNECT_TIMEOUT},
    AuditRecord, Result, Store,
};
use serde::{Deserialize, Serialize};
use std::{io::{Seek, SeekFrom}, path::Path, time::Instant};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    task::spawn_blocking,
    time::timeout,
};

const CANCELLED: &str = "Redis RDB 다운로드가 중단되었습니다.";
const TIMED_OUT: &str = "Redis RDB 다운로드 또는 검증 시간이 초과되었습니다.";
const FRAME: &str = "Redis RDB 복제 응답을 읽을 수 없습니다.";
const TRUNCATED: &str = "Redis RDB 수신이 완료되기 전에 연결이 끊겼습니다.";
const WRITE_FAILED: &str = "임시 RDB 파일을 기록할 수 없습니다. 저장 폴더의 여유 공간을 확인하세요.";
const CHUNK: usize = 128 * 1024;
const MARKER: usize = 40;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedisRdbDownloadInput {
    pub profile_id: String,
    pub revision: i64,
    pub destination: String,
    pub tools_directory: String,
    pub include_all_databases: bool,
    pub confirmation: String,
}

#[derive(Serialize)]
pub struct RedisRdbDownloadReport {
    destination: String,
    pub(crate) engine: &'static str,
    pub(crate) engine_version: String,
    checker_version: String,
    pub(crate) bytes: u64,
    sha256: String,
    rdb: RdbDetails,
    audit_warning: bool,
}

impl Store {
    pub async fn download_redis_rdb(
        &self,
        request: &str,
        input: RedisRdbDownloadInput,
        authentication: RedisAuthentication,
    ) -> Result<RedisRdbDownloadReport> {
        let guard = self.queries.claim(request)?;
        if !input.include_all_databases {
            return Err("Redis 서버의 모든 논리 DB를 백업한다는 점을 확인하세요.".into());
        }
        let store = self.clone();
        let (profile, password, staged, destination) = spawn_blocking(move || {
            let profile = store.redis_profile(&input.profile_id, input.revision)?;
            if profile.settings.environment == "PROD" && input.confirmation != "PROD" {
                return Err("운영 Redis 백업을 승인하려면 PROD를 입력하세요.".into());
            }
            let (password, _) = store.redis_password(&profile, authentication)?;
            let staged = NewFile::stage(&input.destination, Some("rdb"), ".stackport-redis-")?;
            Ok::<_, String>((profile, password, staged, input.destination.trim().to_owned()))
        }).await.map_err(|_| "Redis 백업 준비 작업을 확인할 수 없습니다.")??;
        let deadline = Instant::now() + TIME_LIMIT;
        let check = guard.cancellation_check();
        let transfer = async {
            download_snapshot(&profile, &password, &staged, destination, Path::new(input.tools_directory.trim()), move || {
                if check() { Err(CANCELLED.into()) }
                else if Instant::now() >= deadline { Err(TIMED_OUT.into()) }
                else { Ok(()) }
            }).await.map(|(report, _)| report)
        };
        let transferred = tokio::select! {
            biased;
            _ = guard.wait_cancelled() => Err(CANCELLED.into()),
            result = timeout(TIME_LIMIT, transfer) => result.map_err(|_| TIMED_OUT.to_owned()).and_then(|result| result),
        };
        let result = match transferred {
            Ok(report) => {
                let current = self.clone();
                let expected = profile.clone();
                if !guard.begin_export_publication() {
                    Err(CANCELLED.into())
                } else {
                    spawn_blocking(move || {
                        if current.redis_profile(&expected.id, expected.revision)? != expected {
                            return Err("Redis 연결 설정이 변경되었습니다. 백업을 다시 검토하세요.".into());
                        }
                        staged.publish()?;
                        Ok(report)
                    }).await.map_err(|_| "Redis 백업 파일의 저장 결과를 확인할 수 없습니다.")?
                }
            }
            Err(error) => Err(error),
        };
        let succeeded = result.is_ok();
        let store = self.clone();
        let request = request.to_owned();
        let audit = spawn_blocking(move || insert_audit(&store.connect()?, AuditRecord {
            correlation_id: &request,
            operation: "redis.backup.download",
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(&profile.settings.environment),
            object_name: None,
            outcome: if succeeded { "succeeded" } else { "failed" },
            affected_count: None,
        })).await;
        result.map(|mut report| {
            report.audit_warning = !matches!(audit, Ok(Ok(())));
            report
        })
    }
}

pub(crate) async fn download_snapshot(
    profile: &RedisProfile,
    password: &RedisPassword,
    staged: &NewFile,
    destination: String,
    tools: &Path,
    check: impl Fn() -> Result<()> + Send + 'static,
) -> Result<(RedisRdbDownloadReport, backup_artifact::Evidence)> {
    let (executable, checker_version) = checker_at(tools, RedisBackupFileFormat::Rdb).await?;
    let (engine, engine_version, mut wire) = replication_connection(profile, password).await?;
    wire.send(&[b"PSYNC", b"?", b"-1"]).await.map_err(|error| error.message())?;
    let mut reader = wire.into_reader();
    let mut output = tokio::fs::File::from_std(staged.writer()?);
    let bytes = receive_snapshot(&mut reader, &mut output).await?;
    drop(reader);
    output.sync_all().await.map_err(|_| WRITE_FAILED)?;
    drop(output);

    let path = staged.staging_path();
    let parent = path.parent().ok_or("임시 RDB 폴더를 찾을 수 없습니다.")?;
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("임시 RDB 이름을 읽을 수 없습니다.")?;
    let output = checker(&executable, Some(parent), &format!("./{name}")).await?;
    let mut file = staged.writer()?;
    let (version, evidence) = spawn_blocking(move || {
        file.seek(SeekFrom::Start(0)).map_err(|_| FRAME)?;
        let version = read_rdb_version(&mut file)?;
        let evidence = backup_artifact::measure(&file, check)?;
        Ok::<_, String>((version, evidence))
    }).await.map_err(|_| "Redis RDB의 SHA-256을 확인할 수 없습니다.")??;
    let rdb = rdb_result(version, bytes, &output.text)?;
    Ok((RedisRdbDownloadReport {
        destination, engine, engine_version, checker_version, bytes,
        sha256: evidence.sha256.clone(), rdb, audit_warning: false,
    }, evidence))
}

pub(in crate::redis) async fn replication_connection(
    profile: &RedisProfile,
    password: &RedisPassword,
) -> Result<(&'static str, String, resp::Wire)> {
    let mut settings = profile.settings.clone();
    settings.database = 0;
    timeout(CONNECT_TIMEOUT, async {
        let (engine, version, mut wire) = establish(&settings, connector(&settings)?, password).await?;
        verify_status(&mut wire, &[b"REPLCONF", b"capa", b"eof"], b"OK").await?;
        Ok((engine, version, wire))
    }).await.map_err(|_| "Redis 백업 연결 시간이 초과되었습니다.")?
}

async fn receive_snapshot(
    reader: &mut (impl AsyncBufRead + Unpin),
    output: &mut (impl AsyncWrite + Unpin),
) -> Result<u64> {
    if !replication_line(reader).await?.starts_with(b"+FULLRESYNC ") {
        return Err(FRAME.into());
    }
    let header = replication_line(reader).await?;
    if let Some(marker) = header.strip_prefix(b"$EOF:") {
        if marker.len() != MARKER || !marker.iter().all(u8::is_ascii_hexdigit) {
            return Err(FRAME.into());
        }
        return copy_to_marker(reader, output, marker).await;
    }
    let length: u64 = header.strip_prefix(b"$").and_then(|bytes| std::str::from_utf8(bytes).ok())
        .filter(|text| text.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|text| text.parse().ok()).filter(|&length| length >= 9).ok_or(FRAME)?;
    let bytes = tokio::io::copy(&mut reader.take(length), output)
        .await.map_err(|_| "Redis RDB를 수신하거나 기록할 수 없습니다.")?;
    if bytes != length { return Err(TRUNCATED.into()); }
    Ok(bytes)
}

async fn replication_line(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Vec<u8>> {
    loop {
        let mut line = Vec::new();
        if (&mut *reader).take(129).read_until(b'\n', &mut line).await.map_err(|_| TRUNCATED)? == 0 {
            return Err(TRUNCATED.into());
        }
        if line == b"\n" || line == b"\r\n" { continue; }
        if !line.ends_with(b"\r\n") { return Err(FRAME.into()); }
        line.truncate(line.len() - 2);
        if let Some(error) = line.strip_prefix(b"-") { return Err(resp::server_error(error).message().into()); }
        return Ok(line);
    }
}

async fn copy_to_marker(
    reader: &mut (impl AsyncBufRead + Unpin),
    output: &mut (impl AsyncWrite + Unpin),
    marker: &[u8],
) -> Result<u64> {
    let mut buffer = vec![0; CHUNK + MARKER - 1];
    let mut retained = 0;
    let mut written = 0_u64;
    loop {
        let read = reader.read(&mut buffer[retained..]).await.map_err(|_| TRUNCATED)?;
        if read == 0 { return Err(TRUNCATED.into()); }
        let end = retained + read;
        if let Some(index) = buffer[..end].windows(MARKER).position(|candidate| candidate == marker) {
            output.write_all(&buffer[..index]).await.map_err(|_| WRITE_FAILED)?;
            return written.checked_add(index as u64).ok_or_else(|| FRAME.into());
        }
        let flush = end.saturating_sub(MARKER - 1);
        output.write_all(&buffer[..flush]).await.map_err(|_| WRITE_FAILED)?;
        written = written.checked_add(flush as u64).ok_or(FRAME)?;
        buffer.copy_within(flush..end, 0);
        retained = end - flush;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &[u8] = b"+FULLRESYNC fixture 1\r\n";
    const END: &[u8] = b"abcdef0123456789abcdef0123456789abcdef01";

    async fn receive(parts: &[&[u8]]) -> (Result<u64>, Vec<u8>) {
        let stream = parts.concat();
        let (input, mut sender) = tokio::io::duplex(17);
        let writer = tokio::spawn(async move {
            let _ = sender.write_all(&stream).await;
        });
        let mut output = Vec::new();
        let mut input = tokio::io::BufReader::new(input);
        let result = receive_snapshot(&mut input, &mut output).await;
        drop(input);
        writer.await.unwrap();
        (result, output)
    }

    #[tokio::test]
    async fn receives_only_rdb_bytes_in_length_and_marker_frames() {
        let rdb = b"REDIS0012\xff\0\r\n";
        let length = format!("${}\r\n", rdb.len());
        let (result, actual) = receive(&[b"\n", FULL, b"\n", length.as_bytes(), rdb, b"*1\r\n"]).await;
        assert_eq!(result.unwrap(), rdb.len() as u64);
        assert_eq!(actual, rdb);

        let (result, actual) = receive(&[FULL, b"$EOF:", END, b"\r\n", rdb, END, b"*1\r\n"]).await;
        assert_eq!(result.unwrap(), rdb.len() as u64);
        assert_eq!(actual, rdb);
    }

    #[tokio::test]
    async fn rejects_missing_replication_bytes_or_end_marker() {
        for parts in [
            vec![FULL, b"$14\r\n", b"REDIS0012"],
            vec![FULL, b"$EOF:", END, b"\r\n", b"REDIS0012\xff"],
        ] {
            assert_eq!(receive(&parts).await.0.unwrap_err(), TRUNCATED);
        }
        assert_eq!(receive(&[b"-NOPERM scope\r\n"]).await.0.unwrap_err(), "현재 Redis 역할에 이 명령의 권한이 없습니다.");
    }
}
