//! Versioned, credential-free SSH profile exchange.

use crate::{
    db_error, insert_audit,
    profile_exchange_file::{self, MAX_PROFILES},
    ssh_profiles::{from_row, profile_audit, validate, validate_stored, verify_saved},
    AuditRecord, Result, SshProfile, SshProfileInput, Store,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

const FORMAT: &str = "stackport.ssh-profiles";
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    format: String,
    version: u32,
    profiles: Vec<SshProfileInput>,
}

#[derive(Serialize)]
pub struct SshProfileImportPreview {
    pub digest: String,
    pub profiles: Vec<SshProfileInput>,
}

pub use crate::profile_exchange_file::ProfileExportReport as SshProfileExportReport;

fn read_document(path: &str) -> Result<SshProfileImportPreview> {
    let bytes = profile_exchange_file::read(path)?;
    let document: Document = serde_json::from_slice(&bytes)
        .map_err(|_| "지원하지 않거나 올바르지 않은 SSH 연결 파일입니다.")?;
    if document.format != FORMAT || document.version != VERSION {
        return Err("지원하지 않는 SSH 연결 파일 형식 또는 버전입니다.".into());
    }
    if document.profiles.is_empty() || document.profiles.len() > MAX_PROFILES {
        return Err("SSH 연결 파일에는 1~200개의 연결이 필요합니다.".into());
    }
    let profiles = document
        .profiles
        .into_iter()
        .map(validate)
        .collect::<Result<Vec<_>>>()?;
    Ok(SshProfileImportPreview {
        digest: profile_exchange_file::digest(&bytes),
        profiles,
    })
}

impl Store {
    /// Export exactly the confirmed snapshots, without credentials or trust pins.
    pub fn export_ssh_profiles(
        &self,
        project_id: &str,
        expected: Vec<SshProfile>,
        destination: &str,
    ) -> Result<SshProfileExportReport> {
        if expected.is_empty() || expected.len() > MAX_PROFILES {
            return Err("내보낼 SSH 연결을 1~200개 선택하세요.".into());
        }
        let mut seen = HashSet::new();
        if expected
            .iter()
            .any(|profile| !seen.insert(profile.id.as_str()))
        {
            return Err("같은 SSH 연결을 중복 선택할 수 없습니다.".into());
        }
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut profiles = Vec::with_capacity(expected.len());
        for snapshot in &expected {
            let current = tx.query_row("SELECT id, project_id, name, host, port, username, environment, revision FROM ssh_profiles WHERE id=?1", [&snapshot.id], from_row)
                .optional().map_err(db_error)?.ok_or("SSH 연결을 찾을 수 없습니다.")?;
            let current = validate_stored(current)?;
            if current != *snapshot || current.project_id != project_id {
                return Err("SSH 연결이 변경되었습니다. 새로고침하고 다시 선택하세요.".into());
            }
            profiles.push(SshProfileInput {
                name: current.name,
                host: current.host,
                port: current.port,
                username: current.username,
                environment: current.environment,
            });
        }
        let count = profiles.len();
        let bytes = serde_json::to_vec_pretty(&Document {
            format: FORMAT.into(),
            version: VERSION,
            profiles,
        })
        .map_err(|_| "SSH 연결을 내보낼 수 없습니다.")?;
        profile_exchange_file::export(
            self,
            tx,
            project_id,
            "ssh_profile.export",
            destination,
            &bytes,
            count,
        )
    }

    pub fn preview_ssh_profile_import(&self, path: &str) -> Result<SshProfileImportPreview> {
        read_document(path)
    }

    /// Re-read and compare the reviewed file, then add selected definitions atomically.
    pub fn import_ssh_profiles(
        &self,
        project_id: &str,
        path: &str,
        digest: &str,
        selected: Vec<usize>,
    ) -> Result<Vec<SshProfile>> {
        let preview = read_document(path)?;
        if preview.digest != digest {
            return Err("미리보기 이후 연결 파일이 변경되었습니다. 다시 확인하세요.".into());
        }
        if selected.is_empty() || selected.len() > MAX_PROFILES {
            return Err("가져올 SSH 연결을 하나 이상 선택하세요.".into());
        }
        let mut seen = HashSet::new();
        if selected
            .iter()
            .any(|index| *index >= preview.profiles.len() || !seen.insert(*index))
        {
            return Err("유효한 SSH 연결을 중복 없이 선택하세요.".into());
        }
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
                [project_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("프로젝트를 찾을 수 없습니다.".into());
        }
        let mut created = Vec::with_capacity(selected.len());
        for index in selected {
            let input = &preview.profiles[index];
            let profile = SshProfile {
                id: Uuid::new_v4().to_string(),
                project_id: project_id.into(),
                name: input.name.clone(),
                host: input.host.clone(),
                port: input.port,
                username: input.username.clone(),
                environment: input.environment.clone(),
                revision: 1,
            };
            tx.execute("INSERT INTO ssh_profiles(id, project_id, name, host, port, username, environment, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
                params![profile.id, profile.project_id, profile.name, profile.host, profile.port, profile.username, profile.environment]).map_err(db_error)?;
            profile_audit(&tx, "ssh_profile.create", &profile)?;
            created.push(profile);
        }
        insert_audit(
            &tx,
            AuditRecord {
                correlation_id: &Uuid::new_v4().to_string(),
                operation: "ssh_profile.import",
                project_id: Some(project_id),
                profile_id: None,
                environment: None,
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(created.len() as i64),
            },
        )?;
        for profile in &created {
            verify_saved(&tx, profile)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(created)
    }
}
