use super::{
    catalog::{
        columns_sql, data_suffix, decode_column, ident, is_binary, lookup_object, object_sql,
        text_expression, KEYS_SQL,
    },
    connect, query_error, Column, ExportOptions, ExportOutcome, Manager, Session, SqlClient,
    TIMEOUT,
};
use crate::{
    insert_audit,
    result_export::{ExportFile, ReadyExport, TypedExportColumn, TypedExportValue},
    AuditRecord, Result, TableQueryClauses,
};
use futures_util::TryStreamExt;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tiberius::{Row, ToSql};
use tokio::{
    sync::mpsc,
    task::spawn_blocking,
    time::{timeout, timeout_at, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const EXPORT_TIME: Duration = Duration::from_secs(300);
const CANCEL_TIME: Duration = Duration::from_secs(1);
const MAX_COLUMNS: usize = 4095;
const MAX_LOB_BYTES: u64 = 32 * 1024 * 1024;
const STATE_ERROR: &str = "SQL Server 내보내기 상태를 읽을 수 없습니다.";

#[derive(Default)]
pub(super) struct State {
    active: Option<ActiveExport>,
}

struct ActiveExport {
    id: Uuid,
    job: Arc<ExportJob>,
    publishing: bool,
}

#[derive(Default)]
struct ExportJob {
    stop: CancellationToken,
    rows: AtomicU64,
}

struct Registration<'a>(&'a Session);

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.export.lock() {
            state.active = None;
        }
    }
}

impl Session {
    pub(super) fn stop_export(&self) -> Result<()> {
        let state = self.export.lock().map_err(|_| STATE_ERROR)?;
        if let Some(active) = &state.active {
            if !active.publishing {
                active.job.stop.cancel();
            }
        }
        Ok(())
    }
}

enum Message {
    Columns(Vec<TypedExportColumn>),
    Row(Row),
    Finish,
}

impl Manager {
    pub fn export_progress(&self, id: &str, request_id: &str) -> Result<Option<u64>> {
        let request_id = export_id(request_id)?;
        let session = self.session(id)?;
        let state = session.export.lock().map_err(|_| STATE_ERROR)?;
        Ok(state
            .active
            .as_ref()
            .filter(|active| active.id == request_id)
            .map(|active| active.job.rows.load(Ordering::Relaxed)))
    }

