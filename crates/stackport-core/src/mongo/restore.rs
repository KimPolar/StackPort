use super::{
    archive::{self, ArchiveInfo, Namespace},
    backup::{
        check_database, check_local, check_production, server_version, version_family,
        ArchiveConnection, ARCHIVE_TIME, ARCHIVE_TIMEOUT, CANCELLED, CLOSED,
    },
    document_edit::editable_collection_uuid,
    message,
    namespace_admin::{namespace_exists, valid_create_name},
    tools::{self, Tools},
    MongoManager, MongoPassword, READ_TIMEOUT,
};
use crate::Result;
use bson::{doc, Binary, Document};
use mongodb::{error::ErrorKind, Database};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Seek, SeekFrom},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{sync::Mutex, task::spawn_blocking, time::timeout};
use uuid::Uuid;

mod database;
use database::RestoreDatabase;

const REVIEW_TTL: Duration = Duration::from_secs(300);
const STALE: &str = "MongoDB 복원 검토가 만료됐거나 변경되었습니다. 다시 검토하세요.";
const TARGET_EXISTS: &str = "복원할 이름의 컬렉션 또는 뷰가 이미 있습니다. 다른 이름을 지정하세요.";
const FAILED: &str = "mongorestore가 중단되었습니다. MongoDB 계정 권한과 아카이브를 확인하세요.";
const UNKNOWN: &str =
    "MongoDB 복원 결과를 확인하지 못했습니다. 대상과 임시 컬렉션을 다시 조회하세요.";
const OPERATION: &str = "mongo.archive.restore";
const DATABASE_OPERATION: &str = "mongo.archive.restore.database";
const UNCONFIRMED: &str = "mongo.archive.restore.unconfirmed";

#[derive(Default)]
pub(super) struct RestoreReviewSlot(Mutex<Option<Pending>>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MongoRestoreInput {
    source: String,
    directory: String,
    database: String,
    collection: Option<String>,
}

#[derive(Serialize)]
pub struct MongoRestoreReview {
    token: String,
    #[serde(flatten)]
    archive: ArchiveInfo,
    target_version: String,
    restore_tool_version: String,
    expires_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_database: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    database_sources: Vec<RestoreDatabase>,
}

#[derive(Serialize)]
pub struct MongoRestoreReport {
    pub(super) database: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) collection: Option<String>,
    documents: u64,
    sha256: String,
    audit_warning: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    restored_database: Option<RestoreDatabase>,
}

struct Pending {
    token: String,
    started: Instant,
    input: MongoRestoreInput,
    archive: ArchiveInfo,
    target_version: String,
    tool_version: String,
    database_sources: Vec<RestoreDatabase>,
}

struct Stage {
    tools: Tools,
    source: File,
    gzip: bool,
}

enum RestorePlan {
    Collection {
        source: Namespace,
        target: String,
        staging: String,
    },
    Database(RestoreDatabase),
}

impl MongoManager {
    pub async fn preview_restore_archive(
        &self,
        id: &str,
        request_token: String,
        mut input: MongoRestoreInput,
    ) -> Result<MongoRestoreReview> {
        let request = self.store.queries.claim(&request_token)?;
        let connection = self.archive_connection(id)?;
        let slot = connection
            .restore
            .as_ref()
            .ok_or("컬렉션·뷰 관리를 허용한 MongoDB 연결을 여세요.")?;
        if let Some(collection) = &input.collection {
            check_database(&input.database)?;
            if !valid_create_name(collection) {
                return Err("복원할 새 컬렉션 이름을 확인하세요.".into());
            }
        } else {
            input.database = database::target_name(&input.database)?;
        }
        let mut pending = slot.0.lock().await;
        *pending = None;
        let cancel = request.cancellation_check();
        let deadline = Instant::now() + ARCHIVE_TIME;
        let task = async {
            let source = input.source.clone();
            let db = connection.client.database(&input.database);
            let archive = async {
                spawn_blocking(move || {
                    archive::scan(archive::open_source(&source)?, &|| {
                        check_local(deadline, &cancel)
                    })
                })
                .await
                .map_err(|_| "MongoDB 아카이브를 검토할 수 없습니다.")?
            };
            tokio::try_join!(
                archive,
                Tools::open(input.directory.clone()),
                server_version(&connection.client),
                ensure_target(&db, input.collection.as_deref())
            )
        };
        let (archive, tools, target_version, ()) = tokio::select! {
            biased;
            _ = request.wait_cancelled() => return Err(CANCELLED.into()),
            result = timeout(ARCHIVE_TIME, task) => result.map_err(|_| ARCHIVE_TIMEOUT)??,
        };
        check_compatibility(&archive, &tools.version, &target_version)?;
        let database_sources = if input.collection.is_none() {
            let sources = database::sources(&archive);
            if sources.is_empty() {
                return Err(
                    "모든 컬렉션과 뷰를 복원할 수 있는 원본 데이터베이스가 아카이브에 없습니다."
                        .into(),
                );
            }
            sources
        } else {
            if !archive.namespaces.iter().any(|item| item.restore_supported) {
                return Err("복원할 일반 컬렉션이 포함된 MongoDB 아카이브를 지정하세요.".into());
            }
            Vec::new()
        };
        let target_database = input.collection.is_none().then(|| input.database.clone());
        let token = Uuid::new_v4().to_string();
        *pending = Some(Pending {
            token: token.clone(),
            started: Instant::now(),
            input,
            archive: archive.clone(),
            target_version: target_version.clone(),
            tool_version: tools.version.clone(),
            database_sources: database_sources.clone(),
        });
        Ok(MongoRestoreReview {
            token,
            archive,
            target_version,
            restore_tool_version: tools.version,
            expires_seconds: REVIEW_TTL.as_secs(),
            target_database,
            database_sources,
        })
    }

