use crate::{db_error, insert_audit, require_changed, ssh, valid_name, AuditRecord, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub(crate) const SCHEMA: &str = "CREATE TABLE redis_profiles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    name TEXT NOT NULL COLLATE NOCASE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
    database_index INTEGER NOT NULL CHECK(database_index >= 0),
    username TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment IN ('DEV','STAGING','PROD')),
    tls INTEGER NOT NULL CHECK(tls IN (0,1)),
    ca_path TEXT,
    UNIQUE(project_id, name)
);";

const COLUMNS: &str = "id, project_id, revision, name, host, port, database_index, username, environment, tls, ca_path";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RedisSettings {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: u32,
    pub username: String,
    pub environment: String,
    pub tls: bool,
    pub ca_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RedisProfile {
    pub id: String,
    pub project_id: String,
    pub revision: i64,
    pub settings: RedisSettings,
}

impl Store {
    pub fn list_redis_profiles(&self, project_id: &str) -> Result<Vec<RedisProfile>> {
        list(&self.connect()?, project_id)
    }

    pub fn redis_profile(&self, id: &str, revision: i64) -> Result<RedisProfile> {
        current(&self.connect()?, id, revision)
    }

    pub fn create_redis_profile(
        &self,
        project_id: &str,
        input: RedisSettings,
    ) -> Result<RedisProfile> {
        let input = normalize(input)?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM projects WHERE id=?1)",
                [project_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("프로젝트를 찾을 수 없습니다.".into());
        }
        let profile = create_on(&tx, project_id, input)?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub fn update_redis_profile(
        &self,
        id: &str,
        revision: i64,
        input: RedisSettings,
    ) -> Result<RedisProfile> {
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
            "UPDATE OR IGNORE redis_profiles SET revision=?2, name=?3, host=?4, port=?5, database_index=?6,
                username=?7, environment=?8, tls=?9, ca_path=?10 WHERE id=?1",
            params![id, profile.revision, settings.name, settings.host, settings.port, settings.database,
                settings.username, settings.environment, settings.tls, settings.ca_path],
        ).map_err(db_error)?;
        require_changed(changed, "이 프로젝트에 같은 이름의 Redis 연결이 있습니다.")?;
        profile.settings = settings;
        audit(&tx, &profile, "redis_profile.update")?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub fn delete_redis_profile(&self, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile = current(&tx, id, revision)?;
        tx.execute("DELETE FROM redis_profiles WHERE id=?1", [id])
            .map_err(db_error)?;
        audit(&tx, &profile, "redis_profile.delete")?;
        self.delete_redis_password_if_present(id)?;
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

pub(crate) fn list(db: &Connection, project_id: &str) -> Result<Vec<RedisProfile>> {
    let mut statement = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM redis_profiles WHERE project_id=?1 ORDER BY name, id"
        ))
        .map_err(db_error)?;
    let rows = statement
        .query_map([project_id], from_row)
        .map_err(db_error)?;
    rows.map(|row| validate(row.map_err(db_error)?)).collect()
}

pub(crate) fn current(db: &Connection, id: &str, revision: i64) -> Result<RedisProfile> {
    let profile = find(db, id)?;
    if profile.revision != revision {
        return Err("Redis 연결이 변경되었습니다. 다시 선택하세요.".into());
    }
    Ok(profile)
}

pub(crate) fn find(db: &Connection, id: &str) -> Result<RedisProfile> {
    let profile = db
        .query_row(
            &format!("SELECT {COLUMNS} FROM redis_profiles WHERE id=?1"),
            [id],
            from_row,
        )
        .optional()
        .map_err(db_error)?
        .ok_or("저장된 Redis 연결을 찾을 수 없습니다.")?;
    validate(profile)
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RedisProfile> {
    Ok(RedisProfile {
        id: row.get(0)?,
        project_id: row.get(1)?,
        revision: row.get(2)?,
        settings: RedisSettings {
            name: row.get(3)?,
            host: row.get(4)?,
            port: row.get(5)?,
            database: row.get(6)?,
            username: row.get(7)?,
            environment: row.get(8)?,
            tls: row.get(9)?,
            ca_path: row.get(10)?,
        },
    })
}

pub(crate) fn create_on(
    db: &Connection,
    project_id: &str,
    settings: RedisSettings,
) -> Result<RedisProfile> {
    let profile = RedisProfile {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.to_owned(),
        revision: 1,
        settings,
    };
    insert(db, &profile)?;
    audit(db, &profile, "redis_profile.create")?;
    Ok(profile)
}

fn insert(db: &Connection, profile: &RedisProfile) -> Result<()> {
    let input = &profile.settings;
    let changed = db.execute(
        "INSERT INTO redis_profiles (id, project_id, revision, name, host, port, database_index, username, environment, tls, ca_path)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(project_id,name) DO NOTHING",
        params![profile.id, profile.project_id, profile.revision, input.name, input.host, input.port, input.database,
            input.username, input.environment, input.tls, input.ca_path],
    ).map_err(db_error)?;
    require_changed(changed, "이 프로젝트에 같은 이름의 Redis 연결이 있습니다.")
}

pub(crate) fn normalize(mut settings: RedisSettings) -> Result<RedisSettings> {
    settings.name = valid_name(&settings.name)?.into();
    if settings.name.encode_utf16().count() > 80 || settings.name.chars().any(char::is_control) {
        return Err("연결 이름은 제어 문자 없이 80자 이하로 입력하세요.".into());
    }
    settings.host = ssh::normalize_host(&settings.host)?;
    ssh::validate_port(settings.port)?;
    if settings.username.len() > 1024 || settings.username.contains('\0') {
        return Err("Redis ACL 사용자 이름을 확인하세요.".into());
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
        return Err("TLS를 선택하고 PEM CA 인증서의 절대 경로를 지정하세요.".into());
    }
    Ok(settings)
}

fn validate(profile: RedisProfile) -> Result<RedisProfile> {
    if profile.revision <= 0 || normalize(profile.settings.clone())? != profile.settings {
        return Err("저장된 Redis 연결을 확인할 수 없습니다.".into());
    }
    Ok(profile)
}

pub(super) fn audit(db: &Connection, profile: &RedisProfile, operation: &'static str) -> Result<()> {
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
