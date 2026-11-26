use super::super::valid_database;
use super::{
    archive::{ArchiveInfo, Namespace},
    message, tools, ArchiveConnection, MongoPassword, Stage, FAILED,
};
use crate::Result;
use bson::{doc, Bson, Document};
use futures_util::{stream::FuturesUnordered, TryStreamExt};
use mongodb::{results::CollectionType, Database};
use serde::Serialize;
use std::{collections::BTreeMap, process::Stdio, time::Duration};
use uuid::Uuid;

const CONFLICT: &str = "복원할 데이터베이스에 이미 컬렉션이나 뷰가 있습니다. 다시 검토하세요.";
const MISMATCH: &str =
    "아카이브와 복원된 데이터베이스의 객체, 인덱스 또는 레코드 수가 일치하지 않습니다.";

#[derive(Clone, Debug, Serialize)]
pub(super) struct RestoreDatabase {
    pub(super) name: String,
    pub(super) collections: usize,
    pub(super) views: usize,
    pub(super) documents: u64,
    pub(super) buckets: u64,
}

pub(super) fn target_name(prefix: &str) -> Result<String> {
    if prefix.len() > 30 || !valid_database(prefix) {
        return Err(
            "새 데이터베이스의 이름 앞부분에 MongoDB 이름 규칙에 맞는 값을 30바이트 이내로 입력하세요."
                .into(),
        );
    }
    Ok(format!("{prefix}_{}", Uuid::new_v4().simple()))
}

pub(super) fn sources(archive: &ArchiveInfo) -> Vec<RestoreDatabase> {
    let mut by_database = BTreeMap::new();
    for item in &archive.namespaces {
        by_database
            .entry(item.database.as_str())
            .or_insert_with(BTreeMap::new)
            .insert(item.collection.as_str(), item);
    }
    by_database
        .into_iter()
        .filter_map(|(name, namespaces)| {
            let mut summary = RestoreDatabase {
                name: name.to_owned(),
                collections: 0,
                views: 0,
                documents: 0,
                buckets: 0,
            };
            for item in namespaces.values() {
                if !item.database_restore_supported {
                    return None;
                }
                match item.kind.as_str() {
                    "view" => {
                        let base = item.view_on.as_deref()?;
                        if !namespaces.contains_key(base) || item.documents != 0 {
                            return None;
                        }
                        summary.views += 1;
                    }
                    "timeseries" => {
                        summary.collections += 1;
                        summary.buckets = summary.buckets.checked_add(item.documents)?;
                    }
                    _ => {
                        summary.collections += 1;
                        summary.documents = summary.documents.checked_add(item.documents)?;
                    }
                }
            }
            Some(summary)
        })
        .collect()
}

pub(super) async fn ensure_empty(db: &Database) -> Result<()> {
    let mut cursor = db.list_collections().await.map_err(message)?;
    if cursor.try_next().await.map_err(message)?.is_some() {
        return Err(CONFLICT.into());
    }
    Ok(())
}

pub(super) async fn restore(
    connection: &ArchiveConnection,
    db: &Database,
    source: &RestoreDatabase,
    archive: &ArchiveInfo,
    stage: Stage,
    password: MongoPassword,
) -> Result<()> {
    let from = format!("{}.*", source.name);
    let mut restore = stage.tools.command("mongorestore");
    restore
        .args(["--archive", "--stopOnError"])
        .arg(format!("--nsInclude={from}"))
        .arg(format!("--nsFrom={from}"))
        .arg(format!("--nsTo={}.*", db.name()))
        .stdin(Stdio::from(stage.source));
    if stage.gzip {
        restore.arg("--gzip");
    }
    tools::run(
        restore,
        &connection.profile.settings,
        connection.auth_database.as_deref(),
        password,
        FAILED,
    )
    .await?;
    verify(db, archive, &source.name).await
}

async fn verify(db: &Database, archive: &ArchiveInfo, source: &str) -> Result<()> {
    let expected: BTreeMap<_, _> = archive
        .namespaces
        .iter()
        .filter(|item| item.database == source)
        .map(|item| (item.collection.as_str(), item))
        .collect();
    let mut cursor = db.list_collections().await.map_err(message)?;
    let mut seen = 0;
    while let Some(spec) = cursor.try_next().await.map_err(message)? {
        if spec.name == "system.views" && expected.values().any(|item| item.kind == "view") {
            continue;
        }
        if let Some(name) = spec.name.strip_prefix("system.buckets.") {
            if expected
                .get(name)
                .is_some_and(|item| item.kind == "timeseries")
            {
                continue;
            }
        }
        let item = expected.get(spec.name.as_str()).ok_or(MISMATCH)?;
        let kind = match spec.collection_type {
            CollectionType::Collection => "collection",
            CollectionType::Timeseries => "timeseries",
            CollectionType::View => "view",
            _ => return Err(MISMATCH.into()),
        };
        if item.kind != kind || item.view_on != spec.options.view_on {
            return Err(MISMATCH.into());
        }
        seen += 1;
    }
    if seen != expected.len() {
        return Err(MISMATCH.into());
    }
    let mut checks = FuturesUnordered::new();
    for item in expected.into_values() {
        if item.kind == "view" {
            continue;
        }
        checks.push(verify_collection(db, item));
        if checks.len() == 4 {
            checks.try_next().await?;
        }
    }
    while checks.try_next().await?.is_some() {}
    Ok(())
}

async fn verify_collection(db: &Database, item: &Namespace) -> Result<()> {
    let collection = db.collection::<Document>(&item.collection);
    let count = if item.kind == "timeseries" {
        count_buckets(db, &item.collection).await?
    } else {
        collection
            .count_documents(doc! {})
            .max_time(Duration::from_secs(45))
            .await
            .map_err(message)?
    };
    if count != item.documents {
        return Err(format!("{MISMATCH} 대상 객체 {}.", item.collection));
    }
    if let Some(expected) = &item.indexes {
        let mut expected = expected.clone();
        let mut actual = collection.list_index_names().await.map_err(message)?;
        expected.sort_unstable();
        actual.sort_unstable();
        if actual != expected {
            return Err(format!("{MISMATCH} 대상 객체 {}.", item.collection));
        }
    }
    Ok(())
}

async fn count_buckets(db: &Database, collection: &str) -> Result<u64> {
    let result = db
        .run_command(doc! { "collStats": collection })
        .await
        .map_err(message)?;
    let count = result
        .get_document("timeseries")
        .ok()
        .and_then(|stats| stats.get("bucketCount"));
    match count {
        Some(Bson::Int32(value)) => u64::try_from(*value).map_err(|_| MISMATCH.into()),
        Some(Bson::Int64(value)) => u64::try_from(*value).map_err(|_| MISMATCH.into()),
        _ => Err(MISMATCH.into()),
    }
}
