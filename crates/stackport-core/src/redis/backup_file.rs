use crate::{local_file::valid_filename, Result, Store};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    task::spawn_blocking,
    time::timeout,
};

mod recovery;
mod download;
pub use download::{RedisRdbDownloadInput, RedisRdbDownloadReport};

const TIME_LIMIT: Duration = Duration::from_secs(15 * 60);
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_FILES: usize = 4096;
const OUTPUT_LIMIT: usize = 8192;
const CANCELLED: &str = "Redis 백업 파일 검사가 중단되었습니다.";
const TIMED_OUT: &str = "Redis 백업 파일 검사 시간이 초과되었습니다.";
const INVALID_MANIFEST: &str = "Redis AOF 매니페스트의 형식이나 파일 이름을 확인하세요.";
const SOURCE_CHANGED: &str = "검사할 사본을 준비하는 동안 원본 백업이 변경되었습니다.";
const CHECK_FAILED: &str = "Redis 검사 도구가 파일 형식 또는 무결성을 확인하지 못했습니다.";

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RedisBackupFileFormat {
    Rdb,
    AofFile,
    AofManifest,
}

#[derive(Serialize)]
pub struct RedisBackupFileReport {
    format: RedisBackupFileFormat,
    checker_version: String,
    files: Vec<BackupFile>,
    rdb: Option<RdbDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery: Option<recovery::RecoveryReport>,
}

#[derive(Serialize)]
struct BackupFile {
    name: String,
    role: &'static str,
    bytes: u64,
    sha256: String,
}

#[derive(Serialize)]
struct RdbDetails {
    format_version: u16,
    checksum_verified: bool,
    keys_read: Option<u64>,
    expired_keys: Option<u64>,
}

struct Snapshot {
    directory: TempDir,
    argument: &'static str,
    files: Vec<BackupFile>,
    rdb_version: Option<u16>,
}

impl Store {
    pub async fn inspect_redis_backup_file(
        &self,
        request: &str,
        format: RedisBackupFileFormat,
        source: String,
        directory: String,
    ) -> Result<RedisBackupFileReport> {
        self.check_redis_backup_file(request, format, source, directory, None)
            .await
    }

    pub async fn verify_redis_rdb_restore(
        &self,
        request: &str,
        source: String,
        directory: String,
        sha256: String,
    ) -> Result<RedisBackupFileReport> {
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("백업 파일을 검사해 SHA-256을 확인하세요.".into());
        }
        self.check_redis_backup_file(
            request,
            RedisBackupFileFormat::Rdb,
            source,
            directory,
            Some(sha256),
        )
        .await
    }

    async fn check_redis_backup_file(
        &self,
        request: &str,
        format: RedisBackupFileFormat,
        source: String,
        directory: String,
        reviewed_sha256: Option<String>,
    ) -> Result<RedisBackupFileReport> {
        let guard = self.queries.claim(request)?;
        let cancelled = guard.cancellation_check();
        let deadline = Instant::now() + TIME_LIMIT;
        let directory = Path::new(directory.trim());
        let operation = async {
            let (executable, checker_version) = checker_at(directory, format).await?;
            if matches!(format, RedisBackupFileFormat::AofManifest)
                && checker_version
                    .split('.')
                    .next()
                    .and_then(|major| major.parse::<u32>().ok())
                    .is_none_or(|major| major < 7)
            {
                return Err(
                    "다중 파일 AOF를 검사하려면 Redis 7 이상 검사 도구가 필요합니다.".into(),
                );
            }
            let snapshot = spawn_blocking(move || {
                prepare(format, &source, &|| {
                    if cancelled() {
                        Err(CANCELLED.into())
                    } else if Instant::now() >= deadline {
                        Err(TIMED_OUT.into())
                    } else {
                        Ok(())
                    }
                })
            })
            .await
            .map_err(|_| "Redis 백업 파일의 임시 사본을 준비할 수 없습니다.")??;
            if let Some(reviewed) = &reviewed_sha256 {
                if !snapshot.files[0].sha256.eq_ignore_ascii_case(reviewed) {
                    return Err(
                        "검사 이후 Redis 백업 파일이 변경되었습니다. 파일을 다시 검사하세요."
                            .into(),
                    );
                }
            }
            let output = checker(
                &executable,
                Some(snapshot.directory.path()),
                snapshot.argument,
            )
            .await?;
            let rdb = snapshot
                .rdb_version
                .map(|version| rdb_result(version, snapshot.files[0].bytes, &output.text))
                .transpose()?;
            let report = RedisBackupFileReport {
                format,
                checker_version,
                files: snapshot.files,
                rdb,
                recovery: None,
            };
            Ok::<_, String>((report, snapshot.directory, output.highest_database))
        };
        let (mut report, snapshot, highest_database) = tokio::select! {
            biased;
            _ = guard.wait_cancelled() => return Err(CANCELLED.into()),
            result = timeout(TIME_LIMIT, operation) => result.map_err(|_| TIMED_OUT.to_owned())??,
        };
        if reviewed_sha256.is_some() {
            let keys = report
                .rdb
                .as_ref()
                .and_then(|details| details.keys_read)
                .ok_or("RDB 파일의 키 수를 확인할 수 없습니다.")?;
            report.recovery = Some(
                recovery::restore(
                    directory,
                    snapshot.path(),
                    highest_database,
                    keys,
                    &guard,
                    deadline,
                )
                .await?,
            );
        }
        Ok(report)
    }
}

