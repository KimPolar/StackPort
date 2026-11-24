use super::{
    audit, bounded, cell, commit, edit_field, field, key_predicate_at, pg_error, preview_cells,
    query, read_target, read_transaction, recheck, row::validate_stamp, stamp_keys, update_cells,
    write_transaction, Attribute, CellPreview, Change, EditTarget, PostgresCellChange,
    PostgresEditField, PostgresRowStamp, CELL_LIMIT, STALE, VALUE_LIMIT,
};
use crate::{PostgresProfile, Result, Store, PAGE_SIZE};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};
use tokio::time::timeout;
use tokio_postgres::{Client, Row, Transaction};
use uuid::Uuid;

const MAX_CHANGES: usize = 256;
pub(in crate::postgres) const TIME_LIMIT: Duration = Duration::from_secs(30);

#[derive(Serialize)]
pub struct PostgresGridEditSession {
    token: String,
    table: String,
    keys: Vec<Vec<(String, String)>>,
    columns: Vec<String>,
    max_cells_per_row: usize,
    max_total_cells: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresGridEditChange {
    row: usize,
    cells: Vec<PostgresCellChange>,
}

#[derive(Serialize)]
pub struct PostgresGridEditPreview {
    approval: String,
    rows: Vec<PreviewRow>,
}

#[derive(Serialize)]
struct PreviewRow {
    row: usize,
    changes: Vec<CellPreview>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PostgresGridEditOutcome {
    Applied {
        affected_rows: usize,
        affected_cells: usize,
        audit_warning: bool,
    },
    Unknown,
}

struct OpenColumn {
    attribute: Attribute,
    editable: Vec<bool>,
}

struct RowChange {
    row: usize,
    cells: Vec<Change>,
}

pub(in crate::postgres) struct Plan {
    pub token: Uuid,
    pub created: Instant,
    target: EditTarget,
    stamps: Vec<PostgresRowStamp>,
    columns: HashMap<String, OpenColumn>,
    approved: Option<(Uuid, Vec<RowChange>)>,
}

impl Plan {
    pub fn approved(&self, approval: Uuid) -> bool {
        self.approved
            .as_ref()
            .is_some_and(|(id, _)| *id == approval)
    }

