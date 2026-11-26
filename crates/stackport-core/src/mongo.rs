mod document_edit;
mod document_snapshot;
mod document_structure;
mod find_builder;
mod index_admin;
mod namespace_admin;
mod pipeline;
mod pipeline_store;
mod profiles;
mod query;
mod schema;

pub use document_edit::{MongoDocumentChange, MongoEditDraft, MongoEditReport, MongoEditReview};
pub use document_structure::{edit_mongo_document_draft, MongoDraftChange, MongoDraftStructure};
pub use find_builder::{build_mongo_find_filter, MongoFindNode};
pub use index_admin::{MongoIndexChange, MongoIndexReport, MongoIndexReview};
pub use namespace_admin::{MongoNamespaceCreate, MongoNamespaceReport, MongoNamespaceReview, MongoValidationChange, MongoValidationSettings, MongoViewSettings};
pub use pipeline::{MongoPipelinePreview, MongoPipelineStage};
pub use pipeline_store::{MongoPipelineSummary, MongoPipelineWrite, SavedMongoPipeline};
pub(crate) use pipeline_store::{copy_project_pipelines, SCHEMA as PIPELINE_SCHEMA};
pub use profiles::{MongoProfile, MongoSettings};
pub use query::{MongoDocumentPage, MongoQuery};
pub use schema::MongoSchemaSample;

use crate::{Result, Store};
use bson::{doc, Bson, Document};
use futures_util::TryStreamExt;
use mongodb::{
    error::{Error, ErrorKind},
    options::{Acknowledgment, ClientOptions, Credential, ReadPreference, SelectionCriteria, Tls, TlsOptions},
    Client,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::timeout,
};
use uuid::Uuid;
use zeroize::Zeroizing;

const READ_TIMEOUT: Duration = Duration::from_secs(12);
const SERVER_TIME: Duration = Duration::from_secs(7);
const CATALOG_LIMIT: usize = 50;
const INDEX_LIMIT: usize = 64;