async fn checker_at(directory: &Path, format: RedisBackupFileFormat) -> Result<(PathBuf, String)> {
    if !directory.is_absolute() {
        return Err("Redis 검사 도구 폴더의 절대 경로를 지정하세요.".into());
    }
    let executable = tokio::fs::canonicalize(directory.join(format.tool_executable()))
        .await
        .map_err(|_| "선택한 폴더에서 Redis 검사 도구를 찾을 수 없습니다.")?;
    let version = timeout(Duration::from_secs(8), checker(&executable, None, "--version"))
        .await
        .map_err(|_| "Redis 검사 도구의 버전 확인 시간이 초과되었습니다.")??;
    let version = version.text.split_whitespace().nth(1)
        .map(|word| word.strip_prefix("v=").unwrap_or(word))
        .filter(|word| word.len() <= 48
            && word.as_bytes().first().is_some_and(u8::is_ascii_digit)
            && word.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte)))
        .filter(|_| version.text.starts_with(format.tool_name()))
        .ok_or("Redis 검사 도구의 버전을 확인할 수 없습니다.")?
        .to_owned();
    Ok((executable, version))
}

impl RedisBackupFileFormat {
    fn tool_name(self) -> &'static str {
        match self {
            Self::Rdb => "redis-check-rdb",
            Self::AofFile | Self::AofManifest => "redis-check-aof",
        }
    }

    fn tool_executable(self) -> String {
        format!("{}{}", self.tool_name(), std::env::consts::EXE_SUFFIX)
    }
}

fn prepare(
    format: RedisBackupFileFormat,
    source: &str,
    check: &impl Fn() -> Result<()>,
) -> Result<Snapshot> {
    let source = Path::new(source.trim());
    if !source.is_absolute() {
        return Err("검사할 Redis 백업의 절대 경로를 지정하세요.".into());
    }
    let source = source
        .canonicalize()
        .map_err(|_| "Redis 백업 파일을 열 수 없습니다.")?;
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Redis 백업 파일 이름을 읽을 수 없습니다.")?;
    let directory = tempfile::Builder::new()
        .prefix("stackport-redis-check-")
        .tempdir()
        .map_err(|_| "검사용 임시 폴더를 만들 수 없습니다.")?;
    let (argument, files, rdb_version) = match format {
        RedisBackupFileFormat::Rdb => {
            let mut file = open_source(&source)?;
            let version = read_rdb_version(&mut file)?;
            let entry = copy(
                file,
                &directory.path().join("backup.rdb"),
                name,
                "rdb",
                check,
            )?;
            ("./backup.rdb", vec![entry], Some(version))
        }
        RedisBackupFileFormat::AofFile => {
            let mut file = open_source(&source)?;
            validate_aof_file(&mut file)?;
            let entry = copy(
                file,
                &directory.path().join("backup.aof"),
                name,
                "aof",
                check,
            )?;
            ("./backup.aof", vec![entry], None)
        }
        RedisBackupFileFormat::AofManifest => {
            let entries = copy_manifest(&source, name, directory.path(), check)?;
            ("./backup.manifest", entries, None)
        }
    };
    Ok(Snapshot {
        directory,
        argument,
        files,
        rdb_version,
    })
}

