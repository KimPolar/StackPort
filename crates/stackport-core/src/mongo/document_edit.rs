use super::{
    document_snapshot::{
        canonical, parse_document, parse_id, same_document, snapshot, unchanged_filter,
    },
    message, validate_namespace, MongoManager, MongoProfile, READ_TIMEOUT, SERVER_TIME,
};
use crate::{insert_audit, AuditRecord, Result};
use bson::{doc, oid::ObjectId, raw::RawDocumentBuf, Binary, Document};
use futures_util::TryStreamExt;
use mongodb::{error::ErrorKind, options::Collation, results::CollectionType, Client};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{sync::Mutex, time::timeout};
use uuid::Uuid;

const REVIEW_TTL: Duration = Duration::from_secs(300);
const STALE: &str = "MongoDB 문서 변경 검토가 만료되었거나 바뀌었습니다. 다시 검토하세요.";
const CONFLICT: &str = "검토한 문서나 컬렉션이 변경되었거나 삭제되었습니다. 문서를 다시 읽으세요.";
const UNKNOWN: &str =
    "MongoDB 쓰기 결과를 확인하지 못했습니다. 현재 문서를 조회한 뒤 다시 시도하세요.";
const TARGET: &str = "편집할 수 있는 일반 MongoDB 컬렉션을 확인하세요.";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MongoDocumentChange {
    Insert,
    Duplicate { document_id: String },
    Replace { document_id: String },
    Delete { document_id: String },
}

impl MongoDocumentChange {
    fn document_id(&self) -> Option<&str> {
        match self {
            Self::Insert => None,
            Self::Duplicate { document_id }
            | Self::Replace { document_id }
            | Self::Delete { document_id } => Some(document_id),
        }
    }

    fn operation(&self) -> &'static str {
        match self {
            Self::Insert => "mongo.document.insert",
            Self::Duplicate { .. } => "mongo.document.duplicate",
            Self::Replace { .. } => "mongo.document.replace",
            Self::Delete { .. } => "mongo.document.delete",
        }
    }
}

#[derive(Serialize)]
pub struct MongoEditDraft {
    token: String,
    draft: Option<String>,
}

#[derive(Serialize)]
pub struct MongoEditReview {
    token: String,
    before: Option<String>,
    after: Option<String>,
    expires_seconds: u64,
}

#[derive(Serialize)]
pub struct MongoEditReport {
    affected_count: usize,
    audit_warning: bool,
}

pub(super) struct DocumentEditor {
    profile: MongoProfile,
    pending: Mutex<Option<Pending>>,
}

impl DocumentEditor {
    pub(super) fn new(profile: MongoProfile) -> Self {
        Self {
            profile,
            pending: Mutex::new(None),
        }
    }
}

struct Pending {
    token: String,
    database: String,
    collection: String,
    uuid: Binary,
    change: MongoDocumentChange,
    before: Option<Document>,
    review: Option<Reviewed>,
}

struct Reviewed {
    token: String,
    at: Instant,
    after: Option<Document>,
}

