use super::{PostgresPassword, PostgresProfileInput};
use crate::{local_file::NewFile, Result};
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
    check()?;
    let file = NewFile::stage(&destination, Some("backup"), ".stackport-postgres-")?;
    let tools = locate_tools(
        source
            .major
            .max(if profile.ca_path.is_some() { 14 } else { 16 }),
        &check,
    )?;
    let mut dump = command(&tools.directory, "pg_dump.exe");
    dump.env("PGHOST", &profile.host)
        .env(
            "PGPORT",
            source.tunnel_port.unwrap_or(profile.port).to_string(),
        )
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
        .env("PGGSSENCMODE", "disable")
        .env("PGAPPNAME", "StackPort Backup")
        .env("PGOPTIONS", "-c default_transaction_read_only=on")
        .args([
            "--format=custom",
            "--encoding=UTF8",
            "--no-password",
            "--lock-wait-timeout=5000",
        ])
        .stdout(Stdio::from(file.writer()?));
    if tools.major >= 16 {
        dump.env("PGSSLCERTMODE", "disable");
    }
    if source.tunnel_port.is_some() {
        dump.env("PGHOSTADDR", "127.0.0.1");
    }
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
    file.publish()?;
    Ok(PostgresBackupReport {
        path: destination,
        size_bytes,
        sha256: format!("{:x}", sha256.finalize()),
        tool_version: tools.version,
        audit_warning: false,
    })
}

struct Tools {
    directory: PathBuf,
    major: u32,
    version: String,
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

fn command(directory: &Path, executable: &str) -> Command {
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

fn spawn(command: &mut Command, check: &impl Fn() -> Result<()>) -> Result<std::process::Child> {
    check()?;
    command.spawn().map_err(|_| {
        "PostgreSQL 백업 도구를 실행할 수 없습니다. CLI 설치와 실행 권한을 확인하세요.".into()
    })
}

fn finish(
    mut child: std::process::Child,
    check: &impl Fn() -> Result<()>,
    failure: &str,
) -> Result<()> {
    let result = loop {
        if let Err(error) = check() {
            break Err(error);
        }
        match child.try_wait() {
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
    let _ = child.kill();
    let _ = child.wait();
    result
}
