use super::{Failure, Job};
use crate::oracle::export::read_lob_chunk;
use oracledb::{
    Connection, Cursor, Error, FromDbValue, Lob, Metadata, OracleIntervalDS, OracleIntervalYM,
    OracleNumber, OracleTimestamp, Row, DB_TYPE_BINARY_DOUBLE, DB_TYPE_BINARY_FLOAT, DB_TYPE_BLOB,
    DB_TYPE_BOOLEAN, DB_TYPE_CHAR, DB_TYPE_CLOB, DB_TYPE_DATE, DB_TYPE_INTERVAL_DS,
    DB_TYPE_INTERVAL_YM, DB_TYPE_LONG, DB_TYPE_LONG_NVARCHAR, DB_TYPE_LONG_RAW, DB_TYPE_NCHAR,
    DB_TYPE_NCLOB, DB_TYPE_NUMBER, DB_TYPE_NVARCHAR, DB_TYPE_RAW, DB_TYPE_ROWID, DB_TYPE_TIMESTAMP,
    DB_TYPE_TIMESTAMP_LTZ, DB_TYPE_TIMESTAMP_TZ, DB_TYPE_UROWID, DB_TYPE_VARCHAR,
};
use serde::Serialize;
use std::{
    fmt::{Display, Write},
    io,
};

pub(super) const PREVIEW_BYTES: usize = 1024 * 1024;
const MAX_ROWS: usize = 100;
const MAX_COLUMNS: usize = 128;
const MAX_TEXT_BYTES: usize = 2048;
const MAX_RAW_BYTES: usize = 1024;

#[derive(Serialize)]
pub(super) struct ResultSet {
    columns: Vec<ResultColumn>,
    rows: Vec<Vec<Option<Cell>>>,
    rows_received: u64,
    more_columns: bool,
}

#[derive(Serialize)]
struct ResultColumn {
    name: String,
    data_type: String,
}

#[derive(Serialize)]
struct Cell {
    text: String,
    encoding: &'static str,
    bytes: Option<usize>,
    truncated: bool,
}

pub(super) fn read(
    connection: &Connection,
    mut cursor: Cursor,
    job: &Job,
    budget: &mut usize,
) -> Result<ResultSet, Failure> {
    let metadata = cursor
        .columns()
        .iter()
        .take(MAX_COLUMNS)
        .cloned()
        .collect::<Vec<_>>();
    let mut results = ResultSet {
        columns: metadata
            .iter()
            .map(|column| ResultColumn {
                name: column.name().to_owned(),
                data_type: column.data_type(),
            })
            .collect(),
        rows: Vec::new(),
        rows_received: 0,
        more_columns: cursor.columns().len() > MAX_COLUMNS,
    };
    loop {
        job.prepare_call(connection)?;
        let Some(row) = cursor.next() else { break };
        let mut row = row?;
        results.rows_received += 1;
        if results.rows.len() == MAX_ROWS || *budget == 0 {
            continue;
        }
        let cells = metadata
            .iter()
            .enumerate()
            .map(|(position, column)| cell(&mut row, position, column, connection, job))
            .collect::<Result<Vec<_>, _>>()?;
        let size = cells
            .iter()
            .map(|cell| 32 + cell.as_ref().map_or(0, |cell| cell.text.len()))
            .sum::<usize>();
        if size > *budget {
            *budget = 0;
            continue;
        }
        *budget -= size;
        results.rows.push(cells);
    }
    Ok(results)
}

