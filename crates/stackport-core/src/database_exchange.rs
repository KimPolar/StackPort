//! Selected database connection definitions, without credentials or local certificate paths.

use crate::{
    db_error,
    db_profiles::{self, DatabaseProfile, Settings as NativeSettings},
    insert_audit, insert_sqlite_profile, mysql, oracle, postgres, prepare_sqlite_profile,
    profile_exchange_file::{self, MAX_PROFILES},
    profile_from_row, redis, snowflake, sql_server, valid_name, AuditRecord, MongoSettings,
    MysqlSettings, PostgresProfileInput, Profile, RedisSettings, Result, Store,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{ser::Error as _, Deserialize, Serialize, Serializer};
use std::{collections::HashSet, path::Path};
use uuid::Uuid;

pub use crate::profile_exchange_file::ProfileExportReport;

const FORMAT: &str = "stackport.database-profiles";
const VERSION: u32 = 1;
const STALE: &str = "데이터베이스 연결이 변경되었습니다. 새로 고침한 뒤 다시 선택하세요.";
const LOCAL_FILES: &str = "선택한 연결에 필요한 로컬 파일을 각각 지정하세요.";
const UNSUPPORTED: &str = "지원하지 않거나 올바르지 않은 데이터베이스 연결 파일입니다.";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    Sqlite,
    Postgres,
    Mysql,
    Redis,
    Mongodb,
    SqlServer,
    Oracle,
    Snowflake,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub engine: Engine,
    pub id: String,
    pub revision: Option<i64>,
}

#[derive(Serialize)]
pub struct Candidate {
    pub source: Source,
    pub name: String,
    pub target: String,
    pub environment: String,
}

#[derive(Serialize)]
pub struct ProfileImportPreview {
    pub digest: String,
    pub profiles: Vec<PreviewProfile>,
}

#[derive(Serialize)]
pub struct PreviewProfile {
    pub engine: Engine,
    pub name: String,
    pub target: String,
    pub environment: String,
    pub requires_ca: bool,
    pub requires_client_identity: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportSelection {
    pub index: usize,
    pub name: Option<String>,
    pub sqlite_path: Option<String>,
    pub ca_path: Option<String>,
    pub client_certificate_path: Option<String>,
    pub client_key_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    format: String,
    version: u32,
    profiles: Vec<Definition>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Requirements {
    #[serde(default)]
    ca_certificate: bool,
    #[serde(default)]
    client_identity: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    #[serde(serialize_with = "serialize_portable")]
    connection: ConnectionSettings,
    #[serde(default)]
    local_requirements: Requirements,
}

fn serialize_portable<S: Serializer>(
    connection: &ConnectionSettings,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    let mut value = serde_json::to_value(connection).map_err(S::Error::custom)?;
    let settings = value
        .get_mut("settings")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| S::Error::custom("Missing connection settings"))?;
    for field in ["ca_path", "client_certificate_path", "client_key_path"] {
        settings.remove(field);
    }
    value.serialize(serializer)
}

#[derive(Serialize, Deserialize)]
#[serde(
    deny_unknown_fields,
    tag = "engine",
    content = "settings",
    rename_all = "snake_case"
)]
enum ConnectionSettings {
    Sqlite(SqliteSettings),
    Postgres(PostgresProfileInput),
    Mysql(MysqlSettings),
    Redis(RedisSettings),
    Mongodb(MongoSettings),
    SqlServer(sql_server::ProfileSettings),
    Oracle(oracle::ProfileSettings),
    Snowflake(snowflake::ProfileSettings),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SqliteSettings {
    name: String,
    file_name: String,
    environment: String,
}

enum Prepared {
    Sqlite(Profile),
    Network(ConnectionSettings),
}

impl Store {
    pub fn list_database_exchange_candidates(&self, project: &str) -> Result<Vec<Candidate>> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        require_active(&tx, project)?;
        let mut results = Vec::new();
        for profile in Store::list_profiles_on(&tx, project)? {
            let id = profile.id.clone();
            results.push(candidate(sqlite_settings(profile)?, id, None));
        }
        for profile in postgres::profiles::list(&tx, project)? {
            results.push(candidate(
                ConnectionSettings::Postgres(profile.settings),
                profile.id,
                Some(profile.revision),
            ));
        }
        for profile in mysql::profiles::list(&tx, project)? {
            results.push(candidate(
                ConnectionSettings::Mysql(profile.settings),
                profile.id,
                Some(profile.revision),
            ));
        }
        for profile in redis::profiles::list(&tx, project)? {
            results.push(candidate(
                ConnectionSettings::Redis(profile.settings),
                profile.id,
                Some(profile.revision),
            ));
        }
        results.extend(native_candidates(
            &tx,
            project,
            ConnectionSettings::Mongodb,
        )?);
        results.extend(native_candidates(
            &tx,
            project,
            ConnectionSettings::SqlServer,
        )?);
        results.extend(native_candidates(&tx, project, ConnectionSettings::Oracle)?);
        results.extend(native_candidates(
            &tx,
            project,
            ConnectionSettings::Snowflake,
        )?);
        results.sort_by_cached_key(|item| item.name.to_lowercase());
        Ok(results)
    }

