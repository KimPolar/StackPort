use super::parameters::{type_label, Value};
use crate::{
    result_export::{ExportFile, ExportFormat, ReadyExport, TypedExportColumn, TypedExportValue},
    Result,
};
use futures_util::TryStreamExt;
use serde::Deserialize;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::{spawn_blocking, JoinHandle},
};
use tokio_postgres::{
    types::{Kind, Type},
    Error, Row, Statement, Transaction,
};

pub(super) const EXPORT_TIMEOUT: Duration = Duration::from_secs(300);
pub(super) const MAX_ROW_BYTES: usize = 32 * 1024 * 1024;
const INVALID_ROW: &str = "PostgreSQL 결과 행을 UTF-8로 읽을 수 없습니다.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresExportOptions {
    destination: String,
    format: Format,
    include_header: bool,
    spreadsheet_safe: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Format {
    Csv,
    Json,
}

impl PostgresExportOptions {
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

pub(super) fn columns(statement: &Statement) -> Vec<TypedExportColumn> {
    statement
        .columns()
        .iter()
        .map(|column| TypedExportColumn {
            name: column.name().into(),
            data_type: type_label(column.type_()),
            numeric: numeric(column.type_()),
            encoding: None,
        })
        .collect()
}

fn numeric(ty: &Type) -> bool {
    if let Kind::Domain(base) = ty.kind() {
        return numeric(base);
    }
    [
        Type::INT2,
        Type::INT4,
        Type::INT8,
        Type::FLOAT4,
        Type::FLOAT8,
        Type::NUMERIC,
        Type::OID,
    ]
    .contains(ty)
}

pub(super) struct Writer {
    sender: mpsc::Sender<Message>,
    work: JoinHandle<Result<Option<(ReadyExport, u64)>>>,
}

enum Message {
    Row(Row),
    Finish,
}

impl Writer {
    pub(super) async fn open(
        options: &PostgresExportOptions,
        columns: Vec<TypedExportColumn>,
        progress: Arc<AtomicU64>,
    ) -> Result<Self> {
        let destination = options.destination.clone();
        let format = options.format();
        let (file, columns) = spawn_blocking(move || {
            let file = ExportFile::create_typed(
                &destination,
                format,
                "stackport.postgres-results",
                &columns,
            )?;
            Ok::<_, String>((file, columns))
        })
        .await
        .map_err(|_| "PostgreSQL 내보내기 파일을 열 수 없습니다.")??;
        let (sender, mut receiver) = mpsc::channel(2);
        let work = spawn_blocking(move || {
            let mut file = file;
            let mut rows = 0;
            while let Some(message) = receiver.blocking_recv() {
                let row = match message {
                    Message::Row(row) => row,
                    Message::Finish => return file.finish().map(|file| Some((file, rows))),
                };
                let values = (0..columns.len())
                    .map(|index| {
                        row.try_get::<_, Option<&str>>(index)
                            .map_err(|_| INVALID_ROW.into())
                    })
                    .collect::<Result<Vec<_>>>()?;
                let bytes = values
                    .iter()
                    .flatten()
                    .map(|value| value.len())
                    .sum::<usize>();
                if bytes > MAX_ROW_BYTES {
                    return Err("PostgreSQL 결과에 32 MiB를 초과하는 행이 있습니다.".into());
                }
                file.write_typed_row(
                    values
                        .into_iter()
                        .map(|value| value.map_or(TypedExportValue::Null, TypedExportValue::Text)),
                    &columns,
                    rows,
                )?;
                rows += 1;
                progress.store(rows, Ordering::Relaxed);
            }
            Ok(None)
        });
        Ok(Self { sender, work })
    }

    pub(super) async fn finish(self, complete: bool) -> Result<Option<(ReadyExport, u64)>> {
        if complete {
            let _ = self.sender.send(Message::Finish).await;
        }
        drop(self.sender);
        self.work
            .await
            .map_err(|_| "PostgreSQL 내보내기 파일을 마무리할 수 없습니다.")?
    }

    pub(super) async fn stream(
        &self,
        transaction: &Transaction<'_>,
        statement: &Statement,
        values: &[Value],
        cancelled: watch::Receiver<bool>,
    ) -> std::result::Result<bool, StreamError> {
        if *cancelled.borrow() {
            return Ok(false);
        }
        let portal = transaction
            .bind_raw(statement, values.iter())
            .await
            .map_err(StreamError::Bind)?;
        if *cancelled.borrow() {
            return Ok(false);
        }
        let rows = transaction
            .query_portal_raw(&portal, 0)
            .await
            .map_err(StreamError::Query)?;
        let mut rows = std::pin::pin!(rows);
        while let Some(row) = rows.as_mut().try_next().await.map_err(StreamError::Query)? {
            if !*cancelled.borrow() {
                self.sender
                    .send(Message::Row(row))
                    .await
                    .map_err(|_| StreamError::WriterClosed)?;
            }
        }
        Ok(!*cancelled.borrow())
    }
}

pub(super) enum StreamError {
    Bind(Error),
    Query(Error),
    WriterClosed,
}