fn copy_manifest(
    source: &Path,
    name: &str,
    destination: &Path,
    check: &impl Fn() -> Result<()>,
) -> Result<Vec<BackupFile>> {
    let original = read_manifest(source)?;
    let entries = parse_manifest(&original)?;
    let mut files = vec![BackupFile {
        name: name.into(),
        role: "manifest",
        bytes: original.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&original)),
    }];
    let parent = source.parent().ok_or(INVALID_MANIFEST)?;
    let mut staged = String::new();
    for (index, entry) in entries.into_iter().enumerate() {
        check()?;
        let path = parent.join(&entry.name);
        let file = open_source(&path)
            .map_err(|_| format!("AOF 구성 파일을 열 수 없습니다. {}", entry.name))?;
        let part = format!("part-{index}.aof");
        let role = if entry.kind == "b" {
            "base"
        } else {
            "incremental"
        };
        files.push(copy(
            file,
            &destination.join(&part),
            &entry.name,
            role,
            check,
        )?);
        staged.push_str(&format!(
            "file {part} seq {} type {}\n",
            entry.sequence, entry.kind
        ));
    }
    if read_manifest(source)? != original {
        return Err(SOURCE_CHANGED.into());
    }
    // The checker sees only names produced here. It cannot resolve paths from the original manifest.
    fs::write(destination.join("backup.manifest"), staged)
        .map_err(|_| "검사용 AOF 매니페스트를 만들 수 없습니다.")?;
    Ok(files)
}

fn read_manifest(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_source(path)?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| INVALID_MANIFEST)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("AOF 매니페스트는 1 MiB까지 검사할 수 있습니다.".into());
    }
    Ok(bytes)
}

struct ManifestEntry<'a> {
    name: String,
    sequence: u64,
    kind: &'a str,
}

fn parse_manifest(input: &[u8]) -> Result<Vec<ManifestEntry<'_>>> {
    if !input.ends_with(b"\n") {
        return Err(INVALID_MANIFEST.into());
    }
    let text = std::str::from_utf8(input).map_err(|_| INVALID_MANIFEST)?;
    let mut entries = Vec::new();
    let mut names = HashSet::new();
    let mut base = false;
    let mut previous_increment = 0;
    for line in text
        .split_terminator('\n')
        .filter(|line| !line.starts_with('#'))
    {
        if line.len() >= 1024 || names.len() >= MAX_MANIFEST_FILES {
            return Err(INVALID_MANIFEST.into());
        }
        let (name, tail) = manifest_name(line.strip_prefix("file ").ok_or(INVALID_MANIFEST)?)?;
        if name.is_empty()
            || name.len() > 255
            || name == "."
            || name == ".."
            || name.contains(['/', '\\', ':', '"'])
            || name.chars().any(char::is_control)
            || !valid_filename(&name)
            || !names.insert(name.to_lowercase())
        {
            return Err(INVALID_MANIFEST.into());
        }
        let mut fields = tail.split_ascii_whitespace();
        let (Some("seq"), Some(sequence), Some("type"), Some(kind)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return Err(INVALID_MANIFEST.into());
        };
        let sequence = sequence
            .parse::<u64>()
            .ok()
            .filter(|sequence| (1..=i64::MAX as u64).contains(sequence))
            .ok_or(INVALID_MANIFEST)?;
        while let Some(field) = fields.next() {
            if !matches!(field, "startoffset" | "endoffset")
                || fields
                    .next()
                    .and_then(|value| value.parse::<i64>().ok())
                    .is_none()
            {
                return Err(INVALID_MANIFEST.into());
            }
        }
        match kind {
            "h" => continue,
            "b" if !base && previous_increment == 0 => base = true,
            "i" if sequence > previous_increment => previous_increment = sequence,
            _ => return Err(INVALID_MANIFEST.into()),
        }
        entries.push(ManifestEntry {
            name,
            sequence,
            kind,
        });
    }
    if entries.is_empty() {
        return Err(INVALID_MANIFEST.into());
    }
    Ok(entries)
}

