use super::{profiles, RedisAuthentication, RedisPassword, RedisProfile};
use crate::{credential_store as vault, db_error, Result, Store};
use rusqlite::{Connection, TransactionBehavior};

pub use crate::credential_store::CredentialStatus as RedisCredentialStatus;

impl Store {
    pub fn redis_credential_status(
        &self,
        id: &str,
        revision: i64,
    ) -> Result<RedisCredentialStatus> {
        let profile = self.redis_profile(id, revision)?;
        vault::status(
            &self.redis_vault_target(id)?,
            &vault::binding(&profile, "Redis")?,
        )
    }

    pub fn forget_redis_password(&self, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile = profiles::current(&tx, id, revision)?;
        self.delete_redis_password_if_present(id)?;
        profiles::audit(&tx, &profile, "redis.credential.delete")?;
        tx.commit().map_err(db_error)
    }

    pub(super) fn delete_redis_password_if_present(&self, id: &str) -> Result<()> {
        vault::delete(&self.redis_vault_target(id)?)
    }

    pub(crate) fn delete_project_redis_passwords(&self, db: &Connection, id: &str) -> Result<()> {
        vault::delete_project_passwords(self, db, id, "Redis", "redis_profiles")
    }

    pub(super) fn redis_password(
        &self,
        profile: &RedisProfile,
        authentication: RedisAuthentication,
    ) -> Result<(RedisPassword, bool)> {
        let (password, remember) = match authentication {
            RedisAuthentication::Entered { password, remember } => (password, remember),
            RedisAuthentication::Saved => {
                let binding = vault::binding(profile, "Redis")?;
                let secret =
                    vault::load_password(&self.redis_vault_target(&profile.id)?, &binding)?
                        .ok_or("현재 연결 설정에 저장된 Redis 암호가 없습니다.")?;
                (RedisPassword(secret), false)
            }
        };
        if password.0.len() > 4096 {
            return Err("Redis 암호가 너무 깁니다.".into());
        }
        Ok((password, remember))
    }

    pub(super) fn remember_redis_password(
        &self,
        expected: &RedisProfile,
        password: &RedisPassword,
    ) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile = profiles::current(&tx, &expected.id, expected.revision)?;
        if profile != *expected {
            return Err("Redis 연결이 변경되었습니다. 다시 선택하세요.".into());
        }
        vault::save(
            &self.redis_vault_target(&profile.id)?,
            &vault::binding(&profile, "Redis")?,
            &password.0,
        )?;
        profiles::audit(&tx, &profile, "redis.credential.save")?;
        tx.commit().map_err(db_error)
    }

    fn redis_vault_target(&self, id: &str) -> Result<String> {
        vault::target(self, "Redis", id)
    }
}
