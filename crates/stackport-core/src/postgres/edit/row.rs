use super::{
    access, audit, bind, bounded, catalog, cell, commit, exactly_one, field, key_predicate,
    pg_error, preview_expression, query, visible_default, write_error, Attribute, Client,
    EditTable, IsolationLevel, PostgresCellChange, PostgresEditInput, PostgresProfile,
    PostgresRowStamp, Result, Row, Store, Transaction, Uuid, Zeroizing, DEADLINE, KEY_LIMIT,
    LIFETIME, STALE, VALUE_LIMIT,
};
use crate::{
    edit::{
        InsertColumn, RowBatchSource, RowChangeField, RowChangePreview, RowChangeResult,
        RowChangeSession, RowChangeValue, RowPasteResult,
    },
    quote_identifier as quote, Cell,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::time::timeout;

pub(in crate::postgres) mod paste;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PostgresRowChange {
    Insert,
    Paste,
    #[serde(alias = "import_delimited")]
    ImportFile,
    Delete { stamp: PostgresRowStamp },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PostgresRowChangeOutcome {
    Applied { result: RowChangeResult },
    Pasted { result: RowPasteResult },
    Unknown,
}

struct FieldChange {
    name: String,
    input: PostgresEditInput,
    normalized: Option<Zeroizing<String>>,
}

enum Action {
    Insert(Vec<FieldChange>),
    Paste(RowBatchSource, Option<paste::PasteRows>),
    Delete(PostgresRowStamp),
}

pub(in crate::postgres) struct Plan {
    pub token: Uuid,
    created: Instant,
    object: i64,
    table: String,
    key: Vec<Attribute>,
    columns: Vec<Attribute>,
    action: Action,
    approval: Option<Uuid>,
}

impl Plan {
    pub(in crate::postgres) fn active(&self, token: Uuid) -> bool {
        self.token == token && self.created.elapsed() < LIFETIME
    }

    pub(in crate::postgres) fn approved(&self, approval: Uuid) -> bool {
        self.approval == Some(approval)
    }

    pub(in crate::postgres) fn is_paste(&self) -> bool {
        self.batch_source().is_some()
    }

    fn batch_source(&self) -> Option<RowBatchSource> {
        match self.action {
            Action::Paste(source, _) => Some(source),
            _ => None,
        }
    }

    pub(in crate::postgres) fn batch_preview_timeout(&self, normal: Duration) -> Duration {
        match self.batch_source() {
            Some(RowBatchSource::File) => Duration::from_secs(30),
            _ => normal,
        }
    }

    pub(in crate::postgres) fn clear_paste_preview(&mut self) -> Result<()> {
        let Action::Paste(_, batch) = &mut self.action else {
            return Err("여러 행 추가 작업을 다시 여세요.".into());
        };
        self.approval = None;
        *batch = None;
        Ok(())
    }

    pub(in crate::postgres) fn clear_insert_preview(&mut self) -> Result<()> {
        if !matches!(self.action, Action::Insert(_)) {
            return Err("행 추가 세션을 다시 여세요.".into());
        }
        self.approval = None;
        self.action = Action::Insert(Vec::new());
        Ok(())
    }

    async fn recheck(&self, tx: &Transaction<'_>) -> Result<()> {
        let relation = catalog::relation(tx, self.object).await?;
        let current = access(tx, self.object, relation.kind).await?.allowed()?;
        if self.table != format!("{}.{}", quote(&relation.schema), quote(&relation.name))
            || self.key != current.key
            || self.columns != current.shape
        {
            return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
        }
        match self.action {
            Action::Insert(_) | Action::Paste(..) => check_insert(&current),
            Action::Delete(_) => check_delete(&current),
        }
    }
}

pub(in crate::postgres) async fn begin(
    client: &mut Client,
    object: i64,
    change: PostgresRowChange,
) -> Result<(Plan, RowChangeSession)> {
    let tx = read_transaction(client).await?;
    let relation = catalog::relation(&tx, object).await?;
    let table = format!("{}.{}", quote(&relation.schema), quote(&relation.name));
    let edit = access(&tx, object, relation.kind).await?.allowed()?;
    let (action, columns, preview) = match change {
        PostgresRowChange::Insert
        | PostgresRowChange::Paste
        | PostgresRowChange::ImportFile => {
            check_insert(&edit)?;
            if !matches!(change, PostgresRowChange::Insert) && !edit.allow_paste() {
                return Err("이 테이블에는 여러 행을 추가할 수 있는 대상 열이 없습니다.".into());
            }
            let columns = edit
                .shape
                .iter()
                .map(|column| InsertColumn {
                    name: column.name.clone(),
                    declared_type: column.data_type.clone(),
                    nullable: column.nullable,
                    required: column.required_for_insert(),
                    auto_key: !column.identity.is_empty(),
                    default_value: default_label(column),
                    editable: column.insertable(),
                })
                .collect();
            let action = match change {
                PostgresRowChange::Paste => Action::Paste(RowBatchSource::Clipboard, None),
                PostgresRowChange::ImportFile => {
                    Action::Paste(RowBatchSource::File, None)
                }
                _ => Action::Insert(Vec::new()),
            };
            (action, columns, None)
        }
        PostgresRowChange::Delete { stamp } => {
            check_delete(&edit)?;
            validate_stamp(&stamp, edit.key.len())?;
            let predicate = key_predicate(object, &edit.key);
            let projection = edit
                .shape
                .iter()
                .map(grid_projection)
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT {projection}, {} FROM ONLY {table} WHERE {predicate}",
                PostgresRowStamp::PROJECTION
            );
            let row = exactly_one(&mut query(&tx, &sql, &stamp.values()).await?)?;
            stamp.check(&row, edit.shape.len())?;
            (
                Action::Delete(stamp),
                Vec::new(),
                Some(saved_fields(&row, &edit.shape)?),
            )
        }
    };
    tx.commit().await.map_err(pg_error)?;
    let approval = preview.as_ref().map(|_| Uuid::new_v4());
    let token = Uuid::new_v4();
    let session = RowChangeSession {
        token: token.to_string(),
        columns,
        preview: preview
            .zip(approval)
            .map(|(fields, approval)| RowChangePreview {
                approval: approval.to_string(),
                fields,
            }),
    };
    Ok((
        Plan {
            token,
            created: Instant::now(),
            object,
            table,
            key: edit.key,
            columns: edit.shape,
            action,
            approval,
        },
        session,
    ))
}

pub(in crate::postgres) async fn preview(
    client: &mut Client,
    plan: &mut Plan,
    changes: Vec<PostgresCellChange>,
) -> Result<RowChangePreview> {
    let tx = read_transaction(client).await?;
    plan.recheck(&tx).await?;

    let mut inputs = HashMap::with_capacity(changes.len());
    for change in changes {
        if inputs.insert(change.column, change.input).is_some() {
            return Err("같은 열에 값을 두 번 입력했습니다.".into());
        }
    }
    let mut values = Vec::new();
    let mut casts = Vec::new();
    let mut drafts = HashMap::new();
    for column in &plan.columns {
        match inputs.remove(&column.name) {
            Some(input) if !matches!(input, PostgresEditInput::Default) => {
                if !column.insertable() {
                    return Err(format!("{} 열에 직접 입력할 수 없습니다.", column.name));
                }
                let cast = preview_expression(column, &input, &mut values)?;
                drafts.insert(column.name.clone(), (casts.len(), input));
                casts.push(cast);
            }
            _ if column.required_for_insert() => {
                return Err(format!("{} 열의 값을 입력하세요.", column.name))
            }
            _ => {}
        }
    }
    if !inputs.is_empty() {
        return Err("테이블에 없는 열이 포함되었습니다. 다시 조회하세요.".into());
    }
    let converted = if casts.is_empty() {
        None
    } else {
        Some(exactly_one(
            &mut query(&tx, &format!("SELECT {}", casts.join(", ")), &values).await?,
        )?)
    };
    let mut fields = Vec::with_capacity(plan.columns.len());
    let mut approved = Vec::with_capacity(drafts.len());
    for column in &plan.columns {
        let value = if let Some((index, input)) = drafts.remove(&column.name) {
            let row = converted
                .as_ref()
                .ok_or("서버에서 입력값을 확인하지 못했습니다.")?;
            let normalized = cell(field(row, index)?)?.value;
            approved.push(FieldChange {
                name: column.name.clone(),
                input,
                normalized: normalized.clone().map(Zeroizing::new),
            });
            RowChangeValue::Explicit {
                cell: display_cell(normalized, false),
            }
        } else {
            RowChangeValue::Default {
                expression: default_label(column),
                auto_key: !column.identity.is_empty(),
            }
        };
        fields.push(RowChangeField {
            name: column.name.clone(),
            value,
        });
    }
    tx.commit().await.map_err(pg_error)?;
    let approval = Uuid::new_v4();
    plan.approval = Some(approval);
    plan.action = Action::Insert(approved);
    Ok(RowChangePreview {
        approval: approval.to_string(),
        fields,
    })
}

pub(in crate::postgres) async fn apply(
    client: &mut Client,
    store: &Store,
    profile: &PostgresProfile,
    plan: Plan,
) -> Result<PostgresRowChangeOutcome> {
    let (operation, count) = match &plan.action {
        Action::Insert(_) => ("postgres.row.insert", 1),
        Action::Delete(_) => ("postgres.row.delete", 1),
        Action::Paste(RowBatchSource::Clipboard, Some(batch)) => {
            ("postgres.row.paste", batch.count())
        }
        Action::Paste(RowBatchSource::File, Some(batch)) => {
            ("postgres.row.import", batch.count())
        }
        Action::Paste(_, None) => return Err("추가할 행을 먼저 미리 보세요.".into()),
    };
    let record = |status| {
        audit(
            store,
            profile,
            plan.token,
            operation,
            Some(&plan.table),
            status,
            count,
        )
    };
    record("started").await?;
    let (tx, fields) = match timeout(DEADLINE, write(client, &plan)).await {
        Ok(Ok(result)) => result,
        failure => {
            let _ = record("failed").await;
            return match failure {
                Ok(Err(error)) => Err(error),
                _ => Err("행 변경 시간이 초과되었습니다. 다시 조회하세요.".into()),
            };
        }
    };
    match commit(tx).await {
        Ok(true) => {
            let audit_warning = record("succeeded").await.err();
            if plan.is_paste() {
                Ok(PostgresRowChangeOutcome::Pasted {
                    result: RowPasteResult {
                        rows: count,
                        audit_warning,
                    },
                })
            } else {
                Ok(PostgresRowChangeOutcome::Applied {
                    result: RowChangeResult {
                        fields,
                        audit_warning,
                    },
                })
            }
        }
        Ok(false) => {
            let _ = record("unknown").await;
            Ok(PostgresRowChangeOutcome::Unknown)
        }
        Err(error) => {
            let _ = record("failed").await;
            if let Some(source) = plan.batch_source() {
                Err(format!("{} 전체를 롤백했습니다. {error}", source.name()))
            } else {
                Err(error)
            }
        }
    }
}

async fn write<'a>(
    client: &'a mut Client,
    plan: &Plan,
) -> Result<(Transaction<'a>, Vec<RowChangeField>)> {
    let tx = client
        .build_transaction()
        .read_only(false)
        .isolation_level(IsolationLevel::ReadCommitted)
        .start()
        .await
        .map_err(write_error)?;
    tx.batch_execute(&format!(
        "LOCK TABLE ONLY {} IN ROW EXCLUSIVE MODE",
        plan.table
    ))
    .await
    .map_err(write_error)?;
    plan.recheck(&tx).await?;
    let fields = match &plan.action {
        Action::Insert(changes) => execute_insert(&tx, plan, changes).await?,
        Action::Paste(source, Some(batch)) => {
            paste::apply(&tx, &plan.table, batch)
                .await
                .map_err(|error| format!("{} 전체를 롤백했습니다. {error}", source.name()))?;
            Vec::new()
        }
        Action::Paste(_, None) => return Err("추가할 행을 먼저 미리 보세요.".into()),
        Action::Delete(stamp) => {
            let mut values = stamp.values();
            let predicate = key_predicate(plan.object, &plan.key);
            let tuple = values.len() + 1;
            let version = tuple + 1;
            values.push(bind(stamp.tuple.clone()));
            values.push(bind(stamp.version.clone()));
            let sql = format!("DELETE FROM ONLY {} WHERE {predicate}
                AND ctid = ${tuple}::pg_catalog.tid AND xmin::pg_catalog.text = ${version} RETURNING true", plan.table);
            exactly_one(&mut query(&tx, &sql, &values).await?)?;
            Vec::new()
        }
    };
    Ok((tx, fields))
}

async fn execute_insert(
    tx: &Transaction<'_>,
    plan: &Plan,
    changes: &[FieldChange],
) -> Result<Vec<RowChangeField>> {
    let mut values = Vec::new();
    let mut columns = Vec::new();
    let mut expressions = Vec::new();
    for change in changes {
        columns.push(quote(&change.name));
        let expression = match &change.input {
            PostgresEditInput::Text { value } => {
                values.push(bind(value.to_string()));
                format!("${}", values.len())
            }
            PostgresEditInput::Null => "NULL".into(),
            PostgresEditInput::Default => {
                return Err("기본값 열은 입력에서 생략해야 합니다.".into())
            }
        };
        expressions.push(expression);
    }
    let mut returning = plan.columns.iter().map(grid_projection).collect::<Vec<_>>();
    returning.extend(
        changes
            .iter()
            .map(|change| bounded(&change.name, VALUE_LIMIT)),
    );
    let source = if columns.is_empty() {
        "DEFAULT VALUES".into()
    } else {
        format!(
            "({}) VALUES ({})",
            columns.join(", "),
            expressions.join(", ")
        )
    };
    let sql = format!(
        "INSERT INTO {} {source} RETURNING {}",
        plan.table,
        returning.join(", ")
    );
    let row = exactly_one(&mut query(tx, &sql, &values).await?)?;
    for (index, change) in changes.iter().enumerate() {
        let actual = cell(field(&row, plan.columns.len() + index)?)?;
        if actual.value.as_deref() != change.normalized.as_ref().map(|value| value.as_str()) {
            return Err(format!(
                "{} · 서버의 저장 결과가 미리보기와 달라 롤백했습니다.",
                change.name
            ));
        }
    }
    saved_fields(&row, &plan.columns)
}

fn grid_projection(column: &Attribute) -> String {
    use crate::postgres::value::{grid_text, ValueKind};
    let name = quote(&column.name);
    ValueKind::for_type(column.type_oid)
        .map_or_else(|| grid_text(&name), |kind| kind.grid_preview(&name))
}

fn saved_fields(row: &Row, columns: &[Attribute]) -> Result<Vec<RowChangeField>> {
    let mut rows =
        crate::postgres::session::preview_rows(std::slice::from_ref(row), columns.len())?;
    let cells = rows
        .pop()
        .ok_or("서버가 반환한 행을 확인하지 못했습니다.")?;
    Ok(columns
        .iter()
        .zip(cells)
        .map(|(column, cell)| RowChangeField {
            name: column.name.clone(),
            value: RowChangeValue::Explicit {
                cell: display_cell(cell.value, cell.truncated),
            },
        })
        .collect())
}

fn display_cell(value: Option<String>, truncated: bool) -> Cell {
    match value {
        Some(display) => Cell {
            kind: "text",
            display,
            truncated,
            lossy_text: false,
        },
        None => Cell {
            kind: "null",
            display: "NULL".into(),
            truncated: false,
            lossy_text: false,
        },
    }
}

fn default_label(column: &Attribute) -> Option<String> {
    column
        .default_sql
        .as_ref()
        .map(|_| visible_default(column).unwrap_or("…").to_owned())
}

fn check_insert(table: &EditTable) -> Result<()> {
    if !table.can_insert {
        return Err("이 테이블에 INSERT 권한이 없습니다.".into());
    }
    if !table.allow_insert() {
        return Err("직접 입력을 지원하지 않는 필수 열이 있습니다.".into());
    }
    Ok(())
}

fn check_delete(table: &EditTable) -> Result<()> {
    if !table.can_delete {
        return Err("이 테이블에 DELETE 권한이 없습니다.".into());
    }
    if let Some(reason) = table.delete_reason() {
        return Err(reason.into());
    }
    Ok(())
}

pub(super) fn validate_stamp(stamp: &PostgresRowStamp, keys: usize) -> Result<()> {
    if stamp.tuple.len() > 32
        || stamp.version.parse::<u32>().is_err()
        || stamp.keys.len() != keys
        || stamp.keys.iter().any(|value| {
            value.chars().take(KEY_LIMIT + 1).count() > KEY_LIMIT || value.contains('\0')
        })
    {
        return Err(STALE.into());
    }
    Ok(())
}

async fn read_transaction(client: &mut Client) -> Result<Transaction<'_>> {
    client
        .build_transaction()
        .read_only(true)
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(pg_error)
}
