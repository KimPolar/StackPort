use super::{
    apply_write_concern,
    document_snapshot::{canonical, parse_document, parse_value},
    message,
    pipeline::{validate_expression, validate_view_pipeline},
    validate_namespace, MongoManager, MongoProfile, READ_TIMEOUT, SERVER_TIME,
};
use crate::Result;
use bson::{doc, Document};
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
const STALE: &str = "MongoDB 생성 검토가 만료되었거나 바뀌었습니다. 다시 검토하세요.";
const EXISTS: &str = "같은 이름의 MongoDB 컬렉션 또는 뷰가 이미 있습니다.";
const SOURCE: &str =
    "같은 데이터베이스에 있고 현재 계정으로 조회할 수 있는 원본 이름을 확인하세요.";
const UNKNOWN: &str =
    "MongoDB 생성 결과를 확인하지 못했습니다. 목록을 새로 고쳐 현재 상태를 확인하세요.";

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
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationAction {
    Error,
    Warn,
}

#[derive(Serialize)]
pub struct MongoNamespaceReview {
    token: String,
    definition: String,
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
        timeout(READ_TIMEOUT, async {
            let mut cursor = db
                .run_cursor_command(doc! {
                    "listCollections": 1,
                    "filter": { "name": collection },
                    "cursor": { "batchSize": 1 },
                    "maxTimeMS": SERVER_TIME.as_millis() as i32,
                })
                .await
                .map_err(message)?;
            let row = cursor
                .try_next()
                .await
                .map_err(message)?
                .ok_or("MongoDB 컬렉션 또는 뷰를 찾을 수 없습니다. 목록을 새로 고치세요.")?;
            let options = row
                .get_document("options")
                .map_err(|_| "MongoDB 컬렉션·뷰 정의를 읽을 수 없습니다.")?;
            canonical(options)
                .map_err(|_| "MongoDB 컬렉션·뷰 정의의 표시 한도는 64 KiB입니다.".into())
        })
        .await
        .map_err(|_| "MongoDB 컬렉션·뷰 정의 조회 시간이 초과되었습니다.")?
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
            expires_seconds: REVIEW_TTL.as_secs(),
        };
        *pending = Some(Review {
            token,
            at: Instant::now(),
            database,
            name,
            command,
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
        let (client, admin) = self.namespace_admin(id)?;
        let mut pending = admin.review.lock().await;
        pending
            .as_ref()
            .filter(|review| review.token == token && review.at.elapsed() < REVIEW_TTL)
            .ok_or(STALE)?;
        if admin.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let Review {
            database,
            name,
            mut command,
            ..
        } = pending.take().ok_or(STALE)?;
        let (kind, operation) = if command.contains_key("viewOn") {
            ("view", "mongo.namespace.create_view")
        } else {
            ("collection", "mongo.namespace.create_collection")
        };
        let db = client.database(&database);
        check_names(&db, &name, &command).await?;
        command.insert("maxTimeMS", SERVER_TIME.as_millis() as i32);
        apply_write_concern(&client, &mut command)?;
        self.audit_mongo_change(&admin.profile, token, operation, "started", None)
            .await?;
        let result = execute_create(&db, command).await;
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

async fn execute_create(db: &Database, command: Document) -> Result<()> {
    let reply = timeout(READ_TIMEOUT, db.run_command(command))
        .await
        .map_err(|_| UNKNOWN)?
        .map_err(|error| match error.kind.as_ref() {
            ErrorKind::Command(command) => match command.code {
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
                let validator = parse_document(&validator)?;
                validate_expression(&bson::Bson::Document(validator.clone()), 0)?;
                command.insert("validator", validator);
                command.insert(
                    "validationLevel",
                    match level {
                        ValidationLevel::Strict => "strict",
                        ValidationLevel::Moderate => "moderate",
                    },
                );
                command.insert(
                    "validationAction",
                    match action {
                        ValidationAction::Error => "error",
                        ValidationAction::Warn => "warn",
                    },
                );
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
