use super::{
    collection_identity, message, namespace_options, same_document, validate_namespace,
    view_definition, Action, Change, MongoManager, MongoNamespaceReport, Review, READ_TIMEOUT,
    REVIEW_TTL, SERVER_TIME,
};
use crate::Result;
use bson::{doc, Binary, Bson, Document};
use futures_util::TryStreamExt;
use mongodb::Database;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    time::{Duration, Instant},
};
use tokio::time::timeout;
use uuid::Uuid;

const TARGET: &str = "삭제할 일반 MongoDB 컬렉션을 확인하세요.";
pub(super) const CHANGED: &str =
    "검토한 MongoDB 컬렉션 또는 의존 뷰가 바뀌었습니다. 새로 고친 뒤 다시 검토하세요.";

#[derive(Serialize)]
pub struct MongoCollectionDropReview {
    token: String,
    estimated_documents: Option<String>,
    index_count: Option<usize>,
    dependent_views: Vec<String>,
    expires_seconds: u64,
}

pub(super) struct DropSnapshot {
    uuid: Binary,
    options: Document,
    dependent_views: Vec<String>,
}

impl MongoManager {
    pub async fn review_mongo_collection_drop(
        &self,
        id: &str,
        database: String,
        name: String,
    ) -> Result<MongoCollectionDropReview> {
        let (client, admin) = self.namespace_admin(id)?;
        validate_namespace(&database, &name)?;
        if name.starts_with("system.") || matches!(database.as_str(), "admin" | "config" | "local")
        {
            return Err(TARGET.into());
        }
        let mut pending = admin.review.lock().await;
        let db = client.database(&database);
        let (uuid, options) = collection_identity(&db, &name).await?.ok_or(TARGET)?;
        let dependents = dependent_views(&db, &name).await?;
        let (estimated_documents, index_count) =
            tokio::join!(estimated_documents(&db, &name), index_count(&db, &name),);
        let token = Uuid::new_v4().to_string();
        let review = MongoCollectionDropReview {
            token: token.clone(),
            estimated_documents: estimated_documents.map(|count| count.to_string()),
            index_count,
            dependent_views: dependents.clone(),
            expires_seconds: REVIEW_TTL.as_secs(),
        };
        let command = doc! { "drop": &name, "collectionUUID": uuid.clone() };
        *pending = Some(Review {
            token,
            at: Instant::now(),
            database,
            name,
            command,
            change: Change::DropCollection(DropSnapshot {
                uuid,
                options,
                dependent_views: dependents,
            }),
        });
        Ok(review)
    }

    pub async fn apply_mongo_collection_drop(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
        approval: &str,
    ) -> Result<MongoNamespaceReport> {
        self.apply_namespace_review(id, token, confirmation, approval, Action::DropCollection)
            .await
    }
}

pub(super) async fn check_snapshot(db: &Database, name: &str, before: &DropSnapshot) -> Result<()> {
    if dependent_views(db, name).await? != before.dependent_views {
        return Err(CHANGED.into());
    }
    let (uuid, options) = collection_identity(db, name).await?.ok_or(CHANGED)?;
    if uuid != before.uuid || !same_document(&options, &before.options)? {
        return Err(CHANGED.into());
    }
    Ok(())
}

async fn estimated_documents(db: &Database, name: &str) -> Option<u64> {
    timeout(Duration::from_secs(5), async {
        let mut cursor = db
            .run_cursor_command(doc! {
                "aggregate": name,
                "pipeline": [
                    { "$collStats": { "count": {} } },
                    { "$project": { "_id": 0, "count": 1 } },
                ],
                "cursor": {},
                "maxTimeMS": 4000,
            })
            .await
            .ok()?;
        let mut total = 0_u64;
        let mut seen = false;
        while let Some(row) = cursor.try_next().await.ok()? {
            let count = match row.get("count")? {
                Bson::Int32(count) => u64::try_from(*count).ok()?,
                Bson::Int64(count) => u64::try_from(*count).ok()?,
                _ => return None,
            };
            total = total.checked_add(count)?;
            seen = true;
        }
        seen.then_some(total)
    })
    .await
    .ok()
    .flatten()
}

