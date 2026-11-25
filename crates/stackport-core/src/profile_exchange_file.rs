use crate::{insert_audit, AuditRecord, Result, Store};
use rusqlite::Transaction;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};
use uuid::Uuid;

pub(crate) const MAX_BYTES: usize = 1_048_576;
pub(crate) const MAX_PROFILES: usize = 200;

#[derive(Serialize)]
pub struct ProfileExportReport {
    pub path: String,
    pub count: usize,
    pub audit_warning: Option<String>,
}

pub(crate) fn read(path: &str) -> Result<Vec<u8>> {
    let path = Path::new(path.trim());
    if !path.is_absolute() {
        return Err("가져올 연결 파일의 절대 경로를 지정하세요.".into());
    }
    let file = File::open(path).map_err(|_| "연결 파일을 열 수 없습니다.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "연결 파일을 확인할 수 없습니다.")?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 {
        return Err("연결 파일은 1 MiB 이하의 일반 파일이어야 합니다.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "연결 파일을 읽을 수 없습니다.")?;
    if bytes.len() > MAX_BYTES {
        return Err("연결 파일은 1 MiB 이하여야 합니다.".into());
    }
    Ok(bytes)
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn export(
    store: &Store,
    tx: Transaction<'_>,
    project_id: &str,
    operation: &'static str,
    destination: &str,
    bytes: &[u8],
    count: usize,
) -> Result<ProfileExportReport> {
    if bytes.len() > MAX_BYTES {
        return Err("연결 파일이 1 MiB를 초과합니다. 선택한 연결을 줄이세요.".into());
    }
    let correlation = Uuid::new_v4().to_string();
    let audit = |outcome, affected_count| AuditRecord {
        correlation_id: &correlation,
        operation,
        project_id: Some(project_id),
        profile_id: None,
        environment: None,
        object_name: None,
        outcome,
        affected_count,
    };
    insert_audit(&tx, audit("started", None))?;
    tx.commit().map_err(crate::db_error)?;
    let result = write(destination, bytes);
    let outcome = if result.is_ok() {
        "succeeded"
    } else {
        "failed"
    };
    let audit_result = store.connect().and_then(|db| {
        insert_audit(
            &db,
            audit(outcome, result.as_ref().ok().map(|_| count as i64)),
        )
    });
    match (result, audit_result) {
        (Ok(()), audit_result) => Ok(ProfileExportReport {
            path: destination.trim().into(),
            count,
            audit_warning: audit_result
                .err()
                .map(|_| "파일은 저장됐지만 완료 감사 기록을 저장하지 못했습니다.".into()),
        }),
        (Err(error), Err(_)) => Err(format!("{error} 완료 감사 기록도 저장하지 못했습니다.")),
        (Err(error), Ok(())) => Err(error),
    }
}

fn write(destination: &str, bytes: &[u8]) -> Result<()> {
    let path = Path::new(destination.trim());
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("새 연결 파일의 절대 경로를 지정하세요.".into());
    }
    let parent = path.parent().ok_or("저장 폴더를 찾을 수 없습니다.")?;
    if !parent.is_dir() {
        return Err("저장 폴더가 없거나 접근할 수 없습니다.".into());
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".stackport-connection-export-")
        .tempfile_in(parent)
        .map_err(|_| "연결 파일을 저장할 수 없습니다.")?;
    temporary
        .write_all(bytes)
        .map_err(|_| "연결 파일을 기록할 수 없습니다.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "연결 파일을 디스크에 기록할 수 없습니다.")?;
    temporary
        .persist_noclobber(path)
        .map_err(|_| "연결 파일을 저장할 수 없습니다. 기존 파일은 덮어쓰지 않습니다.")?;
    Ok(())
}
