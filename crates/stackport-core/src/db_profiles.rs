use crate::{db_error, insert_audit, require_changed, AuditRecord, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{de::DeserializeOwned, Serialize};
use uuid::Uuid;

pub(crate) const SCHEMA: &str = "CREATE TABLE native_db_profiles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    name TEXT NOT NULL COLLATE NOCASE,
    settings_json TEXT NOT NULL,
    UNIQUE(project_id, engine, name)
);";

const INVALID: &str = "저장된 데이터베이스 연결 설정을 읽을 수 없습니다.";
const DUPLICATE: &str = "이 프로젝트에 같은 종류와 이름의 데이터베이스 연결이 있습니다.";
const COLUMNS: &str = "id, project_id, revision, name, settings_json";

pub(crate) trait Settings: DeserializeOwned + Serialize {
    const ENGINE: &'static str;
    const AUDIT_OPERATIONS: [&'static str; 3];
    fn normalize(self) -> Result<Self>;
    fn name(&self) -> &str;
    fn environment(&self) -> &str;
}

#[derive(Clone, Debug, Serialize)]
pub struct DatabaseProfile<T> {
    pub id: String,
    pub project_id: String,
    pub revision: i64,
    pub settings: T,
}

impl Store {
    pub(crate) fn list_native_db_profiles<T: Settings>(
        &self,
        project: &str,
    ) -> Result<Vec<DatabaseProfile<T>>> {
        let db = self.connect()?;
        let mut statement = db
            .prepare(&format!(
                "SELECT {COLUMNS} FROM native_db_profiles WHERE project_id=?1 AND engine=?2
             AND NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id=?1)
             ORDER BY name, id"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![project, T::ENGINE], row)
            .map_err(db_error)?;
        rows.map(|item| decode(item.map_err(db_error)?)).collect()
    }

    pub(crate) fn native_db_profile<T: Settings>(
        &self,
        id: &str,
        revision: i64,
    ) -> Result<DatabaseProfile<T>> {
        current(&self.connect()?, id, revision)
    }

    pub(crate) fn create_native_db_profile<T: Settings>(
        &self,
        project: &str,
        input: T,
    ) -> Result<DatabaseProfile<T>> {
        let profile = DatabaseProfile {
            id: Uuid::new_v4().to_string(),
            project_id: project.into(),
            revision: 1,
            settings: input.normalize()?,
        };
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM projects WHERE id=?1 AND NOT EXISTS
                (SELECT 1 FROM project_archives WHERE project_id=?1))",
                [project],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("활성 프로젝트를 찾을 수 없습니다.".into());
        }
        insert(
            &tx,
            &profile.id,
            project,
            T::ENGINE,
            profile.settings.name(),
            &encode(&profile.settings)?,
        )?;
        audit(&tx, &profile, T::AUDIT_OPERATIONS[0])?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub(crate) fn update_native_db_profile<T: Settings>(
        &self,
        id: &str,
        revision: i64,
        input: T,
    ) -> Result<DatabaseProfile<T>> {
        let settings = input.normalize()?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut profile: DatabaseProfile<T> = current(&tx, id, revision)?;
        profile.revision = revision
            .checked_add(1)
            .ok_or("연결 변경 버전이 너무 큽니다.")?;
        let changed = tx.execute(
            "UPDATE OR IGNORE native_db_profiles SET revision=?2, name=?3, settings_json=?4 WHERE id=?1",
            params![id, profile.revision, settings.name(), encode(&settings)?]
        ).map_err(db_error)?;
        require_changed(changed, DUPLICATE)?;
        profile.settings = settings;
        audit(&tx, &profile, T::AUDIT_OPERATIONS[1])?;
        tx.commit().map_err(db_error)?;
        Ok(profile)
    }

    pub(crate) fn delete_native_db_profile<T: Settings>(
        &self,
        id: &str,
        revision: i64,
    ) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile: DatabaseProfile<T> = current(&tx, id, revision)?;
        tx.execute("DELETE FROM native_db_profiles WHERE id=?1", [id])
            .map_err(db_error)?;
        audit(&tx, &profile, T::AUDIT_OPERATIONS[2])?;
        tx.commit().map_err(db_error)
    }
}

pub(crate) fn copy_profiles(db: &Connection, source: &str, destination: &str) -> Result<usize> {
    let mut statement = db
        .prepare("SELECT engine, name, settings_json FROM native_db_profiles WHERE project_id=?1")
        .map_err(db_error)?;
    let rows = statement
        .query_map([source], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(db_error)?;
    let profiles = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    for (engine, name, settings) in &profiles {
        insert(
            db,
            &Uuid::new_v4().to_string(),
            destination,
            engine,
            name,
            settings,
        )?;
    }
    Ok(profiles.len())
}

fn current<T: Settings>(db: &Connection, id: &str, revision: i64) -> Result<DatabaseProfile<T>> {
    let stored = db.query_row(&format!(
        "SELECT {COLUMNS} FROM native_db_profiles WHERE id=?1 AND engine=?2
         AND NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id=native_db_profiles.project_id)"
    ), params![id, T::ENGINE], row).optional().map_err(db_error)?
        .ok_or("저장된 데이터베이스 연결을 찾을 수 없습니다.")?;
    if stored.2 != revision {
        return Err("데이터베이스 연결이 변경되었습니다. 다시 선택하세요.".into());
    }
    decode(stored)
}

type Stored = (String, String, i64, String, String);

fn row(row: &Row<'_>) -> rusqlite::Result<Stored> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn decode<T: Settings>(
    (id, project_id, revision, name, raw): Stored,
) -> Result<DatabaseProfile<T>> {
    let settings = serde_json::from_str::<T>(&raw)
        .map_err(|_| INVALID)?
        .normalize()
        .map_err(|_| INVALID)?;
    if name != settings.name() {
        return Err(INVALID.into());
    }
    Ok(DatabaseProfile {
        id,
        project_id,
        revision,
        settings,
    })
}

fn encode<T: Settings>(settings: &T) -> Result<String> {
    serde_json::to_string(settings)
        .map_err(|_| "데이터베이스 연결 설정을 저장할 수 없습니다.".into())
}

fn insert(
    db: &Connection,
    id: &str,
    project: &str,
    engine: &str,
    name: &str,
    settings: &str,
) -> Result<()> {
    let changed = db
        .execute(
            "INSERT INTO native_db_profiles (id, project_id, engine, revision, name, settings_json)
         VALUES (?1,?2,?3,1,?4,?5) ON CONFLICT(project_id,engine,name) DO NOTHING",
            params![id, project, engine, name, settings],
        )
        .map_err(db_error)?;
    require_changed(changed, DUPLICATE)
}

fn audit<T: Settings>(
    db: &Connection,
    profile: &DatabaseProfile<T>,
    operation: &'static str,
) -> Result<()> {
    insert_audit(
        db,
        AuditRecord {
            correlation_id: &Uuid::new_v4().to_string(),
            operation,
            project_id: Some(&profile.project_id),
            profile_id: Some(&profile.id),
            environment: Some(profile.settings.environment()),
            object_name: None,
            outcome: "succeeded",
            affected_count: Some(1),
        },
    )
}