    pub fn clear_preview(&mut self) {
        self.approved = None;
    }
}

pub(in crate::postgres) async fn begin(
    client: &mut Client,
    object: i64,
    stamps: Vec<PostgresRowStamp>,
) -> Result<(Plan, PostgresGridEditSession)> {
    if !(2..=PAGE_SIZE).contains(&stamps.len()) {
        return Err(format!("편집할 행을 2~{PAGE_SIZE}개 선택하세요."));
    }
    let tx = read_transaction(client).await?;
    let (target, table) = read_target(&tx, object).await?;
    let mut seen = HashSet::with_capacity(stamps.len());
    for stamp in &stamps {
        validate_stamp(stamp, target.key.len())?;
        if !seen.insert(stamp.tuple.as_str()) {
            return Err("같은 행을 한 번만 선택하세요.".into());
        }
    }
    read_rows(&tx, &target, &stamps, None).await?;
    tx.commit().await.map_err(pg_error)?;

    let token = Uuid::new_v4();
    let session = PostgresGridEditSession {
        token: token.to_string(),
        table: target.table.clone(),
        keys: stamps
            .iter()
            .map(|stamp| stamp_keys(&target, stamp))
            .collect(),
        columns: table
            .columns
            .into_iter()
            .map(|column| column.name)
            .collect(),
        max_cells_per_row: CELL_LIMIT,
        max_total_cells: MAX_CHANGES,
    };
    let plan = Plan {
        token,
        target,
        stamps,
        created: Instant::now(),
        columns: HashMap::new(),
        approved: None,
    };
    Ok((plan, session))
}

pub(in crate::postgres) async fn open_column(
    client: &mut Client,
    plan: &mut Plan,
    name: &str,
) -> Result<Vec<Option<PostgresEditField>>> {
    let tx = read_transaction(client).await?;
    let table = recheck(&tx, &plan.target).await?;
    let attribute = table
        .columns
        .into_iter()
        .find(|column| column.name == name)
        .ok_or("선택한 열은 편집할 수 없습니다.")?;
    if plan
        .columns
        .get(name)
        .is_some_and(|previous| previous.attribute != attribute)
    {
        return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
    }
    let rows = read_rows(&tx, &plan.target, &plan.stamps, Some(&attribute)).await?;
    let mut fields = Vec::with_capacity(rows.len());
    for row in rows {
        // A long cell is read-only for that row. Other cells in the column remain editable.
        let current = cell(field(&row, 1)?).ok();
        fields.push(current.map(|current| edit_field(&attribute, current)));
    }
    tx.commit().await.map_err(pg_error)?;
    let editable = fields.iter().map(Option::is_some).collect();
    plan.columns.insert(
        name.into(),
        OpenColumn {
            attribute,
            editable,
        },
    );
    Ok(fields)
}

async fn read_rows(
    tx: &Transaction<'_>,
    target: &EditTarget,
    stamps: &[PostgresRowStamp],
    column: Option<&Attribute>,
) -> Result<Vec<Row>> {
    let projection = column
        .map(|item| format!("{}, ", bounded(&item.name, VALUE_LIMIT)))
        .unwrap_or_default();
    let mut clauses = Vec::with_capacity(stamps.len());
    let mut values = Vec::with_capacity(stamps.len() * target.key.len());
    for (row, stamp) in stamps.iter().enumerate() {
        let predicate = key_predicate_at(target.object, &target.key, values.len());
        clauses.push(format!(
            "SELECT {row}::pg_catalog.int4, {projection}{} FROM ONLY {} WHERE {predicate}",
            PostgresRowStamp::PROJECTION,
            target.table,
        ));
        values.extend(stamp.values());
    }
    let sql = format!("{} ORDER BY 1", clauses.join(" UNION ALL "));
    let rows = query(tx, &sql, &values).await?;
    if rows.len() != stamps.len() {
        return Err(STALE.into());
    }
    for (index, (row, stamp)) in rows.iter().zip(stamps).enumerate() {
        if field::<i32>(row, 0)? as usize != index {
            return Err(STALE.into());
        }
        stamp
            .check(row, 1 + usize::from(column.is_some()))
            .map_err(|error| row_error(index, error))?;
    }
    Ok(rows)
}

pub(in crate::postgres) async fn preview(
    client: &mut Client,
    plan: &mut Plan,
    inputs: Vec<PostgresGridEditChange>,
) -> Result<PostgresGridEditPreview> {
    if inputs.is_empty()
        || inputs.len() > plan.stamps.len()
        || inputs.iter().map(|input| input.cells.len()).sum::<usize>() > MAX_CHANGES
    {
        return Err(format!(
            "선택한 행 중 최대 {MAX_CHANGES}개 셀의 변경을 지정하세요."
        ));
    }
    let tx = read_transaction(client).await?;
    let table = recheck(&tx, &plan.target).await?;
    let mut seen = HashSet::with_capacity(inputs.len());
    let mut rows = Vec::new();
    let mut staged = Vec::new();
    for PostgresGridEditChange { row, cells } in inputs {
        let stamp = plan.stamps.get(row).ok_or("선택한 범위에 없는 행입니다.")?;
        if !seen.insert(row) {
            return Err("같은 행을 한 번만 지정하세요.".into());
        }
        if !(1..=CELL_LIMIT).contains(&cells.len()) {
            return Err(row_error(
                row,
                "한 행에서 1~16개 셀의 변경을 지정하세요.".into(),
            ));
        }
        let fields = cells
            .iter()
            .map(|change| {
                plan.columns
                    .get(&change.column)
                    .filter(|field| field.editable[row])
                    .map(|field| field.attribute.clone())
                    .ok_or_else(|| row_error(row, "편집할 열을 열어 현재 값을 확인하세요.".into()))
            })
            .collect::<Result<Vec<_>>>()?;
        let (changes, valid) = preview_cells(&tx, &plan.target, stamp, &fields, &table, cells)
            .await
            .map_err(|error| row_error(row, error))?;
        if !valid.is_empty() {
            rows.push(PreviewRow { row, changes });
            staged.push(RowChange { row, cells: valid });
        }
    }
    if staged.is_empty() {
        return Err("변경할 값이 기존 값과 같습니다.".into());
    }
    tx.commit().await.map_err(pg_error)?;
    let approval = Uuid::new_v4();
    plan.approved = Some((approval, staged));
    Ok(PostgresGridEditPreview {
        approval: approval.to_string(),
        rows,
    })
}

fn row_error(row: usize, error: String) -> String {
    format!("선택 목록의 {}번째 행 · {error}", row + 1)
}

pub(in crate::postgres) async fn apply(
    client: &mut Client,
    store: &Store,
    profile: &PostgresProfile,
    plan: Plan,
) -> Result<PostgresGridEditOutcome> {
    let (_, rows) = plan
        .approved
        .as_ref()
        .ok_or("변경 내용을 먼저 미리 보세요.")?;
    let affected_rows = rows.len();
    let affected_cells = rows.iter().map(|row| row.cells.len()).sum();
    let record = |status| {
        audit(
            store,
            profile,
            plan.token,
            "postgres.edit.grid",
            Some(&plan.target.table),
            status,
            affected_rows,
        )
    };
    record("started").await?;
    let tx = match timeout(TIME_LIMIT, write(client, &plan, rows)).await {
        Ok(Ok(tx)) => tx,
        failure => {
            let _ = record("failed").await;
            let error = match failure {
                Ok(Err(error)) => error,
                _ => "행 변경 시간이 초과되었습니다. 다시 조회하세요.".into(),
            };
            return Err(format!("{error} 전체 변경을 롤백했습니다."));
        }
    };
    match commit(tx).await {
        Ok(true) => Ok(PostgresGridEditOutcome::Applied {
            affected_rows,
            affected_cells,
            audit_warning: record("succeeded").await.is_err(),
        }),
        Ok(false) => {
            let _ = record("unknown").await;
            Ok(PostgresGridEditOutcome::Unknown)
        }
        Err(error) => {
            let _ = record("failed").await;
            Err(format!("{error} 전체 변경을 롤백했습니다."))
        }
    }
}

async fn write<'a>(
    client: &'a mut Client,
    plan: &Plan,
    rows: &[RowChange],
) -> Result<Transaction<'a>> {
    let tx = write_transaction(client, &plan.target).await?;
    let table = recheck(&tx, &plan.target).await?;
    for row in rows {
        if !row.cells.iter().all(|cell| {
            plan.columns
                .get(&cell.column)
                .is_some_and(|column| table.columns.contains(&column.attribute))
        }) {
            return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
        }
        update_cells(&tx, &plan.target, &plan.stamps[row.row], &row.cells)
            .await
            .map_err(|error| row_error(row.row, error))?;
    }
    Ok(tx)
}
