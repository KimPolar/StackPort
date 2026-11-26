//! Opt-in PostgreSQL credentials in the operating system's per-user vault.
#[cfg(windows)]
mod windows;

use super::{profiles::find, PostgresPassword, PostgresProfile};
use crate::{db_error, insert_audit, AuditRecord, Result, Store};
use rusqlite::{Connection, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

const BINDING_BYTES: usize = 32;
const NO_PASSWORD: &str = "현재 연결 설정에 저장된 PostgreSQL 암호가 없습니다.";
const PROFILE_CHANGED: &str = "PostgreSQL 연결이 변경되었습니다. 새로고침하세요.";

#[derive(Serialize)]
pub struct PostgresCredentialStatus {
    supported: bool,
    stored: bool,
    pub(crate) usable: bool,
}

impl Store {
    pub fn postgres_credential_status(
        &self,
        expected: &PostgresProfile,
    ) -> Result<PostgresCredentialStatus> {
        current_profile(&self.connect()?, expected)?;
        let binding = binding(expected)?;
        let status = platform::read(&self.postgres_vault_target(&expected.id)?, |blob| {
            password_bytes(blob, &binding).is_some()
        })?;
        Ok(PostgresCredentialStatus {
            supported: cfg!(windows),
            stored: status.is_some(),
            usable: status == Some(true),
        })
    }

    pub fn forget_postgres_password(&self, expected: &PostgresProfile) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        current_profile(&tx, expected)?;
        self.delete_postgres_password_if_present(&expected.id)?;
        audit(&tx, expected, "postgres.credential.delete")?;
        tx.commit().map_err(db_error)
    }

    pub(crate) fn delete_postgres_password_if_present(&self, id: &str) -> Result<()> {
        platform::delete(&self.postgres_vault_target(id)?)
    }

    pub(crate) fn delete_project_postgres_passwords(
        &self,
        db: &Connection,
        id: &str,
    ) -> Result<()> {
        let mut directive = db
            .prepare("SELECT id FROM postgres_profiles WHERE project_id=?1")
            .map_err(db_error)?;
        let ids = directive
            .query_map([id], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        for id in ids {
            self.delete_postgres_password_if_present(&id.map_err(db_error)?)?;
        }
        Ok(())
    }

    pub(super) fn saved_postgres_password(
        &self,
        expected: &PostgresProfile,
    ) -> Result<PostgresPassword> {
        current_profile(&self.connect()?, expected)?;
        let binding = binding(expected)?;
        platform::read(&self.postgres_vault_target(&expected.id)?, |blob| {
            password_bytes(blob, &binding)
                .map(|password| PostgresPassword(Zeroizing::new(password.to_owned())))
        })?
        .flatten()
        .ok_or_else(|| NO_PASSWORD.into())
    }

    pub(super) fn remember_postgres_password(
        &self,
        expected: &PostgresProfile,
        password: &PostgresPassword,
    ) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        current_profile(&tx, expected)?;
        let binding = binding(expected)?;
        let mut blob = Zeroizing::new(Vec::with_capacity(BINDING_BYTES + password.0.len()));
        blob.extend_from_slice(&binding);
        blob.extend_from_slice(password.0.as_bytes());
        platform::write(&self.postgres_vault_target(&expected.id)?, &mut blob)?;
        audit(&tx, expected, "postgres.credential.save")?;
        tx.commit().map_err(db_error)
    }

    fn postgres_vault_target(&self, id: &str) -> Result<String> {
        let workspace = self
            .path
            .canonicalize()
            .map_err(|_| "작업 공간 위치를 확인할 수 없습니다.")?;
        let mut name = Sha256::new();
        name.update(b"StackPort PostgreSQL credential v1\0");
        name.update(workspace.as_os_str().as_encoded_bytes());
        name.update(b"\0");
        name.update(id.as_bytes());
        Ok(format!("StackPort/PostgreSQL/{:x}", name.finalize()))
    }
}

fn current_profile(db: &Connection, expected: &PostgresProfile) -> Result<()> {
    if find(db, &expected.id)? != *expected {
        return Err(PROFILE_CHANGED.into());
    }
    Ok(())
}

fn binding(profile: &PostgresProfile) -> Result<[u8; BINDING_BYTES]> {
    let settings =
        serde_json::to_vec(profile).map_err(|_| "PostgreSQL 연결 설정을 확인할 수 없습니다.")?;
    Ok(Sha256::digest(settings).into())
}

fn password_bytes<'a>(blob: &'a [u8], binding: &[u8; BINDING_BYTES]) -> Option<&'a str> {
    let (saved, secret) = blob.split_at_checked(BINDING_BYTES)?;
    if saved != binding || secret.is_empty() {
        return None;
    }
    let password = std::str::from_utf8(secret).ok()?;
    (!password.contains('\0')).then_some(password)
}

fn audit(db: &Connection, profile: &PostgresProfile, operation: &'static str) -> Result<()> {
    insert_audit(
        db,
        AuditRecord {
            correlation_id: &Uuid::new_v4().to_string(),
            operation,
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(&profile.settings.environment),
            object_name: None,
            outcome: "succeeded",
            affected_count: None,
        },
    )
}

#[cfg(windows)]
use windows as platform;

#[cfg(not(windows))]
mod platform {
    use crate::Result;
    pub(super) fn read<T>(_: &str, _: impl FnOnce(&[u8]) -> T) -> Result<Option<T>> {
        Ok(None)
    }
    pub(super) fn write(_: &str, _: &mut [u8]) -> Result<()> {
        Err("이 환경에서는 PostgreSQL 암호 저장을 지원하지 않습니다.".into())
    }
    pub(super) fn delete(_: &str) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PostgresProfileInput;

    #[test]
    fn password_blob_is_bound_to_identity_and_all_profile_settings() {
        let mut profile = PostgresProfile {
            id: "local".into(),
            project_id: "test".into(),
            revision: 1,
            settings: PostgresProfileInput {
                name: "original".into(),
                host: "db.example.test".into(),
                port: 5432,
                database: "postgres".into(),
                username: "reader".into(),
                environment: "DEV".into(),
                ca_path: None,
            },
        };
        let initial = binding(&profile).unwrap();
        let mut blob = initial.to_vec();
        assert!(password_bytes(&blob, &initial).is_none());
        blob.extend_from_slice("가상 단어".as_bytes());
        assert_eq!(password_bytes(&blob, &initial), Some("가상 단어"));
        profile.settings.host = "changed.example.test".into();
        assert!(password_bytes(&blob, &binding(&profile).unwrap()).is_none());
        profile.settings.host = "db.example.test".into();
        profile.revision += 1;
        assert!(password_bytes(&blob, &binding(&profile).unwrap()).is_none());
        blob.push(0);
        assert!(password_bytes(&blob, &initial).is_none());
    }
}