fn manifest_name(value: &str) -> Result<(String, &str)> {
    let value = value.trim_start_matches([' ', '\t']);
    if !value.starts_with('"') {
        let end = value
            .find(|character: char| character.is_ascii_whitespace())
            .ok_or(INVALID_MANIFEST)?;
        return Ok((value[..end].to_owned(), &value[end..]));
    }
    let bytes = value.as_bytes();
    let mut name = Vec::new();
    let mut index = 1;
    while let Some(&byte) = bytes.get(index) {
        index += 1;
        match byte {
            b'"' if bytes.get(index).is_some_and(u8::is_ascii_whitespace) => {
                return Ok((
                    String::from_utf8(name).map_err(|_| INVALID_MANIFEST)?,
                    &value[index..],
                ));
            }
            b'"' => break,
            b'\\' => {
                if bytes.get(index) != Some(&b'x') {
                    return Err(INVALID_MANIFEST.into());
                }
                let hex = bytes
                    .get(index + 1..index + 3)
                    .and_then(|digits| std::str::from_utf8(digits).ok())
                    .ok_or(INVALID_MANIFEST)?;
                if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(INVALID_MANIFEST.into());
                }
                name.push(u8::from_str_radix(hex, 16).map_err(|_| INVALID_MANIFEST)?);
                index += 3;
            }
            _ => name.push(byte),
        }
    }
    Err(INVALID_MANIFEST.into())
}

fn open_source(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
        };
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    if !fs::symlink_metadata(path).is_ok_and(|details| details.is_file()) {
        return Err("일반 Redis 백업 파일을 선택하세요.".into());
    }
    let file = options.open(path).map_err(|_| "Redis 백업 파일을 열 수 없습니다. 다른 프로그램에서 쓰는 중이면 완료 후 복사본을 검사하세요.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Redis 백업 파일을 확인할 수 없습니다.")?;
    if !metadata.is_file() {
        return Err("일반 Redis 백업 파일을 선택하세요.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("AOF 구성 파일에 링크가 있습니다.".into());
        }
    }
    Ok(file)
}

fn copy(
    mut source: File,
    destination: &Path,
    name: &str,
    role: &'static str,
    check: &impl Fn() -> Result<()>,
) -> Result<BackupFile> {
    let original = source.metadata().map_err(|_| SOURCE_CHANGED)?;
    let mut target = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|_| "검사용 백업 사본을 만들 수 없습니다.")?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 128 * 1024];
    let mut bytes = 0;
    loop {
        check()?;
        let size = source
            .read(&mut buffer)
            .map_err(|_| "Redis 백업 파일을 읽을 수 없습니다.")?;
        if size == 0 {
            break;
        }
        bytes += size as u64;
        if bytes > original.len() {
            return Err(SOURCE_CHANGED.into());
        }
        target
            .write_all(&buffer[..size])
            .map_err(|_| "검사용 사본을 기록할 수 없습니다. 임시 폴더의 여유 공간을 확인하세요.")?;
        hash.update(&buffer[..size]);
    }
    let current = source.metadata().map_err(|_| SOURCE_CHANGED)?;
    if bytes != original.len()
        || current.len() != original.len()
        || current.modified().ok() != original.modified().ok()
    {
        return Err(SOURCE_CHANGED.into());
    }
    Ok(BackupFile {
        name: name.into(),
        role,
        bytes,
        sha256: format!("{:x}", hash.finalize()),
    })
}

fn read_rdb_version(file: &mut File) -> Result<u16> {
    let mut header = [0; 9];
    file.read_exact(&mut header).map_err(|_| CHECK_FAILED)?;
    let version = std::str::from_utf8(&header[5..])
        .ok()
        .and_then(|digits| digits.parse::<u16>().ok());
    if !header.starts_with(b"REDIS") || !header[5..].iter().all(u8::is_ascii_digit) {
        return Err(CHECK_FAILED.into());
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| CHECK_FAILED)?;
    version
        .filter(|version| *version > 0)
        .ok_or_else(|| CHECK_FAILED.into())
}

fn validate_aof_file(file: &mut File) -> Result<()> {
    let mut input = BufReader::new(&mut *file);
    let mut count = 0;
    let valid = loop {
        let bytes = input.fill_buf().map_err(|_| CHECK_FAILED)?;
        match bytes.first() {
            None | Some(b'*') => break true,
            Some(b'R') if count == 0 && bytes.starts_with(b"REDIS") => break true,
            Some(b'#') if count < MAX_MANIFEST_BYTES => {
                let mut line = Vec::new();
                let length = (&mut input)
                    .take(1024)
                    .read_until(b'\n', &mut line)
                    .map_err(|_| CHECK_FAILED)?;
                if line.last() != Some(&b'\n') {
                    break false;
                }
                count += length as u64;
            }
            _ => break false,
        }
    };
    if !valid {
        return Err(
            "단일 AOF 파일의 형식을 확인하세요. 매니페스트는 다중 파일 AOF로 검사하세요.".into(),
        );
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| CHECK_FAILED)?;
    Ok(())
}

