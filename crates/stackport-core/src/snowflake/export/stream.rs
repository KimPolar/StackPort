use super::{
    super::api::{ResultMetadata, Row, BAD_RESPONSE},
    ExportOptions, Job,
};
use crate::{
    json_import::decode_hex,
    result_export::{ExportFile, ReadyExport, TypedExportColumn, TypedExportValue},
    Result,
};
use bytes::Bytes;
use reqwest::Response;
use serde::{
    de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor},
    Deserializer as _,
};
use std::{
    fmt,
    io::{self, BufReader, Read},
    sync::{atomic::Ordering, Arc},
};
use tokio::{sync::mpsc, task::spawn_blocking};
use uuid::Uuid;

const ROW_LIMIT: usize = 32 * 1024 * 1024;
const PARTITION_LIMIT: usize = 512 * 1024 * 1024;
const ROW_TOO_LARGE: &str = "Snowflake 내보내기에서 한 행의 값이 32 MiB를 초과합니다.";

pub(super) struct RowsFile {
    file: ExportFile,
    columns: Vec<TypedExportColumn>,
    job: Arc<Job>,
    error: Option<String>,
    rows: u64,
}

impl RowsFile {
    pub(super) fn open(
        options: ExportOptions,
        columns: Vec<TypedExportColumn>,
        job: Arc<Job>,
    ) -> Result<Self> {
        let file = ExportFile::create_typed(
            &options.destination,
            options.format(),
            "stackport.snowflake-results",
            &columns,
        )?;
        Ok(Self {
            file,
            columns,
            job,
            error: None,
            rows: 0,
        })
    }

    fn write(&mut self, row: Row) -> Result<()> {
        self.job.check()?;
        let binaries = row
            .iter()
            .zip(&self.columns)
            .map(|(value, column)| {
                if column.encoding == Some("hex") {
                    value
                        .as_deref()
                        .map(|hex| decode_hex(hex).map_err(|_| BAD_RESPONSE.to_owned()))
                        .transpose()
                } else {
                    Ok(None)
                }
            })
            .collect::<Result<Vec<_>>>()?;
        let values = row
            .iter()
            .zip(&binaries)
            .map(|(value, binary)| match (value, binary) {
                (_, Some(bytes)) => TypedExportValue::Binary(bytes),
                (Some(text), None) => TypedExportValue::Text(text),
                (None, None) => TypedExportValue::Null,
            });
        self.file
            .write_typed_row(values, &self.columns, self.rows)?;
        self.rows = self.rows.checked_add(1).ok_or(BAD_RESPONSE)?;
        self.job.rows.store(self.rows, Ordering::Relaxed);
        Ok(())
    }

    pub(super) fn finish(self) -> Result<(ReadyExport, u64)> {
        Ok((self.file.finish()?, self.rows))
    }
}

#[derive(Default)]
pub(super) struct PartitionInfo {
    pub(super) handle: Option<Uuid>,
    pub(super) metadata: Option<ResultMetadata>,
    pub(super) rows: usize,
}

pub(super) async fn download(
    mut response: Response,
    mut writer: RowsFile,
    job: &Job,
) -> Result<(PartitionInfo, RowsFile)> {
    let (sender, receiver) = mpsc::channel(2);
    let parser = spawn_blocking(move || {
        let reader = BufReader::new(ChunkReader {
            receiver,
            chunk: Bytes::new(),
        });
        let mut json = serde_json::Deserializer::from_reader(reader);
        let info = json
            .deserialize_map(PartitionVisitor(&mut writer))
            .and_then(|info| {
                json.end()?;
                Ok(info)
            })
            .map_err(|_| writer.error.take().unwrap_or_else(|| BAD_RESPONSE.into()))?;
        Ok::<_, String>((info, writer))
    });
    let transferred = job
        .during(async {
            let mut received = 0;
            while let Some(chunk) = response.chunk().await.map_err(|_| BAD_RESPONSE)? {
                if chunk.len() > PARTITION_LIMIT - received {
                    return Err("Snowflake 응답 파티션이 512 MiB를 초과합니다.".into());
                }
                received += chunk.len();
                if sender.send(chunk).await.is_err() {
                    break;
                }
            }
            Ok(())
        })
        .await;
    drop(sender);
    let parsed = parser
        .await
        .map_err(|_| "Snowflake 응답을 파일에 기록할 수 없습니다.")?;
    transferred?;
    parsed
}

