use super::{PostgresPassword, PostgresProfileInput};
use crate::{backup_artifact::{file_identity, Evidence}, local_file::NewFile, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(super) const TIME_LIMIT: Duration = Duration::from_secs(30 * 60);

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PostgresBackupTarget {
    Database,
    Schema { schema: i64 },
    Table { object: i64 },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PostgresBackupContents {
    All,
    Schema,
    Data,
}

#[derive(Serialize)]
pub struct PostgresBackupReport {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub tool_version: String,
    pub audit_warning: bool,
}

pub(super) struct Source {
    pub major: u32,
    pub selection: Option<(&'static str, String)>,
    pub tunnel_port: Option<u16>,
}

pub(super) fn create(
    profile: &PostgresProfileInput,
    source: Source,
    password: PostgresPassword,
    contents: PostgresBackupContents,
    destination: String,
    check: impl Fn() -> Result<()>,
) -> Result<PostgresBackupReport> {
    create_with(profile, source, password, contents, destination, check, || Ok(())).map(|(report, _)| report)
}

pub(super) fn create_with(
    profile: &PostgresProfileInput,
    source: Source,
    password: PostgresPassword,
    contents: PostgresBackupContents,
    destination: String,
    check: impl Fn() -> Result<()>,
    before_publish: impl FnOnce() -> Result<()>,
) -> Result<(PostgresBackupReport, Evidence)> {
    check()?;
    let file = NewFile::stage(&destination, Some("backup"), ".stackport-postgres-")?;
    let tools = tools_for(profile, source.major, &check)?;
    let mut dump = command(&tools.directory, "pg_dump.exe");
    configure_connection(
        &mut dump,
        profile,
        &password,
        source.tunnel_port,
        tools.major,
    );
    dump.env("PGAPPNAME", "StackPort Backup")
        .env("PGOPTIONS", "-c default_transaction_read_only=on")
        .args([
            "--format=custom",
            "--encoding=UTF8",
            "--no-password",
            "--lock-wait-timeout=5000",
        ])
        .stdout(Stdio::from(file.writer()?));
    if let Some((flag, pattern)) = source.selection {
        dump.arg("--strict-names").arg(format!("{flag}={pattern}"));
    }
    match contents {
        PostgresBackupContents::All => {}
        PostgresBackupContents::Schema => {
            dump.arg("--schema-only");
        }
        PostgresBackupContents::Data => {
            dump.arg("--data-only");
        }
    }
    let child = spawn(&mut dump, &check);
    drop(dump);
    drop(password);
    finish(
        child?,
        &check,
        "pg_dump가 백업에 실패했습니다. 암호, TLS 인증서, 테이블 접근 권한과 잠금을 확인하세요.",
    )?;

    let mut archive = file.writer()?;
    archive
        .seek(SeekFrom::Start(0))
        .map_err(|_| "백업을 읽을 수 없습니다.")?;
    let mut restore = command(&tools.directory, "pg_restore.exe");
    restore
        .args(["--format=custom", "--file=-"])
        .stdin(Stdio::from(archive));
    let child = spawn(&mut restore, &check);
    drop(restore);
    finish(
        child?,
        &check,
        "pg_restore가 백업 아카이브를 읽을 수 없습니다.",
    )?;

    let mut archive = file.writer()?;
    archive
        .seek(SeekFrom::Start(0))
        .map_err(|_| "백업을 읽을 수 없습니다.")?;
    let file_id = file_identity(&archive);
    let mut archive = BufReader::with_capacity(128 * 1024, archive);
    let mut bytes = vec![0; 128 * 1024];
    let mut sha256 = Sha256::new();
    let mut size_bytes = 0;
    loop {
        check()?;
        let count = archive
            .read(&mut bytes)
            .map_err(|_| "백업 해시를 계산할 수 없습니다.")?;
        if count == 0 {
            break;
        }
        size_bytes += count as u64;
        sha256.update(&bytes[..count]);
    }
    drop(archive);
    check()?;
    before_publish()?;
    let sha256 = format!("{:x}", sha256.finalize());
    file.publish()?;
    Ok((
        PostgresBackupReport { path: destination, size_bytes, sha256: sha256.clone(), tool_version: tools.version, audit_warning: false },
        Evidence { sha256, file_id },
    ))
}

pub(super) struct Tools {
    pub directory: PathBuf,
    pub major: u32,
    pub version: String,
}

pub(super) fn tools_for(
    profile: &PostgresProfileInput,
    major: u32,
    check: &impl Fn() -> Result<()>,
) -> Result<Tools> {
    locate_tools(
        major.max(if profile.ca_path.is_some() { 14 } else { 16 }),
        check,
    )
}

pub(super) fn configure_connection(
    command: &mut Command,
    profile: &PostgresProfileInput,
    password: &PostgresPassword,
    tunnel_port: Option<u16>,
    tool_major: u32,
) {
    command
        .env("PGHOST", &profile.host)
        .env("PGPORT", tunnel_port.unwrap_or(profile.port).to_string())
        .env("PGDATABASE", &profile.database)
        .env("PGUSER", &profile.username)
        .env("PGPASSWORD", password.0.as_str())
        .env("PGCONNECT_TIMEOUT", "5")
        .env("PGSSLMODE", "verify-full")
        .env("PGSSLMINPROTOCOLVERSION", "TLSv1.2")
        .env(
            "PGSSLROOTCERT",
            profile.ca_path.as_deref().unwrap_or("system"),
        )
        .env("PGGSSENCMODE", "disable");
    if tool_major >= 16 {
        command.env("PGSSLCERTMODE", "disable");
    }
    if tunnel_port.is_some() {
        command.env("PGHOSTADDR", "127.0.0.1");
    }
}

fn locate_tools(minimum: u32, check: &impl Fn() -> Result<()>) -> Result<Tools> {
    if let Some(path) = env::var_os("STACKPORT_POSTGRES_TOOLS_DIR") {
        return tools_at(PathBuf::from(path), minimum, check);
    }
    let mut directories = Vec::new();
    for root in ["ProgramW6432", "ProgramFiles"] {
        let Some(path) = env::var_os(root) else {
            continue;
        };
        let Ok(entries) = fs::read_dir(PathBuf::from(path).join("PostgreSQL")) else {
            continue;
        };
        for entry in entries.flatten() {
            let major = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok());
            if let Some(major) = major.filter(|major| *major >= minimum) {
                directories.push((major, entry.path().join("bin")));
            }
        }
    }
    directories.sort();
    directories.dedup();
    for (_, directory) in directories {
        check()?;
        if let Ok(tools) = tools_at(directory, minimum, check) {
            return Ok(tools);
        }
    }
    Err(format!(
        "PostgreSQL {minimum} 이상 설치의 같은 버전 pg_dump와 pg_restore가 필요합니다."
    ))
}

fn tools_at(directory: PathBuf, minimum: u32, check: &impl Fn() -> Result<()>) -> Result<Tools> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("PostgreSQL 백업 도구 폴더를 찾을 수 없습니다.".into());
    }
    let (major, version) = tool_version(&directory, "pg_dump.exe", "pg_dump", check)?;
    if major < minimum {
        return Err(format!(
            "PostgreSQL {minimum} 이상의 백업 도구가 필요합니다."
        ));
    }
    let (_, restore) = tool_version(&directory, "pg_restore.exe", "pg_restore", check)?;
    if restore != version {
        return Err("pg_dump와 pg_restore의 버전을 맞추세요.".into());
    }
    Ok(Tools {
        directory,
        major,
        version,
    })
}