fn cell(
    row: &mut Row,
    index: usize,
    column: &Metadata,
    connection: &Connection,
    job: &Job,
) -> Result<Option<Cell>, Failure> {
    let value = match column.db_type() {
        DB_TYPE_NUMBER => formatted::<OracleNumber>(row, index)?,
        DB_TYPE_BINARY_FLOAT => formatted::<f32>(row, index)?,
        DB_TYPE_BINARY_DOUBLE => formatted::<f64>(row, index)?,
        DB_TYPE_BOOLEAN => formatted::<bool>(row, index)?,
        DB_TYPE_DATE | DB_TYPE_TIMESTAMP | DB_TYPE_TIMESTAMP_TZ | DB_TYPE_TIMESTAMP_LTZ => {
            formatted::<OracleTimestamp>(row, index)?
        }
        DB_TYPE_INTERVAL_DS => formatted::<OracleIntervalDS>(row, index)?,
        DB_TYPE_INTERVAL_YM => formatted::<OracleIntervalYM>(row, index)?,
        DB_TYPE_RAW | DB_TYPE_LONG_RAW => row
            .get::<Option<&[u8]>>(index)?
            .map(|value| raw(value, value.len())),
        DB_TYPE_CHAR
        | DB_TYPE_NCHAR
        | DB_TYPE_VARCHAR
        | DB_TYPE_NVARCHAR
        | DB_TYPE_LONG
        | DB_TYPE_LONG_NVARCHAR
        | DB_TYPE_ROWID
        | DB_TYPE_UROWID => row.get::<Option<&str>>(index)?.map(text),
        DB_TYPE_CLOB | DB_TYPE_NCLOB | DB_TYPE_BLOB => {
            let Some(lob) = row.take::<Option<Lob>>(index)? else {
                return Ok(None);
            };
            job.prepare_call(connection)?;
            Some(lob_cell(lob, column.db_type() == DB_TYPE_BLOB)?)
        }
        _ => Some(text(&format!("[{} 미리보기 미지원]", column.data_type()))),
    };
    Ok(value)
}

fn formatted<T: for<'a> FromDbValue<'a> + Display>(
    row: &Row,
    index: usize,
) -> Result<Option<Cell>, Error> {
    Ok(row
        .get::<Option<T>>(index)?
        .map(|value| text(&value.to_string())))
}

fn lob_cell(mut lob: Lob, binary: bool) -> Result<Cell, Failure> {
    if binary {
        let mut buffer = [0; MAX_RAW_BYTES + 1];
        let length = read_lob_chunk(&mut lob, &mut buffer).map_err(lob_error)?;
        return Ok(raw(&buffer[..length], lob.get_size()?));
    }
    // Reserve enough UTF-16 units to determine whether the UTF-8 preview truncates.
    let mut buffer = [0; (MAX_TEXT_BYTES + 4) * 3];
    let length = read_lob_chunk(&mut lob, &mut buffer).map_err(lob_error)?;
    let value = std::str::from_utf8(&buffer[..length])
        .map_err(|_| Failure::Value("Oracle 텍스트의 UTF-8 인코딩을 읽을 수 없습니다.".into()))?;
    let mut cell = text(value);
    if cell.truncated {
        cell.bytes = None;
    }
    Ok(cell)
}

fn lob_error(error: io::Error) -> Failure {
    error
        .into_inner()
        .and_then(|source| source.downcast::<Error>().ok())
        .map(|error| Failure::Driver(*error))
        .unwrap_or_else(|| {
            Failure::Value("Oracle의 큰 텍스트 또는 바이너리 값을 읽을 수 없습니다.".into())
        })
}

pub(super) fn limited_text(value: &str) -> String {
    value[..value.floor_char_boundary(MAX_TEXT_BYTES.min(value.len()))].to_owned()
}

fn text(value: &str) -> Cell {
    let preview = limited_text(value);
    Cell {
        truncated: preview.len() < value.len(),
        text: preview,
        encoding: "utf8",
        bytes: Some(value.len()),
    }
}

fn raw(value: &[u8], original_size: usize) -> Cell {
    let preview = &value[..value.len().min(MAX_RAW_BYTES)];
    let mut text = String::with_capacity(preview.len() * 2);
    for byte in preview {
        let _ = write!(text, "{byte:02X}");
    }
    Cell {
        text,
        encoding: "hex",
        bytes: Some(original_size),
        truncated: preview.len() < original_size,
    }
}
