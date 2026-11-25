use crate::{db_error, insert_audit, require_changed, ssh, valid_name, AuditRecord, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub(crate) const SCHEMA: &str = "CREATE TABLE mysql_profiles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    name TEXT NOT NULL COLLATE NOCASE,
    settings_json TEXT NOT NULL,
    UNIQUE(project_id, name)
);";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MysqlSettings {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: Option<String>,
    pub username: String,
    pub environment: String,
    pub tls: bool,
    pub ca_path: Option<String>,
    pub client_certificate_path: Option<String>,
    pub client_key_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MysqlProfile {
    pub id: String,
    pub project_id: String,
    pub revision: i64,
    pub settings: MysqlSettings,
}

impl Store {
    pub fn list_mysql_profiles(&self, project_id: &str) -> Result<Vec<MysqlProfile>> {
        list(&self.connect()?, project_id)
    }

    pub fn mysql_profile(&self, id: &str, revision: i64) -> Result<MysqlProfile> {
        current(&self.connect()?, id, revision)
    }

    pub fn create_mysql_profile(
        &self,
        project_id: &str,
        input: MysqlSettings,
    ) -> Result<MysqlProfile> {
        let profile = MysqlProfile {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            revision: 1,
            settings: normalize(input)?,
        };
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let project_exists = tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM projects WHERE id=?1)",
                [project_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(db_error)?;
        if !project_exists {
            return Err("프로젝트를 찾을 수 없습니다.".into());
        }
        insert(&tx, &profile)?;
        audit(&tx, &profile, "mysql_profile.create")?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub fn update_mysql_profile(
        &self,
        id: &str,
        revision: i64,
        input: MysqlSettings,
    ) -> Result<MysqlProfile> {
        let settings = normalize(input)?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut profile = current(&tx, id, revision)?;
        profile.revision = revision
            .checked_add(1)
            .ok_or("연결 변경 버전이 너무 큽니다.")?;
        let changed = tx.execute(
            "UPDATE OR IGNORE mysql_profiles SET revision=?2, name=?3, settings_json=?4 WHERE id=?1",
            params![id, profile.revision, settings.name, encode(&settings)?],
        ).map_err(db_error)?;
        require_changed(
            changed,
            "이 프로젝트에 같은 이름의 MySQL 계열 연결이 있습니다.",
        )?;
        profile.settings = settings;
        audit(&tx, &profile, "mysql_profile.update")?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub fn delete_mysql_profile(&self, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile = current(&tx, id, revision)?;
        tx.execute("DELETE FROM mysql_profiles WHERE id=?1", [id])
            .map_err(db_error)?;
        audit(&tx, &profile, "mysql_profile.delete")?;
        tx.commit().map_err(db_error)
    }
}

pub(crate) fn copy_profiles(db: &Connection, source: &str, destination: &str) -> Result<usize> {
    let profiles = list(db, source)?;
    let count = profiles.len();
    for mut profile in profiles {
        profile.id = Uuid::new_v4().to_string();
        profile.project_id = destination.into();
        profile.revision = 1;
        insert(db, &profile)?;
    }
    Ok(count)
}

const COLUMNS: &str = "id, project_id, revision, name, settings_json";
const INVALID_PROFILE: &str = "저장된 MySQL 계열 연결 설정을 읽을 수 없습니다.";
type StoredProfile = (String, String, i64, String, String);

fn list(db: &Connection, project_id: &str) -> Result<Vec<MysqlProfile>> {
    let mut query = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM mysql_profiles WHERE project_id=?1 ORDER BY name, id"
        ))
        .map_err(db_error)?;
    let rows = query
        .query_map([project_id], stored_row)
        .map_err(db_error)?;
    rows.map(|row| decode(row.map_err(db_error)?)).collect()
}

fn current(db: &Connection, id: &str, revision: i64) -> Result<MysqlProfile> {
    let stored = db
        .query_row(
            &format!("SELECT {COLUMNS} FROM mysql_profiles WHERE id=?1"),
            [id],
            stored_row,
        )
        .optional()
        .map_err(db_error)?
        .ok_or("저장된 MySQL 계열 연결을 찾을 수 없습니다.")?;
    if stored.2 != revision {
        return Err("MySQL 연결이 변경되었습니다. 다시 선택하세요.".into());
    }
    decode(stored)
}

fn stored_row(row: &Row<'_>) -> rusqlite::Result<StoredProfile> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn decode((id, project_id, revision, name, json): StoredProfile) -> Result<MysqlProfile> {
    let settings: MysqlSettings = serde_json::from_str(&json).map_err(|_| INVALID_PROFILE)?;
    if revision <= 0 || name != settings.name || normalize(settings.clone())? != settings {
        return Err(INVALID_PROFILE.into());
    }
    Ok(MysqlProfile {
        id,
        project_id,
        revision,
        settings,
    })
}

fn encode(settings: &MysqlSettings) -> Result<String> {
    serde_json::to_string(settings).map_err(|_| "MySQL 계열 연결 설정을 저장할 수 없습니다.".into())
}

fn insert(db: &Connection, profile: &MysqlProfile) -> Result<()> {
    let changed = db.execute("INSERT INTO mysql_profiles (id, project_id, revision, name, settings_json) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(project_id,name) DO NOTHING",
        params![profile.id, profile.project_id, profile.revision, profile.settings.name, encode(&profile.settings)?],
    ).map_err(db_error)?;
    require_changed(
        changed,
        "이 프로젝트에 같은 이름의 MySQL 계열 연결이 있습니다.",
    )
}

fn normalize(mut settings: MysqlSettings) -> Result<MysqlSettings> {
    settings.name = valid_name(&settings.name)?.into();
    settings.host = ssh::normalize_host(&settings.host)?;
    ssh::validate_port(settings.port)?;
    if settings.username.is_empty()
        || settings.username.chars().count() > 128
        || settings.username.chars().any(char::is_control)
    {
        return Err("MySQL 사용자 이름을 확인하세요.".into());
    }
    if settings
        .database
        .as_deref()
        .is_some_and(|db| !super::valid_identifier(db))
    {
        return Err("시작 데이터베이스 이름을 확인하세요.".into());
    }
    if !matches!(settings.environment.as_str(), "DEV" | "STAGING" | "PROD") {
        return Err("유효한 환경을 선택하세요.".into());
    }
    if settings.ca_path.as_ref().is_some_and(|path| {
        !settings.tls
            || path.len() > 32_768
            || path.contains('\0')
            || !Path::new(path).is_absolute()
    }) {
        return Err("TLS를 선택하고 CA 인증서의 절대 경로를 지정하세요.".into());
    }
    match (&settings.client_certificate_path, &settings.client_key_path) {
        (None, None) => {}
        (Some(certificate), Some(key))
            if settings.tls
                && [certificate, key].iter().all(|path| {
                    path.len() <= 32_768 && !path.contains('\0') && Path::new(path).is_absolute()
                }) => {}
        _ => {
            return Err(
                "TLS를 선택하고 클라이언트 인증서와 개인 키의 절대 경로를 모두 지정하세요.".into(),
            )
        }
    }
    Ok(settings)
}

fn audit(db: &Connection, profile: &MysqlProfile, operation: &'static str) -> Result<()> {
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
            affected_count: Some(1),
        },
    )
}
