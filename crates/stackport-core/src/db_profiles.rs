use crate::{credential_store as vault, db_error, insert_audit, require_changed, AuditRecord, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{de::DeserializeOwned, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

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

pub enum PasswordAuthentication<P> {
    Entered { password: P, remember: bool },
    Saved,
}

impl<P> From<P> for PasswordAuthentication<P> {
    fn from(password: P) -> Self {
        Self::Entered { password, remember: false }
    }
}

impl<P> PasswordAuthentication<P> {
    pub fn requested(
        password: Option<P>,
        use_saved: bool,
        remember: bool,
        engine: &str,
    ) -> Result<Self> {
        match (password, use_saved, remember) {
            (None, true, false) => Ok(Self::Saved),
            (Some(password), false, remember) => Ok(Self::Entered { password, remember }),
            _ => Err(format!("{engine} 암호를 입력하거나 저장한 암호를 선택하세요.")),
        }
    }

    pub(crate) fn resolve<T: Settings>(
        self,
        store: &Store,
        profile: &DatabaseProfile<T>,
        engine: &str,
        wrap: impl FnOnce(Zeroizing<String>) -> P,
    ) -> Result<(P, bool)> {
        match self {
            Self::Entered { password, remember } => Ok((password, remember)),
            Self::Saved => {
                let password = store
                    .saved_native_db_password(profile, engine)?
                    .ok_or_else(|| format!("현재 연결 설정에 저장된 {engine} 암호가 없습니다."))?;
                Ok((wrap(password), false))
            }
        }
    }
}

impl Store {
    pub(crate) fn list_native_db_profiles<T: Settings>(
        &self,
        project: &str,
    ) -> Result<Vec<DatabaseProfile<T>>> {
        list(&self.connect()?, project)
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
        let settings = input.normalize()?;
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
        let profile = create_on(&tx, project, settings)?;
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
        vault::delete(&vault::target(self, T::ENGINE, id)?)?;
        tx.commit().map_err(db_error)
    }

    pub(crate) fn native_db_credential_status<T: Settings>(
        &self,
        id: &str,
        revision: i64,
        engine: &str,
    ) -> Result<vault::CredentialStatus> {
        let profile = self.native_db_profile::<T>(id, revision)?;
        vault::status(
            &vault::target(self, T::ENGINE, id)?,
            &vault::binding(&profile, engine)?,
        )
    }

    pub(crate) fn forget_native_db_password<T: Settings>(
        &self,
        id: &str,
        revision: i64,
        operation: &'static str,
    ) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let profile = current::<T>(&tx, id, revision)?;
        vault::delete(&vault::target(self, T::ENGINE, id)?)?;
        audit(&tx, &profile, operation)?;
        tx.commit().map_err(db_error)
    }

    pub(crate) fn saved_native_db_password<T: Settings>(
        &self,
        expected: &DatabaseProfile<T>,
        engine: &str,
    ) -> Result<Option<Zeroizing<String>>> {
        let binding = current_credential_binding(&self.connect()?, expected, engine)?;
        vault::load_password(&vault::target(self, T::ENGINE, &expected.id)?, &binding)
    }

    pub(crate) fn remember_native_db_password<T: Settings>(
        &self,
        expected: &DatabaseProfile<T>,
        engine: &str,
        password: &str,
        operation: &'static str,
    ) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let binding = current_credential_binding(&tx, expected, engine)?;
        vault::save(&vault::target(self, T::ENGINE, &expected.id)?, &binding, password)?;
        audit(&tx, expected, operation)?;
        tx.commit().map_err(db_error)
    }

    pub(crate) async fn remember_connected_password<T: Settings + Clone + Send + 'static>(
        &self,
        profile: &DatabaseProfile<T>,
        engine: &'static str,
        password: &str,
        operation: &'static str,
    ) -> Option<String> {
        let store = self.clone();
        let profile = profile.clone();
        let password = Zeroizing::new(password.to_owned());
        match tokio::task::spawn_blocking(move || {
            store.remember_native_db_password(&profile, engine, &password, operation)
        })
        .await
        {
            Ok(result) => result.err(),
            Err(_) => Some(format!("{engine} 암호를 저장할 수 없습니다.")),
        }
    }

    pub(crate) fn delete_project_native_db_passwords(&self, db: &Connection, project: &str) -> Result<()> {
        let mut query = db
            .prepare("SELECT id, engine FROM native_db_profiles WHERE project_id=?1")
            .map_err(db_error)?;
        let rows = query
            .query_map([project], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        for row in rows {
            let (id, engine) = row.map_err(db_error)?;
            vault::delete(&vault::target(self, &engine, &id)?)?;
        }
        Ok(())
    }
}

