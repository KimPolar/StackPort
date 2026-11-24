use super::{backup, PostgresPassword, PostgresProfileInput};
use crate::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub(super) const PREVIEW_TTL: Duration = Duration::from_secs(5 * 60);
const TOC_PREVIEW_BYTES: u64 = 24 * 1024;

#[derive(Clone, Serialize)]
pub struct PostgresRestorePreview {
    pub token: String,
    pub source: String,
    pub database: String,
    pub archive_database: String,
    pub source_version: String,
    pub dump_version: String,
    pub target_version: String,
    pub tool_version: String,
    pub entries: u64,
    pub toc: String,
    pub toc_truncated: bool,
    pub size_bytes: u64,
    pub sha256: String,
    pub expires_seconds: u64,
}

#[derive(Serialize)]
pub struct PostgresRestoreReport {
    pub database: String,
    pub sha256: String,
    pub tables: Option<i64>,
    pub audit_warning: bool,
}

pub(super) struct Plan {
    pub token: Uuid,
    pub preview: PostgresRestorePreview,
    pub expires: Instant,
    archive: File,
    tools: backup::Tools,
}

pub(super) fn preview(
    profile: &PostgresProfileInput,
    source: String,
    database: String,
    target_version: String,
    target_major: u32,
    check: impl Fn() -> Result<()>,
) -> Result<Plan> {
    let mut input = open_archive(&source)?;
    let tools = backup::tools_for(profile, target_major, &check)?;
    let mut archive = tempfile::tempfile().map_err(|_| "백업의 임시 사본을 만들 수 없습니다.")?;
    let mut hash = Sha256::new();
    let mut bytes = vec![0; 128 * 1024];
    let mut size_bytes = 0;
    loop {
        check()?;
        let count = input
            .read(&mut bytes)
            .map_err(|_| "백업 파일을 읽을 수 없습니다.")?;
        if count == 0 {
            break;
        }
        archive
            .write_all(&bytes[..count])
            .map_err(|_| "백업 임시 사본을 기록할 수 없습니다.")?;
        hash.update(&bytes[..count]);
        size_bytes += count as u64;
    }
    archive
        .seek(SeekFrom::Start(0))
        .map_err(|_| "백업 사본을 열 수 없습니다.")?;
    let (toc, toc_truncated) = archive_toc(&archive, &tools, &check)?;
    let header = |key: &str| {
        toc.lines()
            .map_while(|line| line.strip_prefix(';'))
            .find_map(|line| line.trim_start().strip_prefix(key).map(str::trim))
            .ok_or("백업 목차에서 출처와 버전을 확인할 수 없습니다.")
    };
    let archive_database = header("dbname:")?.to_owned();
    let source_version = header("Dumped from database version:")?.to_owned();
    let dump_version = header("Dumped by pg_dump version:")?.to_owned();
    let entries = header("TOC Entries:")?
        .parse()
        .map_err(|_| "백업 목차의 항목 수를 읽을 수 없습니다.")?;
    let required_major = major(&source_version)?.max(major(&dump_version)?);
    if target_major < required_major {
        return Err(format!(
            "이 백업에는 PostgreSQL {required_major} 이상의 복원 대상이 필요합니다."
        ));
    }
    let token = Uuid::new_v4();
    let tool_version = tools.version.clone();
    Ok(Plan {
        token,
        archive,
        tools,
        expires: Instant::now() + PREVIEW_TTL,
        preview: PostgresRestorePreview {
            token: token.to_string(),
            source,
            database,
            archive_database,
            source_version,
            dump_version,
            target_version,
            tool_version,
            entries,
            toc,
            toc_truncated,
            size_bytes,
            sha256: format!("{:x}", hash.finalize()),
            expires_seconds: PREVIEW_TTL.as_secs(),
        },
    })
}

fn open_archive(source: &str) -> Result<File> {
    let path = Path::new(source);
    if !path.is_absolute() || !path.is_file() {
        return Err("PostgreSQL 백업 파일의 절대 경로를 선택하세요.".into());
    }
    let mut file = File::open(path).map_err(|_| "백업 파일을 열 수 없습니다.")?;
    let mut magic = [0; 5];
    if !file.metadata().is_ok_and(|info| info.is_file())
        || file.read_exact(&mut magic).is_err()
        || &magic != b"PGDMP"
    {
        return Err("pg_dump의 커스텀 아카이브 파일을 선택하세요.".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "백업 파일을 읽을 수 없습니다.")?;
    Ok(file)
}

fn archive_toc(
    archive: &File,
    tools: &backup::Tools,
    check: &impl Fn() -> Result<()>,
) -> Result<(String, bool)> {
    let mut listing = tempfile::tempfile().map_err(|_| "백업 목차를 만들 수 없습니다.")?;
    let mut tool = backup::command(&tools.directory, "pg_restore.exe");
    tool.args(["--format=custom", "--list"])
        .stdin(Stdio::from(
            archive
                .try_clone()
                .map_err(|_| "백업 사본을 열 수 없습니다.")?,
        ))
        .stdout(Stdio::from(
            listing
                .try_clone()
                .map_err(|_| "백업 목차를 열 수 없습니다.")?,
        ));
    let child = backup::spawn(&mut tool, check);
    drop(tool);
    backup::finish(child?, check, "pg_restore가 백업 목차를 읽을 수 없습니다.")?;
    listing
        .seek(SeekFrom::Start(0))
        .map_err(|_| "백업 목차를 읽을 수 없습니다.")?;
    let mut bytes = Vec::new();
    listing
        .take(TOC_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "백업 목차를 읽을 수 없습니다.")?;
    let truncated = bytes.len() as u64 > TOC_PREVIEW_BYTES;
    bytes.truncate(TOC_PREVIEW_BYTES as usize);
    if truncated {
        bytes.truncate(bytes.iter().rposition(|byte| *byte == b'\n').unwrap_or(0));
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

fn major(version: &str) -> Result<u32> {
    version
        .split('.')
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or("PostgreSQL 아카이브 주 버전을 읽을 수 없습니다.".into())
}

pub(super) fn apply(
    mut plan: Plan,
    profile: &PostgresProfileInput,
    password: &PostgresPassword,
    staging_database: &str,
    tunnel_port: Option<u16>,
    check: impl Fn() -> Result<()>,
) -> Result<()> {
    plan.archive
        .seek(SeekFrom::Start(0))
        .map_err(|_| "확인한 백업 사본을 읽을 수 없습니다.")?;
    let mut tool = backup::command(&plan.tools.directory, "pg_restore.exe");
    let mut destination = profile.clone();
    destination.database = staging_database.to_owned();
    backup::configure_connection(
        &mut tool,
        &destination,
        password,
        tunnel_port,
        plan.tools.major,
    );
    tool.arg(format!("--dbname={staging_database}"))
        .env("PGAPPNAME", "StackPort Restore")
        .env(
            "PGOPTIONS",
            "-c default_transaction_read_only=off -c lock_timeout=5000",
        )
        .args([
            "--format=custom",
            "--single-transaction",
            "--no-password",
            "--no-owner",
            "--no-privileges",
            "--no-tablespaces",
        ])
        .stdin(Stdio::from(plan.archive));
    let child = backup::spawn(&mut tool, &check);
    drop(tool);
    backup::finish(
        child?,
        &check,
        "pg_restore가 복원에 실패했습니다. 스키마·확장·참조 객체와 역할 권한을 확인하세요.",
    )
}
