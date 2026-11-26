use super::{
    apply_write_concern,
    document_snapshot::{canonical, canonical_pretty, parse_document, parse_value, same_document},
    message,
    pipeline::{validate_expression, validate_view_pipeline},
    validate_namespace, MongoManager, MongoProfile, READ_TIMEOUT, SERVER_TIME,
};
use crate::Result;
use bson::{doc, Binary, Bson, Document};
use futures_util::TryStreamExt;
use mongodb::{error::ErrorKind, Client, Database};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{sync::Mutex, time::timeout};
use uuid::Uuid;

mod collection_changes;
pub use collection_changes::{MongoCollectionDropReview, MongoCollectionRenameReview};

const REVIEW_TTL: Duration = Duration::from_secs(300);
const STALE: &str = "MongoDB 변경 검토가 만료되었거나 바뀌었습니다. 다시 검토하세요.";
const EXISTS: &str = "같은 이름의 MongoDB 컬렉션 또는 뷰가 이미 있습니다.";
const SOURCE: &str =
    "같은 데이터베이스에 있고 현재 계정으로 조회할 수 있는 원본 이름을 확인하세요.";
const UNKNOWN: &str = "MongoDB 변경 결과를 확인하지 못했습니다. 새로 고쳐 현재 상태를 확인하세요.";
const VALIDATION_TARGET: &str = "유효성 규칙을 관리할 수 있는 일반 MongoDB 컬렉션을 확인하세요.";
const VALIDATION_CHANGED: &str =
    "검토한 MongoDB 컬렉션 또는 유효성 규칙이 바뀌었습니다. 새로 고친 뒤 다시 검토하세요.";
