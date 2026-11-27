use super::{HostKey, SshManager};
use crate::{credential_store as vault, db_error, ssh_profiles::profile_audit, Result, SshCredentials, SshProfile, Store};
use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub use vault::CredentialStatus as SshCredentialStatus;

const ENGINE: &str = "ssh";

#[derive(Serialize)]
pub struct SshCredentialReview {
    fingerprint: String,
    #[serde(flatten)]
    status: SshCredentialStatus,
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum SshPasswordChoice {
    Saved { fingerprint: String },
    Remember { fingerprint: String },
}

pub struct SshPasswordSave {
    profile: SshProfile,
    key: HostKey,
    password: Zeroizing<String>,
}

impl SshPasswordSave {
    pub fn store(self, store: &Store, ssh: &SshManager) -> Result<()> {
        let mut db = store.connect()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        let profile = credential_profile(&tx, &self.profile.id, self.profile.revision)?;
        if profile != self.profile {
            return Err("SSH 연결이 변경되어 암호를 저장할 수 없습니다.".into());
        }
        let key = reviewed_key(ssh, &profile, &self.key.fingerprint)?;
        let binding = password_binding(&profile, &key)?;
        vault::save(&vault::target(store, ENGINE, &profile.id)?, &binding, &self.password)?;
        profile_audit(&tx, "ssh.credential.save", &profile)?;
        tx.commit().map_err(db_error)
    }
}

impl Store {
    pub fn ssh_credential_status(
        &self, ssh: &SshManager, id: &str, revision: i64, fingerprint: &str,
    ) -> Result<SshCredentialStatus> {
        let profile = credential_profile(&self.connect()?, id, revision)?;
        let key = reviewed_key(ssh, &profile, fingerprint)?;
        password_status(self, &profile, &key)
    }

    pub fn ssh_credential_review(
        &self, ssh: &SshManager, id: &str, revision: i64,
    ) -> Result<Option<SshCredentialReview>> {
        let profile = credential_profile(&self.connect()?, id, revision)?;
        let Some(key) = ssh.lookup(&profile.host, profile.port)? else {
            return Ok(None);
        };
        let status = password_status(self, &profile, &key)?;
        Ok(Some(SshCredentialReview { fingerprint: key.fingerprint, status }))
    }

    pub fn forget_ssh_password(&self, id: &str, revision: i64) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        let profile = credential_profile(&tx, id, revision)?;
        self.delete_ssh_password_entry(id)?;
        profile_audit(&tx, "ssh.credential.delete", &profile)?;
        tx.commit().map_err(db_error)
    }

    pub fn prepare_ssh_credentials(
        &self,
        ssh: &SshManager,
        profile: &SshProfile,
        entered: Option<SshCredentials>,
        choice: Option<SshPasswordChoice>,
    ) -> Result<(SshCredentials, Option<SshPasswordSave>)> {
        let Some(choice) = choice else {
            return entered.map(|value| (value, None)).ok_or("SSH 인증 방법을 선택하세요.".into());
        };
        let current = credential_profile(&self.connect()?, &profile.id, profile.revision)?;
        if &current != profile {
            return Err("SSH 연결이 변경되었습니다. 대상을 다시 확인하세요.".into());
        }
        let (key, password, save) = match (entered, choice) {
            (None, SshPasswordChoice::Saved { fingerprint }) => {
                let key = reviewed_key(ssh, profile, &fingerprint)?;
                let binding = password_binding(profile, &key)?;
                let password = vault::load_password(&vault::target(self, ENGINE, &profile.id)?, &binding)?
                    .ok_or("현재 SSH 연결과 호스트 키에 저장된 암호가 없습니다.")?;
                (key, password, None)
            }
            (Some(SshCredentials::Password { password }), SshPasswordChoice::Remember { fingerprint }) => {
                let key = reviewed_key(ssh, profile, &fingerprint)?;
                if password.is_empty() || password.len() > 4096 || password.contains('\0') {
                    return Err("저장할 SSH 암호를 확인하세요.".into());
                }
                let save = SshPasswordSave { profile: profile.clone(), key: key.clone(), password: password.clone() };
                (key, password, Some(save))
            }
            _ => return Err("SSH 암호를 입력하거나 저장한 암호를 선택하세요.".into()),
        };
        let public_key = format!("{} {}", key.algorithm, key.public_key);
        Ok((SshCredentials::BoundPassword { password, public_key }, save))
    }

    pub(crate) fn delete_ssh_password_entry(&self, id: &str) -> Result<()> {
        vault::delete(&vault::target(self, ENGINE, id)?)
    }

    pub(crate) fn delete_project_ssh_passwords(&self, db: &Connection, id: &str) -> Result<()> {
        vault::delete_project_passwords(self, db, id, ENGINE, "ssh_profiles")
    }
}

fn credential_profile(db: &Connection, id: &str, revision: i64) -> Result<SshProfile> {
    let profile = Store::ssh_profile_on(db, id)?;
    if profile.revision != revision {
        return Err("SSH 연결이 변경되었습니다. 대상을 다시 확인하세요.".into());
    }
    let archived: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_archives WHERE project_id=?1)",
        [&profile.project_id],
        |row| row.get(0),
    ).map_err(db_error)?;
    if archived {
        return Err("보관된 프로젝트의 SSH 암호를 사용할 수 없습니다.".into());
    }
    Ok(profile)
}

fn reviewed_key(ssh: &SshManager, profile: &SshProfile, fingerprint: &str) -> Result<HostKey> {
    ssh.lookup(&profile.host, profile.port)?
        .filter(|key| key.fingerprint == fingerprint)
        .ok_or_else(|| "SSH 호스트 키가 변경되었습니다. 지문을 다시 확인하세요.".into())
}

fn password_binding(profile: &SshProfile, key: &HostKey) -> Result<[u8; vault::BINDING_BYTES]> {
    vault::binding(&(profile, &key.fingerprint), "SSH")
}

fn password_status(store: &Store, profile: &SshProfile, key: &HostKey) -> Result<SshCredentialStatus> {
    vault::status(&vault::target(store, ENGINE, &profile.id)?, &password_binding(profile, key)?)
}
