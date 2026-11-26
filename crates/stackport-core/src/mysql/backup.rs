use super::{require_identifier, tls, MysqlManager, MysqlPassword, MysqlSettings, ReadError};
use crate::{insert_audit, local_file::NewFile, AuditRecord, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use mysql_async::prelude::Queryable;
use rustls::pki_types::{pem::PemObject, CertificateDer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const CANCELLED: &str = "MySQL 백업이 중단되었습니다.";
const TOOL_FAILED: &str =
    "백업 도구가 SQL 파일을 생성하지 못했습니다. 암호, 인증서, 백업 권한과 서버 상태를 확인하세요.";

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Contents {
    All,
    Schema,
    Data,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MysqlBackupInput {
    database: String,
    table: Option<String>,
    contents: Contents,
    directory: String,
    destination: String,
    password: MysqlPassword,
    confirmation: String,
}

#[derive(Serialize)]
pub struct MysqlBackupReport {
    path: String,
    size_bytes: u64,
    sha256: String,
    server_version: String,
    tool_version: String,
    audit_warning: bool,
}

impl MysqlManager {
    pub async fn backup(
        &self,
        id: &str,
        request: String,
        input: MysqlBackupInput,
    ) -> Result<MysqlBackupReport> {
        let guard = self.store.queries.claim(&request)?;
        let session = self.session(id)?;
        if session.tunnel.is_some() {
            return Err("MySQL 백업 도구는 직접 연결에서 사용할 수 있습니다.".into());
        }
        if session.environment == "PROD" && input.confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        require_identifier(&input.database)?;
        if ["mysql", "information_schema", "performance_schema", "sys"]
            .iter()
            .any(|schema| input.database.eq_ignore_ascii_case(schema))
        {
            return Err("사용자 데이터베이스를 선택하세요.".into());
        }
        if let Some(table) = &input.table {
            require_identifier(table)?;
        }
        if input.password.0.len() > 4096 || input.password.0.contains('\0') {
            return Err("MySQL 백업 암호를 확인하세요.".into());
        }
        let cancelled = guard.cancellation_check();
        if cancelled() {
            return Err(CANCELLED.into());
        }
        let database = input.database.clone();
        let table = input.table.clone();
        let table_selected = table.is_some();
        let (exists, tables, non_transactional, version) = self.read(id, |connection| {
            Box::pin(async move {
                connection.exec_first::<(u64, u64, u64, String), _, _>(
                    "SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME = BINARY ?),
                            COUNT(*), COUNT(CASE WHEN ENGINE IS NULL OR ENGINE <> 'InnoDB' THEN 1 END), VERSION()
                     FROM information_schema.TABLES
                     WHERE BINARY TABLE_SCHEMA = BINARY ? AND TABLE_TYPE = 'BASE TABLE'
                       AND (? IS NULL OR BINARY TABLE_NAME = BINARY ?)",
                    (database.clone(), database, table.clone(), table),
                ).await?.ok_or(ReadError::Shape)
            })
        }).await?;
        if exists != 1 || (table_selected && tables != 1) {
            return Err("백업할 데이터베이스나 일반 테이블을 조회할 수 없습니다.".into());
        }
        if non_transactional > 0 && !matches!(input.contents, Contents::Schema) {
            return Err(
                "데이터 백업에는 InnoDB 트랜잭션 스냅샷이 필요합니다. 구조만 백업할 수 있습니다."
                    .into(),
            );
        }

        let store = self.store.clone();
        let closed = session.closed.subscribe();
        tokio::task::spawn_blocking(move || {
            let deadline = Instant::now() + Duration::from_secs(30 * 60);
            let check = || {
                if cancelled() || *closed.borrow() {
                    return Err(CANCELLED.to_owned());
                }
                if Instant::now() >= deadline {
                    return Err("MySQL 백업 시간이 초과되었습니다.".to_owned());
                }
                Ok(())
            };
            check()?;
            let profile = store.mysql_profile(&session.profile_id, session.profile_revision)?;
            let audit = |operation, outcome| {
                insert_audit(
                    &store.connect()?,
                    AuditRecord {
                        correlation_id: &request,
                        operation,
                        project_id: Some(&session.project_id),
                        profile_id: Some(&session.profile_id),
                        environment: Some(&session.environment),
                        object_name: None,
                        outcome,
                        affected_count: None,
                    },
                )
            };
            audit("mysql.backup", "started")?;
            let result = create(
                input,
                &profile.settings,
                session.engine,
                version,
                &check,
                || {
                    store.mysql_profile(&session.profile_id, session.profile_revision)?;
                    check()?;
                    if !guard.begin_export_publication() {
                        return Err(CANCELLED.into());
                    }
                    Ok(())
                },
            );
            let (operation, outcome) = match &result {
                Ok(_) => ("mysql.backup", "succeeded"),
                Err(error) if error == CANCELLED => ("mysql.backup.cancel", "failed"),
                Err(_) => ("mysql.backup", "failed"),
            };
            let audit_warning = audit(operation, outcome).is_err();
            result.map(|report| MysqlBackupReport {
                audit_warning,
                ..report
            })
        })
        .await
        .map_err(|_| "MySQL 백업을 마무리할 수 없습니다.")?
    }
}

fn create(
    input: MysqlBackupInput,
    settings: &MysqlSettings,
    engine: &str,
    server_version: String,
    check: &impl Fn() -> Result<()>,
    before_publish: impl FnOnce() -> Result<()>,
) -> Result<MysqlBackupReport> {
    let file = NewFile::stage(&input.destination, Some("sql"), ".stackport-mysql-")?;
    let maria = engine == "MariaDB";
    let directory = Path::new(input.directory.trim());
    if !directory.is_absolute() {
        return Err("백업 도구 폴더의 절대 경로를 지정하세요.".into());
    }
    let executable = if maria { "mariadb-dump" } else { "mysqldump" };
    let executable =
        fs::canonicalize(directory.join(format!("{executable}{}", env::consts::EXE_SUFFIX)))
            .map_err(|_| format!("선택한 폴더에서 {executable} 실행 파일을 찾을 수 없습니다."))?;
    let scratch = tempfile::Builder::new()
        .prefix("stackport-mysql-")
        .tempdir()
        .map_err(|_| "MySQL 백업의 임시 폴더를 만들 수 없습니다.")?;
    let tool_version = find_version(&executable, scratch.path(), maria, &server_version, check)?;
    let mut command = client_command(&executable, scratch.path(), maria);
    command
        .args([
            "--skip-lock-tables",
            "--skip-add-locks",
            "--skip-add-drop-table",
            "--quick",
            "--hex-blob",
        ])
        .arg(format!(
            "--result-file={}",
            native_path(file.staging_path())?
        ));
    configure_connection(
        &mut command,
        settings,
        &input.password,
        scratch.path(),
        maria,
    )?;
    if !maria {
        command.args(["--set-gtid-purged=OFF", "--no-tablespaces"]);
    }
    if !matches!(input.contents, Contents::Schema) {
        command.arg("--single-transaction");
    }
    match input.contents {
        Contents::All => {}
        Contents::Schema => {
            command.arg("--no-data");
        }
        Contents::Data => {
            command.args(["--no-create-info", "--skip-triggers"]);
        }
    }
    if input.table.is_none() && !matches!(input.contents, Contents::Data) {
        command.args(["--routines", "--events", "--databases"]);
    }
    command.arg("--").arg(&input.database);
    if let Some(table) = &input.table {
        command.arg(table);
    }
    run(command, check, TOOL_FAILED)?;
    drop(input.password);
    let (size_bytes, sha256) = digest(file.writer()?, check)?;
    before_publish()?;
    file.publish()?;
    Ok(MysqlBackupReport {
        path: input.destination.trim().to_owned(),
        size_bytes,
        sha256,
        server_version,
        tool_version,
        audit_warning: false,
    })
}

pub(super) fn client_command(executable: &Path, directory: &Path, maria: bool) -> Command {
    let mut command = Command::new(executable);
    command
        .current_dir(directory)
        .env_clear()
        .arg("--no-defaults")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if !maria {
        // MySQL 8.0 reads the login file even with --no-defaults.
        command.env("MYSQL_TEST_LOGIN_FILE", directory.join("unused-login.cnf"));
    }
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

pub(super) fn find_version(
    executable: &Path,
    scratch: &Path,
    maria: bool,
    server_version: &str,
    check: &impl Fn() -> Result<()>,
) -> Result<String> {
    let file = tempfile::tempfile_in(scratch).map_err(|_| "백업 도구 버전을 읽을 수 없습니다.")?;
    let mut command = client_command(executable, scratch, maria);
    command.arg("--version").stdout(Stdio::from(
        file.try_clone()
            .map_err(|_| "백업 도구 버전을 읽을 수 없습니다.")?,
    ));
    let started = Instant::now();
    run(
        command,
        &|| {
            check()?;
            if started.elapsed() >= Duration::from_secs(8) {
                return Err("백업 도구 버전 확인 시간이 초과되었습니다.".into());
            }
            Ok(())
        },
        "설치한 백업 도구의 버전을 확인할 수 없습니다.",
    )?;
    use std::io::{Seek, SeekFrom};
    let mut file = file;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "백업 도구 버전을 읽을 수 없습니다.")?;
    let mut output = String::new();
    file.take(2048)
        .read_to_string(&mut output)
        .map_err(|_| "백업 도구 버전을 읽을 수 없습니다.")?;
    let tool_version = output
        .split_ascii_whitespace()
        .skip_while(|word| {
            if maria {
                !matches!(*word, "from" | "Distrib")
            } else {
                *word != "Ver"
            }
        })
        .nth(1)
        .unwrap_or_default()
        .trim_end_matches(',');
    let tool_series = release_series(tool_version);
    if tool_version.contains("MariaDB") != maria
        || tool_series.is_none()
        || tool_series != release_series(server_version)
    {
        return Err("연결한 서버와 같은 제품 및 주·부 버전의 백업 도구를 지정하세요.".into());
    }
    Ok(tool_version.to_owned())
}

pub(super) fn release_series(version: &str) -> Option<(u32, u32)> {
    let version = version.strip_prefix("5.5.5-").unwrap_or(version);
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?;
    patch
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_digit)
        .then_some((major, minor))
}

pub(super) fn configure_connection(
    command: &mut Command,
    settings: &MysqlSettings,
    password: &MysqlPassword,
    scratch: &Path,
    maria: bool,
) -> Result<()> {
    command
        .args(["--protocol=TCP", "--default-character-set=utf8mb4"])
        .arg(format!("--host={}", settings.host))
        .arg(format!("--port={}", settings.port))
        .arg(format!("--user={}", settings.username))
        .env("MYSQL_PWD", password.0.as_str());
    configure_tls(command, settings, scratch, maria)
}

fn configure_tls(
    command: &mut Command,
    settings: &MysqlSettings,
    scratch: &Path,
    maria: bool,
) -> Result<()> {
    if !settings.tls {
        command.arg(if maria {
            "--skip-ssl"
        } else {
            "--ssl-mode=DISABLED"
        });
        return Ok(());
    }
    let bundle = scratch.join("trust.pem");
    write_certificates(&bundle, settings)?;
    command
        .arg("--tls-version=TLSv1.2,TLSv1.3")
        .arg(format!("--ssl-ca={}", native_path(&bundle)?));
    if maria {
        command.args(["--ssl", "--ssl-verify-server-cert"]);
    } else {
        command.arg("--ssl-mode=VERIFY_IDENTITY");
    }
    if let (Some(certificate), Some(key)) =
        (&settings.client_certificate_path, &settings.client_key_path)
    {
        command
            .arg(format!("--ssl-cert={certificate}"))
            .arg(format!("--ssl-key={key}"));
    }
    Ok(())
}

fn write_certificates(path: &Path, settings: &MysqlSettings) -> Result<()> {
    let error = "MySQL 백업 도구의 CA 인증서 묶음을 만들 수 없습니다.";
    let mut file = File::create(path).map_err(|_| error)?;
    for bytes in tls::trusted_certificates(settings)? {
        let certificates = if bytes.first() == Some(&0x30) {
            vec![CertificateDer::from(bytes.as_slice())]
        } else {
            CertificateDer::pem_slice_iter(&bytes)
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| error)?
        };
        if certificates.is_empty() {
            return Err(error.into());
        }
        for certificate in certificates {
            writeln!(file, "-----BEGIN CERTIFICATE-----").map_err(|_| error)?;
            for line in STANDARD.encode(certificate.as_ref()).as_bytes().chunks(64) {
                file.write_all(line)
                    .and_then(|_| file.write_all(b"\n"))
                    .map_err(|_| error)?;
            }
            writeln!(file, "-----END CERTIFICATE-----").map_err(|_| error)?;
        }
    }
    Ok(())
}

fn native_path(path: &Path) -> Result<String> {
    let path = path.to_str().ok_or("백업 파일 경로를 확인하세요.")?;
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return Ok(format!(r"\\{unc}"));
    }
    Ok(path.strip_prefix(r"\\?\").unwrap_or(path).to_owned())
}

pub(super) fn run(
    mut command: Command,
    check: &impl Fn() -> Result<()>,
    failure: &str,
) -> Result<()> {
    check()?;
    #[cfg(windows)]
    let job = crate::terminal::ProcessJob::new()?;
    let mut child = command
        .spawn()
        .map_err(|_| "MySQL 백업 도구를 실행할 수 없습니다.")?;
    drop(command);
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        if let Err(error) = job.attach_handle(child.as_raw_handle()) {
            if !child.try_wait().is_ok_and(|status| status.is_some()) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    }
    let result = loop {
        if let Err(error) = check() {
            break Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(failure.into()),
            Ok(None) => thread::sleep(Duration::from_millis(75)),
            Err(_) => break Err(failure.into()),
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn digest(file: File, check: &impl Fn() -> Result<()>) -> Result<(u64, String)> {
    use std::io::{Seek, SeekFrom};
    let mut file = BufReader::new(file);
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "백업 SQL을 읽을 수 없습니다.")?;
    let mut buffer = vec![0; 128 * 1024];
    let mut hash = Sha256::new();
    let mut size = 0u64;
    loop {
        check()?;
        let read = file
            .read(&mut buffer)
            .map_err(|_| "백업 SQL의 SHA-256을 계산할 수 없습니다.")?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hash.update(&buffer[..read]);
    }
    if size == 0 {
        return Err("백업 도구가 비어 있는 SQL 파일을 생성했습니다.".into());
    }
    Ok((size, format!("{:x}", hash.finalize())))
}
