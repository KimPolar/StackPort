use crate::{edit::RowBatchSource, Result};
use serde::de::{Error, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use std::collections::{HashMap, HashSet};
use std::fmt;

const COLUMNS: usize = 64;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonImportTable {
    format: &'static str,
    headers: Vec<String>,
    column_count: usize,
    column_types: Vec<Option<String>>,
    rows: Vec<Vec<Option<ImportCell>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum CellKind {
    Null,
    Text,
    Integer,
    Real,
    Number,
    Boolean,
    Json,
    Blob,
}

#[derive(Debug, Serialize)]
struct ImportCell {
    kind: CellKind,
    value: String,
}

impl ImportCell {
    fn new(kind: CellKind, value: impl Into<String>) -> Self {
        Self {
            kind,
            value: value.into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportEnvelope<'a> {
    format: String,
    version: u32,
    #[serde(borrow)]
    columns: Vec<&'a RawValue>,
    #[serde(borrow)]
    rows: Vec<&'a RawValue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PostgresColumn {
    name: String,
    data_type: String,
}

struct Properties<'a>(Vec<(String, &'a RawValue)>);

impl<'de> Deserialize<'de> for Properties<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct UniqueProperties;
        impl<'de> Visitor<'de> for UniqueProperties {
            type Value = Properties<'de>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON record with distinct properties")
            }

            fn visit_map<A: MapAccess<'de>>(
                self,
                mut reader: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                let mut names = HashSet::new();
                while let Some((key, value)) = reader.next_entry::<String, &'de RawValue>()? {
                    if entries.len() >= COLUMNS || !names.insert(key.clone()) {
                        return Err(A::Error::custom("duplicate property or too many columns"));
                    }
                    entries.push((key, value));
                }
                Ok(Properties(entries))
            }
        }
        deserializer.deserialize_map(UniqueProperties)
    }
}

pub fn parse_json_import(source: &str) -> Result<JsonImportTable> {
    let limits = RowBatchSource::File.limits();
    if source.len() > limits.bytes {
        return Err("UTF-8로 변환한 JSON을 4 MiB 이하로 줄이세요.".into());
    }
    let root: &RawValue = serde_json::from_str(source).map_err(|error| {
        format!(
            "JSON 문법을 확인하세요. {}줄 {}열",
            error.line(),
            error.column()
        )
    })?;
    match root.get().as_bytes()[0] {
        b'[' => read_records(root),
        b'{' => read_export(root),
        _ => Err("JSON 객체 배열 또는 StackPort 결과 파일을 선택하세요.".into()),
    }
}

fn check_records(total: usize) -> Result<()> {
    let limit = RowBatchSource::File.limits().rows;
    if total == 0 {
        return Err("가져올 JSON 레코드가 없습니다.".into());
    }
    if total > limit {
        return Err(format!("JSON 파일을 데이터 {limit}행 이내로 나누세요."));
    }
    Ok(())
}

fn read_records(root: &RawValue) -> Result<JsonImportTable> {
    let records: Vec<&RawValue> =
        serde_json::from_str(root.get()).map_err(|_| "JSON 객체 배열을 읽지 못했습니다.")?;
    check_records(records.len())?;

    let mut headers = Vec::new();
    let mut positions = HashMap::new();
    let mut sparse = Vec::with_capacity(records.len());
    for (index, raw) in records.into_iter().enumerate() {
        let row = index + 1;
        let Properties(fields) = serde_json::from_str::<Properties>(raw.get()).map_err(|_| {
            format!(
                "JSON {row}번째 레코드는 중복 없는 속성 이름을 가진 64열 이하의 객체여야 합니다."
            )
        })?;
        let mut cells = Vec::with_capacity(fields.len());
        for (name, raw) in fields {
            check_name(&name).map_err(|error| format!("JSON {row}번째 레코드 · {error}"))?;
            let column = match positions.get(&name) {
                Some(index) => *index,
                None => {
                    if headers.len() >= COLUMNS {
                        return Err(format!(
                            "{row}번째 레코드에서 전체 원본 열이 64개를 초과했습니다."
                        ));
                    }
                    let index = headers.len();
                    positions.insert(name.clone(), index);
                    headers.push(name);
                    index
                }
            };
            let value =
                record_cell(raw).map_err(|error| format!("JSON {row}번째 레코드 · {error}"))?;
            cells.push((column, value));
        }
        sparse.push(cells);
    }
    if headers.is_empty() {
        return Err("가져올 JSON 속성이 없습니다.".into());
    }
    let column_count = headers.len();
    let rows = sparse
        .into_iter()
        .map(|record| {
            let mut cells: Vec<_> = (0..column_count).map(|_| None).collect();
            for (column, cell) in record {
                cells[column] = Some(cell);
            }
            cells
        })
        .collect();
    Ok(JsonImportTable {
        format: "JSON 객체 배열",
        headers,
        column_count,
        column_types: vec![None; column_count],
        rows,
    })
}