fn current_credential_binding<T: Settings>(
    db: &Connection,
    expected: &DatabaseProfile<T>,
    engine: &str,
) -> Result<[u8; vault::BINDING_BYTES]> {
    let profile = current::<T>(db, &expected.id, expected.revision)?;
    let binding = vault::binding(expected, engine)?;
    if vault::binding(&profile, engine)? != binding {
        return Err("데이터베이스 연결이 변경되었습니다. 다시 선택하세요.".into());
    }
    Ok(binding)
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

pub(crate) fn list<T: Settings>(db: &Connection, project: &str) -> Result<Vec<DatabaseProfile<T>>> {
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

pub(crate) fn create_on<T: Settings>(
    db: &Connection,
    project: &str,
    settings: T,
) -> Result<DatabaseProfile<T>> {
    let profile = DatabaseProfile {
        id: Uuid::new_v4().to_string(),
        project_id: project.into(),
        revision: 1,
        settings,
    };
    insert(
        db,
        &profile.id,
        project,
        T::ENGINE,
        profile.settings.name(),
        &encode(&profile.settings)?,
    )?;
    audit(db, &profile, T::AUDIT_OPERATIONS[0])?;
    Ok(profile)
}

pub(crate) fn current<T: Settings>(
    db: &Connection,
    id: &str,
    revision: i64,
) -> Result<DatabaseProfile<T>> {
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

#[cfg(all(test, windows))]
mod password_tests {
    use super::*;
    use crate::{oracle, sql_server};

    struct Entries(Vec<String>);

    impl Drop for Entries {
        fn drop(&mut self) {
            for target in &self.0 {
                let _ = vault::delete(target);
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires a Windows user credential vault"]
    async fn relational_credentials_follow_profile_revision_and_authentication() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
        let store = Store::open(dir.path().join("workspace.db"))?;
        let project = store.create_project("Relational credential fixtures")?;
        let sql = store.create_sql_server_profile(&project.id, sql_server::ProfileSettings {
            name: "SQL credential fixture".into(),
            host: "127.0.0.1".into(),
            port: 1,
            database: "sample".into(),
            authentication: sql_server::Authentication::SqlLogin,
            username: Some("fixture".into()),
            encryption: sql_server::Encryption::Required,
            ca_path: None,
            environment: "PROD".into(),
        })?;
        let oracle = store.create_oracle_profile(&project.id, oracle::ProfileSettings {
            name: "Oracle credential fixture".into(),
            host: "127.0.0.1".into(),
            port: 1,
            target: oracle::Target::ServiceName,
            service: "SAMPLE".into(),
            username: "fixture".into(),
            transport: oracle::Transport::Tcps,
            ca_path: None,
            environment: "PROD".into(),
        })?;
        let _entries = Entries(vec![
            vault::target(&store, "sql_server", &sql.id)?,
            vault::target(&store, "oracle", &oracle.id)?,
        ]);

        let sql_manager = sql_server::Manager::new(store.clone());
        let oracle_manager = oracle::Manager::new(store.clone());
        let sql_attempt = sql_manager.open(sql.id.clone(), sql.revision, sql_server::PasswordAuthentication::Saved, "").await;
        let oracle_attempt = oracle_manager.open(oracle.id.clone(), oracle.revision, oracle::PasswordAuthentication::Saved, "".into()).await;
        for error in [sql_attempt.err(), oracle_attempt.err()] {
            assert!(error.is_some_and(|error| error.contains("PROD")));
        }
        let sql_attempt = sql_manager.open(sql.id.clone(), sql.revision, sql_server::PasswordAuthentication::Saved, "PROD").await;
        let oracle_attempt = oracle_manager.open(oracle.id.clone(), oracle.revision, oracle::PasswordAuthentication::Saved, "PROD".into()).await;
        for error in [sql_attempt.err(), oracle_attempt.err()] {
            assert!(error.is_some_and(|error| error.contains("저장된") && error.contains("없습니다")));
        }

        // Seed only temporary profile entries so the test can exercise native password
        // resolution and invalidation without SQL Server or Oracle running.
        let sql_secret = "x".repeat(129);
        let oracle_secret = "x".repeat(257);
        assert!(store.remember_connected_password(&sql, "SQL Server", &sql_secret, "sql_server.credential.save").await.is_none());
        assert!(store.remember_connected_password(&oracle, "Oracle", &oracle_secret, "oracle.credential.save").await.is_none());
        assert!(store.sql_server_credential_status(&sql.id, sql.revision)?.usable);
        assert!(store.oracle_credential_status(&oracle.id, oracle.revision)?.usable);
        let sql_attempt = sql_manager.open(sql.id.clone(), sql.revision, sql_server::PasswordAuthentication::Saved, "PROD").await;
        let oracle_attempt = oracle_manager.open(oracle.id.clone(), oracle.revision, oracle::PasswordAuthentication::Saved, "PROD".into()).await;
        for error in [sql_attempt.err(), oracle_attempt.err()] {
            assert!(error.is_some_and(|error| error.contains("로그인 암호")));
        }

        let integrated = store.update_sql_server_profile(&sql.id, sql.revision, sql_server::ProfileSettings {
            authentication: sql_server::Authentication::Windows,
            username: None,
            ..sql.settings
        })?;
        let status = serde_json::to_value(store.sql_server_credential_status(&integrated.id, integrated.revision)?)
            .map_err(|error| error.to_string())?;
        assert_eq!(status, serde_json::json!({ "supported": true, "stored": true, "usable": false }));
        let integrated_attempt = sql_manager.open(integrated.id.clone(), integrated.revision, sql_server::PasswordAuthentication::Saved, "PROD").await;
        assert!(integrated_attempt.err().is_some_and(|error| error.contains("현재 Windows 계정")));
        store.forget_sql_server_password(&integrated.id, integrated.revision)?;
        assert!(vault::read(&_entries.0[0], |_| ())?.is_none());

        let renamed = store.update_oracle_profile(&oracle.id, oracle.revision, oracle::ProfileSettings {
            name: "Updated Oracle fixture".into(),
            ..oracle.settings
        })?;
        assert!(!store.oracle_credential_status(&renamed.id, renamed.revision)?.usable);
        store.forget_oracle_password(&renamed.id, renamed.revision)?;
        assert!(vault::read(&_entries.0[1], |_| ())?.is_none());
        Ok(())
    }
}
