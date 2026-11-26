//! Opt-in PostgreSQL credentials in the operating system's per-user vault.
use super::{profiles::find, PostgresPassword, PostgresProfile};
pub use crate::credential_store::CredentialStatus as PostgresCredentialStatus;
use crate::credential_store::{self as platform, BINDING_BYTES};
use crate::{db_error, insert_audit, AuditRecord, Result, Store};
use rusqlite::{Connection, TransactionBehavior};
use uuid::Uuid;

const NO_PASSWORD: &str = "현재 연결 설정에 저장된 PostgreSQL 암호가 없습니다.";
const PROFILE_CHANGED: &str = "PostgreSQL 연결이 변경되었습니다. 새로고침하세요.";

impl Store {
    pub fn postgres_credential_status(
        &self,
        expected: &PostgresProfile,
    ) -> Result<PostgresCredentialStatus> {
        current_profile(&self.connect()?, expected)?;
        platform::status(&self.postgres_vault_target(&expected.id)?, &binding(expected)?)
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
        platform::delete_project_passwords(self, db, id, "PostgreSQL", "postgres_profiles")
    }

    pub(super) fn saved_postgres_password(
        &self,
        expected: &PostgresProfile,
    ) -> Result<PostgresPassword> {
        current_profile(&self.connect()?, expected)?;
        platform::load_password(&self.postgres_vault_target(&expected.id)?, &binding(expected)?)?
            .map(PostgresPassword)
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
        platform::save(
            &self.postgres_vault_target(&expected.id)?,
            &binding(expected)?,
            &password.0,
        )?;
        audit(&tx, expected, "postgres.credential.save")?;
        tx.commit().map_err(db_error)
    }

    fn postgres_vault_target(&self, id: &str) -> Result<String> {
        platform::target(self, "PostgreSQL", id)
    }
}

fn current_profile(db: &Connection, expected: &PostgresProfile) -> Result<()> {
    if find(db, &expected.id)? != *expected {
        return Err(PROFILE_CHANGED.into());
    }
    Ok(())
}

fn binding(profile: &PostgresProfile) -> Result<[u8; BINDING_BYTES]> {
    platform::binding(profile, "PostgreSQL")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_store::password_bytes;
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