struct ChunkReader {
    receiver: mpsc::Receiver<Bytes>,
    chunk: Bytes,
}

impl Read for ChunkReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        while self.chunk.is_empty() {
            let Some(chunk) = self.receiver.blocking_recv() else {
                return Ok(0);
            };
            self.chunk = chunk;
        }
        let count = self.chunk.len().min(buffer.len());
        buffer[..count].copy_from_slice(&self.chunk.split_to(count));
        Ok(count)
    }
}

struct PartitionVisitor<'a>(&'a mut RowsFile);

impl<'de> Visitor<'de> for PartitionVisitor<'_> {
    type Value = PartitionInfo;

    fn expecting(&self, fmt: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt.write_str("a Snowflake result partition")
    }

    fn visit_map<M: MapAccess<'de>>(
        self,
        mut map: M,
    ) -> std::result::Result<PartitionInfo, M::Error> {
        let mut result = PartitionInfo::default();
        let mut data_seen = false;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "statementHandle" if result.handle.is_none() => {
                    result.handle = Some(map.next_value()?)
                }
                "resultSetMetaData" if result.metadata.is_none() => {
                    result.metadata = Some(map.next_value()?)
                }
                "data" if !data_seen => {
                    result.rows = map.next_value_seed(RowsVisitor(&mut *self.0))?;
                    data_seen = true;
                }
                "statementHandle" | "resultSetMetaData" | "data" => {
                    return Err(de::Error::custom(BAD_RESPONSE))
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(result)
    }
}

struct RowsVisitor<'a>(&'a mut RowsFile);

impl<'de> DeserializeSeed<'de> for RowsVisitor<'_> {
    type Value = usize;

    fn deserialize<D: de::Deserializer<'de>>(
        self,
        json: D,
    ) -> std::result::Result<usize, D::Error> {
        json.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for RowsVisitor<'_> {
    type Value = usize;

    fn expecting(&self, fmt: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt.write_str("a sequence of Snowflake rows")
    }

    fn visit_unit<E: de::Error>(self) -> std::result::Result<usize, E> {
        Ok(0)
    }

    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> std::result::Result<usize, S::Error> {
        let mut rows = 0_usize;
        let writer = self.0;
        while let Some(row) = seq.next_element_seed(RowVisitor {
            columns: &writer.columns,
            failure: &mut writer.error,
        })? {
            if let Err(error) = writer.write(row) {
                writer.error = Some(error);
                return Err(de::Error::custom(BAD_RESPONSE));
            }
            rows = rows
                .checked_add(1)
                .ok_or_else(|| de::Error::custom(BAD_RESPONSE))?;
        }
        Ok(rows)
    }
}

struct RowVisitor<'a> {
    columns: &'a [TypedExportColumn],
    failure: &'a mut Option<String>,
}

impl<'de> DeserializeSeed<'de> for RowVisitor<'_> {
    type Value = Row;

    fn deserialize<D: de::Deserializer<'de>>(self, json: D) -> std::result::Result<Row, D::Error> {
        json.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for RowVisitor<'_> {
    type Value = Row;

    fn expecting(&self, fmt: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt.write_str("a Snowflake result row")
    }

    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> std::result::Result<Row, S::Error> {
        let mut row = Vec::with_capacity(self.columns.len());
        let mut remaining = ROW_LIMIT;
        for column in self.columns {
            let value = seq
                .next_element::<Option<String>>()?
                .ok_or_else(|| de::Error::custom(BAD_RESPONSE))?;
            if let Some(value) = &value {
                let bytes = if column.encoding == Some("hex") {
                    value.len() / 2
                } else {
                    value.len()
                };
                let Some(left) = remaining.checked_sub(bytes) else {
                    *self.failure = Some(ROW_TOO_LARGE.into());
                    return Err(de::Error::custom(BAD_RESPONSE));
                };
                remaining = left;
            }
            row.push(value);
        }
        if seq.next_element::<IgnoredAny>()?.is_some() {
            return Err(de::Error::custom(BAD_RESPONSE));
        }
        Ok(row)
    }
}
