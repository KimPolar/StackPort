use super::{display_cell, read_transaction, Action, Plan};
use crate::postgres::edit::{
    cast_input, cell, field, pg_error, query, PostgresCellChange, PostgresEditInput, VALUE_LIMIT,
};
use crate::{
    edit::{RowPastePreview, PASTE_BYTES, PASTE_COLUMNS, PASTE_ROWS},
    quote_identifier as quote, Result,
};
use bytes::BytesMut;
use std::{
    collections::{HashMap, HashSet},
    fmt,
};
use tokio_postgres::{
    types::{to_sql_checked, FromSql, IsNull, ToSql, Type},
    Client, Transaction,
};
use uuid::Uuid;
use zeroize::Zeroizing;

type SqlError = Box<dyn std::error::Error + Sync + Send>;

struct ServerValue {
    oid: u32,
    bytes: Zeroizing<Vec<u8>>,
}

impl fmt::Debug for ServerValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ServerValue(<redacted>)")
    }
}

impl<'a> FromSql<'a> for ServerValue {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> std::result::Result<Self, SqlError> {
        Ok(Self {
            oid: ty.oid(),
            bytes: Zeroizing::new(raw.to_vec()),
        })
    }

    fn accepts(_: &Type) -> bool {
        true
    }
}

impl ToSql for ServerValue {
    fn to_sql(&self, ty: &Type, output: &mut BytesMut) -> std::result::Result<IsNull, SqlError> {
        if self.oid != ty.oid() {
            return Err("미리보기 이후 입력 타입이 변경되었습니다.".into());
        }
        output.extend_from_slice(&self.bytes);
        Ok(IsNull::No)
    }

    fn accepts(_: &Type) -> bool {
        true
    }

    to_sql_checked!();
}

enum PasteCell {
    Default,
    Null,
    Value(ServerValue),
}

pub(super) struct PasteRows {
    columns: Vec<String>,
    rows: Vec<Vec<PasteCell>>,
}

impl PasteRows {
    pub(super) fn count(&self) -> usize {
        self.rows.len()
    }
}

