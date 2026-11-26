use super::{profiles, MysqlPassword, MysqlProfile};
use crate::{credential_store as vault, db_error, Result, Store};
use rusqlite::{Connection, TransactionBehavior};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub use crate::credential_store::CredentialStatus as MysqlCredentialStatus;

impl Store {
    pub fn mysql_credential_status(
        &self,
        id: &str,
        revision: i64,
    ) -> Result<MysqlCredentialStatus> {
        let profile = self.mysql_profile(id, revision)?;
        vault::status(&self.mysql_vault_target(id)?, &binding(&profile)?)
    }

    pub fn forget_mysql_password(&self, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile = profiles::current(&tx, id, revision)?;
        self.delete_mysql_password_if_present(id)?;
        profiles::audit(&tx, &profile, "mysql.credential.delete")?;
        tx.commit().map_err(db_error)
    }

    pub(super) fn delete_mysql_password_if_present(&self, id: &str) -> Result<()> {
        vault::delete(&self.mysql_vault_target(id)?)
    }

    pub(crate) fn delete_project_mysql_passwords(&self, db: &Connection, id: &str) -> Result<()> {
        let mut query = db
            .prepare("SELECT id FROM mysql_profiles WHERE project_id=?1")
            .map_err(db_error)?;
        let ids = query
            .query_map([id], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        for id in ids {
            self.delete_mysql_password_if_present(&id.map_err(db_error)?)?;
        }
        Ok(())
    }

    pub(super) fn saved_mysql_password(&self, profile: &MysqlProfile) -> Result<MysqlPassword> {
        let binding = binding(profile)?;
        vault::read(&self.mysql_vault_target(&profile.id)?, |blob| {
            vault::password_bytes(blob, &binding)
                .map(|password| MysqlPassword(Zeroizing::new(password.to_owned())))
        })?
        .flatten()
        .ok_or_else(|| "현재 연결 설정에 저장된 MySQL 암호가 없습니다.".into())
    }

    pub(super) fn remember_mysql_password(
        &self,
        expected: &MysqlProfile,
        password: &MysqlPassword,
    ) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile = profiles::current(&tx, &expected.id, expected.revision)?;
        if profile != *expected {
            return Err("MySQL 연결이 변경되었습니다. 다시 선택하세요.".into());
        }
        vault::save(
            &self.mysql_vault_target(&profile.id)?,
            &binding(&profile)?,
            &password.0,
        )?;
        profiles::audit(&tx, &profile, "mysql.credential.save")?;
        tx.commit().map_err(db_error)
    }

    fn mysql_vault_target(&self, id: &str) -> Result<String> {
        vault::target(self, "MySQL", id)
    }
}

fn binding(profile: &MysqlProfile) -> Result<[u8; vault::BINDING_BYTES]> {
    let settings =
        serde_json::to_vec(profile).map_err(|_| "MySQL 연결 설정을 확인할 수 없습니다.")?;
    Ok(Sha256::digest(settings).into())
}
