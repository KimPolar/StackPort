use crate::{
    db_profiles::{DatabaseProfile, Settings},
    ssh, valid_name, Result, Store,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub type Profile = DatabaseProfile<ProfileSettings>;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    ServiceName,
    Sid,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Tcps,
    Tcp,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProfileSettings {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub target: Target,
    pub service: String,
    pub username: String,
    pub transport: Transport,
    pub ca_path: Option<String>,
    pub environment: String,
}

impl Settings for ProfileSettings {
    const ENGINE: &'static str = "oracle";
    const AUDIT_OPERATIONS: [&'static str; 3] = [
        "oracle_profile.create",
        "oracle_profile.update",
        "oracle_profile.delete",
    ];

    fn normalize(mut self) -> Result<Self> {
        self.name = valid_name(&self.name)?.into();
        self.host = ssh::normalize_host(&self.host)?;
        self.service = self.service.trim().into();
        if self.port == 0 {
            return Err("Oracle 포트는 1–65535 사이에서 지정하세요.".into());
        }
        if self.service.is_empty()
            || self.service.len() > 255
            || !self
                .service
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-$#".contains(&byte))
        {
            return Err("Oracle 서비스 이름 또는 SID를 확인하세요.".into());
        }
        if self.username.trim().is_empty()
            || self.username.len() > 128
            || self.username.chars().any(char::is_control)
        {
            return Err("Oracle 사용자 이름을 확인하세요.".into());
        }
        if self.ca_path.as_ref().is_some_and(|path| {
            self.transport != Transport::Tcps
                || path.len() > 32_768
                || path.contains('\0')
                || !Path::new(path).is_absolute()
        }) {
            return Err("TCPS를 선택하고 CA 인증서의 절대 경로를 지정하세요.".into());
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

impl ProfileSettings {
    pub(super) fn descriptor(&self) -> String {
        let target = match self.target {
            Target::ServiceName => "SERVICE_NAME",
            Target::Sid => "SID",
        };
        let protocol = match self.transport {
            Transport::Tcps => "TCPS",
            Transport::Tcp => "TCP",
        };
        let security = if self.transport == Transport::Tcps {
            "(SECURITY=(SSL_SERVER_DN_MATCH=YES))"
        } else {
            ""
        };
        format!("(DESCRIPTION=(ADDRESS=(PROTOCOL={protocol})(HOST={})(PORT={}))(CONNECT_DATA=({target}={})(SERVER=DEDICATED)){security})",
            self.host, self.port, self.service)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_service_and_sid_descriptors_parse_in_the_native_driver() {
        let settings = ProfileSettings {
            name: "test".into(),
            host: "localhost".into(),
            port: 2484,
            target: Target::ServiceName,
            service: "FREEPDB1".into(),
            username: "reader".into(),
            transport: Transport::Tcps,
            ca_path: None,
            environment: "DEV".into(),
        };
        for settings in [
            settings.clone(),
            ProfileSettings {
                target: Target::Sid,
                transport: Transport::Tcp,
                port: 1521,
                service: "FREE".into(),
                ..settings
            },
        ] {
            oracledb::Config::default()
                .set_connect_string(&settings.descriptor())
                .unwrap();
        }
    }
}

impl Store {
    pub fn list_oracle_profiles(&self, project: &str) -> Result<Vec<Profile>> {
        self.list_native_db_profiles(project)
    }

    pub fn oracle_profile(&self, id: &str, revision: i64) -> Result<Profile> {
        self.native_db_profile(id, revision)
    }

    pub fn create_oracle_profile(&self, project: &str, input: ProfileSettings) -> Result<Profile> {
        self.create_native_db_profile(project, input)
    }

    pub fn update_oracle_profile(
        &self,
        id: &str,
        revision: i64,
        input: ProfileSettings,
    ) -> Result<Profile> {
        self.update_native_db_profile(id, revision, input)
    }

    pub fn delete_oracle_profile(&self, id: &str, revision: i64) -> Result<()> {
        self.delete_native_db_profile::<ProfileSettings>(id, revision)
    }
}
