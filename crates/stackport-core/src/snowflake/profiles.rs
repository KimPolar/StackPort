use crate::{
    db_profiles::{DatabaseProfile, Settings},
    valid_name, Result, Store,
};
use serde::{Deserialize, Serialize};

const ACCOUNT_SUFFIX: &str = ".snowflakecomputing.com";

pub type Profile = DatabaseProfile<ProfileSettings>;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Auth {
    Pat,
    Oauth,
}

impl Auth {
    pub(super) fn header(self) -> &'static str {
        match self {
            Self::Pat => "PROGRAMMATIC_ACCESS_TOKEN",
            Self::Oauth => "OAUTH",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProfileSettings {
    pub name: String,
    pub host: String,
    pub database: String,
    pub warehouse: Option<String>,
    pub role: Option<String>,
    pub auth: Auth,
    pub environment: String,
}

impl Settings for ProfileSettings {
    const ENGINE: &'static str = "snowflake";
    const AUDIT_OPERATIONS: [&'static str; 3] = [
        "snowflake_profile.create",
        "snowflake_profile.update",
        "snowflake_profile.delete",
    ];

    fn normalize(mut self) -> Result<Self> {
        self.name = valid_name(&self.name)?.into();
        self.host = account_host(&self.host)?;
        for identifier in std::iter::once(&self.database)
            .chain(self.warehouse.as_ref())
            .chain(self.role.as_ref())
        {
            if !valid_identifier(identifier) {
                return Err("Snowflake 데이터베이스, 웨어하우스와 역할 이름을 확인하세요.".into());
            }
        }
        if !matches!(self.environment.as_str(), "DEV" | "STAGING" | "PROD") {
            return Err("유효한 환경을 선택하세요.".into());
        }
        Ok(self)
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn environment(&self) -> &str {
        &self.environment
    }
}

fn account_host(value: &str) -> Result<String> {
    let host = value.trim().to_ascii_lowercase().replace('_', "-");
    let account = host.strip_suffix(ACCOUNT_SUFFIX).unwrap_or(&host);
    if account.len() + ACCOUNT_SUFFIX.len() > 253
        || account.split('.').any(|label| {
            label.len() > 63
                || !label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                || !label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err("Snowflake 계정 식별자 또는 계정 호스트를 확인하세요.".into());
    }
    Ok(format!("{account}{ACCOUNT_SUFFIX}"))
}

pub(super) fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= 255 && !value.chars().any(char::is_control)
}

impl Store {
    pub fn list_snowflake_profiles(&self, project: &str) -> Result<Vec<Profile>> {
        self.list_native_db_profiles(project)
    }

    pub fn snowflake_profile(&self, id: &str, revision: i64) -> Result<Profile> {
        self.native_db_profile(id, revision)
    }

    pub fn create_snowflake_profile(
        &self,
        project: &str,
        input: ProfileSettings,
    ) -> Result<Profile> {
        self.create_native_db_profile(project, input)
    }

    pub fn update_snowflake_profile(
        &self,
        id: &str,
        revision: i64,
        input: ProfileSettings,
    ) -> Result<Profile> {
        self.update_native_db_profile(id, revision, input)
    }

    pub fn delete_snowflake_profile(&self, id: &str, revision: i64) -> Result<()> {
        self.delete_native_db_profile::<ProfileSettings>(id, revision)
    }
}