impl MongoManager {
    fn document_editor(&self, id: &str) -> Result<(Client, Arc<DocumentEditor>)> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "MongoDB 연결 목록을 읽을 수 없습니다.")?;
        let session = sessions
            .get(id)
            .ok_or("MongoDB 연결이 닫혔습니다. 다시 연결하세요.")?;
        let editor = session
            .editor
            .clone()
            .ok_or("문서 편집을 허용한 MongoDB 연결을 여세요.")?;
        Ok((session.client.clone(), editor))
    }

    pub async fn begin_document_edit(
        &self,
        id: &str,
        database: String,
        collection: String,
        change: MongoDocumentChange,
    ) -> Result<MongoEditDraft> {
        validate_namespace(&database, &collection)?;
        if collection.starts_with("system.") {
            return Err(TARGET.into());
        }
        let (client, editor) = self.document_editor(id)?;
        let mut pending = editor.pending.lock().await;
        *pending = None;
        let store = self.store.clone();
        let profile = editor.profile.clone();
        tokio::task::spawn_blocking(move || store.mongo_profile(&profile.id, profile.revision))
            .await
            .map_err(|_| "MongoDB 연결 설정을 확인할 수 없습니다.")??;
        let db = client.database(&database);
        let (uuid, before) = timeout(READ_TIMEOUT, async {
            let mut collections = db
                .list_collections()
                .filter(doc! { "name": &collection })
                .await
                .map_err(message)?;
            let spec = collections
                .try_next()
                .await
                .map_err(message)?
                .ok_or(TARGET)?;
            if spec.collection_type != CollectionType::Collection || spec.info.read_only {
                return Err(TARGET.into());
            }
            let uuid = spec.info.uuid.ok_or(TARGET)?;
            let before = if let Some(key) = change.document_id() {
                let document_id = parse_id(key)?;
                let raw = db
                    .collection::<RawDocumentBuf>(&collection)
                    .find_one(doc! { "_id": { "$eq": document_id.clone() } })
                    .collation(Collation::builder().locale("simple".to_owned()).build())
                    .max_time(SERVER_TIME)
                    .await
                    .map_err(message)?
                    .ok_or(CONFLICT)?;
                let original = snapshot(raw)?;
                let actual = original.get("_id").ok_or(CONFLICT)?;
                if !same_document(
                    &doc! { "_id": actual.clone() },
                    &doc! { "_id": document_id },
                )? {
                    return Err(CONFLICT.into());
                }
                Some(original)
            } else {
                None
            };
            Ok::<_, String>((uuid, before))
        })
        .await
        .map_err(|_| "MongoDB 편집 문서를 가져오는 시간이 초과되었습니다.")??;
        let draft = match change {
            MongoDocumentChange::Insert => Some("{}".into()),
            MongoDocumentChange::Duplicate { .. } => {
                let mut source = before.as_ref().ok_or(CONFLICT)?.clone();
                source.remove("_id");
                Some(canonical(&source)?)
            }
            MongoDocumentChange::Replace { .. } => {
                Some(canonical(before.as_ref().ok_or(CONFLICT)?)?)
            }
            MongoDocumentChange::Delete { .. } => None,
        };
        let token = Uuid::new_v4().to_string();
        *pending = Some(Pending {
            token: token.clone(),
            database,
            collection,
            uuid,
            change,
            before,
            review: None,
        });
        Ok(MongoEditDraft { token, draft })
    }

    pub async fn review_document_edit(
        &self,
        id: &str,
        token: &str,
        input: &str,
    ) -> Result<MongoEditReview> {
        let (_, editor) = self.document_editor(id)?;
        let mut pending = editor.pending.lock().await;
        let pending = pending
            .as_mut()
            .filter(|draft| draft.token == token)
            .ok_or(STALE)?;
        pending.review = None;
        let after = prepare_replacement(pending, input)?;
        let before = pending.before.as_ref().map(canonical).transpose()?;
        let after_text = after.as_ref().map(canonical).transpose()?;
        let token = Uuid::new_v4().to_string();
        pending.review = Some(Reviewed {
            token: token.clone(),
            at: Instant::now(),
            after,
        });
        Ok(MongoEditReview {
            token,
            before,
            after: after_text,
            expires_seconds: REVIEW_TTL.as_secs(),
        })
    }

    pub async fn discard_document_edit(&self, id: &str, token: &str) -> Result<()> {
        let (_, editor) = self.document_editor(id)?;
        let mut pending = editor.pending.lock().await;
        if pending.as_ref().is_some_and(|draft| draft.token == token) {
            *pending = None;
        } else if let Some(draft) = pending.as_mut() {
            if draft
                .review
                .as_ref()
                .is_some_and(|review| review.token == token)
            {
                draft.review = None;
            }
        }
        Ok(())
    }

    pub async fn apply_document_edit(
        &self,
        id: &str,
        token: &str,
        approval: &str,
        confirmation: &str,
    ) -> Result<MongoEditReport> {
        let (client, editor) = self.document_editor(id)?;
        let mut guard = editor.pending.lock().await;
        let pending = guard.as_mut().ok_or(STALE)?;
        if !pending
            .review
            .as_ref()
            .is_some_and(|review| review.token == token && review.at.elapsed() <= REVIEW_TTL)
        {
            return Err(STALE.into());
        }
        if editor.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if matches!(pending.change, MongoDocumentChange::Delete { .. }) && approval != "DELETE" {
            return Err("문서를 삭제하려면 DELETE를 입력하세요.".into());
        }
        let review = pending.review.take().ok_or(STALE)?;
        let operation = pending.change.operation();
        let command = write_command(pending, review.after, &client)?;
        self.audit_mongo_change(&editor.profile, token, operation, "started", None)
            .await?;
        let result = execute_write(&client, &pending.database, command).await;
        let (completed_operation, outcome, count) = match result.as_ref() {
            Ok(count) => (operation, "succeeded", Some(*count as i64)),
            Err(error) if error == UNKNOWN => ("mongo.document.unconfirmed", "started", None),
            Err(_) => (operation, "failed", None),
        };
        let audit_warning = self
            .audit_mongo_change(&editor.profile, token, completed_operation, outcome, count)
            .await
            .is_err();
        if result.is_ok() {
            *guard = None;
        }
        match result {
            Ok(affected_count) => Ok(MongoEditReport {
                affected_count,
                audit_warning,
            }),
            Err(error) if audit_warning => {
                Err(format!("{error} 완료 감사 기록도 저장하지 못했습니다."))
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn audit_mongo_change(
        &self,
        profile: &MongoProfile,
        token: &str,
        operation: &'static str,
        outcome: &'static str,
        count: Option<i64>,
    ) -> Result<()> {
        let store = self.store.clone();
        let profile = profile.clone();
        let token = token.to_owned();
        tokio::task::spawn_blocking(move || {
            if outcome == "started" && !operation.ends_with(".unconfirmed") {
                store.mongo_profile(&profile.id, profile.revision)?;
            }
            insert_audit(
                &store.connect()?,
                AuditRecord {
                    correlation_id: &token,
                    operation,
                    project_id: Some(&profile.project_id),
                    profile_id: Some(&profile.id),
                    environment: Some(&profile.settings.environment),
                    object_name: None,
                    outcome,
                    affected_count: count,
                },
            )
        })
        .await
        .map_err(|_| "MongoDB 변경 감사 기록을 저장할 수 없습니다.")?
    }
}

fn prepare_replacement(pending: &Pending, input: &str) -> Result<Option<Document>> {
    if matches!(pending.change, MongoDocumentChange::Delete { .. }) {
        return Ok(None);
    }
    let mut after = parse_document(input)?;
    let original_id = pending.before.as_ref().and_then(|doc| doc.get("_id"));
    if let MongoDocumentChange::Replace { .. } = pending.change {
        let before = pending.before.as_ref().ok_or(CONFLICT)?;
        let old = original_id.ok_or(CONFLICT)?;
        let next = after.get("_id").ok_or("기존 문서의 _id를 유지하세요.")?;
        if !same_document(&doc! { "id": old.clone() }, &doc! { "id": next.clone() })? {
            return Err("기존 문서의 _id를 유지하세요.".into());
        }
        if same_document(before, &after)? {
            return Err("변경된 문서 값이 없습니다.".into());
        }
    } else if !after.contains_key("_id") {
        after.insert("_id", ObjectId::new());
    } else if let (Some(old), Some(next)) = (original_id, after.get("_id")) {
        if same_document(&doc! { "id": old.clone() }, &doc! { "id": next.clone() })? {
            return Err("복제할 문서에는 새 _id를 입력하거나 _id를 비워 두세요.".into());
        }
    }
    Ok(Some(after))
}

fn write_command(pending: &Pending, after: Option<Document>, client: &Client) -> Result<Document> {
    let filter = || {
        let before = pending.before.as_ref().ok_or(CONFLICT)?;
        let id = before.get("_id").ok_or(CONFLICT)?;
        Ok::<_, String>(unchanged_filter(id, before))
    };
    let mut command = match pending.change {
        MongoDocumentChange::Insert | MongoDocumentChange::Duplicate { .. } => {
            doc! { "insert": &pending.collection, "documents": [after.ok_or(STALE)?] }
        }
        MongoDocumentChange::Replace { .. } => doc! { "update": &pending.collection, "updates": [ {
            "q": filter()?, "u": [{ "$replaceWith": { "$literal": after.ok_or(STALE)? } }],
            "upsert": false, "multi": false, "collation": { "locale": "simple" },
        } ] },
        MongoDocumentChange::Delete { .. } => doc! { "delete": &pending.collection, "deletes": [ {
            "q": filter()?, "limit": 1, "collation": { "locale": "simple" },
        } ] },
    };
    command.insert("collectionUUID", pending.uuid.clone());
    command.insert("maxTimeMS", SERVER_TIME.as_millis() as i32);
    super::apply_write_concern(client, &mut command)?;
    Ok(command)
}

async fn execute_write(client: &Client, database: &str, command: Document) -> Result<usize> {
    let reply = timeout(READ_TIMEOUT, async {
        client.database(database).run_command(command).await
    })
    .await
    .map_err(|_| UNKNOWN)?
    .map_err(|error| match error.kind.as_ref() {
        ErrorKind::Command(command) => write_error(command.code),
        _ => UNKNOWN,
    })?;
    if reply.contains_key("writeConcernError") {
        return Err(UNKNOWN.into());
    }
    if let Some(error) = reply
        .get_array("writeErrors")
        .ok()
        .and_then(|errors| errors.first())
    {
        return Err(error
            .as_document()
            .and_then(|error| error.get_i32("code").ok())
            .map(write_error)
            .unwrap_or(UNKNOWN)
            .into());
    }
    match reply
        .get_i32("n")
        .map(i64::from)
        .or_else(|_| reply.get_i64("n"))
    {
        Ok(1) => Ok(1),
        Ok(0) => Err(CONFLICT.into()),
        _ => Err(UNKNOWN.into()),
    }
}

fn write_error(code: i32) -> &'static str {
    match code {
        13 => "현재 MongoDB 계정에 문서 쓰기 권한이 없습니다.",
        26 | 361 => CONFLICT,
        66 => "MongoDB에서 변경할 수 없는 필드를 확인하세요.",
        121 => "문서가 컬렉션의 유효성 검사에 실패했습니다.",
        11000 => "이미 사용 중인 _id 또는 고유 인덱스 값입니다.",
        2 | 9 | 20 | 72 | 73 | 168 | 323 => {
            "MongoDB 서버가 문서 변경을 거부했습니다. 서버 호환성과 필드 구성을 확인하세요."
        }
        _ => UNKNOWN,
    }
}
