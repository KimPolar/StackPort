//! Restore standalone SQLite backup images into new files. A restore only
//! publishes the reviewed bytes after checking the staged database independently.

use super::{db_error, insert_audit, quote_identifier, AuditRecord, Result, Store};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

const PREVIEW_LIFETIME: Duration = Duration::from_secs(300);
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
const SIDECARS: [&str; 3] = ["-journal", "-wal", "-shm"];

#[derive(Debug, Serialize)]
pub struct RestorePreview {
    pub token: String,
    pub source: String,
    pub destination: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub user_version: i64,
    pub objects: i64,
    pub tables: usize,
    pub rows: u64,
    pub expires_seconds: u64,
}

#[derive(Debug, Serialize)]
pub struct RestoreReport {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub objects: i64,
    pub tables: usize,
    pub rows: u64,
    pub integrity: &'static str,
    pub audit_warning: Option<String>,
}

#[derive(PartialEq, Eq)]
struct ImageStats {
    user_version: i64,
    objects: i64,
    table_rows: Vec<(String, u64)>,
    rows: u64,
}

#[derive(PartialEq, Eq)]
struct Checksum {
    sha256: String,
    size_bytes: u64,
}

struct RestorePlan {
    token: String,
    created: Instant,
    project_id: String,
    source: PathBuf,
    destination: PathBuf,
    checksum: Checksum,
    stats: ImageStats,
}

#[derive(Default)]
pub(crate) struct RestoreManager {
    preview: Mutex<Option<RestorePlan>>,
}

impl Store {
    pub fn preview_sqlite_restore(
        &self,
        project_id: &str,
        source: &str,
        destination: &str,
    ) -> Result<RestorePreview> {
        require_project(&self.connect()?, project_id)?;
        let source = absolute_path(source)?
            .canonicalize()
            .map_err(|_| "백업 파일 경로를 확인할 수 없습니다.")?;
        let requested = absolute_path(destination)?;
        let parent = requested
            .parent()
            .ok_or("복원 대상 폴더를 지정하세요.")?
            .canonicalize()
            .map_err(|_| "복원 대상 폴더를 열 수 없습니다.")?;
        let destination = parent.join(
            requested
                .file_name()
                .ok_or("복원 파일 이름을 입력하세요.")?,
        );
        check_destination(&destination)?;
        let checksum = read_image(&source, None)?;
        let stats = inspect_image(&source)?;
        if checksum != read_image(&source, None)? {
            return Err("검사 도중 백업 파일이 바뀌었습니다. 다시 미리보세요.".into());
        }
        let token = Uuid::new_v4().to_string();
        let preview = RestorePreview {
            token: token.clone(),
            source: source.to_string_lossy().into_owned(),
            destination: destination.to_string_lossy().into_owned(),
            sha256: checksum.sha256.clone(),
            size_bytes: checksum.size_bytes,
            user_version: stats.user_version,
            objects: stats.objects,
            tables: stats.table_rows.len(),
            rows: stats.rows,
            expires_seconds: PREVIEW_LIFETIME.as_secs(),
        };
        *self
            .restore
            .preview
            .lock()
            .map_err(|_| "복원 상태를 사용할 수 없습니다.")? = Some(RestorePlan {
            token,
            created: Instant::now(),
            project_id: project_id.into(),
            source,
            destination,
            checksum,
            stats,
        });
        Ok(preview)
    }