    pub fn export_database_profiles(
        &self,
        project: &str,
        selected: Vec<Source>,
        destination: &str,
    ) -> Result<ProfileExportReport> {
        check_count(selected.len())?;
        let mut unique = HashSet::new();
        if selected
            .iter()
            .any(|item| !unique.insert((item.engine, item.id.as_str())))
        {
            return Err("같은 데이터베이스 연결을 중복 선택할 수 없습니다.".into());
        }
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        require_active(&tx, project)?;
        let profiles: Vec<_> = selected
            .iter()
            .map(|source| {
                let mut connection = current(&tx, project, source)?;
                let local_requirements = connection.remove_local_files();
                Ok(Definition {
                    connection,
                    local_requirements,
                })
            })
            .collect::<Result<_>>()?;
        let count = profiles.len();
        let bytes = serde_json::to_vec_pretty(&Document {
            format: FORMAT.into(),
            version: VERSION,
            profiles,
        })
        .map_err(|_| "데이터베이스 연결을 내보낼 수 없습니다.")?;
        profile_exchange_file::export(
            self,
            tx,
            project,
            "database_profile.export",
            destination,
            &bytes,
            count,
        )
    }

    pub fn preview_database_profile_import(&self, path: &str) -> Result<ProfileImportPreview> {
        let (digest, profiles) = read_document(path)?;
        let profiles = profiles
            .into_iter()
            .map(|profile| {
                let (name, target, environment) = profile.connection.summary();
                PreviewProfile {
                    engine: profile.connection.engine(),
                    name: name.into(),
                    target,
                    environment: environment.into(),
                    requires_ca: profile.local_requirements.ca_certificate,
                    requires_client_identity: profile.local_requirements.client_identity,
                }
            })
            .collect();
        Ok(ProfileImportPreview { digest, profiles })
    }

    pub fn import_database_profiles(
        &self,
        project: &str,
        path: &str,
        expected_digest: &str,
        selected: Vec<ImportSelection>,
    ) -> Result<usize> {
        check_count(selected.len())?;
        let (digest, profiles) = read_document(path)?;
        if digest != expected_digest {
            return Err("미리보기 이후 연결 파일이 변경되었습니다. 다시 확인하세요.".into());
        }
        let mut db = self.connect()?;
        require_active(&db, project)?;
        let mut profiles: Vec<_> = profiles.into_iter().map(Some).collect();
        let prepared = selected
            .into_iter()
            .map(|choice| {
                let profile = profiles
                    .get_mut(choice.index)
                    .and_then(Option::take)
                    .ok_or("유효한 데이터베이스 연결을 중복 없이 선택하세요.")?;
                profile.prepare(project, choice)
            })
            .collect::<Result<Vec<_>>>()?;
        let count = prepared.len();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        require_active(&tx, project)?;
        for profile in prepared {
            match profile {
                Prepared::Sqlite(profile) => insert_sqlite_profile(&tx, &profile)?,
                Prepared::Network(settings) => settings.insert(&tx, project)?,
            }
        }
        insert_audit(
            &tx,
            AuditRecord {
                correlation_id: &Uuid::new_v4().to_string(),
                operation: "database_profile.import",
                project_id: Some(project),
                profile_id: None,
                environment: None,
                object_name: None,
                outcome: "succeeded",
                affected_count: Some(count as i64),
            },
        )?;
        tx.commit().map_err(db_error)?;
        Ok(count)
    }
}