fn read_export(root: &RawValue) -> Result<JsonImportTable> {
    let result: ExportEnvelope = serde_json::from_str(root.get()).map_err(|_| {
        "StackPort 결과 JSON의 열과 행을 확인하세요. 일반 JSON은 객체 배열을 사용하세요."
    })?;
    let (format, postgres) = match (result.format.as_str(), result.version) {
        ("stackport.sqlite-results", 1) => ("StackPort SQLite JSON", false),
        ("stackport.postgres-results", 1) => ("StackPort PostgreSQL JSON", true),
        _ => return Err("지원하는 StackPort 결과 JSON 버전은 1입니다.".into()),
    };
    check_records(result.rows.len())?;
    let column_count = result.columns.len();
    if !(1..=COLUMNS).contains(&column_count) {
        return Err("결과 JSON의 열 수를 1~64개로 줄이세요.".into());
    }
    let mut headers = Vec::with_capacity(column_count);
    let mut column_types = Vec::with_capacity(column_count);
    for (index, raw) in result.columns.into_iter().enumerate() {
        let invalid = || format!("결과 JSON의 {}번째 열 정의를 확인하세요.", index + 1);
        let (name, declared) = if postgres {
            let col: PostgresColumn = serde_json::from_str(raw.get()).map_err(|_| invalid())?;
            (col.name, Some(col.data_type))
        } else {
            (
                serde_json::from_str(raw.get()).map_err(|_| invalid())?,
                None,
            )
        };
        check_name(&name).map_err(|_| invalid())?;
        headers.push(name);
        column_types.push(declared);
    }
    let mut rows = Vec::with_capacity(result.rows.len());
    for (index, record) in result.rows.into_iter().enumerate() {
        let row = index + 1;
        let fields: Vec<&RawValue> = serde_json::from_str(record.get())
            .map_err(|_| format!("결과 JSON의 {row}번째 행은 배열이어야 합니다."))?;
        if fields.len() != column_count {
            return Err(format!(
                "결과 JSON의 {row}번째 행의 열 수가 열 정의와 다릅니다."
            ));
        }
        let mut values = Vec::with_capacity(column_count);
        for (column, (raw, declared)) in fields.into_iter().zip(&column_types).enumerate() {
            let cell = if let Some(declared) = declared {
                postgres_cell(raw, declared)
            } else {
                sqlite_cell(raw)
            }
            .map_err(|error| format!("결과 JSON {row}행 {}열 · {error}", column + 1))?;
            values.push(Some(cell));
        }
        rows.push(values);
    }
    Ok(JsonImportTable {
        format,
        headers,
        column_count,
        column_types,
        rows,
    })
}

fn check_name(name: &str) -> Result<()> {
    if name.contains('\0') {
        return Err("열 이름에 NUL 문자가 있습니다.".into());
    }
    Ok(())
}

fn read_string(raw: &RawValue) -> Result<String> {
    serde_json::from_str(raw.get()).map_err(|_| "유효한 JSON 문자열을 입력하세요.".into())
}

fn record_cell(raw: &RawValue) -> Result<ImportCell> {
    let value = raw.get();
    // Keep number tokens and nested objects as written, without converting through f64.
    Ok(match value.as_bytes()[0] {
        b'n' => ImportCell::new(CellKind::Null, ""),
        b'"' => ImportCell::new(CellKind::Text, read_string(raw)?),
        b'{' | b'[' => ImportCell::new(CellKind::Json, value),
        b't' | b'f' => ImportCell::new(CellKind::Boolean, value),
        _ if value.parse::<i64>().is_ok() => ImportCell::new(CellKind::Integer, value),
        _ => ImportCell::new(CellKind::Number, value),
    })
}

