use super::{display_cell, read_transaction, Action, Plan};
use crate::postgres::edit::{
    cast_input, cell, field, pg_error, preview_value_projection, query, ApprovedValue,
    PostgresCellChange, PostgresEditInput, ServerValue,
};
use crate::{
    edit::RowPastePreview,
    postgres::{edit::Attribute, parameters::Value},
    quote_identifier as quote, Result,
};
use std::collections::{HashMap, HashSet};
use tokio_postgres::{Client, Transaction};
use uuid::Uuid;

pub(super) struct PasteRows {
    columns: Vec<String>,
    rows: Vec<Vec<ApprovedValue>>,
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
    let source = plan
        .batch_source()
        .ok_or("여러 행 추가 작업을 다시 여세요.")?;
    let row_count = rows.len();
    source.validate(
        row_count,
        columns.len(),
        rows.iter()
            .flatten()
            .filter_map(|change| match &change.input {
                PostgresEditInput::Text { value } => Some(value.len()),
                _ => None,
            })
            .sum(),
    )?;
    let limits = source.limits();
    let operation = source.name();
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

    let aliases = (0..fields.len())
        .map(|index| format!("f{index}"))
        .collect::<Vec<_>>();
    // Keep the exact binary values behind the displayed text. Reinterpreting a literal such as now during INSERT would change the approved value.
    let projected = aliases
        .iter()
        .flat_map(|name| preview_value_projection(name))
        .collect::<Vec<_>>()
        .join(", ");
    let aliases = aliases.join(", ");
    let mut approved = Vec::with_capacity(row_count);
    let mut previews = Vec::with_capacity(limits.preview_rows.min(row_count));
    let mut normalized_bytes = 0;
    let mut source_rows = rows.into_iter().enumerate();
    // Bound the server's typed preview results before buffering them in memory.
    // Every chunk uses the same snapshot and transaction time.
    while approved.len() < row_count {
        let first = approved.len() + 1;
        let mut bindings = Vec::new();
        let chunk = source_rows
            .by_ref()
            .take(32)
            .map(|(index, row)| prepare_row(index, row, &fields, &mapped, operation, &mut bindings))
            .collect::<Result<Vec<_>>>()?;
        let tuples = chunk
            .iter()
            .map(|(tuple, _)| tuple.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("SELECT {projected} FROM (VALUES {tuples}) AS entries(ordinal, {aliases}) ORDER BY ordinal");
        let last = first + chunk.len() - 1;
        let converted = query(&tx, &sql, &bindings)
            .await
            .map_err(|error| format!("{operation} {first}~{last}행 · {error}"))?;
        if converted.len() != chunk.len() {
            return Err("서버에서 추가할 값을 모두 확인하지 못했습니다.".into());
        }
        for (row, (_, omitted)) in converted.iter().zip(chunk) {
            let mut values = Vec::with_capacity(columns.len());
            let mut preview = Vec::with_capacity(columns.len());
            let index = approved.len() + 1;
            for (position, default) in omitted.into_iter().enumerate() {
                if default {
                    values.push(ApprovedValue::Default);
                    preview.push(None);
                    continue;
                }
                let shown = cell(field(row, 2 * position)?)
                    .map_err(|error| {
                        format!("{operation} {index}행 · {} · {error}", columns[position])
                    })?
                    .value;
                normalized_bytes += shown.as_ref().map_or(0, String::len);
                if normalized_bytes > limits.bytes {
                    return Err(format!(
                        "서버에서 변환된 값이 {} KiB를 초과했습니다.",
                        limits.bytes / 1024
                    ));
                }
                let binary: Option<ServerValue> = field(row, 2 * position + 1)?;
                if shown.is_some() != binary.is_some() {
                    return Err("서버에서 표시한 값을 저장용 형식으로 확인하지 못했습니다.".into());
                }
                values.push(binary.map_or(ApprovedValue::Null, ApprovedValue::Value));
                preview.push(Some(display_cell(shown, false)));
            }
            if index <= limits.preview_rows {
                previews.push(preview);
            }
            approved.push(values);
        }
    }
    tx.commit().await.map_err(pg_error)?;
    let approval = Uuid::new_v4();
    plan.approval = Some(approval);
    plan.action = Action::Paste(
        source,
        Some(PasteRows {
            columns: columns.clone(),
            rows: approved,
        }),
    );
    Ok(RowPastePreview {
        approval: approval.to_string(),
        columns,
        rows: previews,
        row_count,
    })
}

fn prepare_row(
    index: usize,
    row: Vec<PostgresCellChange>,
    fields: &[&Attribute],
    mapped: &HashSet<&str>,
    operation: &str,
    bindings: &mut Vec<Value>,
) -> Result<(String, Vec<bool>)> {
    let row_error = |error: String| format!("{operation} {}행 · {error}", index + 1);
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
    for field in fields {
        let input = inputs
            .remove(&field.name)
            .filter(|input| !matches!(input, PostgresEditInput::Default));
        omitted.push(input.is_none());
        let expression = match input {
            Some(input) => cast_input(field, &input, bindings).map_err(row_error)?,
            None if field.required_for_insert() => {
                return Err(row_error(format!("{} 열의 값을 입력하세요.", field.name)))
            }
            None => None,
        };
        expressions.push(expression.unwrap_or_else(|| format!("NULL::{}", field.data_type)));
    }
    Ok((format!("({})", expressions.join(", ")), omitted))
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
                    ApprovedValue::Default => "DEFAULT".into(),
                    ApprovedValue::Null => "NULL".into(),
                    ApprovedValue::Value(value) => {
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
