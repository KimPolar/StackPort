//! Operations on a local project and its saved connection definitions.

use super::{
    db_error, insert_audit, require_changed, ssh_profiles, valid_name, AuditRecord, Project,
    Result, Store,
};
use rusqlite::{params, TransactionBehavior};
use uuid::Uuid;

impl Store {
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
        let copied_total = db_profiles.len() + ssh_profiles.len();
        for source in db_profiles {
            let changed = tx.execute(
                "INSERT INTO profiles (id, project_id, name, path, environment) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![Uuid::new_v4().to_string(), duplicate.id, source.name, source.path, source.environment],
            ).map_err(db_error)?;
            require_changed(changed, "SQLite 연결 정의를 복제할 수 없습니다.")?;
        }
        for profile in &mut ssh_profiles {
            profile.id = Uuid::new_v4().to_string();
            profile.project_id.clone_from(&duplicate.id);
            profile.revision = 1;
            tx.execute(
                "INSERT INTO ssh_profiles (id, project_id, name, host, port, username, environment, revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
                params![profile.id, profile.project_id, profile.name, profile.host, profile.port, profile.username, profile.environment],
            ).map_err(db_error)?;
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
