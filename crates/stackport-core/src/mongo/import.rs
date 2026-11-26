use super::{
    document_edit::editable_collection_uuid,
    import_file::{self, ImportSample},
    message, validate_namespace, MongoManager, READ_TIMEOUT, SERVER_TIME,
};
use crate::Result;
use bson::{doc, Binary, Document};
use mongodb::{error::ErrorKind, options::WriteConcern, Client, ClientSession};
use serde::Serialize;
use std::time::{Duration, Instant};
use tokio::{
    task::spawn_blocking,
    time::{timeout, timeout_at, Instant as Deadline},
};
use uuid::Uuid;

const REVIEW_TIME: Duration = Duration::from_secs(300);
const APPLY_TIME: Duration = Duration::from_secs(45);
const STALE: &str = "MongoDB 가져오기 검토가 만료됐거나 변경되었습니다. 파일을 다시 검토하세요.";
const OPERATION: &str = "mongo.import.json";
const UNCONFIRMED: &str = "mongo.import.json.unconfirmed";

pub(super) struct PendingImport {
    token: String,
    reviewed: Instant,
    database: String,
    collection: String,
    uuid: Binary,
    path: String,
    digest: [u8; 32],
    total: usize,
    atomic: bool,
    batches: Vec<Vec<Document>>,
}

#[derive(Serialize)]
pub struct MongoImportReview {
    token: String,
    bytes: usize,
    document_count: usize,
    sample: Vec<ImportSample>,
    atomic: bool,
    expires_seconds: u64,
}

#[derive(Serialize)]
pub struct MongoImportReport {
    status: ImportStatus,
    document_count: usize,
    inserted: usize,
    stopped_at: Option<usize>,
    reason: Option<&'static str>,
    audit_warning: bool,
}

#[derive(PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ImportStatus {
    Complete,
    Stopped,
    Unconfirmed,
}

impl MongoManager {
    pub async fn review_document_import(
        &self,
        id: &str,
        database: String,
        collection: String,
        path: String,
    ) -> Result<MongoImportReview> {
        validate_namespace(&database, &collection)?;
        let (client, editor) = self.document_editor(id)?;
        let mut pending = editor.import.lock().await;
        *pending = None;
        let source_path = path.clone();
        let file = spawn_blocking(move || import_file::read_import(&source_path))
            .await
            .map_err(|_| "MongoDB JSON 파일을 검토할 수 없습니다.")??;
        let (uuid, atomic) = timeout(READ_TIMEOUT, async {
            let uuid = editable_collection_uuid(&client.database(&database), &collection).await?;
            let hello = client
                .database("admin")
                .run_command(doc! { "hello": 1 })
                .await
                .map_err(message)?;
            let atomic =
                hello.get_str("setName").is_ok() || matches!(hello.get_str("msg"), Ok("isdbgrid"));
            if !atomic && !matches!(hello.get_bool("isWritablePrimary"), Ok(true)) {
                return Err("가져오기를 받는 쓰기 가능한 MongoDB 서버에 연결하세요.".into());
            }
            Ok::<_, String>((uuid, atomic))
        })
        .await
        .map_err(|_| "MongoDB 가져오기 대상을 확인하는 시간이 초과되었습니다.")??;
        let token = Uuid::new_v4().to_string();
        *pending = Some(PendingImport {
            token: token.clone(),
            reviewed: Instant::now(),
            database,
            collection,
            uuid,
            path,
            digest: file.digest,
            total: file.documents,
            atomic,
            batches: file.batches,
        });
        Ok(MongoImportReview {
            token,
            bytes: file.bytes,
            document_count: file.documents,
            sample: file.sample,
            atomic,
            expires_seconds: REVIEW_TIME.as_secs(),
        })
    }

    pub async fn discard_document_import(&self, id: &str, token: &str) -> Result<()> {
        let (_, editor) = self.document_editor(id)?;
        let mut pending = editor.import.lock().await;
        if pending.as_ref().is_some_and(|review| review.token == token) {
            *pending = None;
        }
        Ok(())
    }