const VIEW_TARGET: &str = "수정할 MongoDB 뷰를 확인하세요.";
const VIEW_CHANGED: &str = "검토한 MongoDB 뷰 정의가 바뀌었습니다. 새로 고친 뒤 다시 검토하세요.";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MongoNamespaceCreate {
    Collection {
        validator: String,
        level: ValidationLevel,
        action: ValidationAction,
    },
    View {
        source: String,
        pipeline: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationLevel {
    Strict,
    Moderate,
    Off,
    Constraint,
}

impl ValidationLevel {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::Moderate => "moderate",
            Self::Off => "off",
            Self::Constraint => "constraint",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationAction {
    Error,
    Warn,
    #[serde(rename = "errorAndLog")]
    ErrorAndLog,
}

impl ValidationAction {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::ErrorAndLog => "errorAndLog",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MongoValidationChange {
    validator: String,
    level: ValidationLevel,
    action: ValidationAction,
}

#[derive(Serialize)]
pub struct MongoValidationSettings {
    validator: String,
    level: String,
    action: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MongoViewSettings {
    source: String,
    pipeline: String,
}

#[derive(Serialize)]
pub struct MongoNamespaceReview {
    token: String,
    definition: String,
    previous_definition: Option<String>,
    removes_validator: bool,
    expires_seconds: u64,
}

#[derive(Serialize)]
pub struct MongoNamespaceReport {
    database: String,
    name: String,
    kind: &'static str,
    audit_warning: bool,
}

pub(super) struct NamespaceAdmin {
    profile: MongoProfile,
    review: Mutex<Option<Review>>,
}

impl NamespaceAdmin {
    pub(super) fn new(profile: MongoProfile) -> Self {
        Self {
            profile,
            review: Mutex::new(None),
        }
    }
}

struct Review {
    token: String,
    at: Instant,
    database: String,
    name: String,
    command: Document,
    change: Change,
}

enum Change {
    Create,
    Validation(ValidationSnapshot),
    View(Document),
    DropCollection(collection_changes::CollectionSnapshot),
    RenameCollection(collection_changes::RenameSnapshot),
}

#[derive(Clone, Copy)]
enum Action {
    Create,
    Validation,
    View,
    DropCollection,
    RenameCollection,
}

struct ValidationSnapshot {
    uuid: Binary,
    options: Document,
}

impl MongoManager {
    pub async fn namespace_definition(
        &self,
        id: &str,
        database: &str,
        collection: &str,
    ) -> Result<String> {
        validate_namespace(database, collection)?;
        let db = self.client(id)?.database(database);
        let row = namespace_record(&db, collection)
            .await?
            .ok_or("MongoDB 컬렉션 또는 뷰를 찾을 수 없습니다. 목록을 새로 고치세요.")?;
        canonical(namespace_options(&row)?)
            .map_err(|_| "MongoDB 컬렉션·뷰 정의의 표시 한도는 64 KiB입니다.".into())
    }

    fn namespace_admin(&self, id: &str) -> Result<(Client, Arc<NamespaceAdmin>)> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "MongoDB 연결 목록을 읽을 수 없습니다.")?;
        let session = sessions
            .get(id)
            .ok_or("MongoDB 연결이 닫혔습니다. 다시 연결하세요.")?;
        let admin = session
            .namespace_admin
            .clone()
            .ok_or("컬렉션·뷰 관리를 허용한 MongoDB 연결을 여세요.")?;
        Ok((session.client.clone(), admin))
    }

    pub async fn review_namespace_create(
        &self,
        id: &str,
        database: String,
        name: String,
        input: MongoNamespaceCreate,
    ) -> Result<MongoNamespaceReview> {
        let (client, admin) = self.namespace_admin(id)?;
        let command = create_command(&database, &name, input)?;
        let mut pending = admin.review.lock().await;
        let db = client.database(&database);
        check_names(&db, &name, &command).await?;
        let token = Uuid::new_v4().to_string();
        let review = MongoNamespaceReview {
            token: token.clone(),
            definition: canonical(&command)?,
            previous_definition: None,
            removes_validator: false,
            expires_seconds: REVIEW_TTL.as_secs(),
        };
        *pending = Some(Review {
            token,
            at: Instant::now(),
            database,
            name,
            command,
            change: Change::Create,
        });
        Ok(review)
    }

    pub async fn namespace_validation_settings(
        &self,
        id: &str,
        database: &str,
        name: &str,
    ) -> Result<MongoValidationSettings> {
        let (client, _) = self.namespace_admin(id)?;
        validate_validation_target(database, name)?;
        let snapshot = validation_snapshot(&client.database(database), name)
            .await?
            .ok_or(VALIDATION_TARGET)?;
        let validator = validation_rule(&snapshot.options)?;
        Ok(MongoValidationSettings {
            validator: if validator.is_empty() {
                String::new()
            } else {
                canonical(validator)?
            },
            level: snapshot
                .options
                .get_str("validationLevel")
                .map_err(|_| VALIDATION_TARGET)?
                .into(),
            action: snapshot
                .options
                .get_str("validationAction")
                .map_err(|_| VALIDATION_TARGET)?
                .into(),
        })
    }

    pub async fn review_namespace_validation(
        &self,
        id: &str,
        database: String,
        name: String,
        input: MongoValidationChange,
    ) -> Result<MongoNamespaceReview> {
        let (client, admin) = self.namespace_admin(id)?;
        validate_validation_target(&database, &name)?;
        let mut pending = admin.review.lock().await;
        let before = validation_snapshot(&client.database(&database), &name)
            .await?
            .ok_or(VALIDATION_TARGET)?;
        let original = validation_rule(&before.options)?;
        let validator = if input.validator == canonical(original)? {
            original.clone()
        } else {
            parse_validator(&input.validator)?
        };
        let removes_validator = !original.is_empty() && validator.is_empty();
        let after = validation_options(validator, input.level, input.action);
        let command = validation_command(&name, &before, &after)?;
        let token = Uuid::new_v4().to_string();
        let review = MongoNamespaceReview {
            token: token.clone(),
            definition: canonical(&after)?,
            previous_definition: Some(canonical(&before.options)?),
            removes_validator,
            expires_seconds: REVIEW_TTL.as_secs(),
        };
        *pending = Some(Review {
            token,
            at: Instant::now(),
            database,
            name,
            command,
            change: Change::Validation(before),
        });
        Ok(review)
    }

    pub async fn namespace_view_settings(
        &self,
        id: &str,
        database: &str,
        name: &str,
    ) -> Result<MongoViewSettings> {
        let (client, _) = self.namespace_admin(id)?;
        validate_namespace(database, name)?;
        let options = view_snapshot(&client.database(database), name)
            .await?
            .ok_or(VIEW_TARGET)?;
        let (source, pipeline) = view_definition(&options)?;
        Ok(MongoViewSettings {
            source: source.into(),
            pipeline: canonical_pretty(pipeline)?,
        })
    }

    pub async fn review_namespace_view(
        &self,
        id: &str,
        database: String,
        name: String,
        input: MongoViewSettings,
    ) -> Result<MongoNamespaceReview> {
        let (client, admin) = self.namespace_admin(id)?;
        validate_namespace(&database, &name)?;
        validate_view_source(&database, &name, &input.source)?;
        let mut pending = admin.review.lock().await;
        let db = client.database(&database);
        let before = view_snapshot(&db, &name).await?.ok_or(VIEW_TARGET)?;
        let (_, stored_pipeline) = view_definition(&before)?;
        let pipeline = if input.pipeline == canonical_pretty(stored_pipeline)? {
            stored_pipeline.clone()
        } else {
            parse_view_pipeline(&input.pipeline)?
        };
        let mut after = before.clone();
        after.insert("viewOn", &input.source);
        after.insert("pipeline", pipeline.clone());
        if same_document(&before, &after)? {
            return Err("변경할 MongoDB 뷰 원본 또는 파이프라인을 지정하세요.".into());
        }
        check_view_source(&db, &input.source).await?;
        let command = doc! { "collMod": &name, "viewOn": input.source, "pipeline": pipeline };
        let token = Uuid::new_v4().to_string();
        let review = MongoNamespaceReview {
            token: token.clone(),
            definition: canonical(&after)?,
            previous_definition: Some(canonical(&before)?),
            removes_validator: false,
            expires_seconds: REVIEW_TTL.as_secs(),
        };
        *pending = Some(Review {
            token,
            at: Instant::now(),
            database,
            name,
            command,
            change: Change::View(before),
        });
        Ok(review)
    }

    pub async fn discard_namespace_review(&self, id: &str, token: &str) -> Result<()> {
        let (_, admin) = self.namespace_admin(id)?;
        let mut pending = admin.review.lock().await;
        if pending.as_ref().is_some_and(|review| review.token == token) {
            *pending = None;
        }
        Ok(())
    }

    pub async fn apply_namespace_create(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
    ) -> Result<MongoNamespaceReport> {
        self.apply_namespace_review(id, token, confirmation, "", Action::Create)
            .await
    }

    pub async fn apply_namespace_validation(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
    ) -> Result<MongoNamespaceReport> {
        self.apply_namespace_review(id, token, confirmation, "", Action::Validation)
            .await
    }

    pub async fn apply_namespace_view(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
    ) -> Result<MongoNamespaceReport> {
        self.apply_namespace_review(id, token, confirmation, "", Action::View)
            .await
    }

    async fn apply_namespace_review(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
        approval: &str,
        action: Action,
    ) -> Result<MongoNamespaceReport> {
        let _write = self.namespace_writes.lock().await;
        let (client, admin) = self.namespace_admin(id)?;
        let mut pending = admin.review.lock().await;
        pending
            .as_ref()
            .filter(|review| {
                review.token == token
                    && review.at.elapsed() < REVIEW_TTL
                    && matches!(
                        (&review.change, action),
                        (Change::Create, Action::Create)
                            | (Change::Validation(_), Action::Validation)
                            | (Change::View(_), Action::View)
                            | (Change::DropCollection(_), Action::DropCollection)
                            | (Change::RenameCollection(_), Action::RenameCollection)
                    )
            })
            .ok_or(STALE)?;
        if admin.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if matches!(action, Action::DropCollection) && approval != "DROP" {
            return Err("컬렉션을 삭제하려면 DROP을 입력하세요.".into());
        }
        let Review {
            database,
            name,
            mut command,
            change,
            ..
        } = pending.take().ok_or(STALE)?;
        let db = client.database(&database);
        let object_name = match &change {
            Change::DropCollection(_) => Some(format!("{database}.{name}")),
            Change::RenameCollection(before) => Some(format!(
                "{database}.{name} → {database}.{}",
                before.new_name
            )),
            _ => None,
        };
        let (kind, operation) = match &change {
            Change::Validation(_) => ("collection", "mongo.namespace.validation"),
            Change::View(_) => ("view", "mongo.namespace.update_view"),
            Change::DropCollection(_) => ("collection", "mongo.namespace.drop_collection"),
            Change::RenameCollection(_) => ("collection", "mongo.namespace.rename_collection"),
            Change::Create => {
                check_names(&db, &name, &command).await?;
                if command.contains_key("viewOn") {
                    ("view", "mongo.namespace.create_view")
                } else {
                    ("collection", "mongo.namespace.create_collection")
                }
            }
        };
        command.insert("maxTimeMS", SERVER_TIME.as_millis() as i32);
        apply_write_concern(&client, &mut command)?;
        self.audit_mongo_change(
            &admin.profile,
            token,
            operation,
            "started",
            None,
            object_name.as_deref(),
        )
        .await?;
        let result = async {
            match &change {
                Change::Validation(before) => {
                    let current = validation_snapshot(&db, &name)
                        .await?
                        .ok_or(VALIDATION_CHANGED)?;
                    if current.uuid != before.uuid
                        || !same_document(&current.options, &before.options)?
                    {
                        return Err(VALIDATION_CHANGED.into());
                    }
                }
                Change::View(before) => {
                    check_view_source(&db, command.get_str("viewOn").map_err(|_| VIEW_TARGET)?)
                        .await?;
                    let current = view_snapshot(&db, &name).await?.ok_or(VIEW_CHANGED)?;
                    if !same_document(&current, &before)? {
                        return Err(VIEW_CHANGED.into());
                    }
                }
                Change::DropCollection(before) => {
                    collection_changes::check_drop(&db, &name, before).await?;
                }
                Change::RenameCollection(before) => {
                    collection_changes::check_rename(&db, &name, before).await?;
                    return execute_namespace_change(&client.database("admin"), command, action)
                        .await;
                }
                Change::Create => {}
            }
            execute_namespace_change(&db, command, action).await
        }
        .await;
        let (event, outcome, count) = match result.as_ref() {
            Ok(()) => (operation, "succeeded", Some(1)),
            Err(error) if error == UNKNOWN && matches!(action, Action::DropCollection) => (
                "mongo.namespace.drop_collection.unconfirmed",
                "started",
                None,
            ),
            Err(error) if error == UNKNOWN && matches!(action, Action::RenameCollection) => (
                "mongo.namespace.rename_collection.unconfirmed",
                "started",
                None,
            ),
            Err(error) if error == UNKNOWN => ("mongo.namespace.unconfirmed", "started", None),
            Err(_) => (operation, "failed", None),
        };
        let audit_warning = self
            .audit_mongo_change(
                &admin.profile,
                token,
                event,
                outcome,
                count,
                object_name.as_deref(),
            )
            .await
            .is_err();
        match result {
            Ok(()) => Ok(MongoNamespaceReport {
                database,
                name: match change {
                    Change::RenameCollection(before) => before.new_name,
                    _ => name,
                },
                kind,
                audit_warning,
            }),
            Err(error) if audit_warning => {
                Err(format!("{error} 완료 감사 기록도 저장하지 못했습니다."))
            }
            Err(error) => Err(error),
        }
    }
}

async fn namespace_record(db: &Database, name: &str) -> Result<Option<Document>> {
    timeout(READ_TIMEOUT, async {
        let mut cursor = db
            .run_cursor_command(doc! {
                "listCollections": 1,
                "filter": { "name": name },
                "cursor": { "batchSize": 1 },
                "maxTimeMS": SERVER_TIME.as_millis() as i32,
            })
            .await
            .map_err(message)?;
        cursor.try_next().await.map_err(message)
    })
    .await
    .map_err(|_| "MongoDB 컬렉션·뷰 정의 조회 시간이 초과되었습니다.")?
}

fn namespace_options(row: &Document) -> Result<&Document> {
    row.get_document("options")
        .map_err(|_| "MongoDB 컬렉션·뷰 정의를 읽을 수 없습니다.".into())
}

async fn collection_identity(db: &Database, name: &str) -> Result<Option<(Binary, Document)>> {
    let Some(row) = namespace_record(db, name).await? else {
        return Ok(None);
    };
    if row.get_str("type").ok() != Some("collection") {
        return Ok(None);
    }
    let info = row
        .get_document("info")
        .map_err(|_| "MongoDB 컬렉션 정보를 읽을 수 없습니다.")?;
    let Some(Bson::Binary(uuid)) = info.get("uuid") else {
        return Ok(None);
    };
    if info.get_bool("readOnly").ok() != Some(false) {
        return Ok(None);
    }
    Ok(Some((uuid.clone(), namespace_options(&row)?.clone())))
}

async fn validation_snapshot(db: &Database, name: &str) -> Result<Option<ValidationSnapshot>> {
    let Some((uuid, options)) = collection_identity(db, name).await? else {
        return Ok(None);
    };
    let validator = match options.get("validator") {
        Some(Bson::Document(validator)) => validator.clone(),
        None => Document::new(),
        _ => return Err(VALIDATION_TARGET.into()),
    };
    Ok(Some(ValidationSnapshot {
        uuid,
        options: doc! {
            "validator": validator,
            "validationLevel": options.get_str("validationLevel").unwrap_or("strict"),
            "validationAction": options.get_str("validationAction").unwrap_or("error"),
        },
    }))
}

async fn view_snapshot(db: &Database, name: &str) -> Result<Option<Document>> {
    let Some(row) = namespace_record(db, name).await? else {
        return Ok(None);
    };
    if row.get_str("type").ok() != Some("view") {
        return Ok(None);
    }
    Ok(Some(namespace_options(&row)?.clone()))
}

fn view_definition(options: &Document) -> Result<(&str, &Bson)> {
    let source = options.get_str("viewOn").map_err(|_| VIEW_TARGET)?;
    let pipeline = options
        .get("pipeline")
        .filter(|value| value.as_array().is_some())
        .ok_or(VIEW_TARGET)?;
    Ok((source, pipeline))
}

fn validate_validation_target(database: &str, name: &str) -> Result<()> {
    validate_namespace(database, name)?;
    if name.starts_with("system.") || matches!(database, "admin" | "config" | "local") {
        return Err(VALIDATION_TARGET.into());
    }
    Ok(())
}

fn validation_rule(options: &Document) -> Result<&Document> {
    options
        .get_document("validator")
        .map_err(|_| VALIDATION_TARGET.into())
}

fn parse_validator(validator: &str) -> Result<Document> {
    let validator = if validator.trim().is_empty() {
        Document::new()
    } else {
        parse_document(validator)?
    };
    validate_expression(&Bson::Document(validator.clone()), 0)?;
    Ok(validator)
}

fn validation_options(
    validator: Document,
    level: ValidationLevel,
    action: ValidationAction,
) -> Document {
    doc! { "validator": validator, "validationLevel": level.as_str(), "validationAction": action.as_str() }
}

fn validation_command(
    name: &str,
    before: &ValidationSnapshot,
    after: &Document,
) -> Result<Document> {
    let mut command = doc! { "collMod": name, "collectionUUID": before.uuid.clone() };
    for (field, value) in after {
        let unchanged = match (before.options.get(field), value) {
            (Some(Bson::Document(old)), Bson::Document(new)) => same_document(old, new)?,
            (old, new) => old == Some(new),
        };
        if !unchanged {
            command.insert(field, value.clone());
        }
    }
    if command.len() == 2 {
        return Err("변경할 유효성 규칙 또는 검사 옵션을 지정하세요.".into());
    }
    Ok(command)
}

async fn check_names(db: &Database, name: &str, command: &Document) -> Result<()> {
    timeout(READ_TIMEOUT, async {
        if namespace_exists(db, name).await? {
            return Err(EXISTS.into());
        }
        if let Ok(source) = command.get_str("viewOn") {
            if !namespace_exists(db, source).await? {
                return Err(SOURCE.into());
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| "MongoDB 이름 확인 시간이 초과되었습니다.")?
}

async fn namespace_exists(db: &Database, name: &str) -> Result<bool> {
    let mut cursor = db
        .run_cursor_command(doc! {
            "listCollections": 1, "authorizedCollections": true, "nameOnly": true,
            "filter": { "name": name },
        })
        .await
        .map_err(message)?;
    Ok(cursor.try_next().await.map_err(message)?.is_some())
}

async fn check_view_source(db: &Database, source: &str) -> Result<()> {
    let exists = timeout(READ_TIMEOUT, namespace_exists(db, source))
        .await
        .map_err(|_| "MongoDB 원본 조회 시간이 초과되었습니다.")??;
    if !exists {
        return Err(SOURCE.into());
    }
    Ok(())
}

async fn execute_namespace_change(db: &Database, command: Document, action: Action) -> Result<()> {
    let reply = timeout(READ_TIMEOUT, db.run_command(command))
        .await
        .map_err(|_| UNKNOWN)?
        .map_err(|error| match error.kind.as_ref() {
            ErrorKind::Command(command) => match (action, command.code) {
                (Action::Validation, 13) => "현재 MongoDB 계정에 유효성 규칙을 변경할 권한이 없습니다.",
                (Action::Validation, 26 | 361) => VALIDATION_CHANGED,
                (Action::Validation, 2 | 9 | 20 | 72 | 73 | 121 | 167 | 168 | 169 | 173 | 303 | 323 | 40324) => {
                    "MongoDB 서버가 유효성 규칙 변경을 거부했습니다. 규칙과 서버 지원을 확인하세요."
                }
                (Action::View, 13) => "현재 MongoDB 계정에 뷰를 변경할 권한이 없습니다.",
                (Action::View, 26) => VIEW_CHANGED,
                (Action::View, 5) => "MongoDB 뷰가 원본을 통해 자신을 참조합니다.",
                (Action::View, 2 | 9 | 20 | 72 | 73 | 167 | 168 | 169 | 173 | 40324) => {
                    "MongoDB 서버가 뷰 정의 변경을 거부했습니다. 원본, 파이프라인과 서버 지원을 확인하세요."
                }
                (Action::DropCollection, 13) => "현재 MongoDB 계정에 컬렉션을 삭제할 권한이 없습니다.",
                (Action::DropCollection, 26 | 361) => collection_changes::CHANGED,
                (Action::DropCollection, 2 | 9 | 20 | 72 | 73 | 115 | 197 | 303 | 323 | 40415) => {
                    "MongoDB 서버가 UUID 조건이 있는 컬렉션 삭제를 거부했습니다. 서버 지원을 확인하세요."
                }
                (Action::RenameCollection, 13) => "현재 MongoDB 계정에 컬렉션 이름을 변경할 권한이 없습니다.",
                (Action::RenameCollection, 26 | 361) => collection_changes::CHANGED,
                (Action::RenameCollection, 48) => collection_changes::NAME_TAKEN,
                (Action::RenameCollection, 2 | 9 | 20 | 72 | 73 | 115 | 166 | 197 | 303 | 323 | 40415) => {
                    "MongoDB 서버가 컬렉션 이름 변경을 거부했습니다. 이름과 서버 지원을 확인하세요."
                }
                (Action::Create, 13) => "현재 MongoDB 계정에 컬렉션 또는 뷰를 생성할 권한이 없습니다.",
                (Action::Create, 48) => EXISTS,
                (Action::Create, 2 | 9 | 72 | 73 | 167 | 168 | 169 | 173 | 40324) => {
                    "MongoDB 서버가 생성을 거부했습니다. 이름, 유효성 규칙 또는 뷰 파이프라인을 확인하세요."
                }
                _ => UNKNOWN,
            },
            _ => UNKNOWN,
        })?;
    if reply.contains_key("writeConcernError") {
        return Err(UNKNOWN.into());
    }
    Ok(())
}

fn create_command(database: &str, name: &str, input: MongoNamespaceCreate) -> Result<Document> {
    validate_namespace(database, name)?;
    if !valid_create_name(name) {
        return Err(
            "컬렉션과 뷰 이름에 $, 제어 문자 또는 system. 접두사를 사용할 수 없습니다.".into(),
        );
    }
    let mut command = doc! { "create": name };
    match input {
        MongoNamespaceCreate::Collection {
            validator,
            level,
            action,
        } => {
            if !validator.trim().is_empty() {
                command.extend(validation_options(
                    parse_validator(&validator)?,
                    level,
                    action,
                ));
            }
        }
        MongoNamespaceCreate::View { source, pipeline } => {
            validate_view_source(database, name, &source)?;
            command.insert("viewOn", source);
            command.insert("pipeline", parse_view_pipeline(&pipeline)?);
        }
    }
    Ok(command)
}

fn validate_view_source(database: &str, name: &str, source: &str) -> Result<()> {
    validate_namespace(database, source)?;
    if source == name || !valid_create_name(source) {
        return Err(SOURCE.into());
    }
    Ok(())
}

fn parse_view_pipeline(pipeline: &str) -> Result<Bson> {
    let pipeline = parse_value(pipeline)?;
    validate_view_pipeline(&pipeline)?;
    Ok(pipeline)
}

fn valid_create_name(name: &str) -> bool {
    !name.trim().is_empty()
        && !name.starts_with("system.")
        && !name.chars().any(|value| value.is_control() || value == '$')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_command_preserves_unchanged_options_and_clears_rules_explicitly() {
        let input =
            parse_validator(r#"{"qty":{"$gte":{"$numberLong":"9007199254740993"}}}"#).unwrap();
        let uuid = Binary {
            subtype: bson::spec::BinarySubtype::Uuid,
            bytes: vec![0; 16],
        };
        let before = ValidationSnapshot {
            uuid: uuid.clone(),
            options: validation_options(
                input.clone(),
                ValidationLevel::Strict,
                ValidationAction::Error,
            ),
        };
        assert!(validation_command("items", &before, &before.options).is_err());
        let warn = validation_options(input, ValidationLevel::Strict, ValidationAction::Warn);
        assert_eq!(
            validation_command("items", &before, &warn).unwrap(),
            doc! {
                "collMod": "items", "collectionUUID": uuid.clone(), "validationAction": "warn",
            }
        );
        let removed = validation_options(
            parse_validator(" ").unwrap(),
            ValidationLevel::Strict,
            ValidationAction::Error,
        );
        assert_eq!(
            validation_command("items", &before, &removed).unwrap(),
            doc! {
                "collMod": "items", "collectionUUID": uuid, "validator": {},
            }
        );
    }

    #[test]
    fn create_keeps_bson_validator_and_view_pipeline() {
        let command = create_command(
            "orders",
            "items",
            MongoNamespaceCreate::Collection {
                validator: r#"{"qty":{"$gte":{"$numberLong":"9007199254740993"}}}"#.into(),
                level: ValidationLevel::Moderate,
                action: ValidationAction::Warn,
            },
        )
        .unwrap();
        assert_eq!(
            command,
            doc! {
                "create": "items", "validator": { "qty": { "$gte": 9007199254740993_i64 } },
                "validationLevel": "moderate", "validationAction": "warn",
            }
        );
        let command = create_command(
            "orders",
            "positive",
            MongoNamespaceCreate::View {
                source: "items".into(),
                pipeline: r#"[{"$match":{"qty":{"$gt":0}}}]"#.into(),
            },
        )
        .unwrap();
        assert_eq!(
            command,
            doc! {
                "create": "positive", "viewOn": "items", "pipeline": [{ "$match": { "qty": { "$gt": 0 } } }],
            }
        );
    }

    #[test]
    fn create_rejects_invalid_names_duplicate_keys_and_nested_write_stages() {
        let view = |source: &str, pipeline: &str| MongoNamespaceCreate::View {
            source: source.into(),
            pipeline: pipeline.into(),
        };
        assert!(create_command("db", "same", view("same", "[]")).is_err());
        assert!(create_command("db", "system.views", view("source", "[]")).is_err());
        assert!(create_command(
            "db",
            "view",
            view("source", r#"[{"$facet":{"write":[{"$out":"other"}]}}]"#)
        )
        .is_err());
        assert!(create_command(
            "db",
            "view",
            view("source", r#"[{"$match":{"x":1,"x":2}}]"#)
        )
        .is_err());
        assert!(create_command(
            "db",
            "view",
            view("source", r#"[{"$match":{"$where":"true"}}]"#)
        )
        .is_err());
        assert!(create_command("db", "view", view("source", "[]")).is_ok());
    }
}