    pub fn cancel_export(&self, id: &str, request_id: &str) -> Result<bool> {
        let request_id = export_id(request_id)?;
        let session = self.session(id)?;
        let state = session.export.lock().map_err(|_| STATE_ERROR)?;
        let Some(active) = state
            .active
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
        object: i32,
        clauses: TableQueryClauses,
        options: ExportOptions,
    ) -> Result<ExportOutcome> {
        let request_id = export_id(&request_id)?;
        let session = self.session(id)?;
        let job = Arc::new(ExportJob::default());
        {
            let mut state = session.export.lock().map_err(|_| STATE_ERROR)?;
            if session.closed.load(Ordering::Acquire) {
                return Ok(ExportOutcome::Cancelled);
            }
            if state.active.is_some() {
                return Err("이 연결의 내보내기가 이미 실행 중입니다.".into());
            }
            state.active = Some(ActiveExport {
                id: request_id,
                job: Arc::clone(&job),
                publishing: false,
            });
        }
        let _registration = Registration(&session);
        let deadline = Instant::now() + EXPORT_TIME;
        let file = spawn_blocking(move || ExportFile::open(&options.destination, options.format()))
            .await
            .map_err(|_| "SQL Server 내보내기 파일을 열 수 없습니다.")??;
        let settings = &session.profile.settings;
        let Some(auth) = session.operation_auth()? else {
            return Ok(ExportOutcome::Cancelled);
        };
        let mut client = tokio::select! {
            biased;
            _ = job.stop.cancelled() => return Ok(ExportOutcome::Cancelled),
            open = timeout(TIMEOUT, connect(settings, auth)) => open.map_err(|_| "SQL Server 내보내기 연결 시간이 초과되었습니다.")??,
        };
        if session.closed.load(Ordering::Acquire) {
            return Ok(ExportOutcome::Cancelled);
        }
        let (sender, receiver) = mpsc::channel(2);
        let writer_job = Arc::clone(&job);
        let writer = spawn_blocking(move || write_file(file, receiver, &writer_job));
        let mut in_flight = false;
        let read = stream_rows(&mut client, object, &clauses, &sender, &mut in_flight);
        let result = tokio::select! {
            biased;
            _ = job.stop.cancelled() => Ok(None),
            read = timeout_at(deadline, read) => read.map(Some),
        };
        drop(sender);
        // Send Attention if possible, then discard this dedicated connection.
        // A dropped TDS read may have consumed part of a token already.
        if in_flight {
            let _ = timeout(CANCEL_TIME, client.cancel_query()).await;
        }
        drop(client);
        let output = writer
            .await
            .map_err(|_| "SQL Server 내보내기 파일을 마무리할 수 없습니다.")?;
        let target = match result {
            Ok(None) => return Ok(ExportOutcome::Cancelled),
            Err(_) => return Ok(ExportOutcome::TimedOut),
            Ok(Some(read)) => read,
        };
        let output = output?;
        let target = target?;
        let (file, rows) = output.ok_or("SQL Server 결과를 모두 읽지 못했습니다.")?;
        {
            let mut state = session.export.lock().map_err(|_| STATE_ERROR)?;
            let active = state.active.as_mut().ok_or(STATE_ERROR)?;
            if job.stop.is_cancelled() || session.closed.load(Ordering::Acquire) {
                return Ok(ExportOutcome::Cancelled);
            }
            if Instant::now() >= deadline {
                return Ok(ExportOutcome::TimedOut);
            }
            active.publishing = true;
        }
        let store = self.store.clone();
        let profile = session.profile.clone();
        let report = spawn_blocking(move || {
            let mut report = file.publish(rows)?;
            let audit = AuditRecord {
                correlation_id: &request_id.to_string(),
                operation: if report.format == "CSV" {
                    "sql_server.export.csv"
                } else {
                    "sql_server.export.json"
                },
                project_id: Some(&profile.project_id),
                profile_id: Some(&profile.id),
                environment: Some(&profile.settings.environment),
                object_name: Some(&target),
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
        .map_err(|_| "SQL Server 파일 저장을 마무리할 수 없습니다.")??;
        Ok(ExportOutcome::Exported { report })
    }
}

fn export_id(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| "SQL Server 내보내기 요청 ID가 올바르지 않습니다.".into())
}

async fn read_catalog(
    client: &mut SqlClient,
    sql: &str,
    object: i32,
    in_flight: &mut bool,
) -> Result<Vec<Row>> {
    *in_flight = true;
    let rows = client
        .query(sql, &[&object])
        .await
        .map_err(query_error)?
        .into_first_result()
        .await
        .map_err(query_error)?;
    *in_flight = false;
    Ok(rows)
}

async fn stream_rows(
    client: &mut SqlClient,
    object: i32,
    clauses: &TableQueryClauses,
    sender: &mpsc::Sender<Message>,
    in_flight: &mut bool,
) -> Result<String> {
    let target = lookup_object(&read_catalog(client, &object_sql(), object, in_flight).await?)?;
    let table = format!("{}.{}", ident(&target.schema), ident(&target.name));
    let columns = read_catalog(client, &columns_sql(MAX_COLUMNS + 1), object, in_flight)
        .await?
        .iter()
        .map(decode_column)
        .collect::<Result<Vec<_>>>()?;
    if columns.is_empty() || columns.len() > MAX_COLUMNS {
        return Err(
            "내보내려면 읽을 수 있는 SQL Server 열이 1개 이상 4,095개 이하여야 합니다.".into(),
        );
    }
    let keys = read_catalog(client, KEYS_SQL, object, in_flight).await?;
    let (suffix, parameters) = data_suffix(&columns, &keys, clauses)?;
    let (select, typed, size_guard) = projection(&columns)?;
    let bindings: Vec<&dyn ToSql> = parameters.iter().map(|value| value as &dyn ToSql).collect();
    let stopped = "SQL Server 내보내기 파일에 기록할 수 없습니다.";
    sender
        .send(Message::Columns(typed))
        .await
        .map_err(|_| stopped)?;
    let sql = format!("SELECT {select} FROM {table} AS sp_source{size_guard}{suffix}");
    *in_flight = true;
    let mut stream = client
        .query(sql, &bindings)
        .await
        .map_err(query_error)?
        .into_row_stream();
    while let Some(row) = stream.try_next().await.map_err(query_error)? {
        if !size_guard.is_empty()
            && row.try_get::<bool, _>(columns.len()).map_err(query_error)? == Some(true)
        {
            return Err(
                "한 행의 큰 값이 32 MiB를 초과합니다. 조회 범위에서 해당 행을 제외하세요.".into(),
            );
        }
        sender.send(Message::Row(row)).await.map_err(|_| stopped)?;
    }
    *in_flight = false;
    sender.send(Message::Finish).await.map_err(|_| stopped)?;
    Ok(table)
}

fn projection(columns: &[Column]) -> Result<(String, Vec<TypedExportColumn>, String)> {
    let mut expressions = Vec::with_capacity(columns.len() + 1);
    let mut typed = Vec::with_capacity(columns.len());
    let mut large = Vec::new();
    for column in columns {
        let native = column.native_type.as_str();
        let name = format!("sp_source.{}", ident(&column.name));
        let binary = is_binary(column) || matches!(native, "geometry" | "geography");
        let numeric = matches!(
            native,
            "bit"
                | "tinyint"
                | "smallint"
                | "int"
                | "bigint"
                | "decimal"
                | "numeric"
                | "real"
                | "float"
                | "money"
                | "smallmoney"
        );
        let expression = if binary {
            format!("CONVERT(varbinary(max), {name})")
        } else {
            text_expression(native, &name).ok_or_else(|| {
                format!(
                    "SQL Server의 ‘{}’ 열({})은 원본을 보존하는 내보내기를 지원하지 않습니다.",
                    column.name, column.data_type
                )
            })?
        };
        if column.max_length == -1
            || matches!(
                native,
                "image" | "text" | "ntext" | "xml" | "json" | "geometry" | "geography"
            )
        {
            large.push(expressions.len());
        }
        expressions.push(expression);
        typed.push(TypedExportColumn {
            name: column.name.clone(),
            data_type: column.data_type.clone(),
            numeric,
            encoding: binary.then_some("hex"),
        });
    }
    let size_guard = if large.is_empty() {
        String::new()
    } else {
        let size = large
            .iter()
            .map(|&index| {
                format!(
                    "COALESCE(CONVERT(bigint, DATALENGTH({})), 0)",
                    expressions[index]
                )
            })
            .collect::<Vec<_>>()
            .join(" + ");
        for index in large {
            expressions[index] = format!(
                "CASE WHEN sp_export_size.bytes <= {MAX_LOB_BYTES} THEN {} END",
                expressions[index]
            );
        }
        expressions.push(format!(
            "CONVERT(bit, CASE WHEN sp_export_size.bytes > {MAX_LOB_BYTES} THEN 1 ELSE 0 END)"
        ));
        format!(" CROSS APPLY (SELECT {size} AS bytes) AS sp_export_size")
    };
    Ok((expressions.join(", "), typed, size_guard))
}

fn write_file(
    mut file: ExportFile,
    mut messages: mpsc::Receiver<Message>,
    job: &ExportJob,
) -> Result<Option<(ReadyExport, u64)>> {
    let Some(Message::Columns(columns)) = messages.blocking_recv() else {
        return Ok(None);
    };
    file.typed_header("stackport.sqlserver-results", &columns)?;
    let mut count = 0;
    while let Some(message) = messages.blocking_recv() {
        if job.stop.is_cancelled() {
            return Ok(None);
        }
        let row = match message {
            Message::Row(row) => row,
            Message::Finish => return Ok(Some((file.finish()?, count))),
            Message::Columns(_) => return Err("SQL Server의 내보내기 열이 변경되었습니다.".into()),
        };
        let values = columns
            .iter()
            .enumerate()
            .map(|(index, column)| {
                if column.encoding == Some("hex") {
                    row.try_get::<&[u8], _>(index)
                        .map(|value| value.map_or(TypedExportValue::Null, TypedExportValue::Binary))
                } else {
                    row.try_get::<&str, _>(index)
                        .map(|value| value.map_or(TypedExportValue::Null, TypedExportValue::Text))
                }
                .map_err(query_error)
            })
            .collect::<Result<Vec<_>>>()?;
        file.write_typed_row(values, &columns, count)?;
        count += 1;
        job.rows.store(count, Ordering::Relaxed);
    }
    Ok(None)
}
