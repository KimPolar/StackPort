use super::{
    document_snapshot::canonical_value,
    message,
    query::{valid_field, MongoQuery},
    validate_namespace, MongoManager,
};
use crate::{
    insert_audit,
    result_export::{
        ExportFile, ExportFormat, ReadyExport, ResultFileOptions, TypedExportColumn,
        TypedExportValue,
    },
    AuditRecord, Result,
};
use bson::{raw::RawDocumentBuf, Bson, Document};
use futures_util::TryStreamExt;
use mongodb::Collection;
use serde::Deserialize;
use std::{
    borrow::Cow,
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{sync::mpsc, task::spawn_blocking, time::timeout};

pub use crate::result_export::ResultFileOutcome as MongoExportOutcome;

const EXPORT_TIME: Duration = Duration::from_secs(300);
const CLOSED: &str = "MongoDB 연결이 닫혔습니다. 다시 연결하세요.";
const BSON_LOSS: &str =
    "BSON 표현을 Canonical Extended JSON으로 손실 없이 변환할 수 없는 문서가 있습니다.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MongoExportInput {
    query: MongoQuery,
    options: ResultFileOptions,
    #[serde(default)]
    fields: Vec<String>,
}

enum Staged {
    Ready(ReadyExport, u64),
    Cancelled,
    TimedOut,
}

enum Message {
    Document(RawDocumentBuf),
    Finish,
}

impl MongoManager {
    pub async fn export_documents(
        &self,
        id: &str,
        token: String,
        database: &str,
        name: &str,
        input: MongoExportInput,
    ) -> Result<MongoExportOutcome> {
        let request = self.store.queries.claim(&token)?;
        validate_namespace(database, name)?;
        let query = input.query.prepare()?;
        let format = input.options.format();
        let columns = match format {
            ExportFormat::Json => Vec::new(),
            ExportFormat::Csv { .. } => csv_columns(input.fields)?,
        };
        let (collection, profile) = {
            let sessions = self.sessions.lock().map_err(|_| CLOSED)?;
            let session = sessions.get(id).ok_or(CLOSED)?;
            (
                session
                    .client
                    .database(database)
                    .collection::<RawDocumentBuf>(name),
                session.profile.clone(),
            )
        };
        let target = format!("{database}.{name}");
        let operation = match format {
            ExportFormat::Json => "mongo.export.json",
            ExportFormat::Csv { .. } => "mongo.export.csv",
        };
        self.audit_mongo_change(&profile, &token, operation, "started", None, Some(&target))
            .await?;
        let work = stage_file(
            collection,
            query,
            input.options.destination,
            format,
            columns,
            request.export_counter(),
        );
        let staged = tokio::select! {
            biased;
            _ = request.wait_cancelled() => Ok(Staged::Cancelled),
            result = timeout(EXPORT_TIME, work) => match result {
                Ok(ready) => ready.map(|(file, rows)| Staged::Ready(file, rows)),
                Err(_) => Ok(Staged::TimedOut),
            },
        };
        let state = {
            let sessions = self.sessions.lock().map_err(|_| CLOSED)?;
            if !sessions.contains_key(id)
                || (matches!(&staged, Ok(Staged::Ready(..))) && !request.begin_export_publication())
            {
                Ok(Staged::Cancelled)
            } else {
                staged
            }
        };
        if let Ok(Staged::Ready(file, rows)) = state {
            let store = self.store.clone();
            return spawn_blocking(move || {
                let _request = request;
                let mut report = file.publish(rows);
                let audit = AuditRecord {
                    correlation_id: &token,
                    operation,
                    project_id: Some(&profile.project_id),
                    profile_id: Some(&profile.id),
                    environment: Some(&profile.settings.environment),
                    object_name: Some(&target),
                    outcome: if report.is_ok() {
                        "succeeded"
                    } else {
                        "failed"
                    },
                    affected_count: report.as_ref().ok().and_then(|_| i64::try_from(rows).ok()),
                };
                if store
                    .connect()
                    .and_then(|db| insert_audit(&db, audit))
                    .is_err()
                {
                    match &mut report {
                        Ok(report) => {
                            report.audit_warning =
                                Some("파일은 저장됐지만 작업 기록을 저장할 수 없습니다.".into())
                        }
                        Err(error) => error.push_str(" 작업 기록도 저장하지 못했습니다."),
                    }
                }
                report.map(|report| MongoExportOutcome::Exported { report })
            })
            .await
            .map_err(|_| "MongoDB 파일 저장을 마무리할 수 없습니다.")?;
        }
        if self
            .audit_mongo_change(&profile, &token, operation, "failed", None, Some(&target))
            .await
            .is_err()
        {
            return Err(match state {
                Err(error) => format!("{error} 작업 기록도 저장하지 못했습니다."),
                _ => "MongoDB 파일을 저장하지 않았으며 작업 기록도 저장하지 못했습니다.".into(),
            });
        }
        match state {
            Ok(Staged::Cancelled) => Ok(MongoExportOutcome::Cancelled),
            Ok(Staged::TimedOut) => Ok(MongoExportOutcome::TimedOut),
            Err(error) => Err(error),
            Ok(Staged::Ready(..)) => unreachable!("ready exports are published above"),
        }
    }
}

