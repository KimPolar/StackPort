use crate::{
    db_profiles::{DatabaseProfile, Settings},
    ssh, valid_name, Result, Store,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub type Profile = DatabaseProfile<ProfileSettings>;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Authentication {
    SqlLogin,
    Windows,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Encryption {
    Required,
    Strict,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProfileSettings {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub authentication: Authentication,
    pub username: Option<String>,
    pub encryption: Encryption,
    pub ca_path: Option<String>,
    pub environment: String,
}

impl Settings for ProfileSettings {
    const ENGINE: &'static str = "sql_server";
    const AUDIT_OPERATIONS: [&'static str; 3] = [
        "sql_server_profile.create",
        "sql_server_profile.update",
        "sql_server_profile.delete",
    ];

    fn normalize(mut self) -> Result<Self> {
        self.name = valid_name(&self.name)?.into();
        self.host = ssh::normalize_host(&self.host)?;
        if self.port == 0 {
            return Err("SQL Server 포트는 1–65535 사이에서 지정하세요.".into());
        }
        if !valid_identifier(&self.database) {
            return Err("SQL Server 데이터베이스 이름을 확인하세요.".into());
        }
        match self.authentication {
            Authentication::SqlLogin if !self.username.as_deref().is_some_and(valid_identifier) => {
                return Err("SQL Server 로그인 이름을 입력하세요.".into());
            }
            Authentication::Windows if self.username.is_some() => {
                return Err("Windows 통합 인증은 현재 Windows 계정을 사용합니다.".into());
            }
            _ => {}
        }
        if self.ca_path.as_ref().is_some_and(|path| {
            path.len() > 32_768 || path.contains('\0') || !Path::new(path).is_absolute()
        }) {
            return Err("SQL Server CA 인증서의 절대 경로를 지정하세요.".into());
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

pub(super) fn valid_identifier(value: &str) -> bool {
    !value.trim().is_empty()
        && value.encode_utf16().count() <= 128
        && !value.chars().any(char::is_control)
}

impl Store {
    pub fn list_sql_server_profiles(&self, project: &str) -> Result<Vec<Profile>> {
        self.list_native_db_profiles(project)
    }

    pub fn sql_server_profile(&self, id: &str, revision: i64) -> Result<Profile> {
        self.native_db_profile(id, revision)
    }

    pub fn create_sql_server_profile(
        &self,
        project: &str,
        input: ProfileSettings,
    ) -> Result<Profile> {
        self.create_native_db_profile(project, input)
    }

    pub fn update_sql_server_profile(
        &self,
        id: &str,
        revision: i64,
        input: ProfileSettings,
    ) -> Result<Profile> {
        self.update_native_db_profile(id, revision, input)
    }

    pub fn delete_sql_server_profile(&self, id: &str, revision: i64) -> Result<()> {
        self.delete_native_db_profile::<ProfileSettings>(id, revision)
    }
}
