use super::{
    catalog,
    session::{field, pg_error, VALUE_LENGTH},
};
use crate::{
    local_file::NewFile,
    png_preview::{png_for_display, PNG_LIMIT},
    quote_identifier, Result,
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio_postgres::{
    types::{ToSql, Type},
    Row, Transaction,
};

const PREVIEW_SIZE: i32 = 4096;
const SAVE_SIZE: i32 = 64 * 1024;
const STRUCTURE_LIMIT: usize = 256 * 1024;
const STALE: &str = "행이 변경되었거나 조회 권한이 달라졌습니다. 그리드를 다시 조회하세요.";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ValueKind {
    Text,
    Json,
    Xml,
    Binary,
}

impl ValueKind {
    pub(super) fn for_type(oid: i64) -> Option<Self> {
        let oid = u32::try_from(oid).ok()?;
        if oid == Type::BYTEA.oid() {
            return Some(Self::Binary);
        }
        if oid == Type::JSON.oid() || oid == Type::JSONB.oid() {
            return Some(Self::Json);
        }
        if oid == Type::XML.oid() {
            return Some(Self::Xml);
        }
        [Type::TEXT, Type::VARCHAR]
            .iter()
            .any(|kind| kind.oid() == oid)
            .then_some(Self::Text)
    }

    pub(super) fn grid_preview(self, column: &str) -> String {
        match self {
            Self::Binary => {
                let shown = (VALUE_LENGTH - 2) / 2;
                // The extra character marks truncation and is removed by the grid preview.
                format!("pg_catalog.chr(92) || 'x' || pg_catalog.encode(pg_catalog.substr({column}, 1, {shown}), 'hex') ||
                    CASE WHEN pg_catalog.octet_length({column}) > {shown} THEN '0' ELSE '' END")
            }
            Self::Text | Self::Json | Self::Xml => grid_text(column),
        }
    }

    fn expression(self, column: &str) -> String {
        match self {
            Self::Text | Self::Json | Self::Xml => format!("{column}::pg_catalog.text"),
            Self::Binary => column.to_owned(),
        }
    }

    fn length(self, expression: &str) -> String {
        let function = match self {
            Self::Text | Self::Json | Self::Xml => "char_length",
            Self::Binary => "octet_length",
        };
        format!("pg_catalog.{function}({expression})")
    }
}

pub(super) fn grid_text(column: &str) -> String {
    format!(
        "pg_catalog.left({column}::pg_catalog.text, {})",
        VALUE_LENGTH + 1
    )
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PostgresValueRow {
    tuple: String,
    version: String,
    command: String,
}

impl PostgresValueRow {
    pub(super) const PROJECTION: &str =
        "ctid::pg_catalog.text, xmin::pg_catalog.text, cmin::pg_catalog.text";
    pub(super) const FIELD_COUNT: usize = 3;

    pub(super) fn from_row(row: &Row, index: usize) -> Result<Self> {
        Ok(Self {
            tuple: field(row, index)?,
            version: field(row, index + 1)?,
            command: field(row, index + 2)?,
        })
    }

    fn valid(&self) -> bool {
        self.tuple.len() <= 32
            && !self.tuple.contains('\0')
            && self.version.parse::<u32>().is_ok()
            && self.command.parse::<u32>().is_ok()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresValueTarget {
    object: i64,
    column: String,
    row: PostgresValueRow,
}

#[derive(Serialize)]
pub struct PostgresValuePage {
    offset: i32,
    total_units: i32,
    has_next: bool,
    #[serde(flatten)]
    content: ValueContent,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ValueContent {
    Text { text: String },
    Binary { bytes: Vec<u8> },
}

impl ValueContent {
    fn from_row(kind: ValueKind, row: &Row, index: usize) -> Result<Self> {
        let null = "이 셀의 값이 NULL입니다.";
        Ok(match kind {
            ValueKind::Text | ValueKind::Json | ValueKind::Xml => Self::Text {
                text: field::<Option<String>>(row, index)?.ok_or(null)?,
            },
            ValueKind::Binary => Self::Binary {
                bytes: field::<Option<Vec<u8>>>(row, index)?.ok_or(null)?,
            },
        })
    }

    fn units(&self) -> usize {
        match self {
            Self::Text { text } => text.chars().count(),
            Self::Binary { bytes } => bytes.len(),
        }
    }

    fn into_bytes(self) -> Vec<u8> {
        match self {
            Self::Text { text } => text.into_bytes(),
            Self::Binary { bytes } => bytes,
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PostgresValueRepresentation {
    Json { text: String },
    Xml { text: String },
    Png { base64: String },
}

#[derive(Serialize)]
pub struct PostgresValueSave {
    pub(super) size_bytes: u64,
    pub(super) audit_warning: bool,
}

pub(super) async fn supports_row(tx: &Transaction<'_>, object: i64, kind: &str) -> Result<bool> {
    if kind != "table" {
        return Ok(false);
    }
    let row = tx.query_one(
        "SELECT EXISTS (SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_am a ON a.oid = c.relam
         WHERE c.oid::bigint = $1 AND c.relkind = 'r' AND a.amname = 'heap'
           AND NOT EXISTS (SELECT FROM pg_catalog.pg_inherits WHERE inhparent = c.oid))", &[&object],
    ).await.map_err(pg_error)?;
    field(&row, 0)
}

struct CellTarget {
    kind: ValueKind,
    expression: String,
    from: String,
}

impl CellTarget {
    async fn resolve(tx: &Transaction<'_>, target: &PostgresValueTarget) -> Result<Self> {
        if target.object <= 0
            || target.column.is_empty()
            || target.column.len() > 1024
            || target.column.contains('\0')
            || !target.row.valid()
        {
            return Err("조회할 셀을 확인하세요.".into());
        }
        let catalog::Relation { schema, name, kind } = catalog::relation(tx, target.object).await?;
        if !supports_row(tx, target.object, kind).await? {
            return Err("이 객체의 셀은 그리드에서 원본을 열 수 없습니다.".into());
        }
        let row = tx.query_opt(
            "SELECT atttypid::bigint FROM pg_catalog.pg_attribute
             WHERE attrelid::bigint = $1 AND attname::text = $2 AND attnum > 0 AND NOT attisdropped",
            &[&target.object, &target.column],
        ).await.map_err(pg_error)?.ok_or("조회할 열을 찾을 수 없습니다.")?;
        let kind =
            ValueKind::for_type(field(&row, 0)?).ok_or("이 열의 원본 형식을 지원하지 않습니다.")?;
        let expression = kind.expression(&format!("t.{}", quote_identifier(&target.column)));
        let from = format!("FROM ONLY {}.{} t WHERE t.ctid = $1::pg_catalog.text::pg_catalog.tid
            AND t.xmin::pg_catalog.text = $2 AND t.cmin::pg_catalog.text = $3 AND t.tableoid::bigint = $4",
            quote_identifier(&schema), quote_identifier(&name));
        Ok(Self {
            kind,
            expression,
            from,
        })
    }

    fn range(&self) -> String {
        format!("pg_catalog.substr({}, $5::int, $6::int)", self.expression)
    }
}

impl PostgresValueTarget {
    fn parameters(&self) -> [&(dyn ToSql + Sync); 4] {
        [
            &self.row.tuple,
            &self.row.version,
            &self.row.command,
            &self.object,
        ]
    }

    fn range_parameters<'a>(
        &'a self,
        offset: &'a i32,
        count: &'a i32,
    ) -> [&'a (dyn ToSql + Sync); 6] {
        [
            &self.row.tuple,
            &self.row.version,
            &self.row.command,
            &self.object,
            offset,
            count,
        ]
    }
}

pub(super) async fn preview(
    tx: &Transaction<'_>,
    target: &PostgresValueTarget,
    page: u32,
) -> Result<PostgresValuePage> {
    let offset = i32::try_from(i64::from(page) * i64::from(PREVIEW_SIZE))
        .map_err(|_| "값 페이지 범위를 확인하세요.")?;
    let start = offset
        .checked_add(1)
        .ok_or("값 페이지 범위를 확인하세요.")?;
    let cell = CellTarget::resolve(tx, target).await?;
    let sql = format!(
        "SELECT {}, {} {}",
        cell.kind.length(&cell.expression),
        cell.range(),
        cell.from
    );
    let row = tx
        .query_opt(&sql, &target.range_parameters(&start, &PREVIEW_SIZE))
        .await
        .map_err(pg_error)?
        .ok_or(STALE)?;
    let total_units: i32 = field::<Option<i32>>(&row, 0)?.ok_or("이 셀의 값이 NULL입니다.")?;
    if page != 0 && offset >= total_units {
        return Err("값 페이지 범위를 확인하세요.".into());
    }
    let content = ValueContent::from_row(cell.kind, &row, 1)?;
    let has_next = i64::from(offset) + i64::from(PREVIEW_SIZE) < i64::from(total_units);
    Ok(PostgresValuePage {
        offset,
        total_units,
        has_next,
        content,
    })
}

pub(super) async fn representation(
    tx: &Transaction<'_>,
    target: &PostgresValueTarget,
) -> Result<PostgresValueRepresentation> {
    let cell = CellTarget::resolve(tx, target).await?;
    let (limit, too_large) = match cell.kind {
        ValueKind::Json | ValueKind::Xml => (
            STRUCTURE_LIMIT,
            "구조 보기는 최대 256 KiB까지 지원합니다. 원문 페이지에서 계속 볼 수 있습니다.",
        ),
        ValueKind::Binary => (
            PNG_LIMIT,
            "PNG 미리보기는 최대 1 MiB까지 지원합니다. HEX 페이지에서 계속 볼 수 있습니다.",
        ),
        ValueKind::Text => return Err("이 셀은 원문 텍스트로 확인할 수 있습니다.".into()),
    };
    let expression = &cell.expression;
    let sql = format!(
        "SELECT CASE WHEN pg_catalog.octet_length({expression}) <= {limit} THEN {expression} END,
            {expression} IS NULL {}",
        cell.from
    );
    let row = tx
        .query_opt(&sql, &target.parameters())
        .await
        .map_err(pg_error)?
        .ok_or(STALE)?;
    if field(&row, 1)? {
        return Err("이 셀의 값이 NULL입니다.".into());
    }
    match cell.kind {
        ValueKind::Binary => {
            let bytes = field::<Option<Vec<u8>>>(&row, 0)?.ok_or(too_large)?;
            let base64 = png_for_display(&bytes, bytes.len() as u64)
                .ok_or("지원되는 정적 PNG를 열 수 없습니다. HEX 페이지에서 값을 확인하세요.")?;
            Ok(PostgresValueRepresentation::Png { base64 })
        }
        kind => {
            let text = field::<Option<String>>(&row, 0)?
                .filter(|text| text.len() <= limit)
                .ok_or(too_large)?;
            if matches!(kind, ValueKind::Json) {
                Ok(PostgresValueRepresentation::Json { text })
            } else {
                Ok(PostgresValueRepresentation::Xml { text })
            }
        }
    }
}

pub(super) async fn stage(
    tx: &Transaction<'_>,
    target: &PostgresValueTarget,
    destination: String,
) -> Result<(NewFile, u64)> {
    let cell = CellTarget::resolve(tx, target).await?;
    let size_sql = format!(
        "SELECT {} {}",
        cell.kind.length(&cell.expression),
        cell.from
    );
    let row = tx
        .query_opt(&size_sql, &target.parameters())
        .await
        .map_err(pg_error)?
        .ok_or(STALE)?;
    let total: i32 = field::<Option<i32>>(&row, 0)?.ok_or("이 셀의 값이 NULL입니다.")?;
    let (file, writer) = tokio::task::spawn_blocking(move || {
        let file = NewFile::stage(&destination, None, ".stackport-postgres-value-")?;
        let writer = file.writer()?;
        Ok::<_, String>((file, writer))
    })
    .await
    .map_err(|_| "값을 저장할 임시 파일을 열 수 없습니다.")??;
    let mut writer = tokio::fs::File::from_std(writer);
    let statement = tx
        .prepare(&format!("SELECT {} {}", cell.range(), cell.from))
        .await
        .map_err(pg_error)?;
    let mut offset = 0;
    let mut bytes_written = 0_u64;
    while offset < total {
        let count = (total - offset).min(SAVE_SIZE);
        let row = tx
            .query_opt(&statement, &target.range_parameters(&(offset + 1), &count))
            .await
            .map_err(pg_error)?
            .ok_or(STALE)?;
        let content = ValueContent::from_row(cell.kind, &row, 0)?;
        if content.units() != count as usize {
            return Err("서버에서 셀의 전체 값을 읽을 수 없습니다.".into());
        }
        let bytes = content.into_bytes();
        writer
            .write_all(&bytes)
            .await
            .map_err(|error| format!("값을 기록할 수 없습니다: {error}"))?;
        bytes_written += bytes.len() as u64;
        offset += count;
    }
    writer
        .flush()
        .await
        .map_err(|error| format!("값을 기록할 수 없습니다: {error}"))?;
    Ok((file, bytes_written))
}