fn require_active(db: &Connection, project: &str) -> Result<()> {
    let exists = db
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM projects WHERE id=?1 AND NOT EXISTS
         (SELECT 1 FROM project_archives WHERE project_id=?1))",
            [project],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_error)?;
    if !exists {
        return Err("활성 프로젝트를 찾을 수 없습니다.".into());
    }
    Ok(())
}

fn check_count(count: usize) -> Result<()> {
    if !(1..=MAX_PROFILES).contains(&count) {
        return Err("데이터베이스 연결을 1~200개 선택하세요.".into());
    }
    Ok(())
}

fn native_candidates<T: NativeSettings>(
    db: &Connection,
    project: &str,
    wrap: impl Fn(T) -> ConnectionSettings,
) -> Result<Vec<Candidate>> {
    Ok(db_profiles::list::<T>(db, project)?
        .into_iter()
        .map(|profile| candidate(wrap(profile.settings), profile.id, Some(profile.revision)))
        .collect())
}

fn candidate(settings: ConnectionSettings, id: String, revision: Option<i64>) -> Candidate {
    let (name, target, environment) = settings.summary();
    Candidate {
        source: Source {
            engine: settings.engine(),
            id,
            revision,
        },
        name: name.into(),
        target,
        environment: environment.into(),
    }
}

fn current(db: &Connection, project: &str, source: &Source) -> Result<ConnectionSettings> {
    if source.engine == Engine::Sqlite {
        if source.revision.is_some() {
            return Err(STALE.into());
        }
        let profile = db.query_row(
            "SELECT id, project_id, name, path, environment FROM profiles WHERE id=?1 AND project_id=?2",
            [&source.id, project], profile_from_row,
        ).optional().map_err(db_error)?.ok_or(STALE)?;
        return sqlite_settings(profile);
    }
    let id = &source.id;
    let revision = source.revision.filter(|value| *value > 0).ok_or(STALE)?;
    let (owner, connection) = match source.engine {
        Engine::Sqlite => unreachable!(),
        Engine::Postgres => {
            let profile = postgres::profiles::find(db, id)?;
            if profile.revision != revision {
                return Err(STALE.into());
            }
            (
                profile.project_id,
                ConnectionSettings::Postgres(profile.settings),
            )
        }
        Engine::Mysql => {
            let profile = mysql::profiles::current(db, id, revision)?;
            (
                profile.project_id,
                ConnectionSettings::Mysql(profile.settings),
            )
        }
        Engine::Redis => {
            let profile = redis::profiles::current(db, id, revision)?;
            (
                profile.project_id,
                ConnectionSettings::Redis(profile.settings),
            )
        }
        Engine::Mongodb => native_current(db, id, revision, ConnectionSettings::Mongodb)?,
        Engine::SqlServer => native_current(db, id, revision, ConnectionSettings::SqlServer)?,
        Engine::Oracle => native_current(db, id, revision, ConnectionSettings::Oracle)?,
        Engine::Snowflake => native_current(db, id, revision, ConnectionSettings::Snowflake)?,
    };
    if owner != project {
        return Err(STALE.into());
    }
    Ok(connection)
}

fn native_current<T: NativeSettings>(
    db: &Connection,
    id: &str,
    revision: i64,
    wrap: impl FnOnce(T) -> ConnectionSettings,
) -> Result<(String, ConnectionSettings)> {
    let DatabaseProfile {
        project_id,
        settings,
        ..
    } = db_profiles::current(db, id, revision)?;
    Ok((project_id, wrap(settings)))
}

