use super::{
    apply_write_concern,
    document_snapshot::{canonical, parse_document, parse_value, same_document},
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

const REVIEW_TTL: Duration = Duration::from_secs(300);
const STALE: &str = "MongoDB 변경 검토가 만료되었거나 바뀌었습니다. 다시 검토하세요.";
const EXISTS: &str = "같은 이름의 MongoDB 컬렉션 또는 뷰가 이미 있습니다.";
const SOURCE: &str =
    "같은 데이터베이스에 있고 현재 계정으로 조회할 수 있는 원본 이름을 확인하세요.";
const UNKNOWN: &str = "MongoDB 변경 결과를 확인하지 못했습니다. 새로 고쳐 현재 상태를 확인하세요.";
const VALIDATION_TARGET: &str = "유효성 규칙을 관리할 수 있는 일반 MongoDB 컬렉션을 확인하세요.";
const VALIDATION_CHANGED: &str =
    "검토한 MongoDB 컬렉션 또는 유효성 규칙이 바뀌었습니다. 새로 고친 뒤 다시 검토하세요.";

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
    validation: Option<ValidationSnapshot>,
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
            validation: None,
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
            validation: Some(before),
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
        self.apply_namespace_review(id, token, confirmation, false)
            .await
    }

    pub async fn apply_namespace_validation(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
    ) -> Result<MongoNamespaceReport> {
        self.apply_namespace_review(id, token, confirmation, true)
            .await
    }

    async fn apply_namespace_review(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
        validation: bool,
    ) -> Result<MongoNamespaceReport> {
        let _write = self.namespace_writes.lock().await;
        let (client, admin) = self.namespace_admin(id)?;
        let mut pending = admin.review.lock().await;
        pending
            .as_ref()
            .filter(|review| {
                review.token == token
                    && review.at.elapsed() < REVIEW_TTL
                    && review.validation.is_some() == validation
            })
            .ok_or(STALE)?;
        if admin.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let Review {
            database,
            name,
            mut command,
            validation: before,
            ..
        } = pending.take().ok_or(STALE)?;
        let db = client.database(&database);
        let (kind, operation) = if before.is_some() {
            ("collection", "mongo.namespace.validation")
        } else {
            check_names(&db, &name, &command).await?;
            if command.contains_key("viewOn") {
                ("view", "mongo.namespace.create_view")
            } else {
                ("collection", "mongo.namespace.create_collection")
            }
        };
        command.insert("maxTimeMS", SERVER_TIME.as_millis() as i32);
        apply_write_concern(&client, &mut command)?;
        self.audit_mongo_change(&admin.profile, token, operation, "started", None)
            .await?;
        let result = async {
            if let Some(before) = before {
                let current = validation_snapshot(&db, &name)
                    .await?
                    .ok_or(VALIDATION_CHANGED)?;
                if current.uuid != before.uuid || !same_document(&current.options, &before.options)?
                {
                    return Err(VALIDATION_CHANGED.into());
                }
            }
            execute_namespace_change(&db, command, validation).await
        }
        .await;
        let (event, outcome, count) = match result.as_ref() {
            Ok(()) => (operation, "succeeded", Some(1)),
            Err(error) if error == UNKNOWN => ("mongo.namespace.unconfirmed", "started", None),
            Err(_) => (operation, "failed", None),
        };
        let audit_warning = self
            .audit_mongo_change(&admin.profile, token, event, outcome, count)
            .await
            .is_err();
        match result {
            Ok(()) => Ok(MongoNamespaceReport {
                database,
                name,
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

async fn validation_snapshot(db: &Database, name: &str) -> Result<Option<ValidationSnapshot>> {
    let Some(row) = namespace_record(db, name).await? else {
        return Ok(None);
    };
    let info = row.get_document("info").map_err(|_| VALIDATION_TARGET)?;
    if row.get_str("type").ok() != Some("collection")
        || info.get_bool("readOnly").ok() != Some(false)
    {
        return Ok(None);
    }
    let Some(Bson::Binary(uuid)) = info.get("uuid") else {
        return Ok(None);
    };
    let options = namespace_options(&row)?;
    let validator = match options.get("validator") {
        Some(Bson::Document(validator)) => validator.clone(),
        None => Document::new(),
        _ => return Err(VALIDATION_TARGET.into()),
    };
    Ok(Some(ValidationSnapshot {
        uuid: uuid.clone(),
        options: doc! {
            "validator": validator,
            "validationLevel": options.get_str("validationLevel").unwrap_or("strict"),
            "validationAction": options.get_str("validationAction").unwrap_or("error"),
        },
    }))
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

async fn execute_namespace_change(
    db: &Database,
    command: Document,
    validation: bool,
) -> Result<()> {
    let reply = timeout(READ_TIMEOUT, db.run_command(command))
        .await
        .map_err(|_| UNKNOWN)?
        .map_err(|error| match error.kind.as_ref() {
            ErrorKind::Command(command) => match command.code {
                13 if validation => "현재 MongoDB 계정에 유효성 규칙을 변경할 권한이 없습니다.",
                26 | 361 if validation => VALIDATION_CHANGED,
                2 | 9 | 20 | 72 | 73 | 121 | 167 | 168 | 169 | 173 | 303 | 323 | 40324 if validation => {
                    "MongoDB 서버가 유효성 규칙 변경을 거부했습니다. 규칙과 서버 지원을 확인하세요."
                }
                13 => "현재 MongoDB 계정에 컬렉션 또는 뷰를 생성할 권한이 없습니다.",
                48 => EXISTS,
                2 | 9 | 72 | 73 | 167 | 168 | 169 | 173 | 40324 => {
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
            validate_namespace(database, &source)?;
            if source == name || !valid_create_name(&source) {
                return Err(SOURCE.into());
            }
            let pipeline = parse_value(&pipeline)?;
            validate_view_pipeline(&pipeline)?;
            command.insert("viewOn", source);
            command.insert("pipeline", pipeline);
        }
    }
    Ok(command)
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