    pub async fn apply_document_import(
        &self,
        id: &str,
        token: &str,
        confirmation: &str,
        accept_partial: bool,
    ) -> Result<MongoImportReport> {
        let (client, editor) = self.document_editor(id)?;
        let mut guard = editor.import.lock().await;
        let pending = guard
            .as_ref()
            .filter(|review| review.token == token)
            .ok_or(STALE)?;
        if pending.reviewed.elapsed() > REVIEW_TIME {
            *guard = None;
            return Err(STALE.into());
        }
        if editor.profile.settings.environment == "PROD" && confirmation != "PROD" {
            return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
        }
        if !pending.atomic && pending.total > 1 && !accept_partial {
            return Err("오류 전까지 저장된 문서가 유지됨을 확인하세요.".into());
        }
        let pending = guard.take().ok_or(STALE)?;
        let source_path = pending.path.clone();
        let digest = spawn_blocking(move || {
            import_file::read_bytes(&source_path).map(|bytes| import_file::fingerprint(&bytes))
        })
        .await
        .map_err(|_| "MongoDB 가져오기 파일을 다시 확인할 수 없습니다.")??;
        if digest != pending.digest {
            return Err("검토 뒤 파일이 변경되었습니다. 파일을 다시 검토하세요.".into());
        }
        let target = format!("{}.{}", pending.database, pending.collection);
        self.audit_mongo_change(
            &editor.profile,
            token,
            OPERATION,
            "started",
            None,
            Some(&target),
        )
        .await?;
        // The server checks the reviewed UUID on each batch, including writes inside a transaction.
        let mut report = insert_documents(&client, pending).await;
        let (operation, outcome) = match report.status {
            ImportStatus::Complete => (OPERATION, "succeeded"),
            ImportStatus::Unconfirmed => (UNCONFIRMED, "started"),
            ImportStatus::Stopped => (OPERATION, "failed"),
        };
        report.audit_warning = self
            .audit_mongo_change(
                &editor.profile,
                token,
                operation,
                outcome,
                Some(report.inserted as i64),
                Some(&target),
            )
            .await
            .is_err();
        drop(guard);
        Ok(report)
    }
}

async fn insert_documents(client: &Client, pending: PendingImport) -> MongoImportReport {
    let PendingImport {
        database,
        collection,
        uuid,
        total,
        atomic,
        batches,
        ..
    } = pending;
    let mut report = MongoImportReport {
        status: ImportStatus::Complete,
        document_count: total,
        inserted: 0,
        stopped_at: None,
        reason: None,
        audit_warning: false,
    };
    let mut transaction = if atomic {
        let Ok(Ok(session)) = timeout(READ_TIMEOUT, start_transaction(client)).await else {
            report.status = ImportStatus::Stopped;
            report.reason = Some("MongoDB 트랜잭션을 시작할 수 없습니다.");
            return report;
        };
        Some(session)
    } else {
        None
    };
    let db = client.database(&database);
    let deadline = Deadline::now() + APPLY_TIME;
    for batch in batches {
        if Deadline::now() >= deadline {
            report.status = ImportStatus::Stopped;
            report.stopped_at = Some(report.inserted + 1);
            report.reason = Some("다음 묶음을 쓰기 전에 가져오기 제한 시간이 지났습니다.");
            break;
        }
        let count = batch.len();
        let mut command = doc! { "insert": &collection, "collectionUUID": uuid.clone(), "ordered": true,
        "documents": batch, "maxTimeMS": SERVER_TIME.as_millis() as i32 };
        if !atomic && super::apply_write_concern(client, &mut command).is_err() {
            report.status = ImportStatus::Stopped;
            report.reason = Some("MongoDB 쓰기 옵션을 읽을 수 없습니다.");
            break;
        }
        let reply = timeout_at(deadline.min(Deadline::now() + READ_TIMEOUT), async {
            let command = db.run_command(command);
            match transaction.as_mut() {
                Some(session) => command.session(session).await,
                None => command.await,
            }
        })
        .await;
        match batch_result(reply, count) {
            BatchResult::Inserted => report.inserted += count,
            BatchResult::Stopped { inserted, reason } => {
                report.inserted += inserted;
                report.status = ImportStatus::Stopped;
                report.stopped_at = Some(report.inserted + 1);
                report.reason = Some(reason);
                break;
            }
            BatchResult::Unconfirmed => {
                report.status = ImportStatus::Unconfirmed;
                report.stopped_at = Some(report.inserted + 1);
                report.reason =
                    Some("이 묶음의 저장 결과를 확인할 수 없습니다. 현재 컬렉션을 확인하세요.");
                break;
            }
        }
    }
    if let Some(mut transaction) = transaction {
        if report.status != ImportStatus::Complete {
            let _ = timeout(READ_TIMEOUT, transaction.abort_transaction()).await;
            report.inserted = 0;
            if report.status == ImportStatus::Unconfirmed {
                report.status = ImportStatus::Stopped;
                report.reason = Some("묶음 응답을 확인하지 못해 트랜잭션을 커밋하지 않았습니다.");
            }
        } else if !commit(&mut transaction).await {
            report.status = ImportStatus::Unconfirmed;
            report.inserted = 0;
            report.reason =
                Some("커밋 결과를 확인할 수 없습니다. 다시 가져오기 전에 컬렉션을 확인하세요.");
        }
    }
    report
}

