use super::{
    document_snapshot::{canonical, same_document},
    message,
    query::valid_field,
    validate_namespace, MongoManager, MongoProfile, READ_TIMEOUT, SERVER_TIME,
};
use crate::Result;
use bson::{doc, Binary, Bson, Document};
use futures_util::TryStreamExt;
use mongodb::{error::ErrorKind, results::CollectionType, Client, Database};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{sync::Mutex, time::timeout};
use uuid::Uuid;

const REVIEW_TTL: Duration = Duration::from_secs(300);
const BUILD_LIMIT: Duration = Duration::from_secs(120);
const STALE: &str = "MongoDB 인덱스 변경 검토가 만료되었거나 바뀌었습니다. 다시 검토하세요.";
const TARGET: &str = "인덱스를 관리할 수 있는 일반 MongoDB 컬렉션을 확인하세요.";
const CHANGED: &str =
    "검토한 컬렉션 또는 인덱스가 바뀌었습니다. 목록을 새로 고친 뒤 다시 검토하세요.";
const UNKNOWN: &str =
    "MongoDB 인덱스 변경 결과를 확인하지 못했습니다. 목록을 새로 고쳐 현재 상태를 확인하세요.";
const TTL_KEY: &str = "TTL에는 _id를 제외한 오름차순 또는 내림차순 키 하나를 지정하세요.";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MongoIndexChange {
    Create {
        name: String,
        keys: Vec<IndexKey>,
        unique: bool,
        expire_after_seconds: Option<u32>,
    },
    Drop {
        name: String,
    },
    Modify {
        name: String,
        hidden: Option<bool>,
        expire_after_seconds: Option<u32>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndexKey {
    field: String,
    kind: IndexKind,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum IndexKind {
    Asc,
    Desc,
    Text,
    Sphere,
    Planar,
    Hashed,
}

#[derive(Serialize)]
pub struct MongoIndexReview {
    token: String,
    definition: String,
    previous_definition: Option<String>,
    unique: bool,
    ttl_seconds: Option<u32>,
    ttl_may_expire_documents: bool,
    hidden: bool,
    visibility_changed: bool,
    usage: Option<IndexUsage>,
    expires_seconds: u64,
}

#[derive(Serialize)]
struct IndexUsage {
    operations: String,
    observed_nodes: usize,
}

#[derive(Serialize)]
pub struct MongoIndexReport {
    audit_warning: bool,
}

pub(super) struct IndexAdmin {
    profile: MongoProfile,
    review: Mutex<Option<Review>>,
}

impl IndexAdmin {
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
    collection: String,
    uuid: Binary,
    name: String,
    change: Change,
}

enum Change {
    Create(Document),
    Drop(Document),
    Modify { before: Document, options: Document },
}

impl MongoManager {
    fn index_admin(&self, id: &str) -> Result<(Client, Arc<IndexAdmin>)> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "MongoDB 연결 목록을 읽을 수 없습니다.")?;
        let session = sessions
            .get(id)
            .ok_or("MongoDB 연결이 닫혔습니다. 다시 연결하세요.")?;
        let admin = session
            .index_admin
            .clone()
            .ok_or("인덱스 관리를 허용한 MongoDB 연결을 여세요.")?;
        Ok((session.client.clone(), admin))
    }

    pub async fn review_index_change(
        &self,
        id: &str,
        database: String,
        collection: String,
        input: MongoIndexChange,
    ) -> Result<MongoIndexReview> {
        validate_namespace(&database, &collection)?;
        if collection.starts_with("system.") {
            return Err(TARGET.into());
        }
        let (client, admin) = self.index_admin(id)?;
        let mut pending = admin.review.lock().await;
        *pending = None;
        let name = match &input {
            MongoIndexChange::Create { name, .. }
            | MongoIndexChange::Drop { name }
            | MongoIndexChange::Modify { name, .. } => name.clone(),
        };
        validate_name(&name)?;
        let db = client.database(&database);
        let (uuid, existing) = timeout(READ_TIMEOUT, async {
            let uuid = collection_uuid(&db, &collection).await?;
            let index = named_index(&db, &collection, &name).await?;
            Ok::<_, String>((uuid, index))
        })
        .await
        .map_err(|_| "MongoDB 인덱스 검토 시간이 초과되었습니다.")??;

        let change = match (input, existing) {
            (
                MongoIndexChange::Create {
                    keys,
                    unique,
                    expire_after_seconds,
                    ..
                },
                None,
            ) => Change::Create(definition(&name, keys, unique, expire_after_seconds)?),
            (MongoIndexChange::Create { .. }, Some(_)) => {
                return Err("같은 이름의 MongoDB 인덱스가 이미 있습니다.".into())
            }
            (MongoIndexChange::Drop { .. }, Some(spec))
                if !spec.get_bool("clustered").unwrap_or(false) =>
            {
                Change::Drop(spec)
            }
            (
                MongoIndexChange::Modify {
                    hidden,
                    expire_after_seconds,
                    ..
                },
                Some(before),
            ) if !before.get_bool("clustered").unwrap_or(false) => {
                let options = modified_options(&before, hidden, expire_after_seconds)?;
                Change::Modify { before, options }
            }
            _ => return Err("변경할 수 있는 MongoDB 인덱스를 확인하세요.".into()),
        };
        let token = Uuid::new_v4().to_string();
        let (spec, previous_definition, ttl_may_expire_documents) = match &change {
            Change::Create(spec) => (spec.clone(), None, spec.contains_key("expireAfterSeconds")),
            Change::Drop(spec) => (spec.clone(), None, false),
            Change::Modify { before, options } => {
                let mut after = before.clone();
                if let Ok(hidden) = options.get_bool("hidden") {
                    if hidden {
                        after.insert("hidden", true);
                    } else {
                        after.remove("hidden");
                    }
                }
                if let Ok(ttl) = options.get_i32("expireAfterSeconds") {
                    after.insert("expireAfterSeconds", ttl);
                }
                let may_expire = bson_count(options, "expireAfterSeconds").is_some_and(|ttl| {
                    bson_count(before, "expireAfterSeconds").is_none_or(|old| ttl < old)
                });
                (after, Some(canonical(before)?), may_expire)
            }
        };
        let review = MongoIndexReview {
            token: token.clone(),
            definition: canonical(&spec)?,
            previous_definition,
            unique: spec.get_bool("unique").unwrap_or(false),
            ttl_seconds: bson_count(&spec, "expireAfterSeconds")
                .and_then(|value| u32::try_from(value).ok()),
            ttl_may_expire_documents,
            hidden: spec.get_bool("hidden").unwrap_or(false),
            visibility_changed: matches!(&change, Change::Modify { options, .. } if options.contains_key("hidden")),
            usage: if matches!(&change, Change::Drop(_))
                || matches!(&change, Change::Modify { options, .. } if options.get_bool("hidden").unwrap_or(false))
            {
                index_usage(&db, &collection, &name).await
            } else {
                None
            },
            expires_seconds: REVIEW_TTL.as_secs(),
        };
        *pending = Some(Review {
            token,
            at: Instant::now(),
            database,
            collection,
            uuid,
            name,
            change,
        });
        Ok(review)
    }

    pub async fn discard_index_review(&self, id: &str, token: &str) -> Result<()> {
        let (_, admin) = self.index_admin(id)?;
        let mut pending = admin.review.lock().await;
        if pending.as_ref().is_some_and(|review| review.token == token) {
            *pending = None;
        }
        Ok(())
    }

    pub async fn apply_index_change(
        &self,
        id: &str,
        token: &str,
        approval: &str,
        confirmation: &str,
    ) -> Result<MongoIndexReport> {
        let (client, admin) = self.index_admin(id)?;
        let mut pending = admin.review.lock().await;
        let review = pending
            .as_ref()
            .filter(|review| review.token == token && review.at.elapsed() < REVIEW_TTL)
            .ok_or(STALE)?;
        if admin.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        let dropping = matches!(&review.change, Change::Drop(_));
        if dropping && approval != "DROP" {
            return Err("인덱스를 삭제하려면 DROP을 입력하세요.".into());
        }
        let review = pending.take().ok_or(STALE)?;
        let db = client.database(&review.database);
        let (operation, mut command, server_limit) = match &review.change {
            Change::Create(spec) => (
                "mongo.index.create",
                doc! { "createIndexes": &review.collection, "indexes": [spec.clone()] },
                BUILD_LIMIT,
            ),
            Change::Drop(_) => (
                "mongo.index.drop",
                doc! { "dropIndexes": &review.collection, "index": [&review.name] },
                SERVER_TIME,
            ),
            Change::Modify { options, .. } => {
                let mut index = doc! { "name": &review.name };
                index.extend(options.clone());
                (
                    "mongo.index.modify",
                    doc! { "collMod": &review.collection, "index": index },
                    SERVER_TIME,
                )
            }
        };
        command.insert("collectionUUID", review.uuid.clone());
        command.insert("maxTimeMS", server_limit.as_millis() as i32);
        super::apply_write_concern(&client, &mut command)?;
        self.audit_mongo_change(&admin.profile, token, operation, "started", None)
            .await?;
        let result = async {
            timeout(READ_TIMEOUT, check_review(&db, &review))
                .await
                .map_err(|_| "MongoDB 인덱스 상태 확인 시간이 초과되었습니다.")??;
            execute(&db, command, server_limit).await
        }
        .await;
        let (event, outcome, count) = match result.as_ref() {
            Ok(()) => (operation, "succeeded", Some(1)),
            Err(error) if error == UNKNOWN => ("mongo.index.unconfirmed", "started", None),
            Err(_) => (operation, "failed", None),
        };
        let audit_warning = self
            .audit_mongo_change(&admin.profile, token, event, outcome, count)
            .await
            .is_err();
        match result {
            Ok(()) => Ok(MongoIndexReport { audit_warning }),
            Err(error) if audit_warning => {
                Err(format!("{error} 완료 감사 기록도 저장하지 못했습니다."))
            }
            Err(error) => Err(error),
        }
    }
}

async fn check_review(db: &Database, review: &Review) -> Result<()> {
    if collection_uuid(db, &review.collection).await? != review.uuid {
        return Err(CHANGED.into());
    }
    let current = named_index(db, &review.collection, &review.name).await?;
    let unchanged = match (&review.change, current) {
        (Change::Create(_), None) => true,
        (Change::Drop(before) | Change::Modify { before, .. }, Some(current)) => {
            same_document(before, &current)?
        }
        _ => false,
    };
    if unchanged {
        Ok(())
    } else {
        Err(CHANGED.into())
    }
}

async fn collection_uuid(db: &Database, name: &str) -> Result<Binary> {
    let mut rows = db
        .list_collections()
        .filter(doc! { "name": name })
        .await
        .map_err(message)?;
    let spec = rows.try_next().await.map_err(message)?.ok_or(TARGET)?;
    if spec.collection_type != CollectionType::Collection || spec.info.read_only {
        return Err(TARGET.into());
    }
    spec.info.uuid.ok_or_else(|| TARGET.into())
}

async fn named_index(db: &Database, collection: &str, name: &str) -> Result<Option<Document>> {
    let mut rows = db.run_cursor_command(doc! { "listIndexes": collection, "cursor": { "batchSize": 32 }, "maxTimeMS": SERVER_TIME.as_millis() as i32 }).await.map_err(message)?;
    while let Some(row) = rows.try_next().await.map_err(message)? {
        if row.get_str("name").is_ok_and(|candidate| candidate == name) {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

async fn index_usage(db: &Database, collection: &str, name: &str) -> Option<IndexUsage> {
    timeout(Duration::from_secs(2), async {
        let mut rows = db
            .collection::<Document>(collection)
            .aggregate([
                doc! { "$indexStats": {} },
                doc! { "$match": { "name": name } },
            ])
            .max_time(Duration::from_secs(1))
            .await
            .ok()?;
        let mut operations = 0_u64;
        let mut observed_nodes = 0;
        while let Some(row) = rows.try_next().await.ok()? {
            observed_nodes += 1;
            if observed_nodes > 64 {
                return None;
            }
            operations =
                operations.checked_add(bson_count(row.get_document("accesses").ok()?, "ops")?)?;
        }
        (observed_nodes > 0).then(|| IndexUsage {
            operations: operations.to_string(),
            observed_nodes,
        })
    })
    .await
    .ok()
    .flatten()
}

fn bson_count(document: &Document, field: &str) -> Option<u64> {
    match document.get(field)? {
        Bson::Int32(value) => u64::try_from(*value).ok(),
        Bson::Int64(value) => u64::try_from(*value).ok(),
        _ => None,
    }
}

async fn execute(db: &Database, command: Document, limit: Duration) -> Result<()> {
    let reply = timeout(limit + Duration::from_secs(5), async {
        db.run_command(command).await
    })
    .await
    .map_err(|_| UNKNOWN)?
    .map_err(|error| match error.kind.as_ref() {
        ErrorKind::Command(command) => match command.code {
            13 => "현재 MongoDB 계정에 인덱스 관리 권한이 없습니다.",
            26 | 27 | 361 => CHANGED,
            68 | 85 | 86 => "이미 등록된 인덱스와 이름, 키 또는 옵션이 충돌합니다.",
            11000 => "중복 값이 있어 고유 인덱스를 생성할 수 없습니다.",
            2 | 9 | 20 | 67 | 72 | 73 | 197 | 303 | 323 => {
                "MongoDB 서버가 인덱스 변경을 거부했습니다. 키, 옵션과 서버 지원을 확인하세요."
            }
            _ => UNKNOWN,
        },
        _ => UNKNOWN,
    })?;
    if reply.contains_key("writeConcernError") || reply.contains_key("writeErrors") {
        return Err(UNKNOWN.into());
    }
    if bson_count(&reply, "numIndexesBefore")
        .zip(bson_count(&reply, "numIndexesAfter"))
        .is_some_and(|(before, after)| before >= after)
    {
        return Err(CHANGED.into());
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty()
        || name.len() > 128
        || name.chars().any(char::is_control)
        || matches!(name, "_id_" | "*")
    {
        return Err("MongoDB 인덱스 이름을 확인하세요. _id_와 *는 사용할 수 없습니다.".into());
    }
    Ok(())
}

pub(super) fn ttl_key(pattern: &Document) -> bool {
    pattern.len() == 1
        && pattern.iter().next().is_some_and(|(field, order)| {
            field != "_id"
                && valid_field(field)
                && match order {
                    Bson::Int32(1 | -1) | Bson::Int64(1 | -1) => true,
                    Bson::Double(value) => *value == 1.0 || *value == -1.0,
                    _ => false,
                }
        })
}

fn ttl_value(seconds: u32) -> Result<i32> {
    i32::try_from(seconds).map_err(|_| "TTL은 0~2147483647초로 입력하세요.".into())
}

fn modified_options(
    before: &Document,
    hidden: Option<bool>,
    expire_after_seconds: Option<u32>,
) -> Result<Document> {
    let mut options = Document::new();
    if let Some(hidden) =
        hidden.filter(|hidden| *hidden != before.get_bool("hidden").unwrap_or(false))
    {
        options.insert("hidden", hidden);
    }
    if let Some(ttl) = expire_after_seconds {
        let ttl = ttl_value(ttl)?;
        if !before.get_document("key").is_ok_and(ttl_key) {
            return Err(TTL_KEY.into());
        }
        if bson_count(before, "expireAfterSeconds") != Some(ttl as u64) {
            options.insert("expireAfterSeconds", ttl);
        }
    }
    if options.is_empty() {
        return Err("변경할 인덱스 옵션을 지정하세요.".into());
    }
    Ok(options)
}

fn definition(name: &str, keys: Vec<IndexKey>, unique: bool, ttl: Option<u32>) -> Result<Document> {
    if !(1..=32).contains(&keys.len()) {
        return Err("인덱스 키를 1~32개 지정하세요.".into());
    }
    let ttl = ttl.map(ttl_value).transpose()?;
    let simple_collation = keys
        .iter()
        .any(|key| matches!(key.kind, IndexKind::Text | IndexKind::Planar));
    let mut pattern = Document::new();
    for IndexKey { field, kind } in keys {
        if !(valid_field(&field) || field == "$**" && kind == IndexKind::Text)
            || pattern.contains_key(&field)
        {
            return Err("인덱스 키의 필드 경로와 중복 여부를 확인하세요.".into());
        }
        let key = match kind {
            IndexKind::Asc => Bson::Int32(1),
            IndexKind::Desc => Bson::Int32(-1),
            IndexKind::Text => Bson::String("text".into()),
            IndexKind::Sphere => Bson::String("2dsphere".into()),
            IndexKind::Planar => Bson::String("2d".into()),
            IndexKind::Hashed => Bson::String("hashed".into()),
        };
        pattern.insert(field, key);
    }
    if ttl.is_some() && !ttl_key(&pattern) {
        return Err(TTL_KEY.into());
    }
    let mut spec = doc! { "key": pattern, "name": name };
    if unique {
        spec.insert("unique", true);
    }
    if let Some(ttl) = ttl {
        spec.insert("expireAfterSeconds", ttl);
    }
    if simple_collation {
        spec.insert("collation", doc! { "locale": "simple" });
    }
    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(field: &str, kind: IndexKind) -> IndexKey {
        IndexKey {
            field: field.into(),
            kind,
        }
    }

    #[test]
    fn keeps_compound_key_order_and_encodes_index_types() {
        let spec = definition(
            "compound",
            vec![key("z", IndexKind::Desc), key("a", IndexKind::Asc)],
            true,
            None,
        )
        .unwrap();
        let pattern = spec.get_document("key").unwrap();
        assert_eq!(
            pattern.keys().map(String::as_str).collect::<Vec<_>>(),
            ["z", "a"]
        );
        assert_eq!(pattern.get_i32("z").unwrap(), -1);
        assert!(spec.get_bool("unique").unwrap());
        let ttl = definition(
            "expiry",
            vec![key("expires", IndexKind::Asc)],
            false,
            Some(0),
        )
        .unwrap();
        assert_eq!(ttl.get_i32("expireAfterSeconds").unwrap(), 0);
        for (kind, code) in [
            (IndexKind::Sphere, "2dsphere"),
            (IndexKind::Planar, "2d"),
            (IndexKind::Hashed, "hashed"),
            (IndexKind::Text, "text"),
        ] {
            let spec = definition("special", vec![key("value", kind)], false, None).unwrap();
            assert_eq!(
                spec.get_document("key").unwrap().get_str("value").unwrap(),
                code
            );
        }
    }

    #[test]
    fn rejects_wildcard_drop_names_duplicate_fields_and_invalid_ttl() {
        for name in ["*", "_id_", "", "a\0b"] {
            assert!(validate_name(name).is_err());
        }
        for field in ["_id", "a..b"] {
            assert!(definition("test", vec![key(field, IndexKind::Asc)], false, Some(10)).is_err());
        }
        assert!(definition(
            "test",
            vec![key("a", IndexKind::Asc), key("a", IndexKind::Desc)],
            false,
            None
        )
        .is_err());
        assert!(definition(
            "test",
            vec![key("a", IndexKind::Asc), key("b", IndexKind::Desc)],
            false,
            Some(10)
        )
        .is_err());
        assert!(definition("test", vec![key("a", IndexKind::Text)], false, Some(10)).is_err());
        assert!(definition(
            "test",
            vec![key("a", IndexKind::Asc)],
            false,
            Some(u32::MAX)
        )
        .is_err());
    }

    #[test]
    fn changes_only_supported_distinct_index_options() {
        let before =
            doc! { "key": { "expires": -1.0 }, "hidden": true, "expireAfterSeconds": 120_i64 };
        assert!(modified_options(&before, Some(true), Some(120)).is_err());
        let options = modified_options(&before, Some(false), Some(60)).unwrap();
        assert_eq!(options, doc! { "hidden": false, "expireAfterSeconds": 60 });
        assert_eq!(
            modified_options(&before, None, Some(0)).unwrap(),
            doc! { "expireAfterSeconds": 0 }
        );
        for pattern in [
            doc! { "_id": 1 },
            doc! { "a": 1, "b": 1 },
            doc! { "tag": "text" },
            doc! { "$**": 1 },
        ] {
            assert!(modified_options(&doc! { "key": pattern }, Some(true), Some(1)).is_err());
        }
    }
}