async fn stage_file(
    collection: Collection<RawDocumentBuf>,
    (filter, projection, sort): (Document, Document, Document),
    path: String,
    format: ExportFormat,
    columns: Vec<TypedExportColumn>,
    progress: Arc<AtomicU64>,
) -> Result<(ReadyExport, u64)> {
    let file = spawn_blocking(move || ExportFile::open(&path, format))
        .await
        .map_err(|_| "MongoDB 내보내기 파일을 열 수 없습니다.")??;
    let mut cursor = collection
        .find(filter)
        .projection(projection)
        .sort(sort)
        .batch_size(64)
        .max_time(EXPORT_TIME)
        .await
        .map_err(message)?;
    let (sender, receiver) = mpsc::channel(2);
    let writer =
        spawn_blocking(move || write_documents(file, format, &columns, receiver, &progress));
    while let Some(document) = cursor.try_next().await.map_err(message)? {
        if sender.send(Message::Document(document)).await.is_err() {
            return writer
                .await
                .map_err(|_| "MongoDB 내보내기 파일을 마무리할 수 없습니다.")?;
        }
    }
    let _ = sender.send(Message::Finish).await;
    drop(sender);
    writer
        .await
        .map_err(|_| "MongoDB 내보내기 파일을 마무리할 수 없습니다.")?
}

fn write_documents(
    mut file: ExportFile,
    format: ExportFormat,
    columns: &[TypedExportColumn],
    mut receiver: mpsc::Receiver<Message>,
    progress: &AtomicU64,
) -> Result<(ReadyExport, u64)> {
    if matches!(format, ExportFormat::Csv { .. }) {
        file.typed_header("stackport.mongodb-results", columns)?;
    }
    let mut rows = 0;
    while let Some(message) = receiver.blocking_recv() {
        let raw = match message {
            Message::Document(raw) => raw,
            Message::Finish => {
                let ready = match format {
                    ExportFormat::Json => file.finish_json_array(rows)?,
                    ExportFormat::Csv { .. } => file.finish()?,
                };
                return Ok((ready, rows));
            }
        };
        let document = Document::try_from(raw.as_ref())
            .map_err(|_| "MongoDB BSON 문서를 읽을 수 없습니다.")?;
        match format {
            ExportFormat::Json => {
                let json = lossless_json(document, &raw)?;
                file.write_json_array_document(&json, rows)?;
            }
            ExportFormat::Csv { .. } => {
                let cells = columns
                    .iter()
                    .map(|column| csv_cell(field_value(&document, &column.name)))
                    .collect::<Result<Vec<_>>>()?;
                file.write_typed_row(
                    cells.iter().map(|cell| match cell {
                        None => TypedExportValue::Null,
                        Some((value, true)) => TypedExportValue::Number(value.as_ref()),
                        Some((value, false)) => TypedExportValue::Text(value.as_ref()),
                    }),
                    columns,
                    rows,
                )?;
            }
        }
        rows += 1;
        progress.store(rows, Ordering::Relaxed);
    }
    Err("MongoDB 내보내기가 파일 작성 중 중단되었습니다.".into())
}

fn lossless_json(document: Document, raw: &RawDocumentBuf) -> Result<String> {
    let json = canonical_value(&Bson::Document(document))?;
    let parsed: Document = serde_json::from_str(&json).map_err(|_| BSON_LOSS)?;
    let restored = RawDocumentBuf::try_from(&parsed).map_err(|_| BSON_LOSS)?;
    if restored.as_bytes() != raw.as_bytes() {
        return Err(BSON_LOSS.into());
    }
    Ok(json)
}

fn csv_columns(fields: Vec<String>) -> Result<Vec<TypedExportColumn>> {
    if !(1..=64).contains(&fields.len())
        || fields.iter().any(|field| !valid_field(field))
        || fields.iter().collect::<HashSet<_>>().len() != fields.len()
    {
        return Err("CSV 필드 경로를 중복 없이 1~64개 지정하세요.".into());
    }
    Ok(fields
        .into_iter()
        .map(|name| TypedExportColumn {
            name,
            data_type: String::new(),
            numeric: false,
            encoding: None,
        })
        .collect())
}

fn field_value<'a>(document: &'a Document, path: &str) -> Option<&'a Bson> {
    let mut parts = path.split('.');
    let mut value = document.get(parts.next()?)?;
    for part in parts {
        value = match value {
            Bson::Document(document) => document.get(part)?,
            Bson::Array(values) => values.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(value)
}

fn csv_cell(value: Option<&Bson>) -> Result<Option<(Cow<'_, str>, bool)>> {
    let Some(value) = value else { return Ok(None) };
    let cell = match value {
        Bson::Null => return Ok(None),
        Bson::String(value) => (Cow::Borrowed(value.as_str()), false),
        Bson::Int32(value) => (Cow::Owned(value.to_string()), true),
        Bson::Int64(value) => (Cow::Owned(value.to_string()), true),
        Bson::Double(value) if value.is_finite() => (Cow::Owned(value.to_string()), true),
        Bson::Decimal128(value) => (Cow::Owned(value.to_string()), true),
        other => (Cow::Owned(canonical_value(other)?), false),
    };
    Ok(Some(cell))
}
