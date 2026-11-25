use super::{
    quoted, read_columns, read_message, require_identifier,
    sql::{
        binary_column, open_request_connection, prepare_read_sql, result_value, sql_error,
        type_name, validate_input, MysqlSqlParameter, Request, ResultValue,
    },
    table_source, MysqlManager, Session,
};
use crate::{
    insert_audit,
    result_export::{ExportFile, ExportFormat, ReadyExport, TypedExportColumn, TypedExportValue},
    AuditRecord, ExportReport, Result, TableQueryClauses,
};
use mysql_async::{
    consts::ColumnType, prelude::Queryable, Conn, OptsBuilder, Params, Row, Statement, Value,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{sync::mpsc, task::spawn_blocking, time::timeout};
use uuid::Uuid;

const EXPORT_TIME: Duration = Duration::from_secs(300);
const MAX_ROW_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MysqlExportSource {
    Table {
        database: String,
        table: String,
        clauses: TableQueryClauses,
    },
    Sql {
        database: Option<String>,
        sql: String,
        parameters: Vec<MysqlSqlParameter>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MysqlExportOptions {
    destination: String,
    format: Format,
    include_header: bool,
    spreadsheet_safe: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Format {
    Csv,
    Json,
}

impl MysqlExportOptions {
    fn format(&self) -> ExportFormat {
        match self.format {
            Format::Csv => ExportFormat::Csv {
                include_header: self.include_header,
                spreadsheet_safe: self.spreadsheet_safe,
            },
            Format::Json => ExportFormat::Json,
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MysqlExportOutcome {
    Exported { report: ExportReport },
    Cancelled,
    TimedOut,
}

enum Source {
    Table {
        database: String,
        table: String,
        clauses: TableQueryClauses,
    },
    Sql {
        sql: String,
        values: Vec<Value>,
    },
}

enum Message {
    Row(Row),
    Finish,
}

impl MysqlManager {
    pub fn export_progress(&self, id: &str, request_id: &str) -> Result<Option<u64>> {
        let request_id: Uuid = request_id
            .parse()
            .map_err(|_| "MySQL 실행 ID를 확인하세요.")?;
        let session = self.session(id)?;
        let slot = session
            .running_sql
            .lock()
            .map_err(|_| "MySQL 실행 상태를 읽을 수 없습니다.")?;
        Ok(slot
            .as_ref()
            .filter(|active| active.id == request_id)
            .and_then(|active| active.exported_rows.as_ref())
            .map(|rows| rows.load(Ordering::Relaxed)))
    }

    pub async fn export(
        &self,
        id: &str,
        request_id: String,
        source: MysqlExportSource,
        options: MysqlExportOptions,
    ) -> Result<MysqlExportOutcome> {
        let session = self.session(id)?;
        let (source, database) = match source {
            MysqlExportSource::Table {
                database,
                table,
                clauses,
            } => {
                require_identifier(&database)?;
                require_identifier(&table)?;
                let selected = Some(database.clone());
                (
                    Source::Table {
                        database,
                        table,
                        clauses,
                    },
                    selected,
                )
            }
            MysqlExportSource::Sql {
                database,
                sql,
                parameters,
            } => {
                let values = validate_input(&session, database.as_deref(), &sql, parameters)?;
                (Source::Sql { sql, values }, database)
            }
        };
        let progress = Arc::new(AtomicU64::new(0));
        let (request, mut stopped) = Request::claim(&session, &request_id, Some(progress.clone()))?;
        if self.session(id).is_err() {
            return Ok(MysqlExportOutcome::Cancelled);
        }
        let work = prepare_file(&session, source, database, options, progress);
        let (file, rows) = tokio::select! {
            biased;
            _ = &mut stopped => return Ok(MysqlExportOutcome::Cancelled),
            read = timeout(EXPORT_TIME, work) => match read {
                Ok(result) => result?,
                Err(_) => return Ok(MysqlExportOutcome::TimedOut),
            }
        };
        if self.session(id).is_err() || !request.begin_publication()? {
            return Ok(MysqlExportOutcome::Cancelled);
        }
        let store = self.store.clone();
        let audit_target = (
            session.project_id.clone(),
            session.profile_id.clone(),
            session.environment.clone(),
        );
        let report = spawn_blocking(move || {
            let mut report = file.publish(rows)?;
            let (project, profile, environment) = audit_target;
            let audit = AuditRecord {
                correlation_id: &request_id,
                operation: if report.format == "CSV" {
                    "mysql.export.csv"
                } else {
                    "mysql.export.json"
                },
                project_id: Some(&project),
                profile_id: Some(&profile),
                environment: Some(&environment),
                object_name: None,
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
        .map_err(|_| "MySQL 파일 저장을 마무리할 수 없습니다.")??;
        Ok(MysqlExportOutcome::Exported { report })
    }
}

async fn prepare_file(
    session: &Session,
    source: Source,
    database: Option<String>,
    options: MysqlExportOptions,
    progress: Arc<AtomicU64>,
) -> Result<(ReadyExport, u64)> {
    let file = spawn_blocking(move || ExportFile::open(&options.destination, options.format()))
        .await
        .map_err(|_| "MySQL 내보내기 파일을 열 수 없습니다.")??;
    let connection_options = OptsBuilder::from_opts(session.options.clone())
        .db_name(database)
        .max_allowed_packet(Some(MAX_ROW_BYTES));
    let mut connection = open_request_connection(connection_options).await?;
    let (statement, values) = export_statement(&mut connection, source).await?;
    let mut result = connection
        .exec_iter(statement, Params::Positional(values))
        .await
        .map_err(sql_error)?;
    let metadata = result
        .columns()
        .ok_or("MySQL 서버에서 조회 열을 받지 못했습니다.")?;
    let (sender, receiver) = mpsc::channel(2);
    let writer = spawn_blocking(move || write_rows(file, &metadata, receiver, progress));
    let mut complete = true;
    while let Some(row) = result.next().await.map_err(sql_error)? {
        if sender.send(Message::Row(row)).await.is_err() {
            complete = false;
            break;
        }
    }
    if complete {
        result.drop_result().await.map_err(sql_error)?;
        connection.query_drop("ROLLBACK").await.map_err(sql_error)?;
        let _ = sender.send(Message::Finish).await;
    }
    drop(sender);
    writer
        .await
        .map_err(|_| "MySQL 내보내기 파일을 마무리할 수 없습니다.")?
}

async fn export_statement(
    connection: &mut Conn,
    source: Source,
) -> Result<(Statement, Vec<Value>)> {
    match source {
        Source::Sql { sql, values } => {
            let statement = prepare_read_sql(connection, &sql, values.len()).await?;
            Ok((statement, values))
        }
        Source::Table {
            database,
            table,
            clauses,
        } => {
            connection
                .query_drop("START TRANSACTION READ ONLY")
                .await
                .map_err(sql_error)?;
            let columns = read_columns(connection, &database, &table)
                .await
                .map_err(|error| read_message(&error).to_owned())?;
            let (source, values, _) =
                table_source(connection, &database, &table, &columns, &clauses)
                    .await
                    .map_err(|error| read_message(&error).to_owned())?;
            let projection = columns
                .iter()
                .map(|column| format!("sp_source.{}", quoted(&column.name)))
                .collect::<Vec<_>>()
                .join(", ");
            let statement = connection
                .prep(format!("SELECT {projection}\n{source}"))
                .await
                .map_err(sql_error)?;
            Ok((statement, values))
        }
    }
}

fn write_rows(
    mut file: ExportFile,
    metadata: &[mysql_async::Column],
    mut receiver: mpsc::Receiver<Message>,
    progress: Arc<AtomicU64>,
) -> Result<(ReadyExport, u64)> {
    let columns: Vec<_> = metadata
        .iter()
        .map(|column| TypedExportColumn {
            name: column.name_str().into_owned(),
            data_type: type_name(column),
            encoding: binary_column(column).then_some("hex"),
            numeric: matches!(
                column.column_type(),
                ColumnType::MYSQL_TYPE_TINY
                    | ColumnType::MYSQL_TYPE_SHORT
                    | ColumnType::MYSQL_TYPE_INT24
                    | ColumnType::MYSQL_TYPE_LONG
                    | ColumnType::MYSQL_TYPE_LONGLONG
                    | ColumnType::MYSQL_TYPE_FLOAT
                    | ColumnType::MYSQL_TYPE_DOUBLE
                    | ColumnType::MYSQL_TYPE_DECIMAL
                    | ColumnType::MYSQL_TYPE_NEWDECIMAL
                    | ColumnType::MYSQL_TYPE_YEAR
            ),
        })
        .collect();
    file.typed_header("stackport.mysql-results", &columns)?;
    let mut rows = 0;
    while let Some(message) = receiver.blocking_recv() {
        let row = match message {
            Message::Row(row) => row.unwrap(),
            Message::Finish => return file.finish().map(|file| (file, rows)),
        };
        if row.len() != columns.len() {
            return Err("MySQL 서버의 결과 행 형식을 읽을 수 없습니다.".into());
        }
        let values: Vec<_> = row
            .into_iter()
            .zip(metadata)
            .map(|(value, column)| result_value(value, column))
            .collect();
        let size = values
            .iter()
            .map(|value| match value {
                ResultValue::Null => 0,
                ResultValue::Text(value) => value.len(),
                ResultValue::Bytes(value) => value.len(),
            })
            .sum::<usize>();
        if size > MAX_ROW_BYTES {
            return Err("MySQL 결과에 32 MiB를 초과하는 행이 있습니다.".into());
        }
        let cells = values
            .iter()
            .zip(&columns)
            .map(|(value, column)| match value {
                ResultValue::Null => Ok(TypedExportValue::Null),
                ResultValue::Text(text) => Ok(TypedExportValue::Text(text)),
                ResultValue::Bytes(bytes) if column.encoding.is_some() => {
                    Ok(TypedExportValue::Binary(bytes))
                }
                ResultValue::Bytes(bytes) => std::str::from_utf8(bytes)
                    .map(TypedExportValue::Text)
                    .map_err(|_| "MySQL 결과에 UTF-8로 읽을 수 없는 텍스트가 있습니다.".into()),
            })
            .collect::<Result<Vec<_>>>()?;
        file.write_typed_row(cells, &columns, rows)?;
        rows += 1;
        progress.store(rows, Ordering::Relaxed);
    }
    Err("MySQL 내보내기를 마치기 전에 조회가 중단됐습니다.".into())
}
