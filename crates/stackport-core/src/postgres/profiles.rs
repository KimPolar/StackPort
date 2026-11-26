use crate::{db_error, insert_audit, require_changed, ssh, valid_name, AuditRecord, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub(crate) const SCHEMA: &str = "CREATE TABLE postgres_profiles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    name TEXT NOT NULL COLLATE NOCASE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
    database_name TEXT NOT NULL,
    username TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment IN ('DEV', 'STAGING', 'PROD')),
    ca_path TEXT,
    UNIQUE(project_id, name)
);";

const COLUMNS: &str =
    "id, project_id, revision, name, host, port, database_name, username, environment, ca_path";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PostgresProfileInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub environment: String,
    pub ca_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PostgresProfile {
    pub id: String,
    pub project_id: String,
    pub revision: i64,
    pub settings: PostgresProfileInput,
}

impl Store {
    pub fn list_postgres_profiles(&self, project_id: &str) -> Result<Vec<PostgresProfile>> {
        list(&self.connect()?, project_id)
    }

    pub fn postgres_profile(&self, id: &str) -> Result<PostgresProfile> {
        find(&self.connect()?, id)
    }

    pub fn create_postgres_profile(
        &self,
        project_id: &str,
        input: PostgresProfileInput,
    ) -> Result<PostgresProfile> {
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

    pub fn update_postgres_profile(
        &self,
        id: &str,
        revision: i64,
        input: PostgresProfileInput,
    ) -> Result<PostgresProfile> {
        let settings = normalize(input)?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut profile = find(&tx, id)?;
        check_revision(&profile, revision)?;
        profile.revision = revision
            .checked_add(1)
            .ok_or("연결 변경 버전이 너무 큽니다.")?;
        profile.settings = settings;
        let input = &profile.settings;
        let changed = tx.execute(
            "UPDATE OR IGNORE postgres_profiles SET revision=?2, name=?3, host=?4, port=?5, database_name=?6, username=?7, environment=?8, ca_path=?9 WHERE id=?1",
            params![id, profile.revision, input.name, input.host, input.port, input.database, input.username, input.environment, input.ca_path],
        ).map_err(db_error)?;
        require_changed(
            changed,
            "이 프로젝트에 같은 이름의 PostgreSQL 연결이 있습니다.",
        )?;
        audit(&tx, &profile, "postgres_profile.update")?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub fn delete_postgres_profile(&self, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile = find(&tx, id)?;
        check_revision(&profile, revision)?;
        require_changed(
            tx.execute("DELETE FROM postgres_profiles WHERE id=?1", [id])
                .map_err(db_error)?,
            "연결을 찾을 수 없습니다.",
        )?;
        audit(&tx, &profile, "postgres_profile.delete")?;
        self.delete_postgres_password_if_present(id)?;
        tx.commit().map_err(db_error)
    }
}

pub(crate) fn copy_profiles(db: &Connection, source: &str, destination: &str) -> Result<usize> {
    let profiles = list(db, source)?;
    let mut count = profiles.len();
    for mut profile in profiles {
        let source_id = std::mem::replace(&mut profile.id, Uuid::new_v4().to_string());
        profile.project_id = destination.into();
        profile.revision = 1;
        insert(db, &profile)?;
        count += crate::workspace_favorites::copy_project_favorites(
            db,
            source,
            destination,
            &source_id,
            &profile.id,
        )?;
    }
    Ok(count)
}

pub(crate) fn list(db: &Connection, project: &str) -> Result<Vec<PostgresProfile>> {
    let mut statement = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM postgres_profiles WHERE project_id=?1 ORDER BY name, id"
        ))
        .map_err(db_error)?;
    let rows = statement.query_map([project], from_row).map_err(db_error)?;
    rows.map(|row| validate(row.map_err(db_error)?)).collect()
}

pub(crate) fn find(db: &Connection, id: &str) -> Result<PostgresProfile> {
    let profile = db
        .query_row(
            &format!("SELECT {COLUMNS} FROM postgres_profiles WHERE id=?1"),
            [id],
            from_row,
        )
        .optional()
        .map_err(db_error)?
        .ok_or("PostgreSQL 연결을 찾을 수 없습니다.")?;
    validate(profile)
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PostgresProfile> {
    Ok(PostgresProfile {
        id: row.get(0)?,
        project_id: row.get(1)?,
        revision: row.get(2)?,
        settings: PostgresProfileInput {
            name: row.get(3)?,
            host: row.get(4)?,
            port: row.get(5)?,
            database: row.get(6)?,
            username: row.get(7)?,
            environment: row.get(8)?,
            ca_path: row.get(9)?,
        },
    })
}

pub(crate) fn create_on(
    db: &Connection,
    project_id: &str,
    settings: PostgresProfileInput,
) -> Result<PostgresProfile> {
    let profile = PostgresProfile {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.into(),
        revision: 1,
        settings,
    };
    insert(db, &profile)?;
    audit(db, &profile, "postgres_profile.create")?;
    Ok(profile)
}

fn insert(db: &Connection, profile: &PostgresProfile) -> Result<()> {
    let input = &profile.settings;
    let changed = db.execute(
        &format!("INSERT INTO postgres_profiles ({COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(project_id,name) DO NOTHING"),
        params![profile.id, profile.project_id, profile.revision, input.name, input.host, input.port, input.database, input.username, input.environment, input.ca_path],
    ).map_err(db_error)?;
    require_changed(
        changed,
        "이 프로젝트에 같은 이름의 PostgreSQL 연결이 있습니다.",
    )
}

pub(crate) fn normalize(mut input: PostgresProfileInput) -> Result<PostgresProfileInput> {
    input.name = valid_name(&input.name)?.into();
    if input.name.encode_utf16().count() > 80 || input.name.chars().any(char::is_control) {
        return Err("연결 이름은 제어 문자 없이 80자 이하로 입력하세요.".into());
    }
    input.host = ssh::normalize_host(&input.host)?;
    ssh::validate_port(input.port)?;
    if [&input.database, &input.username]
        .into_iter()
        .any(|text| text.is_empty() || text.len() > 1024 || text.contains('\0'))
    {
        return Err("PostgreSQL 데이터베이스 이름과 사용자 이름을 확인하세요.".into());
    }
    if !matches!(input.environment.as_str(), "DEV" | "STAGING" | "PROD") {
        return Err("유효한 환경을 선택하세요.".into());
    }
    if input.ca_path.as_ref().is_some_and(|path| {
        path.len() > 32_768 || path.contains('\0') || !Path::new(path).is_absolute()
    }) {
        return Err("CA 인증서의 절대 경로를 선택하세요.".into());
    }
    Ok(input)
}

fn validate(profile: PostgresProfile) -> Result<PostgresProfile> {
    if profile.revision <= 0 || normalize(profile.settings.clone())? != profile.settings {
        return Err("저장된 PostgreSQL 연결을 확인할 수 없습니다.".into());
    }
    Ok(profile)
}

fn check_revision(profile: &PostgresProfile, revision: i64) -> Result<()> {
    if revision != profile.revision {
        return Err("PostgreSQL 연결이 변경되었습니다. 새로고침하세요.".into());
    }
    Ok(())
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
            affected_count: Some(1),
        },
    )
}
