use super::{Column, WireValue};
use crate::{
    postgres::export::MAX_ROW_BYTES,
    result_export::{JsonResultBatch, JsonResultCell, ReadyExport},
    Result,
};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::{
    sync::{mpsc, oneshot},
    task::{spawn_blocking, JoinHandle},
};
use tokio_postgres::{Row, SimpleQueryRow};

const FORMAT: &str = "stackport.postgres-script-results";
const INVALID_ROW: &str = "PostgreSQL 스크립트 결과의 행을 읽을 수 없습니다.";
const LARGE_ROW: &str = "PostgreSQL 스크립트 결과에 32 MiB를 초과하는 행이 있습니다.";

pub(in crate::postgres) struct Writer {
    sender: mpsc::Sender<Message>,
    work: JoinHandle<Result<Option<(ReadyExport, u64)>>>,
}

pub(super) enum Message {
    Start(u32, Vec<Column>),
    Text(SimpleQueryRow),
    Bound(Row),
    End(Option<u64>, oneshot::Sender<()>),
    Finish,
}

impl Writer {
    pub(in crate::postgres) async fn open(
        destination: String,
        progress: Arc<AtomicU64>,
    ) -> Result<Self> {
        let batch = spawn_blocking(move || JsonResultBatch::open(&destination, FORMAT))
            .await
            .map_err(|_| "스크립트 결과 파일을 열 수 없습니다.")??;
        let (sender, receiver) = mpsc::channel(2);
        let work = spawn_blocking(move || write_batch(batch, receiver, progress));
        Ok(Self { sender, work })
    }

    pub(super) async fn send(&self, message: Message) {
        // Drain a statement that already reached the server even if the file sink has failed.
        let _ = self.sender.send(message).await;
    }

    pub(super) async fn end(&self, affected_rows: Option<u64>) -> bool {
        let (signal, flushed) = oneshot::channel();
        self.send(Message::End(affected_rows, signal)).await;
        flushed.await.is_ok()
    }

    pub(in crate::postgres) async fn finish(
        self,
        complete: bool,
    ) -> Result<Option<(ReadyExport, u64)>> {
        if complete {
            self.send(Message::Finish).await;
        }
        drop(self.sender);
        self.work
            .await
            .map_err(|_| "스크립트 결과 파일을 마무리할 수 없습니다.")?
    }
}

fn write_batch(
    mut batch: JsonResultBatch,
    mut receiver: mpsc::Receiver<Message>,
    progress: Arc<AtomicU64>,
) -> Result<Option<(ReadyExport, u64)>> {
    while let Some(message) = receiver.blocking_recv() {
        match message {
            Message::Start(line, columns) => batch.start(line, &columns)?,
            Message::Text(row) => {
                let values = (0..row.len())
                    .map(|index| row.try_get(index).map_err(|_| INVALID_ROW.into()))
                    .collect::<Result<Vec<_>>>()?;
                if values
                    .iter()
                    .flatten()
                    .map(|value| value.len())
                    .sum::<usize>()
                    > MAX_ROW_BYTES
                {
                    return Err(LARGE_ROW.into());
                }
                let rows = batch.row(
                    values
                        .into_iter()
                        .map(|value| Ok(value.map(|text| JsonResultCell::Text(text.into())))),
                )?;
                progress.store(rows, Ordering::Relaxed);
            }
            Message::Bound(row) => {
                if row.raw_size_bytes() > MAX_ROW_BYTES {
                    return Err(LARGE_ROW.into());
                }
                let values = row.columns().iter().enumerate().map(|(index, column)| {
                    let value: Option<WireValue<'_>> =
                        row.try_get(index).map_err(|_| INVALID_ROW)?;
                    Ok(value.map(|value| value.export(column.type_())))
                });
                let rows = batch.row(values)?;
                progress.store(rows, Ordering::Relaxed);
            }
            Message::End(affected_rows, flushed) => {
                batch.end(affected_rows)?;
                let _ = flushed.send(());
            }
            Message::Finish => return batch.finish().map(Some),
        }
    }
    Ok(None)
}
