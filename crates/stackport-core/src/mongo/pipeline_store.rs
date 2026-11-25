use super::{pipeline::validate_draft, MongoPipelineStage};
use crate::{
    db_error, insert_audit, require_changed, sql_templates::require_active_project, valid_name,
    AuditRecord, Result, Store,
};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS mongo_pipelines (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    stages TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    UNIQUE(project_id, name)
);";
const STALE: &str = "저장된 파이프라인이 변경되었거나 삭제되었습니다. 다시 불러오세요.";

#[derive(Serialize)]
pub struct MongoPipelineSummary {
    pub id: String,
    pub name: String,
    pub revision: i64,
}

#[derive(Serialize)]
pub struct SavedMongoPipeline {
    #[serde(flatten)]
    pub summary: MongoPipelineSummary,
    pub stages: Vec<MongoPipelineStage>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MongoPipelineWrite {
    name: String,
    stages: Vec<MongoPipelineStage>,
    replaces: Option<PipelineVersion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PipelineVersion {
    id: String,
    revision: i64,
}

impl Store {
    pub fn list_mongo_pipelines(&self, project: &str) -> Result<Vec<MongoPipelineSummary>> {
        let db = self.connect()?;
        require_active_project(&db, project)?;
        let mut statement = db.prepare("SELECT id, name, revision FROM mongo_pipelines WHERE project_id = ?1 ORDER BY name, id").map_err(db_error)?;
        let rows = statement.query_map([project], summary).map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    }

    pub fn read_mongo_pipeline(&self, project: &str, id: &str) -> Result<SavedMongoPipeline> {
        let db = self.connect()?;
        require_active_project(&db, project)?;
        load(&db, project, id)
    }

    pub fn save_mongo_pipeline(
        &self,
        project: &str,
        write: MongoPipelineWrite,
    ) -> Result<SavedMongoPipeline> {
        let name = valid_name(&write.name)?;
        if name.chars().count() > 100 || name.chars().any(char::is_control) {
            return Err("파이프라인 이름에는 제어 문자 없이 최대 100자를 입력하세요.".into());
        }
        validate_draft(&write.stages)?;
        let stages = serde_json::to_string(&write.stages)
            .map_err(|_| "집계 단계 JSON을 저장할 수 없습니다.")?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        require_active_project(&tx, project)?;
        let (id, operation) = if let Some(previous) = write.replaces {
            let changed = tx
                .execute(
                    "UPDATE mongo_pipelines SET name = ?4, stages = ?5, revision = revision + 1
                 WHERE project_id = ?1 AND id = ?2 AND revision = ?3",
                    params![project, previous.id, previous.revision, name, stages],
                )
                .map_err(write_error)?;
            require_changed(changed, STALE)?;
            (previous.id, "mongo_pipeline.update")
        } else {
            let count: i64 = tx
                .query_row(
                    "SELECT count(*) FROM mongo_pipelines WHERE project_id = ?1",
                    [project],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            if count >= 64 {
                return Err("프로젝트마다 파이프라인을 최대 64개 저장할 수 있습니다.".into());
            }
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO mongo_pipelines(id, project_id, name, stages) VALUES(?1, ?2, ?3, ?4)",
                params![id, project, name, stages],
            )
            .map_err(write_error)?;
            (id, "mongo_pipeline.create")
        };
        let saved = load(&tx, project, &id)?;
        record(&tx, project, operation)?;
        tx.commit().map_err(db_error)?;
        Ok(saved)
    }

    pub fn delete_mongo_pipeline(&self, project: &str, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        require_active_project(&tx, project)?;
        let changed = tx
            .execute(
                "DELETE FROM mongo_pipelines WHERE project_id = ?1 AND id = ?2 AND revision = ?3",
                params![project, id, revision],
            )
            .map_err(db_error)?;
        require_changed(changed, STALE)?;
        record(&tx, project, "mongo_pipeline.delete")?;
        tx.commit().map_err(db_error)
    }
}

pub(crate) fn copy_project_pipelines(
    db: &Connection,
    source: &str,
    destination: &str,
) -> Result<usize> {
    let mut statement = db
        .prepare("SELECT name, stages FROM mongo_pipelines WHERE project_id = ?1")
        .map_err(db_error)?;
    let rows = statement
        .query_map([source], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;
    let mut count = 0;
    for row in rows {
        let (name, stages) = row.map_err(db_error)?;
        count += db
            .execute(
                "INSERT INTO mongo_pipelines(id, project_id, name, stages) VALUES(?1, ?2, ?3, ?4)",
                params![Uuid::new_v4().to_string(), destination, name, stages],
            )
            .map_err(db_error)?;
    }
    Ok(count)
}

fn summary(row: &Row<'_>) -> rusqlite::Result<MongoPipelineSummary> {
    Ok(MongoPipelineSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        revision: row.get(2)?,
    })
}

fn load(db: &Connection, project: &str, id: &str) -> Result<SavedMongoPipeline> {
    let (summary, stages) = db.query_row(
        "SELECT id, name, revision, stages FROM mongo_pipelines WHERE project_id = ?1 AND id = ?2",
        params![project, id], |row| Ok((summary(row)?, row.get::<_, String>(3)?)),
    ).optional().map_err(db_error)?.ok_or(STALE)?;
    let stages =
        serde_json::from_str(&stages).map_err(|_| "저장된 집계 단계를 읽을 수 없습니다.")?;
    Ok(SavedMongoPipeline { summary, stages })
}

fn write_error(error: rusqlite::Error) -> String {
    if matches!(&error, rusqlite::Error::SqliteFailure(code, _) if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
    {
        return "같은 이름의 파이프라인이 있습니다.".into();
    }
    db_error(error)
}

fn record(db: &Connection, project: &str, operation: &'static str) -> Result<()> {
    insert_audit(
        db,
        AuditRecord {
            correlation_id: &Uuid::new_v4().to_string(),
            operation,
            project_id: Some(project),
            profile_id: None,
            environment: None,
            object_name: None,
            outcome: "succeeded",
            affected_count: Some(1),
        },
    )
}