fn rdb_result(version: u16, expected_bytes: u64, output: &str) -> Result<RdbDetails> {
    let offset = format!("[offset {expected_bytes}] ");
    let success = format!("{offset}\\o/ RDB looks OK! \\o/");
    let mut lines = output.lines().rev();
    let (keys_read, expired_keys) = (
        counter(output, " keys read"),
        counter(output, " already expired"),
    );
    let Some(end) = lines.find(|line| line.ends_with("] \\o/ RDB looks OK! \\o/")) else {
        return Err(CHECK_FAILED.into());
    };
    if end != success {
        return Err("Redis RDB의 끝 위치가 파일 크기와 일치하지 않습니다.".into());
    }
    Ok(RdbDetails {
        format_version: version,
        checksum_verified: version >= 5
            && lines
                .next()
                .is_some_and(|line| line.strip_prefix(&offset) == Some("Checksum OK")),
        keys_read,
        expired_keys,
    })
}

fn counter(output: &str, suffix: &str) -> Option<u64> {
    output.lines().rev().find_map(|line| {
        line.strip_prefix("[info] ")?
            .strip_suffix(suffix)?
            .parse()
            .ok()
    })
}

struct CheckerOutput {
    text: String,
    highest_database: u64,
}

struct LocalProcess {
    child: Child,
    #[cfg(windows)]
    _job: crate::terminal::ProcessJob,
}

fn local_process(executable: &Path, directory: &Path, argument: &str) -> Result<LocalProcess> {
    let mut command = Command::new(executable);
    command
        .arg(argument)
        .kill_on_drop(true)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command.current_dir(directory);
    #[cfg(windows)]
    let job = {
        for name in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        crate::terminal::ProcessJob::with_memory_limit(2 * 1024 * 1024 * 1024)?
    };
    let mut child = command
        .spawn()
        .map_err(|_| "Redis 실행 파일을 시작할 수 없습니다.")?;
    #[cfg(windows)]
    {
        let attached = child
            .raw_handle()
            .ok_or("Redis 검사 프로세스 핸들을 열 수 없습니다.")
            .map_err(str::to_owned)
            .and_then(|handle| job.attach_handle(handle));
        if let Err(error) = attached {
            if !child.try_wait().is_ok_and(|status| status.is_some()) {
                return Err(error);
            }
        }
    }
    Ok(LocalProcess {
        child,
        #[cfg(windows)]
        _job: job,
    })
}

async fn checker(
    executable: &Path,
    directory: Option<&Path>,
    argument: &str,
) -> Result<CheckerOutput> {
    let directory = directory
        .or_else(|| executable.parent())
        .ok_or("Redis 검사 도구 폴더를 확인하세요.")?;
    let mut process = local_process(executable, directory, argument)?;
    let mut stdout = process.child.stdout.take().ok_or(CHECK_FAILED)?;
    let mut tail = Vec::with_capacity(OUTPUT_LIMIT);
    let mut chunk = [0; 4096];
    let mut line = Vec::with_capacity(2048);
    let mut oversized = false;
    let mut highest_database = 0;
    loop {
        let size = stdout.read(&mut chunk).await.map_err(|_| CHECK_FAILED)?;
        if size == 0 {
            break;
        }
        let extra = (tail.len() + size).saturating_sub(OUTPUT_LIMIT);
        tail.drain(..extra);
        tail.extend_from_slice(&chunk[..size]);
        for segment in chunk[..size].split_inclusive(|byte| *byte == b'\n') {
            oversized |= line.len() + segment.len() > 2048;
            if !oversized {
                line.extend_from_slice(segment);
            }
            if segment.ends_with(b"\n") {
                if !oversized {
                    if let Some(database) = checker_database(&line) {
                        highest_database = highest_database.max(database);
                    }
                }
                oversized = false;
                line.clear();
            }
        }
    }
    if !process
        .child
        .wait()
        .await
        .is_ok_and(|status| status.success())
    {
        return Err(CHECK_FAILED.into());
    }
    Ok(CheckerOutput {
        text: String::from_utf8_lossy(&tail).into_owned(),
        highest_database,
    })
}

fn checker_database(line: &[u8]) -> Option<u64> {
    let line = std::str::from_utf8(line).ok()?.strip_prefix("[offset ")?;
    let (offset, message) = line.split_once("] Selecting DB ID ")?;
    if !offset.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    message.trim_end().parse().ok()
}
