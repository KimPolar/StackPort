mod stream;

use super::{
    api::{check_handle, finish_handle, Api, BAD_RESPONSE},
    catalog::{data_suffix, object_names, quote, read_columns, sortable},
    Column, ExportOptions, ExportOutcome, Manager, Session,
};
use crate::{
    insert_audit, result_export::TypedExportColumn, AuditRecord, Result, TableQueryClauses,
};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use stream::{download, RowsFile};
use tokio::{
    task::spawn_blocking,
    time::{sleep_until, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const EXPORT_TIME: Duration = Duration::from_secs(300);
const MAX_COLUMNS: usize = 4096;
const STATE_ERROR: &str = "Snowflake 내보내기 상태를 읽을 수 없습니다.";
const STOPPED: &str = "Snowflake 내보내기가 종료되었습니다.";

pub(super) struct ActiveExport {
    id: Uuid,
    job: Arc<Job>,
    publishing: bool,
}

struct Job {
    stop: CancellationToken,
    rows: AtomicU64,
    deadline: Instant,
}

impl Job {
    fn outcome(&self) -> Option<ExportOutcome> {
        if self.stop.is_cancelled() {
            Some(ExportOutcome::Cancelled)
        } else if Instant::now() >= self.deadline {
            Some(ExportOutcome::TimedOut)
        } else {
            None
        }
    }

    fn check(&self) -> Result<()> {
        if self.outcome().is_some() {
            Err(STOPPED.into())
        } else {
            Ok(())
        }
    }

    async fn during<T>(&self, operation: impl Future<Output = Result<T>>) -> Result<T> {
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => Err(STOPPED.into()),
            _ = sleep_until(self.deadline) => Err(STOPPED.into()),
            result = operation => result,
        }
    }
}

struct Registration<'a>(&'a Session);

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.export.lock() {
            *active = None;
        }
    }
}

impl Manager {
    pub fn export_progress(&self, id: &str, request_id: &str) -> Result<Option<u64>> {
        let request_id = export_id(request_id)?;
        let session = self.session(id)?;
        let slot = session.export.lock().map_err(|_| STATE_ERROR)?;
        Ok(slot
            .as_ref()
            .filter(|active| active.id == request_id)
            .map(|active| active.job.rows.load(Ordering::Relaxed)))
    }

    pub fn cancel_export(&self, id: &str, request_id: &str) -> Result<bool> {
        let request_id = export_id(request_id)?;
        let session = self.session(id)?;
        let slot = session.export.lock().map_err(|_| STATE_ERROR)?;
        let Some(active) = slot
            .as_ref()
            .filter(|active| active.id == request_id && !active.publishing)
        else {
            return Ok(false);
        };
        active.job.stop.cancel();
        Ok(true)
    }

    pub async fn export(
        &self,
        id: &str,
        request_id: String,
        object: String,
        clauses: TableQueryClauses,
        options: ExportOptions,
    ) -> Result<ExportOutcome> {
        let request = export_id(&request_id)?;
        let [schema, name] = object_names(&object)?;
        let session = self.session(id)?;
        let _operation = session.operation()?;
        let job = Arc::new(Job {
            stop: session.api.operation_token(),
            rows: AtomicU64::new(0),
            deadline: Instant::now() + EXPORT_TIME,
        });
        {
            let mut slot = session.export.lock().map_err(|_| STATE_ERROR)?;
            if let Some(outcome) = job.outcome() {
                return Ok(outcome);
            }
            if slot.is_some() {
                return Err("이 연결의 내보내기가 이미 실행 중입니다.".into());
            }
            *slot = Some(ActiveExport {
                id: request,
                job: Arc::clone(&job),
                publishing: false,
            });
        }
        let _registration = Registration(&session);
        let table = [&session.database, &schema, &name]
            .map(|part| quote(part))
            .join(".");
        let result = write_results(&session, &schema, &name, &table, &clauses, options, &job).await;
        let (file, rows) = {
            let mut slot = session.export.lock().map_err(|_| STATE_ERROR)?;
            if let Some(outcome) = job.outcome() {
                return Ok(outcome);
            }
            let file = result?;
            slot.as_mut().ok_or(STATE_ERROR)?.publishing = true;
            file
        };
        let store = self.store.clone();
        let profile = session.profile.clone();
        let report = spawn_blocking(move || {
            let mut report = file.publish(rows)?;
            let audit = AuditRecord {
                correlation_id: &request.to_string(),
                operation: if report.format == "CSV" {
                    "snowflake.export.csv"
                } else {
                    "snowflake.export.json"
                },
                project_id: Some(&profile.project_id),
                profile_id: Some(&profile.id),
                environment: Some(&profile.settings.environment),
                object_name: Some(&table),
                outcome: "succeeded",
                affected_count: i64::try_from(rows).ok(),
            };
            if store
                .connect()
                .and_then(|db| insert_audit(&db, audit))
                .is_err()
            {
                report.audit_warning =
                    Some("파일은 저장됐지만 작업 기록을 저장할 수 없습니다.".into());
            }
            Ok::<_, String>(report)
        })
        .await
        .map_err(|_| "Snowflake 내보내기 파일을 저장할 수 없습니다.")??;
        Ok(ExportOutcome::Exported { report })
    }
}