async fn index_count(db: &Database, name: &str) -> Option<usize> {
    timeout(
        Duration::from_secs(5),
        db.collection::<Document>(name).list_index_names(),
    )
    .await
    .ok()?
    .ok()
    .map(|names| names.len())
}

async fn dependent_views(db: &Database, name: &str) -> Result<Vec<String>> {
    timeout(READ_TIMEOUT, async {
        let mut rows = db
            .run_cursor_command(doc! {
                "listCollections": 1,
                "filter": { "type": "view" },
                "cursor": { "batchSize": 32 },
                "maxTimeMS": SERVER_TIME.as_millis() as i32,
            })
            .await
            .map_err(message)?;
        let mut references = BTreeMap::<String, BTreeSet<String>>::new();
        while let Some(row) = rows.try_next().await.map_err(message)? {
            let view = row
                .get_str("name")
                .map_err(|_| "MongoDB 의존 뷰 이름을 읽을 수 없습니다.")?;
            let (source, pipeline) = view_definition(namespace_options(&row)?)?;
            let mut sources = BTreeSet::from([source.to_owned()]);
            pipeline_sources(pipeline, db.name(), &mut sources);
            for source in sources {
                references.entry(source).or_default().insert(view.into());
            }
        }
        let mut dependents = BTreeSet::new();
        let mut pending = VecDeque::from([name.to_owned()]);
        while let Some(source) = pending.pop_front() {
            if let Some(views) = references.remove(&source) {
                for view in views {
                    if dependents.insert(view.clone()) {
                        pending.push_back(view);
                    }
                }
            }
        }
        Ok(dependents.into_iter().collect())
    })
    .await
    .map_err(|_| "MongoDB 의존 뷰 조회 시간이 초과되었습니다.")?
}

fn pipeline_sources(pipeline: &Bson, database: &str, sources: &mut BTreeSet<String>) {
    let Some(stages) = pipeline.as_array() else {
        return;
    };
    for stage in stages {
        let Some(stage) = stage.as_document() else {
            continue;
        };
        for (operator, value) in stage {
            match operator.as_str() {
                "$lookup" | "$graphLookup" => {
                    if let Some(from) = value.as_document().and_then(|spec| spec.get("from")) {
                        let source = from.as_str().or_else(|| {
                            let namespace = from.as_document()?;
                            (namespace.get_str("db").unwrap_or(database) == database)
                                .then(|| namespace.get_str("coll").ok())
                                .flatten()
                        });
                        if let Some(source) = source {
                            sources.insert(source.into());
                        }
                    }
                }
                "$unionWith" => {
                    if let Some(source) = value
                        .as_str()
                        .or_else(|| value.as_document()?.get_str("coll").ok())
                    {
                        sources.insert(source.into());
                    }
                }
                "$facet" => {
                    if let Some(branches) = value.as_document() {
                        for branch in branches.values() {
                            pipeline_sources(branch, database, sources);
                        }
                    }
                }
                _ => {}
            }
            if matches!(operator.as_str(), "$lookup" | "$unionWith") {
                if let Some(branch) = value.as_document().and_then(|spec| spec.get("pipeline")) {
                    pipeline_sources(branch, database, sources);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_local_namespace_sources_without_treating_literal_fields_as_dependencies() {
        let pipeline = Bson::Array(vec![
            Bson::Document(doc! { "$match": { "from": "literal" } }),
            Bson::Document(doc! { "$facet": { "nested": [
                { "$lookup": { "from": "items", "pipeline": [{ "$unionWith": "inventory" }] } },
                { "$graphLookup": { "from": { "db": "other", "coll": "external" } } },
            ] } }),
            Bson::Document(doc! { "$unionWith": { "coll": "events", "pipeline": [
                { "$lookup": { "from": { "db": "app", "coll": "users" } } }
            ] } }),
        ]);
        let mut sources = BTreeSet::new();
        pipeline_sources(&pipeline, "app", &mut sources);
        assert_eq!(
            sources.into_iter().collect::<Vec<_>>(),
            ["events", "inventory", "items", "users"]
        );
    }
}