fn sqlite_cell(raw: &RawValue) -> Result<ImportCell> {
    if matches!(raw.get().as_bytes()[0], b'n' | b'"') {
        return record_cell(raw);
    }
    let Properties(fields) = serde_json::from_str::<Properties>(raw.get())
        .map_err(|_| "SQLite 결과의 값 형식을 확인하세요.")?;
    let [(kind, raw)] = fields.as_slice() else {
        return Err("SQLite 결과의 값 형식을 확인하세요.".into());
    };
    let value = read_string(raw)?;
    let kind = match kind.as_str() {
        "integer" if value.parse::<i64>().is_ok() => CellKind::Integer,
        "real"
            if value.parse::<f64>().is_ok_and(f64::is_finite)
                || matches!(value.as_str(), "inf" | "-inf") =>
        {
            CellKind::Real
        }
        "blob_hex" if valid_hex(&value) => CellKind::Blob,
        _ => return Err("SQLite 정수·실수 또는 BLOB 표기를 확인하세요.".into()),
    };
    Ok(ImportCell::new(kind, value))
}

fn postgres_cell(raw: &RawValue, declared: &str) -> Result<ImportCell> {
    if raw.get() == "null" {
        return Ok(ImportCell::new(CellKind::Null, ""));
    }
    let value = read_string(raw)?;
    let kind = match declared {
        "bytea" => return Ok(ImportCell::new(CellKind::Blob, pg_bytea_hex(&value)?)),
        "json" | "jsonb" => {
            serde_json::from_str::<&RawValue>(&value)
                .map_err(|_| "PostgreSQL 결과의 JSON 값을 확인하세요.")?;
            CellKind::Json
        }
        "int2" | "int4" | "int8" | "smallint" | "integer" | "bigint" => {
            value
                .parse::<i64>()
                .map_err(|_| "PostgreSQL 결과의 정수 값을 확인하세요.")?;
            CellKind::Integer
        }
        "numeric" | "decimal" | "real" | "float4" | "float8" | "double precision" => {
            CellKind::Number
        }
        "bool" | "boolean" if matches!(value.as_str(), "true" | "false" | "t" | "f") => {
            CellKind::Boolean
        }
        "bool" | "boolean" => return Err("PostgreSQL 결과의 불리언 값을 확인하세요.".into()),
        _ => CellKind::Text,
    };
    Ok(ImportCell::new(kind, value))
}

fn valid_hex(value: &str) -> bool {
    value.len() % 2 == 0 && value.bytes().all(|digit| digit.is_ascii_hexdigit())
}

pub(crate) fn decode_hex(value: &str) -> Result<Vec<u8>> {
    if !valid_hex(value) {
        return Err("BLOB의 두 자리 16진수 바이트를 확인하세요.".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "잘못된 16진수입니다.".into())
        })
        .collect()
}

pub(crate) fn hex_text(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut text = String::with_capacity(2 + bytes.len() * 2);
    text.push_str("\\x");
    for byte in bytes {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

fn pg_bytea_hex(value: &str) -> Result<String> {
    const INVALID: &str = "PostgreSQL bytea의 HEX 또는 이스케이프 표기를 확인하세요.";
    if let Some(hex) = value.strip_prefix("\\x") {
        return if valid_hex(hex) {
            Ok(hex.to_owned())
        } else {
            Err(INVALID.into())
        };
    }
    use std::fmt::Write;
    let mut hex = String::with_capacity(value.len());
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        let byte = match byte {
            b'\\' => match input.next() {
                Some(b'\\') => b'\\',
                Some(first @ b'0'..=b'3') => {
                    let second = input
                        .next()
                        .filter(|digit| matches!(digit, b'0'..=b'7'))
                        .ok_or(INVALID)?;
                    let third = input
                        .next()
                        .filter(|digit| matches!(digit, b'0'..=b'7'))
                        .ok_or(INVALID)?;
                    (first - b'0') * 64 + (second - b'0') * 8 + (third - b'0')
                }
                _ => return Err(INVALID.into()),
            },
            b' '..=b'~' => byte,
            _ => return Err(INVALID.into()),
        };
        write!(hex, "{byte:02x}").map_err(|_| INVALID)?;
    }
    Ok(hex)
}
