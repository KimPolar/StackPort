use crate::{
    db_profiles::{DatabaseProfile, Settings},
    valid_name, Result, Store,
};
use mongodb::options::ConnectionString;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub type MongoProfile = DatabaseProfile<MongoSettings>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MongoSettings {
    pub name: String,
    pub uri: String,
    pub username: Option<String>,
    pub auth_database: Option<String>,
    pub environment: String,
    pub tls: bool,
    pub ca_path: Option<String>,
}

impl Settings for MongoSettings {
    const ENGINE: &'static str = "mongodb";
    const AUDIT_OPERATIONS: [&'static str; 3] = [
        "mongo_profile.create",
        "mongo_profile.update",
        "mongo_profile.delete",
    ];

    fn normalize(mut self) -> Result<Self> {
        self.name = valid_name(&self.name)?.into();
        self.uri = self.uri.trim().into();
        parse_uri(&self.uri, self.tls)?;
        self.username = self.username.filter(|value| !value.is_empty());
        self.auth_database = self.auth_database.filter(|value| !value.is_empty());
        if self
            .username
            .as_deref()
            .is_some_and(|value| value.len() > 256 || value.chars().any(char::is_control))
        {
            return Err("MongoDB 사용자 이름을 확인하세요.".into());
        }
        if self
            .auth_database
            .as_ref()
            .is_some_and(|source| self.username.is_none() || !super::valid_database(source))
        {
            return Err("MongoDB 사용자 이름과 인증 데이터베이스를 확인하세요.".into());
        }
        if !matches!(self.environment.as_str(), "DEV" | "STAGING" | "PROD") {
            return Err("유효한 환경을 선택하세요.".into());
        }
        if self.ca_path.as_ref().is_some_and(|path| {
            !self.tls
                || path.len() > 32_768
                || path.contains('\0')
                || !Path::new(path).is_absolute()
        }) {
            return Err("TLS를 선택하고 CA 인증서의 절대 경로를 지정하세요.".into());
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

pub(super) fn parse_uri(uri: &str, tls: bool) -> Result<ConnectionString> {
    const INVALID: &str =
        "MongoDB 연결 주소를 확인하세요. mongodb:// 또는 mongodb+srv:// 주소를 사용하세요.";
    if uri.len() > 4096
        || uri
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || uri.contains('#')
    {
        return Err(INVALID.into());
    }
    let (scheme, rest) = uri.split_once("://").ok_or(INVALID)?;
    let host = rest.split(['/', '?']).next().unwrap_or("");
    if host.contains('@') {
        return Err("연결 주소에서 사용자 이름과 암호를 빼고 별도로 입력하세요.".into());
    }
    if scheme == "mongodb+srv" && !tls {
        return Err("MongoDB SRV 주소는 TLS로 연결하세요.".into());
    }
    if let Some((_, arguments)) = rest.split_once('?') {
        let safe = [
            "authsource",
            "replicaset",
            "directconnection",
            "loadbalanced",
            "retrywrites",
            "retryreads",
            "w",
            "appname",
            "readpreference",
        ];
        if arguments.split('&').any(|argument| {
            argument
                .split_once('=')
                .is_none_or(|(key, _)| !safe.contains(&key.to_ascii_lowercase().as_str()))
        }) {
            return Err(
                "MongoDB 주소의 옵션을 확인하세요. TLS와 인증서는 연결 설정에서 지정하세요.".into(),
            );
        }
    }
    // The driver only parses authSource into a credential when the URI includes a user.
    // Use a fixed placeholder to parse the option without putting the actual user in the URI.
    let mut conn =
        ConnectionString::parse(format!("{scheme}://stackport@{rest}")).map_err(|_| INVALID)?;
    if let Some(credential) = &mut conn.credential {
        credential.username = None;
    }
    Ok(conn)
}

impl Store {
    pub fn list_mongo_profiles(&self, project: &str) -> Result<Vec<MongoProfile>> {
        self.list_native_db_profiles(project)
    }
    pub fn mongo_profile(&self, id: &str, revision: i64) -> Result<MongoProfile> {
        self.native_db_profile(id, revision)
    }
    pub fn create_mongo_profile(
        &self,
        project: &str,
        input: MongoSettings,
    ) -> Result<MongoProfile> {
        self.create_native_db_profile(project, input)
    }
    pub fn update_mongo_profile(
        &self,
        id: &str,
        revision: i64,
        input: MongoSettings,
    ) -> Result<MongoProfile> {
        self.update_native_db_profile(id, revision, input)
    }
    pub fn delete_mongo_profile(&self, id: &str, revision: i64) -> Result<()> {
        self.delete_native_db_profile::<MongoSettings>(id, revision)
    }
}