    pub fn restore_sqlite(&self, token: &str, confirmed: bool) -> Result<RestoreReport> {
        if !confirmed {
            return Err("미리보기를 확인한 뒤 복원하세요.".into());
        }
        let plan = {
            let mut preview = self
                .restore
                .preview
                .lock()
                .map_err(|_| "복원 상태를 사용할 수 없습니다.")?;
            if preview.as_ref().is_some_and(|entry| entry.token == token) {
                preview.take()
            } else {
                None
            }
        }
        .filter(|plan| plan.created.elapsed() < PREVIEW_LIFETIME)
        .ok_or("복원 미리보기가 없거나 만료되었습니다. 다시 미리보세요.")?;

        let correlation_id = Uuid::new_v4().to_string();
        let audit = |outcome, affected_count| AuditRecord {
            correlation_id: &correlation_id,
            operation: "sqlite.restore",
            project_id: Some(&plan.project_id),
            profile_id: None,
            environment: None,
            object_name: None,
            outcome,
            affected_count,
        };
        let db = self.connect()?;
        require_project(&db, &plan.project_id)?;
        insert_audit(&db, audit("started", None))?;
        drop(db);
        let mut result = restore_image(&plan);
        let (outcome, count) = if result.is_ok() {
            ("succeeded", Some(1))
        } else {
            ("failed", None)
        };
        if self
            .connect()
            .and_then(|db| insert_audit(&db, audit(outcome, count)))
            .is_err()
        {
            match &mut result {
                Ok(report) => {
                    report.audit_warning =
                        Some("복원은 완료됐지만 완료 감사 기록을 저장하지 못했습니다.".into())
                }
                Err(error) => error.push_str(" 완료 감사 기록도 저장하지 못했습니다."),
            }
        }
        result
    }
}

fn require_project(db: &Connection, project: &str) -> Result<()> {
    let exists = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [project],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_error)?;
    if !exists {
        return Err("복원 작업의 프로젝트를 찾을 수 없습니다.".into());
    }
    Ok(())
}

fn absolute_path(value: &str) -> Result<&Path> {
    let path = Path::new(value.trim());
    let name = path.file_name().and_then(|name| name.to_str());
    if !path.is_absolute()
        || name.is_none()
        || (cfg!(windows) && name.is_some_and(|name| name.contains(':')))
    {
        return Err("SQLite 파일의 절대 경로를 입력하세요.".into());
    }
    Ok(path)
}

fn check_destination(path: &Path) -> Result<()> {
    if !path.parent().is_some_and(|parent| parent.is_dir()) {
        return Err("복원 대상 폴더를 찾을 수 없습니다.".into());
    }
    if exists(path)? {
        return Err("복원 대상 파일이 이미 있습니다. 새 파일 이름을 지정하세요.".into());
    }
    require_no_sidecars(path)
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("파일 경로에 접근할 수 없습니다.".into()),
    }
}

fn require_no_sidecars(path: &Path) -> Result<()> {
    for suffix in SIDECARS {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        if exists(Path::new(&name))? {
            return Err("SQLite 저널 또는 WAL 보조 파일이 있습니다. 독립된 백업과 새 복원 경로를 선택하세요.".into());
        }
    }
    Ok(())
}

fn read_image(path: &Path, mut destination: Option<&mut File>) -> Result<Checksum> {
    require_no_sidecars(path)?;
    // Check before opening so a path to a directory, pipe or device is never read.
    if !fs::metadata(path).is_ok_and(|metadata| metadata.is_file()) {
        return Err("일반 SQLite 백업 파일을 선택하세요.".into());
    }
    let mut source = File::open(path).map_err(|_| "백업 파일을 열 수 없습니다.")?;
    let expected_size = source
        .metadata()
        .map_err(|_| "백업 파일 크기를 확인할 수 없습니다.")?
        .len();
    let mut header = [0; 100];
    source
        .read_exact(&mut header)
        .map_err(|_| "SQLite 백업 헤더를 읽을 수 없습니다.")?;
    if &header[..16] != b"SQLite format 3\0" || header[18..20] != [1, 1] {
        return Err("별도 저널이 필요 없는 SQLite 백업 파일을 선택하세요.".into());
    }
    let mut sha = Sha256::new();
    sha.update(header);
    if let Some(file) = destination.as_deref_mut() {
        file.write_all(&header)
            .map_err(|e| format!("복원 파일을 쓸 수 없습니다: {e}"))?;
    }
    let mut size_bytes = header.len() as u64;
    let mut bytes = [0; 64 * 1024];
    loop {
        let count = source
            .read(&mut bytes)
            .map_err(|_| "백업 파일을 읽을 수 없습니다.")?;
        if count == 0 {
            break;
        }
        size_bytes += count as u64;
        if size_bytes > expected_size {
            return Err("읽는 동안 백업 파일 크기가 바뀌었습니다.".into());
        }
        sha.update(&bytes[..count]);
        if let Some(file) = destination.as_deref_mut() {
            file.write_all(&bytes[..count])
                .map_err(|e| format!("복원 파일을 쓸 수 없습니다: {e}"))?;
        }
    }
    if size_bytes != expected_size {
        return Err("읽는 동안 백업 파일 크기가 바뀌었습니다.".into());
    }
    require_no_sidecars(path)?;
    Ok(Checksum {
        sha256: format!("{:x}", sha.finalize()),
        size_bytes,
    })
}

