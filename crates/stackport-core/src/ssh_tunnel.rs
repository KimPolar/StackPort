mod runtime;

use crate::{db_error, insert_audit, require_changed, ssh, valid_name, AuditRecord, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use runtime::{SshTunnelManager, SshTunnelStatus};

pub(crate) const SCHEMA: &str = "CREATE TABLE ssh_tunnels (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ssh_profile_id TEXT NOT NULL REFERENCES ssh_profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    local_port INTEGER NOT NULL CHECK(local_port BETWEEN 0 AND 65535),
    target_host TEXT NOT NULL,
    target_port INTEGER NOT NULL CHECK(target_port BETWEEN 1 AND 65535),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    UNIQUE(project_id, name)
);";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedSshTunnel {
    pub id: String,
    pub project_id: String,
    pub revision: i64,
    pub settings: SshTunnelInput,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SshTunnelInput {
    pub name: String,
    pub ssh_profile_id: String,
    pub local_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

impl Store {
    pub fn list_ssh_tunnels(&self, project_id: &str) -> Result<Vec<SavedSshTunnel>> {
        let db = self.connect()?;
        let mut query = db.prepare(
            "SELECT id, project_id, revision, name, ssh_profile_id, local_port, target_host, target_port
             FROM ssh_tunnels WHERE project_id=?1 ORDER BY name, id",
        ).map_err(db_error)?;
        let rows = query
            .query_map([project_id], read_tunnel)
            .map_err(db_error)?;
        rows.map(|row| row.map_err(db_error).and_then(validate_stored))
            .collect()
    }

    pub fn ssh_tunnel(&self, id: &str) -> Result<SavedSshTunnel> {
        let db = self.connect()?;
        load_tunnel(&db, id)
    }

    pub fn create_ssh_tunnel(
        &self,
        project_id: &str,
        input: SshTunnelInput,
    ) -> Result<SavedSshTunnel> {
        let settings = validated(input)?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        verify_profile(&tx, project_id, &settings.ssh_profile_id)?;
        let saved = SavedSshTunnel {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            revision: 1,
            settings,
        };
        insert_tunnel(&tx, &saved)?;
        audit(&tx, &saved, "ssh_tunnel.create")?;
        tx.commit().map_err(db_error)?;
        Ok(saved)
    }

    pub fn update_ssh_tunnel(
        &self,
        id: &str,
        revision: i64,
        input: SshTunnelInput,
    ) -> Result<SavedSshTunnel> {
        let settings = validated(input)?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut saved = load_tunnel(&tx, id)?;
        check_revision(&saved, revision)?;
        verify_profile(&tx, &saved.project_id, &settings.ssh_profile_id)?;
        saved.revision = revision
            .checked_add(1)
            .ok_or("터널 변경 버전이 너무 큽니다.")?;
        saved.settings = settings;
        let settings = &saved.settings;
        let changed = tx.execute(
            "UPDATE OR IGNORE ssh_tunnels SET revision=?2, name=?3, ssh_profile_id=?4, local_port=?5, target_host=?6, target_port=?7 WHERE id=?1",
            params![id, saved.revision, settings.name, settings.ssh_profile_id, settings.local_port, settings.target_host, settings.target_port],
        ).map_err(db_error)?;
        require_changed(changed, "같은 이름의 터널이 있습니다.")?;
        audit(&tx, &saved, "ssh_tunnel.update")?;
        tx.commit().map_err(db_error)?;
        Ok(saved)
    }

    pub fn delete_ssh_tunnel(&self, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let saved = load_tunnel(&tx, id)?;
        check_revision(&saved, revision)?;
        let changed = tx
            .execute("DELETE FROM ssh_tunnels WHERE id=?1", [id])
            .map_err(db_error)?;
        require_changed(changed, "터널을 찾을 수 없습니다.")?;
        audit(&tx, &saved, "ssh_tunnel.delete")?;
        tx.commit().map_err(db_error)
    }
}

pub(crate) fn copy_tunnels_for_profile(
    db: &Connection,
    source_profile: &str,
    destination_project: &str,
    destination_profile: &str,
) -> Result<usize> {
    let mut query = db.prepare(
        "SELECT id, project_id, revision, name, ssh_profile_id, local_port, target_host, target_port
         FROM ssh_tunnels WHERE ssh_profile_id=?1",
    ).map_err(db_error)?;
    let rows = query
        .query_map([source_profile], read_tunnel)
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    let count = rows.len();
    for row in rows {
        let mut item = validate_stored(row)?;
        item.id = Uuid::new_v4().to_string();
        item.project_id = destination_project.into();
        item.revision = 1;
        item.settings.ssh_profile_id = destination_profile.into();
        insert_tunnel(db, &item)?;
    }
    Ok(count)
}

fn insert_tunnel(db: &Connection, tunnel: &SavedSshTunnel) -> Result<()> {
    let settings = &tunnel.settings;
    let changed = db.execute(
        "INSERT INTO ssh_tunnels(id, project_id, revision, name, ssh_profile_id, local_port, target_host, target_port)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(project_id, name) DO NOTHING",
        params![tunnel.id, tunnel.project_id, tunnel.revision, settings.name, settings.ssh_profile_id, settings.local_port, settings.target_host, settings.target_port],
    ).map_err(db_error)?;
    require_changed(changed, "같은 이름의 터널이 있습니다.")
}

fn verify_profile(db: &Connection, project: &str, profile: &str) -> Result<()> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ssh_profiles WHERE id=?1 AND project_id=?2)",
            params![profile, project],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !exists {
        return Err("같은 프로젝트에 저장된 SSH 연결을 선택하세요.".into());
    }
    Ok(())
}