    pub async fn discard_restore_archive(&self, id: &str, token: &str) -> Result<()> {
        let connection = self.archive_connection(id)?;
        let slot = connection
            .restore
            .ok_or("컬렉션·뷰 관리를 허용한 MongoDB 연결을 여세요.")?;
        let mut pending = slot.0.lock().await;
        if pending.as_ref().is_some_and(|review| review.token == token) {
            *pending = None;
        }
        Ok(())
    }

    pub async fn apply_restore_archive(
        &self,
        id: &str,
        request_token: String,
        token: &str,
        source_database: &str,
        source_collection: Option<&str>,
        password: MongoPassword,
        confirmation: &str,
    ) -> Result<MongoRestoreReport> {
        let request = self.store.queries.claim(&request_token)?;
        let connection = self.archive_connection(id)?;
        let slot = connection
            .restore
            .as_ref()
            .ok_or("컬렉션·뷰 관리를 허용한 MongoDB 연결을 여세요.")?;
        let mut guard = slot.0.lock().await;
        let valid = guard
            .as_ref()
            .filter(|review| review.token == token && review.started.elapsed() <= REVIEW_TTL)
            .ok_or(STALE)?;
        check_production(&connection.profile, confirmation)?;
        let plan = if let Some(target) = &valid.input.collection {
            let source = valid
                .archive
                .namespaces
                .iter()
                .find(|item| {
                    item.restore_supported
                        && item.database == source_database
                        && Some(item.collection.as_str()) == source_collection
                })
                .cloned()
                .ok_or("검토한 일반 MongoDB 컬렉션을 선택하세요.")?;
            RestorePlan::Collection {
                source,
                target: target.clone(),
                staging: format!("stackport_restore_{}", Uuid::new_v4().simple()),
            }
        } else {
            let source = valid
                .database_sources
                .iter()
                .find(|item| item.name == source_database && source_collection.is_none())
                .cloned()
                .ok_or("검토한 원본 MongoDB 데이터베이스를 선택하세요.")?;
            RestorePlan::Database(source)
        };
        let pending = guard.take().ok_or(STALE)?;
        let cancel = request.cancellation_check();
        let deadline = Instant::now() + ARCHIVE_TIME;
        let db = connection.client.database(&pending.input.database);
        let stage = tokio::select! {
            biased;
            _ = request.wait_cancelled() => return Err(CANCELLED.into()),
            result = timeout(ARCHIVE_TIME, prepare_stage(&connection, &pending, deadline, cancel)) =>
                result.map_err(|_| ARCHIVE_TIMEOUT)??,
        };
        if let RestorePlan::Collection { staging, .. } = &plan {
            ensure_destination(&db, staging).await?;
        }
        let target = pending.input.collection.as_ref().map_or_else(
            || pending.input.database.clone(),
            |name| format!("{}.{name}", pending.input.database),
        );
        let operation = if matches!(plan, RestorePlan::Database(_)) {
            DATABASE_OPERATION
        } else {
            OPERATION
        };
        self.audit_mongo_change(
            &connection.profile,
            token,
            operation,
            "started",
            None,
            Some(&target),
        )
        .await?;
        let (result, documents) = match &plan {
            RestorePlan::Collection {
                source,
                target: collection,
                staging,
            } => {
                let staged = tokio::select! {
                    biased;
                    _ = request.wait_cancelled() => Err(CANCELLED.into()),
                    result = timeout(deadline.saturating_duration_since(Instant::now()),
                        stage_archive(&connection, &db, source, staging, stage, password)) =>
                        result.map_err(|_| ARCHIVE_TIMEOUT.to_owned()).and_then(|result| result),
                };
                let result = match staged {
                    Ok(uuid) => {
                        let publication = tokio::select! {
                            biased;
                            _ = request.wait_cancelled() => None,
                            lock = self.namespace_writes.lock() => Some(lock),
                        };
                        let can_publish = {
                            let sessions = self.sessions.lock().map_err(|_| CLOSED)?;
                            publication.is_some()
                                && sessions.contains_key(id)
                                && request.begin_export_publication()
                        };
                        if can_publish {
                            publish(&connection, &db, staging, &target, collection, uuid).await
                        } else {
                            Err(CANCELLED.into())
                        }
                    }
                    Err(error) => Err(error),
                };
                (result, source.documents)
            }
            RestorePlan::Database(source) => {
                let operation = async {
                    if !self.sessions.lock().map_err(|_| CLOSED)?.contains_key(id) {
                        return Err(CLOSED.into());
                    }
                    ensure_target(&db, None).await?;
                    database::restore(&connection, &db, source, &pending.archive, stage, password)
                        .await
                };
                let result = tokio::select! {
                    biased;
                    _ = request.wait_cancelled() => Err(CANCELLED.into()),
                    result = timeout(deadline.saturating_duration_since(Instant::now()), operation) =>
                        result.map_err(|_| ARCHIVE_TIMEOUT.to_owned()).and_then(|result| result),
                };
                (result, source.documents)
            }
        };
        let (operation, outcome, count) = match &result {
            Ok(()) => (operation, "succeeded", i64::try_from(documents).ok()),
            Err(error) if error == UNKNOWN => (UNCONFIRMED, "started", None),
            _ => (operation, "failed", None),
        };
        let audit_warning = self
            .audit_mongo_change(
                &connection.profile,
                token,
                operation,
                outcome,
                count,
                Some(&target),
            )
            .await
            .is_err();
        match result {
            Ok(()) => Ok(MongoRestoreReport {
                database: pending.input.database,
                collection: pending.input.collection,
                documents,
                sha256: pending.archive.sha256,
                audit_warning,
                restored_database: if let RestorePlan::Database(source) = plan {
                    Some(source)
                } else {
                    None
                },
            }),
            Err(error) => {
                let mut failure = error;
                if let RestorePlan::Collection { staging, .. } = plan {
                    if !matches!(
                        timeout(READ_TIMEOUT, namespace_exists(&db, &staging)).await,
                        Ok(Ok(false))
                    ) {
                        failure.push_str(&format!(
                            " 임시 컬렉션 {}.{staging}을 확인하세요.",
                            db.name()
                        ));
                    }
                } else if ensure_target(&db, None).await.is_err() {
                    failure.push_str(&format!(
                        " 복원 대상 데이터베이스 {}의 상태를 확인하세요.",
                        db.name()
                    ));
                }
                if audit_warning {
                    failure.push_str(" 완료 작업 기록도 저장하지 못했습니다.");
                }
                Err(failure)
            }
        }
    }
}

