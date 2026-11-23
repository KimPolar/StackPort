//! Project-scoped SSH connection definitions without credentials.

use crate::{db_error, insert_audit, ssh, valid_name, AuditRecord, Result, Store};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshProfile {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub environment: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SshProfileInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub environment: String,
}

pub(crate) fn validate(input: SshProfileInput) -> Result<SshProfileInput> {
    let name = valid_name(&input.name)?.to_owned();
    let host = ssh::normalize_host(&input.host)?;
    ssh::validate_port(input.port)?;
    let username = ssh::normalize_username(&input.username)?;
    if !matches!(input.environment.as_str(), "DEV" | "STAGING" | "PROD") {
        return Err("유효한 환경을 선택하세요.".into());
    }
    Ok(SshProfileInput {
        name,
        host,
        port: input.port,
        username,
        environment: input.environment,
    })
}

pub(crate) fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SshProfile> {
    Ok(SshProfile {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        host: row.get(3)?,
        port: row.get(4)?,
        username: row.get(5)?,
        environment: row.get(6)?,
        revision: row.get(7)?,
    })
}

pub(crate) fn validate_stored(profile: SshProfile) -> Result<SshProfile> {
    let input = validate(SshProfileInput {
        name: profile.name.clone(),
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        environment: profile.environment.clone(),
    })
    .map_err(|_| "저장된 SSH 연결이 유효하지 않습니다. 연결하지 않았습니다.")?;
    if profile.revision <= 0
        || input.name != profile.name
        || input.host != profile.host
        || input.username != profile.username
        || input.environment != profile.environment
    {
        return Err("저장된 SSH 연결이 유효하지 않습니다. 연결하지 않았습니다.".into());
    }
    Ok(profile)
}

pub(crate) fn verify_saved(db: &rusqlite::Connection, profile: &SshProfile) -> Result<()> {
    let saved = db.query_row("SELECT id, project_id, name, host, port, username, environment, revision FROM ssh_profiles WHERE id=?1", [&profile.id], from_row)
        .optional().map_err(db_error)?;
    if saved.as_ref() != Some(profile) {
        return Err("SSH 연결 저장 결과가 달라 변경을 취소했습니다.".into());
    }
    Ok(())
}

impl Store {
    pub fn list_ssh_profiles(&self, project_id: &str) -> Result<Vec<SshProfile>> {
        let db = self.connect()?;
        let mut statement = db.prepare("SELECT id, project_id, name, host, port, username, environment, revision FROM ssh_profiles WHERE project_id=?1 ORDER BY name COLLATE NOCASE, id").map_err(db_error)?;
        let profiles = statement
            .query_map([project_id], from_row)
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        profiles.into_iter().map(validate_stored).collect()
    }

    pub fn ssh_profile(&self, id: &str) -> Result<SshProfile> {
        let profile = self.connect()?.query_row("SELECT id, project_id, name, host, port, username, environment, revision FROM ssh_profiles WHERE id=?1", [id], from_row)
            .optional().map_err(db_error)?.ok_or("SSH 연결을 찾을 수 없습니다.")?;
        validate_stored(profile)
    }

    pub fn create_ssh_profile(
        &self,
        project_id: &str,
        input: SshProfileInput,
    ) -> Result<SshProfile> {
        let input = validate(input)?;
        let profile = SshProfile {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            name: input.name,
            host: input.host,
            port: input.port,
            username: input.username,
            environment: input.environment,
            revision: 1,
        };
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
        tx.execute("INSERT INTO ssh_profiles(id, project_id, name, host, port, username, environment, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
            params![profile.id, profile.project_id, profile.name, profile.host, profile.port, profile.username, profile.environment]).map_err(db_error)?;
        profile_audit(&tx, "ssh_profile.create", &profile)?;
        verify_saved(&tx, &profile)?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub fn update_ssh_profile(
        &self,
        id: &str,
        revision: i64,
        input: SshProfileInput,
    ) -> Result<SshProfile> {
        let input = validate(input)?;
        if revision <= 0 {
            return Err("유효하지 않은 SSH 연결 버전입니다.".into());
        }
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut profile = validate_stored(tx.query_row("SELECT id, project_id, name, host, port, username, environment, revision FROM ssh_profiles WHERE id=?1", [id], from_row)
            .optional().map_err(db_error)?.ok_or("SSH 연결을 찾을 수 없습니다.")?)?;
        if profile.revision != revision {
            return Err(
                "다른 창에서 SSH 연결이 변경되었습니다. 새로고침 후 다시 시도하세요.".into(),
            );
        }
        profile.name = input.name;
        profile.host = input.host;
        profile.port = input.port;
        profile.username = input.username;
        profile.environment = input.environment;
        profile.revision = profile
            .revision
            .checked_add(1)
            .ok_or("SSH 연결 버전이 너무 큽니다.")?;
        tx.execute("UPDATE ssh_profiles SET name=?2, host=?3, port=?4, username=?5, environment=?6, revision=?7 WHERE id=?1",
            params![profile.id, profile.name, profile.host, profile.port, profile.username, profile.environment, profile.revision]).map_err(db_error)?;
        profile_audit(&tx, "ssh_profile.update", &profile)?;
        verify_saved(&tx, &profile)?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub fn delete_ssh_profile(&self, id: &str, revision: i64) -> Result<()> {
        if revision <= 0 {
            return Err("유효하지 않은 SSH 연결 버전입니다.".into());
        }
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile = validate_stored(tx.query_row("SELECT id, project_id, name, host, port, username, environment, revision FROM ssh_profiles WHERE id=?1", [id], from_row)
            .optional().map_err(db_error)?.ok_or("SSH 연결을 찾을 수 없습니다.")?)?;
        if profile.revision != revision {
            return Err(
                "다른 창에서 SSH 연결이 변경되었습니다. 새로고침 후 다시 시도하세요.".into(),
            );
        }
        let changed = tx
            .execute("DELETE FROM ssh_profiles WHERE id=?1", [id])
            .map_err(db_error)?;
        if changed != 1 {
            return Err("SSH 연결을 삭제하지 못했습니다.".into());
        }
        profile_audit(&tx, "ssh_profile.delete", &profile)?;
        let remains: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ssh_profiles WHERE id=?1)",
                [id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if remains {
            return Err("SSH 연결 삭제 결과를 확인할 수 없어 변경을 취소했습니다.".into());
        }
        tx.commit().map_err(db_error)
    }
}

pub(crate) fn profile_audit(
    db: &rusqlite::Connection,
    operation: &'static str,
    profile: &SshProfile,
) -> Result<()> {
    insert_audit(
        db,
        AuditRecord {
            correlation_id: &Uuid::new_v4().to_string(),
            operation,
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(&profile.environment),
            object_name: None,
            outcome: "succeeded",
            affected_count: Some(1),
        },
    )
}