pub(in crate::postgres) async fn preview(
    client: &mut Client,
    plan: &mut Plan,
    columns: Vec<String>,
    rows: Vec<Vec<PostgresCellChange>>,
) -> Result<RowPastePreview> {
    if rows.is_empty()
        || rows.len() > PASTE_ROWS
        || columns.is_empty()
        || columns.len() > PASTE_COLUMNS
    {
        return Err(format!(
            "붙여넣을 범위를 1~{PASTE_ROWS}행, 1~{PASTE_COLUMNS}열로 선택하세요."
        ));
    }
    let bytes: usize = rows
        .iter()
        .flatten()
        .filter_map(|change| match &change.input {
            PostgresEditInput::Text { value } => Some(value.len()),
            _ => None,
        })
        .sum();
    if bytes > PASTE_BYTES {
        return Err("붙여넣을 값의 전체 크기를 256 KiB 이하로 줄이세요.".into());
    }
    let tx = read_transaction(client).await?;
    plan.recheck(&tx).await?;
    let mapped: HashSet<_> = columns.iter().map(String::as_str).collect();
    if mapped.len() != columns.len() {
        return Err("같은 대상 열을 두 번 선택했습니다.".into());
    }
    if let Some(column) = plan
        .columns
        .iter()
        .find(|column| column.required_for_insert() && !mapped.contains(column.name.as_str()))
    {
        return Err(format!("{} 필수 열을 매핑하세요.", column.name));
    }
    let fields = columns
        .iter()
        .map(|name| {
            plan.columns
                .iter()
                .find(|column| column.name == *name && column.insertable())
                .ok_or_else(|| format!("{name} 열에 직접 입력할 수 없습니다."))
        })
        .collect::<Result<Vec<_>>>()?;

    let mut bindings = Vec::new();
    let mut tuples = Vec::with_capacity(rows.len());
    let mut defaults = Vec::with_capacity(rows.len());
    for (index, row) in rows.into_iter().enumerate() {
        let row_error = |error: String| format!("붙여넣기 {}행 · {error}", index + 1);
        let mut inputs = HashMap::with_capacity(row.len());
        for change in row {
            if !mapped.contains(change.column.as_str())
                || inputs.insert(change.column, change.input).is_some()
            {
                return Err(row_error("매핑되지 않았거나 중복된 열이 있습니다.".into()));
            }
        }
        let mut expressions = vec![index.to_string()];
        let mut omitted = Vec::with_capacity(fields.len());
        for field in &fields {
            let input = inputs
                .remove(&field.name)
                .filter(|input| !matches!(input, PostgresEditInput::Default));
            omitted.push(input.is_none());
            let expression = match input {
                Some(input) => cast_input(field, &input, &mut bindings).map_err(row_error)?,
                None if field.required_for_insert() => {
                    return Err(row_error(format!("{} 열의 값을 입력하세요.", field.name)))
                }
                None => None,
            };
            expressions.push(expression.unwrap_or_else(|| format!("NULL::{}", field.data_type)));
        }
        tuples.push(format!("({})", expressions.join(", ")));
        defaults.push(omitted);
    }
    let aliases = (0..fields.len())
        .map(|index| format!("f{index}"))
        .collect::<Vec<_>>();
    // Keep the exact binary values behind the displayed text. Reinterpreting a literal such as now during INSERT would change the approved value.
    let projected = aliases.iter().flat_map(|name| [
        format!("pg_catalog.left({name}::pg_catalog.text, {})", VALUE_LIMIT + 1),
        format!("CASE WHEN pg_catalog.char_length({name}::pg_catalog.text) <= {VALUE_LIMIT} AND pg_catalog.pg_column_size({name}) <= {} THEN {name} END", VALUE_LIMIT * 4 + 64),
    ]).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT {projected} FROM (VALUES {}) AS entries(ordinal, {}) ORDER BY ordinal",
        tuples.join(", "),
        aliases.join(", ")
    );
    let converted = query(&tx, &sql, &bindings).await?;
    if converted.len() != defaults.len() {
        return Err("서버에서 붙여넣을 값을 모두 확인하지 못했습니다.".into());
    }
    let mut approved = Vec::with_capacity(converted.len());
    let mut previews = Vec::with_capacity(converted.len());
    let mut normalized_bytes = 0;
    for (index, (row, omitted)) in converted.iter().zip(defaults).enumerate() {
        let mut values = Vec::with_capacity(columns.len());
        let mut preview = Vec::with_capacity(columns.len());
        for (position, default) in omitted.into_iter().enumerate() {
            if default {
                values.push(PasteCell::Default);
                preview.push(None);
                continue;
            }
            let shown = cell(field(row, 2 * position)?)
                .map_err(|error| {
                    format!("붙여넣기 {}행 · {} · {error}", index + 1, columns[position])
                })?
                .value;
            normalized_bytes += shown.as_ref().map_or(0, String::len);
            if normalized_bytes > PASTE_BYTES {
                return Err("서버에서 변환된 값이 256 KiB를 초과했습니다.".into());
            }
            let binary: Option<ServerValue> = field(row, 2 * position + 1)?;
            if shown.is_some() != binary.is_some() {
                return Err("서버에서 표시한 값을 저장용 형식으로 확인하지 못했습니다.".into());
            }
            values.push(binary.map_or(PasteCell::Null, PasteCell::Value));
            preview.push(Some(display_cell(shown, false)));
        }
        approved.push(values);
        previews.push(preview);
    }
    tx.commit().await.map_err(pg_error)?;
    let approval = Uuid::new_v4();
    plan.approval = Some(approval);
    plan.action = Action::Paste(Some(PasteRows {
        columns: columns.clone(),
        rows: approved,
    }));
    Ok(RowPastePreview {
        approval: approval.to_string(),
        columns,
        rows: previews,
    })
}

pub(super) async fn apply(tx: &Transaction<'_>, table: &str, batch: &PasteRows) -> Result<()> {
    let mut bindings = Vec::new();
    let tuples = batch
        .rows
        .iter()
        .map(|row| {
            let expressions = row
                .iter()
                .map(|cell| match cell {
                    PasteCell::Default => "DEFAULT".into(),
                    PasteCell::Null => "NULL".into(),
                    PasteCell::Value(value) => {
                        bindings.push(value);
                        format!("${}", bindings.len())
                    }
                })
                .collect::<Vec<_>>();
            format!("({})", expressions.join(", "))
        })
        .collect::<Vec<_>>();
    let columns = batch
        .columns
        .iter()
        .map(|name| quote(name))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {table} ({columns}) VALUES {} RETURNING true",
        tuples.join(", ")
    );
    let rows = query(tx, &sql, &bindings).await?;
    if rows.len() != batch.count() {
        return Err("예정된 행 수와 저장 결과가 달라 전체를 롤백했습니다.".into());
    }
    Ok(())
}