fn check_compatibility(
    archive: &ArchiveInfo,
    tool_version: &str,
    target_version: &str,
) -> Result<()> {
    let source = version_family(&archive.server_version)
        .ok_or("아카이브의 원본 MongoDB 버전을 확인하세요.")?;
    let target = version_family(target_version).ok_or("대상 MongoDB 버전을 확인하세요.")?;
    if source != target || target < [8, 0] {
        return Err(
            "MongoDB 8.0 이상에서 아카이브와 대상의 주·부 버전이 같은지 확인하세요.".into(),
        );
    }
    let writer = tools::version_parts(&archive.tool_version)
        .ok_or("아카이브를 만든 도구 버전을 확인하세요.")?;
    if tools::version_parts(tool_version).is_none_or(|version| version < writer) {
        return Err("백업에 사용한 버전 이상의 mongorestore를 지정하세요.".into());
    }
    let protected = archive.namespaces.iter().any(|item| {
        item.database.is_empty() || matches!(item.database.as_str(), "admin" | "config" | "local")
    });
    if protected {
        return Err("시스템 데이터베이스와 oplog가 제외된 아카이브를 지정하세요.".into());
    }
    Ok(())
}

async fn ensure_target(db: &Database, collection: Option<&str>) -> Result<()> {
    if let Some(collection) = collection {
        ensure_destination(db, collection).await
    } else {
        timeout(READ_TIMEOUT, database::ensure_empty(db))
            .await
            .map_err(|_| "복원할 새 데이터베이스 확인 시간이 초과되었습니다.")?
    }
}

