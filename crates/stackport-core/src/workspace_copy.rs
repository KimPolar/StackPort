//! Copy the local metadata stores into a new, verified working directory.

use super::{
    db_error, insert_audit, open_user_db, snapshot_sqlite, AuditRecord, Result, Store,
    SCHEMA_VERSION,
};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const WORKSPACE_FILE: &str = "workspace.sqlite";
const TRUST_FILE: &str = "ssh-trust.sqlite";

#[derive(Debug, Serialize)]
pub struct WorkspaceCopyPreview {
    pub source: String,
    pub destination: String,
    pub include_trust: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceCopyFile {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceCopyReport {
    pub directory: String,
    pub files: Vec<WorkspaceCopyFile>,
    pub audit_warning: Option<String>,
}

impl Store {
    pub fn preview_workspace_copy(
        &self,
        destination: &str,
        include_trust: bool,
    ) -> Result<WorkspaceCopyPreview> {
        let source = self
            .path
            .parent()
            .ok_or("원본 작업 공간 폴더를 찾을 수 없습니다.")?;
        let target = destination_path(destination)?;
        let trust_file = source.join(TRUST_FILE);
        let trust = include_trust && path_exists(&trust_file)?;
        if trust && !trust_file.is_file() {
            return Err("SSH 호스트 신뢰 저장소를 읽을 수 없습니다.".into());
        }
        Ok(WorkspaceCopyPreview {
            source: source.to_string_lossy().into_owned(),
            destination: target.to_string_lossy().into_owned(),
            include_trust: trust,
        })
    }

    pub fn copy_workspace(
        &self,
        destination: &str,
        include_trust: bool,
        reviewed_trust: bool,
    ) -> Result<WorkspaceCopyReport> {
        let preview = self.preview_workspace_copy(destination, include_trust)?;
        if preview.include_trust != reviewed_trust {
            return Err("미리보기 이후 SSH 신뢰 저장소가 바뀌었습니다. 다시 확인하세요.".into());
        }
        let mut result = self.copy_workspace_to(Path::new(&preview.destination), reviewed_trust);
        let (outcome, count) = match &result {
            Ok(report) => ("succeeded", Some(report.files.len() as i64)),
            Err(_) => ("failed", None),
        };
        let audit = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(db_error)
            .and_then(|db| {
                db.busy_timeout(std::time::Duration::from_secs(5))
                    .map_err(db_error)?;
                insert_audit(
                    &db,
                    AuditRecord {
                        correlation_id: &Uuid::new_v4().to_string(),
                        operation: "workspace.copy",
                        project_id: None,
                        profile_id: None,
                        environment: None,
                        object_name: None,
                        outcome,
                        affected_count: count,
                    },
                )
            });
        if audit.is_err() {
            match &mut result {
                Ok(report) => {
                    report.audit_warning =
                        Some("작업 공간을 복사했지만 작업 기록을 저장하지 못했습니다.".into())
                }
                Err(error) => error.push_str(" 작업 기록도 저장하지 못했습니다."),
            }
        }
        result
    }

    fn copy_workspace_to(
        &self,
        destination: &Path,
        include_trust: bool,
    ) -> Result<WorkspaceCopyReport> {
        let parent = destination.parent().ok_or("복사 위치를 지정하세요.")?;
        let staging = tempfile::Builder::new()
            .prefix(".stackport-workspace-")
            .tempdir_in(parent)
            .map_err(|error| format!("작업 공간 임시 폴더를 만들 수 없습니다: {error}"))?;
        let mut files = vec![copy_database(
            &self.path,
            staging.path(),
            WORKSPACE_FILE,
            Some(SCHEMA_VERSION),
        )?];
        if include_trust {
            let trust = self.path.with_file_name(TRUST_FILE);
            files.push(copy_database(&trust, staging.path(), TRUST_FILE, None)?);
        }
        publish(staging.path(), destination)?;
        let _ = staging.keep();
        Ok(WorkspaceCopyReport {
            directory: destination.to_string_lossy().into_owned(),
            files,
            audit_warning: None,
        })
    }
}

fn destination_path(destination: &str) -> Result<PathBuf> {
    if !cfg!(windows) {
        return Err("작업 공간 폴더 복사는 현재 Windows에서 지원합니다.".into());
    }
    let requested = Path::new(destination.trim());
    let name = requested.file_name().ok_or("새 폴더 이름을 지정하세요.")?;
    if !requested.is_absolute() || name.to_string_lossy().contains(':') {
        return Err("복사할 새 폴더의 절대 경로를 지정하세요.".into());
    }
    let parent = requested
        .parent()
        .ok_or("복사 위치를 지정하세요.")?
        .canonicalize()
        .map_err(|_| "복사 위치의 상위 폴더를 열 수 없습니다.")?;
    if !parent.is_dir() {
        return Err("복사 위치의 상위 폴더를 지정하세요.".into());
    }
    let target = parent.join(name);
    if path_exists(&target)? {
        return Err("대상 경로가 이미 있습니다. 새 폴더를 지정하세요.".into());
    }
    Ok(target)
}

fn path_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("작업 공간 경로에 접근할 수 없습니다.".into()),
    }
}

fn copy_database(
    source: &Path,
    staging: &Path,
    name: &'static str,
    version: Option<i64>,
) -> Result<WorkspaceCopyFile> {
    let database = open_user_db(source)?;
    let target = staging.join(name);
    let copied = snapshot_sqlite(&database, &target, version)?;
    let mut file = File::open(&target).map_err(|_| "복사한 파일을 읽을 수 없습니다.")?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "복사한 파일의 SHA-256을 계산할 수 없습니다.")?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(WorkspaceCopyFile {
        name,
        bytes: copied.size_bytes,
        sha256: format!("{:x}", digest.finalize()),
    })
}

#[cfg(windows)]
fn publish(staging: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileW;
    let source: Vec<u16> = staging.as_os_str().encode_wide().chain([0]).collect();
    let target: Vec<u16> = destination.as_os_str().encode_wide().chain([0]).collect();
    if source[..source.len() - 1].contains(&0) || target[..target.len() - 1].contains(&0) {
        return Err("올바른 Windows 폴더 경로를 지정하세요.".into());
    }
    // The staging directory is adjacent, and MoveFileW refuses an existing destination.
    if unsafe { MoveFileW(source.as_ptr(), target.as_ptr()) } == 0 {
        return Err(format!(
            "작업 공간을 새 폴더에 게시할 수 없습니다: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish(_staging: &Path, _destination: &Path) -> Result<()> {
    Err("작업 공간 폴더 복사는 현재 Windows에서 지원합니다.".into())
}