fn tool_version(
    directory: &Path,
    executable: &str,
    name: &str,
    check: &impl Fn() -> Result<()>,
) -> Result<(u32, String)> {
    let deadline = Instant::now() + Duration::from_secs(8);
    let check = || {
        check()?;
        if Instant::now() >= deadline {
            return Err(
                "백업 도구가 응답하지 않습니다. PostgreSQL 설치 및 런타임을 확인하세요.".into(),
            );
        }
        Ok(())
    };
    let mut output = tempfile::tempfile().map_err(|_| "백업 도구의 버전을 확인할 수 없습니다.")?;
    let stream = output
        .try_clone()
        .map_err(|_| "백업 도구의 버전을 확인할 수 없습니다.")?;
    let mut probe = command(directory, executable);
    probe.arg("--version").stdout(Stdio::from(stream));
    let child = spawn(&mut probe, &check);
    drop(probe);
    finish(
        child?,
        &check,
        "PostgreSQL 백업 도구의 버전을 확인할 수 없습니다.",
    )?;
    output
        .seek(SeekFrom::Start(0))
        .map_err(|_| "백업 도구의 버전을 확인할 수 없습니다.")?;
    let mut text = String::new();
    output
        .take(512)
        .read_to_string(&mut text)
        .map_err(|_| "백업 도구의 버전을 확인할 수 없습니다.")?;
    let version = text
        .strip_prefix(&format!("{name} (PostgreSQL) "))
        .and_then(|value| value.split_whitespace().next())
        .ok_or("PostgreSQL 백업 도구의 버전 형식을 확인하세요.")?;
    let major = version
        .split('.')
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or("PostgreSQL 백업 도구의 주 버전을 확인하세요.")?;
    Ok((major, version.into()))
}

pub(super) fn command(directory: &Path, executable: &str) -> Command {
    let mut command = Command::new(directory.join(executable));
    command
        .current_dir(directory)
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

pub(super) struct ArchiveChild {
    process: std::process::Child,
    #[cfg(windows)]
    _job: crate::terminal::ProcessJob,
}

pub(super) fn spawn(
    command: &mut Command,
    check: &impl Fn() -> Result<()>,
) -> Result<ArchiveChild> {
    check()?;
    #[cfg(windows)]
    let job = crate::terminal::ProcessJob::new()?;
    let process = command.spawn().map_err(|_| {
        "PostgreSQL 백업 도구를 실행할 수 없습니다. CLI 설치와 실행 권한을 확인하세요."
    })?;
    #[cfg(windows)]
    let process = {
        use std::os::windows::io::AsRawHandle;
        let mut process = process;
        if let Err(error) = job.attach_handle(process.as_raw_handle()) {
            if !matches!(process.try_wait(), Ok(Some(_))) {
                let _ = process.kill();
                let _ = process.wait();
                return Err(error);
            }
        }
        process
    };
    Ok(ArchiveChild { process, #[cfg(windows)] _job: job })
}

pub(super) fn finish(
    mut child: ArchiveChild,
    check: &impl Fn() -> Result<()>,
    failure: &str,
) -> Result<()> {
    let result = loop {
        if let Err(error) = check() {
            break Err(error);
        }
        match child.process.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(failure.into())
                }
            }
            Ok(None) => thread::sleep(Duration::from_millis(75)),
            Err(_) => break Err(failure.into()),
        }
    };
    let _ = child.process.kill();
    let _ = child.process.wait();
    result
}