async fn ensure_destination(db: &Database, name: &str) -> Result<()> {
    if timeout(READ_TIMEOUT, namespace_exists(db, name))
        .await
        .map_err(|_| "복원 대상 확인 시간이 초과되었습니다.")??
    {
        Err(TARGET_EXISTS.into())
    } else {
        Ok(())
    }
}

async fn prepare_stage(
    connection: &ArchiveConnection,
    pending: &Pending,
    deadline: Instant,
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Result<Stage> {
    let path = pending.input.source.clone();
    let open_snapshot = async move {
        spawn_blocking(move || {
            let check = || check_local(deadline, &cancelled);
            let mut source = archive::snapshot(archive::open_source(&path)?, &check)?;
            let snapshot = archive::scan(
                source
                    .try_clone()
                    .map_err(|_| "임시 아카이브를 읽을 수 없습니다.")?,
                &check,
            )?;
            source
                .seek(SeekFrom::Start(0))
                .map_err(|_| "임시 아카이브를 열 수 없습니다.")?;
            Ok::<_, String>((source, snapshot))
        })
        .await
        .map_err(|_| "복원할 MongoDB 아카이브를 확인할 수 없습니다.")?
    };
    let db = connection.client.database(&pending.input.database);
    let (tools, (source, snapshot), target_version, ()) = tokio::try_join!(
        Tools::open(pending.input.directory.clone()),
        open_snapshot,
        server_version(&connection.client),
        ensure_target(&db, pending.input.collection.as_deref())
    )?;
    if snapshot != pending.archive {
        return Err("검토 이후 MongoDB 아카이브가 변경되었습니다.".into());
    }
    if tools.version != pending.tool_version
        || version_family(&target_version) != version_family(&pending.target_version)
    {
        return Err("검토 이후 MongoDB 서버 또는 도구 버전이 변경되었습니다.".into());
    }
    Ok(Stage {
        tools,
        source,
        gzip: snapshot.gzip,
    })
}

async fn stage_archive(
    connection: &ArchiveConnection,
    db: &Database,
    source: &Namespace,
    staging: &str,
    stage: Stage,
    password: MongoPassword,
) -> Result<Binary> {
    let name = format!("{}.{}", source.database, source.collection);
    let mut restore = stage.tools.command("mongorestore");
    restore
        .args(["--archive", "--stopOnError"])
        .arg(format!("--nsInclude={name}"))
        .arg(format!("--nsFrom={name}"))
        .arg(format!("--nsTo={}.{staging}", db.name()))
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
    let uuid = timeout(READ_TIMEOUT, editable_collection_uuid(db, staging))
        .await
        .map_err(|_| "복원한 컬렉션을 확인할 수 없습니다.")??;
    let documents = timeout(
        Duration::from_secs(60),
        db.collection::<Document>(staging)
            .count_documents(doc! {})
            .max_time(Duration::from_secs(45)),
    )
    .await
    .map_err(|_| "복원 건수 확인 시간이 초과되었습니다.")?
    .map_err(message)?;
    if documents != source.documents {
        return Err("아카이브와 복원된 컬렉션의 문서 수가 일치하지 않습니다.".into());
    }
    Ok(uuid)
}

async fn publish(
    connection: &ArchiveConnection,
    db: &Database,
    staging: &str,
    target: &str,
    collection: &str,
    uuid: Binary,
) -> Result<()> {
    let command = doc! { "renameCollection": format!("{}.{staging}", db.name()), "to": target,
    "dropTarget": false, "collectionUUID": uuid.clone(), "writeConcern": { "w": "majority" }, "maxTimeMS": 7000 };
    let result = timeout(
        READ_TIMEOUT,
        connection.client.database("admin").run_command(command),
    )
    .await;
    match result {
        Ok(Ok(reply)) if !reply.contains_key("writeConcernError") => return Ok(()),
        Ok(Err(error)) => {
            if let ErrorKind::Command(command) = error.kind.as_ref() {
                match command.code {
                    13 => {
                        return Err(
                            "MongoDB 계정에 복원한 컬렉션을 이름 변경할 권한이 없습니다.".into(),
                        )
                    }
                    48 => return Err(TARGET_EXISTS.into()),
                    26 | 361 => return Err("임시 컬렉션이 변경되었거나 삭제되었습니다.".into()),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    if let Ok(Ok(actual)) = timeout(READ_TIMEOUT, editable_collection_uuid(db, collection)).await {
        if actual == uuid {
            return Ok(());
        }
    }
    Err(UNKNOWN.into())
}