fn check_revision(current: &SavedSshTunnel, expected: i64) -> Result<()> {
    if current.revision != expected {
        return Err("터널 설정이 변경되었습니다. 새로고침하세요.".into());
    }
    Ok(())
}

fn load_tunnel(db: &Connection, id: &str) -> Result<SavedSshTunnel> {
    let item = db.query_row(
        "SELECT id, project_id, revision, name, ssh_profile_id, local_port, target_host, target_port FROM ssh_tunnels WHERE id=?1",
        [id], read_tunnel,
    ).optional().map_err(db_error)?.ok_or("터널을 찾을 수 없습니다.")?;
    validate_stored(item)
}

fn read_tunnel(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedSshTunnel> {
    Ok(SavedSshTunnel {
        id: row.get(0)?,
        project_id: row.get(1)?,
        revision: row.get(2)?,
        settings: SshTunnelInput {
            name: row.get(3)?,
            ssh_profile_id: row.get(4)?,
            local_port: row.get(5)?,
            target_host: row.get(6)?,
            target_port: row.get(7)?,
        },
    })
}

fn validated(mut input: SshTunnelInput) -> Result<SshTunnelInput> {
    input.name = valid_name(&input.name)?.to_owned();
    if input.name.encode_utf16().count() > 80 || input.name.chars().any(char::is_control) {
        return Err("터널 이름은 제어 문자 없이 80자 이하로 입력하세요.".into());
    }
    input.target_host = ssh::normalize_host(&input.target_host)?;
    ssh::validate_port(input.target_port)?;
    Ok(input)
}

fn validate_stored(item: SavedSshTunnel) -> Result<SavedSshTunnel> {
    if item.revision <= 0 || validated(item.settings.clone())? != item.settings {
        return Err("저장된 터널 설정을 확인할 수 없습니다.".into());
    }
    Ok(item)
}

fn audit(db: &Connection, tunnel: &SavedSshTunnel, operation: &'static str) -> Result<()> {
    insert_audit(
        db,
        AuditRecord {
            correlation_id: &Uuid::new_v4().to_string(),
            operation,
            project_id: Some(&tunnel.project_id),
            profile_id: Some(&tunnel.settings.ssh_profile_id),
            environment: None,
            object_name: None,
            outcome: "succeeded",
            affected_count: Some(1),
        },
    )
}
