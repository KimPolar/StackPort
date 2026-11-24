//! Operations on a local project and its saved connection definitions.

use super::{
    db_error, insert_audit, require_changed, sql_templates::copy_project_templates, ssh_profiles, valid_name, AuditRecord, Project,
    Result, Store,
};
use rusqlite::{params, TransactionBehavior};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct ArchivedProject {
    pub id: String,
    pub name: String,
    pub archived_at: String,
}

impl Store {
    pub fn list_archived_projects(&self) -> Result<Vec<ArchivedProject>> {
        let db = self.connect()?;
        let mut statement = db
            .prepare(
                "SELECT projects.id, projects.name, archives.archived_at
             FROM project_archives AS archives
             JOIN projects ON projects.id = archives.project_id
             ORDER BY archives.archived_at DESC, projects.name COLLATE NOCASE, projects.id",
            )
            .map_err(db_error)?;
        let result = statement
            .query_map([], |row| {
                Ok(ArchivedProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    archived_at: row.get(2)?,
                })
            })
            .map_err(db_error)?;
        result.collect::<rusqlite::Result<_>>().map_err(db_error)
    }

    pub fn archive_project(&self, id: &str) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let changed = tx
            .execute(
                "INSERT INTO project_archives(project_id)
             SELECT id FROM projects WHERE id = ?1
             AND NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id = ?1)",
                [id],
            )
            .map_err(db_error)?;
        require_changed(changed, "보관할 활성 프로젝트를 찾을 수 없습니다.")?;
        record_archive_change(&tx, id, "project.archive")?;
        tx.commit().map_err(db_error)
    }

    pub fn unarchive_project(&self, id: &str) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let changed = tx
            .execute("DELETE FROM project_archives WHERE project_id = ?1", [id])
            .map_err(db_error)?;
        require_changed(changed, "보관된 프로젝트를 찾을 수 없습니다.")?;
        record_archive_change(&tx, id, "project.unarchive")?;
        tx.commit().map_err(db_error)
    }

    /// Duplicate connection definitions in one transaction. The original
    /// SQLite files and SSH destinations are still referenced by both projects.
    pub fn duplicate_project(&self, source: &str, name: &str) -> Result<Project> {
        let duplicate = Project {
            id: Uuid::new_v4().to_string(),
            name: valid_name(name)?.into(),
        };
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let created = tx
            .execute(
                "INSERT INTO projects (id, name) SELECT ?1, ?2 FROM projects WHERE id = ?3",
                params![duplicate.id, duplicate.name, source],
            )
            .map_err(db_error)?;
        require_changed(created, "복제할 프로젝트를 찾을 수 없습니다.")?;
        let db_profiles = Self::list_profiles_on(&tx, source)?;
        let mut ssh_profiles = Self::list_ssh_profiles_on(&tx, source)?;
        let mut copied_total = db_profiles.len() + ssh_profiles.len() + copy_project_templates(&tx, source, &duplicate.id)?;
        for source in db_profiles {
            let changed = tx.execute(
                "INSERT INTO profiles (id, project_id, name, path, environment) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![Uuid::new_v4().to_string(), duplicate.id, source.name, source.path, source.environment],
            ).map_err(db_error)?;
            require_changed(changed, "SQLite 연결 정의를 복제할 수 없습니다.")?;
        }
        for profile in &mut ssh_profiles {
            let source_id = std::mem::replace(&mut profile.id, Uuid::new_v4().to_string());
            profile.project_id.clone_from(&duplicate.id);
            profile.revision = 1;
            tx.execute(
                "INSERT INTO ssh_profiles (id, project_id, name, host, port, username, environment, revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
                params![profile.id, profile.project_id, profile.name, profile.host, profile.port, profile.username, profile.environment],
            ).map_err(db_error)?;
            copied_total += crate::ssh_tunnel::copy_tunnels_for_profile(&tx, &source_id, &duplicate.id, &profile.id)?;
        }
        for profile in &ssh_profiles {
            ssh_profiles::verify_saved(&tx, profile)?;
        }
        insert_audit(
            &tx,
            AuditRecord {
                correlation_id: &Uuid::new_v4().to_string(),
                operation: "project.duplicate",
                project_id: Some(&duplicate.id),
                profile_id: None,
                environment: None,
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(copied_total as i64 + 1),
            },
        )?;
        tx.commit().map_err(db_error)?;
        Ok(duplicate)
    }
}

fn record_archive_change(
    db: &rusqlite::Connection,
    id: &str,
    operation: &'static str,
) -> Result<()> {
    insert_audit(
        db,
        AuditRecord {
            correlation_id: &Uuid::new_v4().to_string(),
            operation,
            project_id: Some(id),
            profile_id: None,
            environment: None,
            object_name: None,
            outcome: "succeeded",
            affected_count: Some(1),
        },
    )
}