fn export_id(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| "Snowflake 내보내기 요청 ID가 올바르지 않습니다.".into())
}

async fn write_results(
    session: &Session,
    schema: &str,
    name: &str,
    table: &str,
    clauses: &TableQueryClauses,
    options: ExportOptions,
    job: &Arc<Job>,
) -> Result<(crate::result_export::ReadyExport, u64)> {
    let columns = read_columns(session, schema, name, MAX_COLUMNS + 1, &job.stop).await?;
    if columns.is_empty() || columns.len() > MAX_COLUMNS {
        return Err(
            "내보내려면 읽을 수 있는 Snowflake 열이 1개 이상 4,096개 이하여야 합니다.".into(),
        );
    }
    let (suffix, parameters) = data_suffix(&columns, clauses)?;
    let (expressions, typed): (Vec<_>, Vec<_>) = columns
        .iter()
        .map(projection)
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .unzip();
    let statement = format!(
        "SELECT {}\nFROM {table} AS sp_source{suffix}",
        expressions.join(", ")
    );
    let bindings: Vec<_> = parameters.iter().map(String::as_str).collect();
    job.check()?;
    let writer_job = Arc::clone(job);
    let writer = spawn_blocking(move || RowsFile::open(options, typed, writer_job))
        .await
        .map_err(|_| "Snowflake 내보내기 파일을 열 수 없습니다.")??;
    let writer = fetch(&session.api, &statement, &bindings, writer, job).await?;
    job.check()?;
    spawn_blocking(move || writer.finish())
        .await
        .map_err(|_| "Snowflake 내보내기 파일을 마무리할 수 없습니다.")?
}

async fn fetch(
    api: &Api,
    statement: &str,
    bindings: &[&str],
    writer: RowsFile,
    job: &Job,
) -> Result<RowsFile> {
    let mut pending = None;
    let first = match job
        .during(api.start(statement, bindings, 0, EXPORT_TIME.as_secs(), &mut pending))
        .await
    {
        Ok(response) => response,
        Err(error) => {
            api.cancel_pending(pending).await;
            return Err(error);
        }
    };
    let (first, mut writer) = download(first, writer, job).await?;
    let handle = finish_handle(&mut pending, first.handle)?;
    let metadata = first.metadata.ok_or(BAD_RESPONSE)?;
    metadata.validate(None)?;
    if first.rows
        != metadata
            .partition_info
            .first()
            .map_or(0, |part| part.row_count)
    {
        return Err(BAD_RESPONSE.into());
    }
    for (index, partition) in metadata.partition_info.into_iter().enumerate().skip(1) {
        let id = handle.ok_or(BAD_RESPONSE)?;
        let response = job.during(api.partition(id, index, EXPORT_TIME)).await?;
        let (next, output) = download(response, writer, job).await?;
        check_handle(handle, next.handle)?;
        if next.rows != partition.row_count {
            return Err(BAD_RESPONSE.into());
        }
        writer = output;
    }
    Ok(writer)
}

fn projection(column: &Column) -> Result<(String, TypedExportColumn)> {
    let name = format!("sp_source.{}", quote(&column.name));
    let native = column.native_type.split('(').next().unwrap_or_default();
    let numeric = matches!(
        native,
        "NUMBER"
            | "FIXED"
            | "DECIMAL"
            | "NUMERIC"
            | "FLOAT"
            | "REAL"
            | "DOUBLE"
            | "DOUBLE PRECISION"
            | "DECFLOAT"
    );
    let binary = column.binary() || matches!(native, "GEOGRAPHY" | "GEOMETRY");
    let expression = match native {
        "BINARY" | "VARBINARY" => format!("HEX_ENCODE({name})"),
        "GEOGRAPHY" | "GEOMETRY" => format!("HEX_ENCODE(ST_ASEWKB({name}))"),
        "VARIANT" => format!("TO_JSON({name})"),
        "ARRAY" | "OBJECT" | "MAP" => format!("TO_JSON({name}::VARIANT)"),
        "VECTOR" => format!("TO_JSON({name}::ARRAY::VARIANT)"),
        _ if numeric => name,
        _ if sortable(native) => column.value_expression(),
        _ => {
            return Err(format!(
                "Snowflake의 ‘{}’ 열({})은 내보내기에서 지원하지 않습니다.",
                column.name, column.data_type
            ))
        }
    };
    Ok((
        expression,
        TypedExportColumn {
            name: column.name.clone(),
            data_type: column.data_type.clone(),
            numeric,
            encoding: binary.then_some("hex"),
        },
    ))
}