async fn start_transaction(client: &Client) -> mongodb::error::Result<ClientSession> {
    let mut session = client.start_session().await?;
    session
        .start_transaction()
        .write_concern(WriteConcern::majority())
        .max_commit_time(SERVER_TIME)
        .await?;
    Ok(session)
}

async fn commit(session: &mut ClientSession) -> bool {
    match timeout(READ_TIMEOUT, session.commit_transaction()).await {
        Ok(Ok(())) => true,
        Ok(Err(error)) if error.contains_label("UnknownTransactionCommitResult") => {
            matches!(
                timeout(READ_TIMEOUT, session.commit_transaction()).await,
                Ok(Ok(()))
            )
        }
        _ => false,
    }
}

enum BatchResult {
    Inserted,
    Stopped {
        inserted: usize,
        reason: &'static str,
    },
    Unconfirmed,
}

fn batch_result(
    reply: std::result::Result<mongodb::error::Result<Document>, tokio::time::error::Elapsed>,
    count: usize,
) -> BatchResult {
    let reply = match reply {
        Ok(Ok(reply)) => reply,
        Ok(Err(error)) => {
            if let ErrorKind::Command(command) = error.kind.as_ref() {
                if let Some(reason) = write_reason(command.code) {
                    return BatchResult::Stopped {
                        inserted: 0,
                        reason,
                    };
                }
            }
            return BatchResult::Unconfirmed;
        }
        Err(_) => return BatchResult::Unconfirmed,
    };
    if reply.contains_key("writeConcernError") {
        return BatchResult::Unconfirmed;
    }
    let inserted = reply
        .get_i32("n")
        .map(i64::from)
        .or_else(|_| reply.get_i64("n"));
    let Some(inserted) = inserted.ok().and_then(|value| usize::try_from(value).ok()) else {
        return BatchResult::Unconfirmed;
    };
    let errors = reply.get_array("writeErrors").ok();
    if let Some(error) = errors.and_then(|errors| errors.first()) {
        let Some(error) = error.as_document() else {
            return BatchResult::Unconfirmed;
        };
        if inserted >= count
            || error
                .get_i32("index")
                .ok()
                .and_then(|value| usize::try_from(value).ok())
                != Some(inserted)
        {
            return BatchResult::Unconfirmed;
        }
        let reason = error
            .get_i32("code")
            .ok()
            .and_then(write_reason)
            .unwrap_or("MongoDB 서버가 이 문서를 거부했습니다.");
        BatchResult::Stopped { inserted, reason }
    } else if inserted == count && (errors.is_some() || !reply.contains_key("writeErrors")) {
        BatchResult::Inserted
    } else {
        BatchResult::Unconfirmed
    }
}

fn write_reason(code: i32) -> Option<&'static str> {
    Some(match code {
        13 => "현재 MongoDB 계정에 문서 쓰기 권한이 없습니다.",
        26 | 361 => "검토한 컬렉션이 변경됐거나 삭제되었습니다.",
        121 => "문서가 컬렉션의 유효성 검사에 실패했습니다.",
        11000 => "이미 사용 중인 _id 또는 고유 인덱스 값입니다.",
        2 | 9 | 20 | 72 | 73 | 166 | 323 => {
            "MongoDB 서버가 쓰기 요청을 거부했습니다. 서버 호환성과 문서 형식을 확인하세요."
        }
        _ => return None,
    })
}
