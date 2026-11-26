use super::{MongoManager, MongoPassword, MongoProfile, MongoSettings};
use crate::{Result, Store};

pub use crate::credential_store::CredentialStatus as MongoCredentialStatus;

pub enum MongoAuthentication {
    Entered {
        password: MongoPassword,
        remember: bool,
    },
    Saved,
}

impl From<MongoPassword> for MongoAuthentication {
    fn from(password: MongoPassword) -> Self {
        Self::Entered {
            password,
            remember: false,
        }
    }
}

impl MongoAuthentication {
    pub fn requested(
        password: Option<MongoPassword>,
        use_saved: bool,
        remember: bool,
    ) -> Result<Self> {
        match (password, use_saved, remember) {
            (None, true, false) => Ok(Self::Saved),
            (Some(password), false, remember) => Ok(Self::Entered { password, remember }),
            _ => Err("MongoDB 암호를 입력하거나 저장한 암호를 선택하세요.".into()),
        }
    }
}

impl Store {
    pub fn mongo_credential_status(
        &self,
        id: &str,
        revision: i64,
    ) -> Result<MongoCredentialStatus> {
        self.native_db_credential_status::<MongoSettings>(id, revision, "MongoDB")
    }

    pub fn forget_mongo_password(&self, id: &str, revision: i64) -> Result<()> {
        self.forget_native_db_password::<MongoSettings>(id, revision, "mongo.credential.delete")
    }
}

impl MongoManager {
    pub(super) async fn mongo_password(
        &self,
        profile: &MongoProfile,
        authentication: MongoAuthentication,
    ) -> Result<(MongoPassword, bool)> {
        let (password, remember) = match authentication {
            MongoAuthentication::Entered { password, remember } => (password, remember),
            MongoAuthentication::Saved => {
                let store = self.store.clone();
                let expected = profile.clone();
                let secret = tokio::task::spawn_blocking(move || {
                    store.saved_native_db_password(&expected, "MongoDB")
                })
                .await
                .map_err(|_| "저장된 MongoDB 암호를 읽을 수 없습니다.")??
                .ok_or("현재 연결 설정에 저장된 MongoDB 암호가 없습니다.")?;
                (MongoPassword(secret), false)
            }
        };
        if password.0.len() > 4096
            || (profile.settings.username.is_none() && !password.0.is_empty())
        {
            return Err("MongoDB 사용자 이름과 암호를 확인하세요.".into());
        }
        Ok((password, remember))
    }
}