#[derive(Deserialize)]
#[serde(transparent)]
pub struct MongoPassword(#[serde(deserialize_with = "deserialize_password")] Zeroizing<String>);

fn deserialize_password<'de, D: Deserializer<'de>>(
    input: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(input).map(Zeroizing::new)
}

#[derive(Serialize)]
pub struct MongoSessionInfo {
    id: String,
    database: Option<String>,
    allow_edits: bool,
    allow_indexes: bool,
    allow_namespaces: bool,
}

#[derive(Serialize)]
pub struct MongoCatalogPage<T> {
    items: Vec<T>,
    has_next: bool,
}

#[derive(Serialize)]
pub struct MongoCollection {
    name: String,
    kind: String,
}

#[derive(Serialize)]
pub struct MongoIndex {
    name: String,
    keys: String,
    unique: bool,
    ttl_seconds: Option<u64>,
    ttl_eligible: bool,
    hidden: bool,
}

struct Session {
    client: Client,
    editor: Option<Arc<document_edit::DocumentEditor>>,
    index_admin: Option<Arc<index_admin::IndexAdmin>>,
    namespace_admin: Option<Arc<namespace_admin::NamespaceAdmin>>,
    _permit: OwnedSemaphorePermit,
}

pub struct MongoManager {
    store: Store,
    capacity: Arc<Semaphore>,
    sessions: Mutex<HashMap<String, Session>>,
    namespace_writes: tokio::sync::Mutex<()>,
}

impl MongoManager {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            capacity: Arc::new(Semaphore::new(6)),
            sessions: Mutex::default(),
            namespace_writes: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn open(
        &self,
        profile_id: String,
        revision: i64,
        password: MongoPassword,
        confirmation: &str,
        allow_edits: bool,
        allow_indexes: bool,
        allow_namespaces: bool,
    ) -> Result<MongoSessionInfo> {
        let store = self.store.clone();
        let profile =
            tokio::task::spawn_blocking(move || store.mongo_profile(&profile_id, revision))
                .await
                .map_err(|_| "MongoDB 연결 설정을 읽을 수 없습니다.")??;
        let editor = allow_edits.then(|| Arc::new(document_edit::DocumentEditor::new(profile.clone())));
        let index_admin = allow_indexes.then(|| Arc::new(index_admin::IndexAdmin::new(profile.clone())));
        let namespace_admin = allow_namespaces.then(|| Arc::new(namespace_admin::NamespaceAdmin::new(profile.clone())));
        let settings = profile.settings;
        if settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if password.0.len() > 4096 || (settings.username.is_none() && !password.0.is_empty()) {
            return Err("MongoDB 사용자 이름과 암호를 확인하세요.".into());
        }
        let permit = Arc::clone(&self.capacity)
            .try_acquire_owned()
            .map_err(|_| "열린 MongoDB 연결이 너무 많습니다.")?;
        let (client, database) = timeout(READ_TIMEOUT, async {
            let mut address = profiles::parse_uri(&settings.uri, settings.tls)?;
            let uri_source = address.credential.take().and_then(|auth| auth.source);
            address.credential = settings.username.map(|username| {
                Credential::builder()
                    .username(Some(username))
                    .password(Some(password.0.as_str().to_owned()))
                    .source(settings.auth_database.or(uri_source))
                    .build()
            });
            drop(password);
            let mut options = ClientOptions::parse(address)
                .await
                .map_err(|_| "MongoDB 주소 또는 DNS 설정을 확인하세요.")?;
            let database = options.default_database.clone();
            options.tls = Some(if settings.tls {
                let mut tls = TlsOptions::default();
                if let Some(path) = settings.ca_path {
                    let path = PathBuf::from(path);
                    let metadata = tokio::fs::metadata(&path)
                        .await
                        .map_err(|_| "MongoDB CA 인증서 파일을 읽을 수 없습니다.")?;
                    if !metadata.is_file() || !(1..=256 * 1024).contains(&metadata.len()) {
                        return Err(
                            "MongoDB CA 인증서는 256 KiB 이하의 PEM 파일을 지정하세요.".into()
                        );
                    }
                    tls.ca_file_path = Some(path);
                }
                Tls::Enabled(tls)
            } else {
                Tls::Disabled
            });
            options.app_name.get_or_insert_with(|| "StackPort".into());
            options.connect_timeout = Some(Duration::from_secs(5));
            options.server_selection_timeout = Some(Duration::from_secs(6));
            options.max_pool_size = Some(4);
            options.retry_reads = Some(false);
            options.retry_writes = Some(false);
            if allow_edits || allow_indexes || allow_namespaces {
                if options.write_concern.as_ref().is_some_and(|setting| setting.w == Some(Acknowledgment::Nodes(0))) {
                    return Err("MongoDB 변경에는 서버가 결과를 확인하는 쓰기 설정(w=1 이상)이 필요합니다.".into());
                }
                options.selection_criteria = Some(SelectionCriteria::ReadPreference(ReadPreference::Primary));
            }
            let client =
                Client::with_options(options).map_err(|_| "MongoDB 연결 설정을 확인하세요.")?;
            client
                .database("admin")
                .run_command(doc! { "ping": 1 })
                .await
                .map_err(message)?;
            Ok::<_, String>((client, database))
        })
        .await
        .map_err(|_| "MongoDB 연결 시간이 초과되었습니다.")??;
        let id = Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .map_err(|_| "MongoDB 연결 목록을 읽을 수 없습니다.")?
            .insert(
                id.clone(),
                Session {
                    client,
                    editor,
                    index_admin,
                    namespace_admin,
                    _permit: permit,
                },
            );
        Ok(MongoSessionInfo { id, database, allow_edits, allow_indexes, allow_namespaces })
    }

    pub async fn close(&self, id: &str) -> Result<()> {
        let ended = self
            .sessions
            .lock()
            .map_err(|_| "MongoDB 연결 목록을 읽을 수 없습니다.")?
            .remove(id);
        if let Some(session) = ended {
            session.client.shutdown().immediate(true).await;
        }
        Ok(())
    }

    fn client(&self, id: &str) -> Result<Client> {
        self.sessions
            .lock()
            .map_err(|_| "MongoDB 연결 목록을 읽을 수 없습니다.")?
            .get(id)
            .map(|session| session.client.clone())
            .ok_or_else(|| "MongoDB 연결이 닫혔습니다. 다시 연결하세요.".into())
    }

    pub async fn databases(
        &self,
        id: &str,
        search: &str,
        page: u32,
    ) -> Result<MongoCatalogPage<String>> {
        let client = self.client(id)?;
        let filter = name_filter(search)?;
        let mut names = timeout(READ_TIMEOUT, async {
            client
                .list_database_names()
                .authorized_databases(true)
                .filter(filter)
                .await
        })
        .await
        .map_err(|_| "MongoDB 데이터베이스 조회 시간이 초과되었습니다.")?
        .map_err(message)?;
        names.sort_unstable();
        Ok(page_from(names, page))
    }

    pub async fn collections(
        &self,
        id: &str,
        database: &str,
        search: &str,
        page: u32,
    ) -> Result<MongoCatalogPage<MongoCollection>> {
        if !valid_database(database) {
            return Err("MongoDB 데이터베이스 이름을 확인하세요.".into());
        }
        let client = self.client(id)?;
        let filter = name_filter(search)?;
        timeout(READ_TIMEOUT, async {
            let mut cursor = client
                .database(database)
                .run_cursor_command(doc! {
                    "listCollections": 1, "authorizedCollections": true, "nameOnly": true,
                    "filter": filter, "cursor": { "batchSize": 100 },
                })
                .await
                .map_err(message)?;
            let mut items = Vec::new();
            let limit = u64::from(page) * CATALOG_LIMIT as u64 + CATALOG_LIMIT as u64 + 1;
            let mut seen = 0;
            while seen < limit {
                let Some(row) = cursor.try_next().await.map_err(message)? else {
                    break;
                };
                if seen >= limit - CATALOG_LIMIT as u64 - 1 {
                    let name = row
                        .get_str("name")
                        .map_err(|_| "MongoDB 컬렉션 응답을 읽을 수 없습니다.")?;
                    items.push(MongoCollection {
                        name: name.into(),
                        kind: row.get_str("type").unwrap_or("collection").into(),
                    });
                }
                seen += 1;
            }
            let has_next = items.len() > CATALOG_LIMIT;
            items.truncate(CATALOG_LIMIT);
            Ok(MongoCatalogPage { items, has_next })
        })
        .await
        .map_err(|_| "MongoDB 컬렉션 조회 시간이 초과되었습니다.")?
    }

    pub async fn indexes(
        &self,
        id: &str,
        database: &str,
        collection: &str,
    ) -> Result<MongoCatalogPage<MongoIndex>> {
        validate_namespace(database, collection)?;
        let client = self.client(id)?;
        timeout(READ_TIMEOUT, async {
            let mut cursor = client
                .database(database)
                .collection::<Document>(collection)
                .list_indexes()
                .await
                .map_err(message)?;
            let mut items = Vec::new();
            while items.len() <= INDEX_LIMIT {
                let Some(index) = cursor.try_next().await.map_err(message)? else {
                    break;
                };
                let options = index.options.unwrap_or_default();
                let name = options.name.unwrap_or_default();
                items.push(MongoIndex {
                    unique: options.unique.unwrap_or(name == "_id_"),
                    name,
                    ttl_seconds: options.expire_after.map(|duration| duration.as_secs()),
                    ttl_eligible: index_admin::ttl_key(&index.keys),
                    keys: document_snapshot::canonical_value(&Bson::Document(index.keys))?,
                    hidden: options.hidden.unwrap_or(false),
                });
            }
            let has_next = items.len() > INDEX_LIMIT;
            items.truncate(INDEX_LIMIT);
            Ok(MongoCatalogPage { items, has_next })
        })
        .await
        .map_err(|_| "MongoDB 인덱스 조회 시간이 초과되었습니다.")?
    }
}

fn apply_write_concern(client: &Client, command: &mut Document) -> Result<()> {
    if let Some(concern) = client.write_concern() {
        command.insert(
            "writeConcern",
            bson::serialize_to_document(concern).map_err(|_| "MongoDB 쓰기 옵션을 읽을 수 없습니다.")?,
        );
    }
    Ok(())
}

fn page_from<T>(items: Vec<T>, page: u32) -> MongoCatalogPage<T> {
    let offset = (u64::from(page) * CATALOG_LIMIT as u64).min(usize::MAX as u64) as usize;
    let mut items: Vec<_> = items
        .into_iter()
        .skip(offset)
        .take(CATALOG_LIMIT + 1)
        .collect();
    let has_next = items.len() > CATALOG_LIMIT;
    items.truncate(CATALOG_LIMIT);
    MongoCatalogPage { items, has_next }
}

fn name_filter(search: &str) -> Result<Document> {
    if search.len() > 256 || search.contains('\0') {
        return Err("MongoDB 검색어는 256바이트 이하여야 합니다.".into());
    }
    if search.is_empty() {
        return Ok(doc! {});
    }
    let mut pattern = String::new();
    for character in search.chars() {
        if r"\.^$|?*+()[]{}".contains(character) {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    Ok(doc! { "name": { "$regex": pattern, "$options": "i" } })
}

fn valid_database(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && !name
            .chars()
            .any(|value| value.is_control() || "/\\. \"$*<>:|?".contains(value))
}

fn validate_namespace(database: &str, collection: &str) -> Result<()> {
    if !valid_database(database)
        || collection.is_empty()
        || collection.len() > 256
        || collection.contains('\0')
    {
        return Err("MongoDB 데이터베이스와 컬렉션 이름을 확인하세요.".into());
    }
    Ok(())
}

fn message(error: Error) -> String {
    match error.kind.as_ref() {
        ErrorKind::Authentication { .. } => "MongoDB 사용자 이름, 암호와 인증 데이터베이스를 확인하세요.",
        ErrorKind::Command(command) if command.code == 13 => "현재 MongoDB 계정에 조회 권한이 없습니다.",
        ErrorKind::Command(command) if command.code == 50 => "MongoDB 서버 조회 시간이 초과되었습니다.",
        ErrorKind::Command(_) => "MongoDB 서버가 조회를 거부했습니다. 필터와 계정 권한을 확인하세요.",
        _ => "MongoDB 연결 또는 서버 응답을 확인할 수 없습니다. 호스트, TLS 인증서와 네트워크를 확인하세요.",
    }.into()
}