fn inspect_image(path: &Path) -> Result<ImageStats> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(db_error)?;
    db.busy_timeout(Duration::from_secs(3)).map_err(db_error)?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN DEFERRED;")
        .map_err(db_error)?;
    let start = Instant::now();
    db.progress_handler(10_000, Some(move || start.elapsed() >= VERIFY_TIMEOUT));
    let check: String = db
        .query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))
        .map_err(db_error)?;
    if check != "ok" {
        return Err("SQLite 무결성 검사를 통과하지 못했습니다.".into());
    }
    let user_version = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    let objects = db.query_row(
        "SELECT count(*) FROM main.sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_' COLLATE NOCASE",
        [], |row| row.get(0),
    ).map_err(db_error)?;
    let mut tables = db.prepare(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND substr(name, 1, 7) <> 'sqlite_' COLLATE NOCASE ORDER BY name",
    ).map_err(db_error)?;
    let table_names = tables
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?;
    let mut table_rows = Vec::new();
    let mut rows: u64 = 0;
    for name in table_names {
        let name = name.map_err(db_error)?;
        let identifier = quote_identifier(&name);
        let count: u64 = db
            .query_row(
                &format!("SELECT count(*) FROM main.{identifier}"),
                [],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        rows = rows
            .checked_add(count)
            .ok_or("복원 검증의 총 행 수가 너무 큽니다.")?;
        table_rows.push((name, count));
    }
    Ok(ImageStats {
        user_version,
        objects,
        table_rows,
        rows,
    })
}

fn restore_image(plan: &RestorePlan) -> Result<RestoreReport> {
    let destination = &plan.destination;
    check_destination(destination)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".stackport-restore-")
        .tempfile_in(destination.parent().ok_or("복원 대상 폴더를 지정하세요.")?)
        .map_err(|e| format!("복원 임시 파일을 만들 수 없습니다: {e}"))?;
    if read_image(&plan.source, Some(temporary.as_file_mut()))? != plan.checksum {
        return Err("미리보기 후 백업 파일이 바뀌었습니다. 다시 미리보세요.".into());
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("복원 파일을 디스크에 기록할 수 없습니다: {e}"))?;
    if inspect_image(temporary.path())? != plan.stats
        || read_image(temporary.path(), None)? != plan.checksum
    {
        return Err("미리보기와 복원 파일의 검사 결과가 다릅니다.".into());
    }
    check_destination(destination)?;
    temporary
        .persist_noclobber(destination)
        .map_err(|error| format!("복원 파일을 저장할 수 없습니다: {}", error.error))?;
    Ok(RestoreReport {
        path: destination.to_string_lossy().into_owned(),
        sha256: plan.checksum.sha256.clone(),
        size_bytes: plan.checksum.size_bytes,
        objects: plan.stats.objects,
        tables: plan.stats.table_rows.len(),
        rows: plan.stats.rows,
        integrity: "ok",
        audit_warning: None,
    })
}