fn sqlite_settings(profile: Profile) -> Result<ConnectionSettings> {
    let file_name = Path::new(&profile.path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(UNSUPPORTED)?;
    Ok(ConnectionSettings::Sqlite(SqliteSettings {
        name: profile.name,
        file_name: file_name.into(),
        environment: profile.environment,
    }))
}

fn read_document(path: &str) -> Result<(String, Vec<Definition>)> {
    let bytes = profile_exchange_file::read(path)?;
    let mut document: Document = serde_json::from_slice(&bytes).map_err(|_| UNSUPPORTED)?;
    if document.format != FORMAT || document.version != VERSION {
        return Err("지원하지 않는 데이터베이스 연결 파일 형식 또는 버전입니다.".into());
    }
    check_count(document.profiles.len())?;
    for profile in &mut document.profiles {
        let supplied = profile.connection.remove_local_files();
        if supplied.ca_certificate
            || supplied.client_identity
            || (profile.local_requirements.ca_certificate && !profile.connection.accepts_ca())
            || (profile.local_requirements.client_identity
                && !profile.connection.accepts_client_identity())
        {
            return Err(UNSUPPORTED.into());
        }
    }
    let profiles = document
        .profiles
        .into_iter()
        .map(|profile| {
            Ok(Definition {
                connection: profile.connection.normalize()?,
                ..profile
            })
        })
        .collect::<Result<_>>()?;
    Ok((profile_exchange_file::digest(&bytes), profiles))
}

impl Definition {
    fn prepare(mut self, project: &str, selection: ImportSelection) -> Result<Prepared> {
        let ImportSelection {
            name,
            sqlite_path,
            ca_path,
            client_certificate_path,
            client_key_path,
            ..
        } = selection;
        let local = &self.local_requirements;
        if ca_path.is_some() != local.ca_certificate
            || client_certificate_path.is_some() != local.client_identity
            || client_key_path.is_some() != local.client_identity
            || sqlite_path.is_some() != (self.connection.engine() == Engine::Sqlite)
        {
            return Err(LOCAL_FILES.into());
        }
        if let Some(name) = name {
            *self.connection.name_mut() = name;
        }
        if let ConnectionSettings::Sqlite(settings) = self.connection {
            let path = sqlite_path.as_deref().ok_or(LOCAL_FILES)?.trim();
            if !Path::new(path).is_absolute()
                || path.len() > 32_768
                || path.chars().any(char::is_control)
            {
                return Err("SQLite 파일의 절대 경로를 지정하세요.".into());
            }
            return prepare_sqlite_profile(project, &settings.name, path, &settings.environment)
                .map(Prepared::Sqlite);
        }
        if let Some(slot) = self.connection.ca_path_mut() {
            *slot = ca_path;
        }
        if let ConnectionSettings::Mysql(settings) = &mut self.connection {
            settings.client_certificate_path = client_certificate_path;
            settings.client_key_path = client_key_path;
        }
        self.connection.normalize().map(Prepared::Network)
    }
}

impl ConnectionSettings {
    fn engine(&self) -> Engine {
        match self {
            Self::Sqlite(_) => Engine::Sqlite,
            Self::Postgres(_) => Engine::Postgres,
            Self::Mysql(_) => Engine::Mysql,
            Self::Redis(_) => Engine::Redis,
            Self::Mongodb(_) => Engine::Mongodb,
            Self::SqlServer(_) => Engine::SqlServer,
            Self::Oracle(_) => Engine::Oracle,
            Self::Snowflake(_) => Engine::Snowflake,
        }
    }

    fn name_mut(&mut self) -> &mut String {
        match self {
            Self::Sqlite(settings) => &mut settings.name,
            Self::Postgres(settings) => &mut settings.name,
            Self::Mysql(settings) => &mut settings.name,
            Self::Redis(settings) => &mut settings.name,
            Self::Mongodb(settings) => &mut settings.name,
            Self::SqlServer(settings) => &mut settings.name,
            Self::Oracle(settings) => &mut settings.name,
            Self::Snowflake(settings) => &mut settings.name,
        }
    }

    fn summary(&self) -> (&str, String, &str) {
        match self {
            Self::Sqlite(s) => (&s.name, s.file_name.clone(), &s.environment),
            Self::Postgres(s) => (
                &s.name,
                endpoint(&s.host, s.port, Some(&s.username), &s.database),
                &s.environment,
            ),
            Self::Mysql(s) => (
                &s.name,
                endpoint(
                    &s.host,
                    s.port,
                    Some(&s.username),
                    s.database.as_deref().unwrap_or(""),
                ),
                &s.environment,
            ),
            Self::Redis(s) => (
                &s.name,
                endpoint(
                    &s.host,
                    s.port,
                    Some(&s.username),
                    &format!("DB {}", s.database),
                ),
                &s.environment,
            ),
            Self::Mongodb(s) => (&s.name, s.uri.clone(), &s.environment),
            Self::SqlServer(s) => (
                &s.name,
                endpoint(&s.host, s.port, s.username.as_deref(), &s.database),
                &s.environment,
            ),
            Self::Oracle(s) => (
                &s.name,
                endpoint(&s.host, s.port, Some(&s.username), &s.service),
                &s.environment,
            ),
            Self::Snowflake(s) => (
                &s.name,
                format!("{} / {}", s.host, s.database),
                &s.environment,
            ),
        }
    }

    fn accepts_ca(&self) -> bool {
        match self {
            Self::Postgres(_) | Self::SqlServer(_) => true,
            Self::Mysql(s) => s.tls,
            Self::Redis(s) => s.tls,
            Self::Mongodb(s) => s.tls,
            Self::Oracle(s) => s.transport == oracle::Transport::Tcps,
            Self::Sqlite(_) | Self::Snowflake(_) => false,
        }
    }

    fn accepts_client_identity(&self) -> bool {
        matches!(self, Self::Mysql(settings) if settings.tls)
    }

    fn ca_path_mut(&mut self) -> Option<&mut Option<String>> {
        Some(match self {
            Self::Postgres(s) => &mut s.ca_path,
            Self::Mysql(s) => &mut s.ca_path,
            Self::Redis(s) => &mut s.ca_path,
            Self::Mongodb(s) => &mut s.ca_path,
            Self::SqlServer(s) => &mut s.ca_path,
            Self::Oracle(s) => &mut s.ca_path,
            Self::Sqlite(_) | Self::Snowflake(_) => return None,
        })
    }

    fn remove_local_files(&mut self) -> Requirements {
        let ca_certificate = self.ca_path_mut().and_then(Option::take).is_some();
        let client_identity = if let Self::Mysql(settings) = self {
            let certificate = settings.client_certificate_path.take();
            let key = settings.client_key_path.take();
            certificate.is_some() || key.is_some()
        } else {
            false
        };
        Requirements {
            ca_certificate,
            client_identity,
        }
    }

    fn normalize(self) -> Result<Self> {
        Ok(match self {
            Self::Sqlite(mut s) => {
                s.name = valid_name(&s.name)?.into();
                if s.file_name.is_empty()
                    || s.file_name.len() > 1024
                    || s.file_name.contains(['/', '\\'])
                    || s.file_name.chars().any(char::is_control)
                    || !matches!(s.environment.as_str(), "DEV" | "STAGING" | "PROD")
                {
                    return Err(UNSUPPORTED.into());
                }
                Self::Sqlite(s)
            }
            Self::Postgres(s) => Self::Postgres(postgres::profiles::normalize(s)?),
            Self::Mysql(s) => Self::Mysql(mysql::profiles::normalize(s)?),
            Self::Redis(s) => Self::Redis(redis::profiles::normalize(s)?),
            Self::Mongodb(s) => Self::Mongodb(s.normalize()?),
            Self::SqlServer(s) => Self::SqlServer(s.normalize()?),
            Self::Oracle(s) => Self::Oracle(s.normalize()?),
            Self::Snowflake(s) => Self::Snowflake(s.normalize()?),
        })
    }

    fn insert(self, db: &Connection, project: &str) -> Result<()> {
        match self {
            Self::Postgres(s) => {
                postgres::profiles::create_on(db, project, s)?;
            }
            Self::Mysql(s) => {
                mysql::profiles::create_on(db, project, s)?;
            }
            Self::Redis(s) => {
                redis::profiles::create_on(db, project, s)?;
            }
            Self::Mongodb(s) => {
                db_profiles::create_on(db, project, s)?;
            }
            Self::SqlServer(s) => {
                db_profiles::create_on(db, project, s)?;
            }
            Self::Oracle(s) => {
                db_profiles::create_on(db, project, s)?;
            }
            Self::Snowflake(s) => {
                db_profiles::create_on(db, project, s)?;
            }
            Self::Sqlite(_) => unreachable!(),
        }
        Ok(())
    }
}

fn endpoint(host: &str, port: u16, user: Option<&str>, database: &str) -> String {
    let mut route = String::new();
    if let Some(user) = user.filter(|user| !user.is_empty()) {
        route.push_str(user);
        route.push('@');
    }
    if host.contains(':') {
        route.push_str(&format!("[{host}]:{port}"));
    } else {
        route.push_str(&format!("{host}:{port}"));
    }
    if !database.is_empty() {
        route.push_str(" / ");
        route.push_str(database);
    }
    route
}
