use super::{
    display_value, editable_table, ensure_identity, file_handle, insert_audit, key_predicate,
    open_edit_db, open_schema_db, parse_input, quote, read_row, schema_version, validate_keys,
    verify_profile, wipe_value, AuditRecord, Cell, Connection, EditInput, EditKey, Handle,
    ObjectDetails, Path, Profile, Result, Store, TransactionBehavior, Uuid, Value, ValueRef,
    SESSION_LIFETIME,
};
use crate::db_error;
use rusqlite::{params_from_iter, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    time::Instant,
};
use zeroize::Zeroize;

const EXPIRED: &str = "행 작업이 만료되었습니다. 테이블을 다시 조회하세요.";
const PASTE_ROWS: usize = 100;
const PASTE_COLUMNS: usize = 64;
const PASTE_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RowChange {
    Insert,
    Paste,
    Delete { keys: Vec<EditKey> },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowInsertField {
    pub column: String,
    pub input: EditInput,
}

#[derive(Serialize)]
pub struct RowChangeSession {
    pub token: String,
    pub columns: Vec<InsertColumn>,
    pub preview: Option<RowChangePreview>,
}

#[derive(Serialize)]
pub struct InsertColumn {
    pub name: String,
    pub declared_type: String,
    pub nullable: bool,
    pub required: bool,
    pub auto_key: bool,
    pub default_value: Option<String>,
    pub editable: bool,
}

#[derive(Serialize)]
pub struct RowChangePreview {
    pub approval: String,
    pub fields: Vec<RowChangeField>,
}

#[derive(Serialize)]
pub struct RowChangeField {
    pub name: String,
    #[serde(flatten)]
    pub value: RowChangeValue,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RowChangeValue {
    Explicit {
        cell: Cell,
    },
    Default {
        expression: Option<String>,
        auto_key: bool,
    },
}

#[derive(Serialize)]
pub struct RowChangeResult {
    pub fields: Vec<RowChangeField>,
    pub audit_warning: Option<String>,
}

#[derive(Serialize)]
pub struct RowPastePreview {
    pub approval: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<Cell>>>,
}

#[derive(Serialize)]
pub struct RowPasteResult {
    pub rows: usize,
    pub audit_warning: Option<String>,
}

#[derive(Default)]
struct Values(Vec<(String, Value)>);

impl Values {
    fn cell(&self, name: &str) -> Option<Cell> {
        self.0
            .iter()
            .find(|(column, _)| column == name)
            .map(|(_, value)| display_value(ValueRef::from(value)))
    }
}

impl Drop for Values {
    fn drop(&mut self) {
        for (_, value) in &mut self.0 {
            wipe_value(value);
        }
    }
}

enum Action {
    Insert(Values),
    Paste(Vec<Values>),
    Delete { keys: Values, fingerprint: [u8; 32] },
}

impl Drop for Action {
    fn drop(&mut self) {
        if let Self::Delete { fingerprint, .. } = self {
            fingerprint.zeroize();
        }
    }
}

pub(super) struct Plan {
    profile: Profile,
    table: String,
    identity: Handle,
    schema_version: i64,
    action: Action,
    approval: Option<String>,
    pub(super) created: Instant,
}

impl Plan {
    fn check_target(&self, store: &Store, db: &Connection) -> Result<()> {
        ensure_identity(&self.identity, &self.profile.path)?;
        verify_profile(store, &self.profile)?;
        if schema_version(db)? != self.schema_version {
            return Err("테이블 구조가 변경되었습니다. 테이블을 다시 조회하세요.".into());
        }
        Ok(())
    }
}

impl Store {
    pub fn begin_row_change(
        &self,
        profile_id: &str,
        table: &str,
        change: RowChange,
    ) -> Result<RowChangeSession> {
        let profile = self.profile(profile_id)?;
        if !matches!(profile.environment.as_str(), "DEV" | "STAGING" | "PROD") {
            return Err("유효하지 않은 연결 환경입니다. 연결 설정을 확인하세요.".into());
        }
        let identity = file_handle(&profile.path)?;
        if identity == file_handle(&self.path)? {
            return Err("StackPort 작업 공간 파일은 이 기능으로 편집할 수 없습니다.".into());
        }
        let db = open_schema_db(Path::new(&profile.path))?;
        ensure_identity(&identity, &profile.path)?;
        let schema_version = schema_version(&db)?;
        let details = editable_table(&db, table)?;
        let (action, columns, preview) = match change {
            RowChange::Insert => (
                Action::Insert(Values::default()),
                insert_columns(&details),
                None,
            ),
            RowChange::Paste => (Action::Paste(Vec::new()), insert_columns(&details), None),
            RowChange::Delete { keys } => {
                ensure_delete_scope(&db, table)?;
                let keys = Values(validate_keys(&details, &keys)?);
                let snapshot = read_row(&db, table, &keys.0, &[])?;
                let fields = snapshot
                    .fields
                    .into_iter()
                    .map(|field| explicit(field.name, field.display))
                    .collect();
                let preview = RowChangePreview {
                    approval: Uuid::new_v4().to_string(),
                    fields,
                };
                (
                    Action::Delete {
                        keys,
                        fingerprint: snapshot.fingerprint,
                    },
                    Vec::new(),
                    Some(preview),
                )
            }
        };
        let token = Uuid::new_v4().to_string();
        self.edits.active_state()?.rows.insert(
            token.clone(),
            Plan {
                profile,
                table: table.into(),
                identity,
                schema_version,
                action,
                approval: preview.as_ref().map(|preview| preview.approval.clone()),
                created: Instant::now(),
            },
        );
        Ok(RowChangeSession {
            token,
            columns,
            preview,
        })
    }

    pub fn preview_row_insert(
        &self,
        token: &str,
        fields: Vec<RowInsertField>,
    ) -> Result<RowChangePreview> {
        let mut state = self.edits.lock()?;
        let plan = active_plan(&mut state.rows, token)?;
        if !matches!(plan.action, Action::Insert(_)) {
            return Err("행 추가 세션을 다시 여세요.".into());
        }
        plan.approval = None;
        plan.action = Action::Insert(Values::default());
        let db = open_schema_db(Path::new(&plan.profile.path))?;
        plan.check_target(self, &db)?;
        let columns = insert_columns(&editable_table(&db, &plan.table)?);
        let values = prepare_insert(&columns, fields)?;
        let preview = columns
            .into_iter()
            .map(|column| {
                let value = values.cell(&column.name);
                RowChangeField {
                    name: column.name,
                    value: match value {
                        Some(cell) => RowChangeValue::Explicit { cell },
                        None => RowChangeValue::Default {
                            expression: column.default_value,
                            auto_key: column.auto_key,
                        },
                    },
                }
            })
            .collect();
        let approval = Uuid::new_v4().to_string();
        plan.approval = Some(approval.clone());
        plan.action = Action::Insert(values);
        Ok(RowChangePreview {
            approval,
            fields: preview,
        })
    }

    pub fn preview_row_paste(
        &self,
        token: &str,
        columns: Vec<String>,
        rows: Vec<Vec<RowInsertField>>,
    ) -> Result<RowPastePreview> {
        let mut state = self.edits.lock()?;
        let plan = active_plan(&mut state.rows, token)?;
        if !matches!(plan.action, Action::Paste(_)) {
            return Err("붙여넣기 작업을 다시 여세요.".into());
        }
        plan.approval = None;
        plan.action = Action::Paste(Vec::new());
        if rows.is_empty()
            || rows.len() > PASTE_ROWS
            || columns.is_empty()
            || columns.len() > PASTE_COLUMNS
        {
            return Err(format!(
                "붙여넣을 범위를 1~{PASTE_ROWS}행, 1~{PASTE_COLUMNS}열로 선택하세요."
            ));
        }
        if rows
            .iter()
            .flatten()
            .map(|field| field.input.value.len())
            .sum::<usize>()
            > PASTE_BYTES
        {
            return Err("붙여넣을 값의 전체 크기를 256 KiB 이하로 줄이세요.".into());
        }
        let db = open_schema_db(Path::new(&plan.profile.path))?;
        plan.check_target(self, &db)?;
        let table_columns = insert_columns(&editable_table(&db, &plan.table)?);
        let names: HashSet<_> = columns.iter().map(String::as_str).collect();
        if names.len() != columns.len() {
            return Err("같은 대상 열을 두 번 선택했습니다.".into());
        }
        if columns
            .iter()
            .any(|name| !table_columns.iter().any(|column| column.name == *name))
        {
            return Err("테이블에 없는 열이 포함되었습니다. 다시 조회하세요.".into());
        }
        let mut prepared = Vec::with_capacity(rows.len());
        let mut previews = Vec::with_capacity(rows.len());
        for (index, fields) in rows.into_iter().enumerate() {
            if fields
                .iter()
                .any(|field| !names.contains(field.column.as_str()))
            {
                return Err(format!(
                    "붙여넣기 {}행에 매핑되지 않은 열이 있습니다.",
                    index + 1
                ));
            }
            let values = prepare_insert(&table_columns, fields)
                .map_err(|error| format!("붙여넣기 {}행 · {error}", index + 1))?;
            previews.push(columns.iter().map(|name| values.cell(name)).collect());
            prepared.push(values);
        }
        let approval = Uuid::new_v4().to_string();
        plan.approval = Some(approval.clone());
        plan.action = Action::Paste(prepared);
        Ok(RowPastePreview {
            approval,
            columns,
            rows: previews,
        })
    }

    pub fn apply_row_change(
        &self,
        token: &str,
        approval: &str,
        confirmation: &str,
    ) -> Result<RowChangeResult> {
        let (applied, audit_warning) = self.apply_row_plan(token, approval, confirmation, false)?;
        Ok(RowChangeResult {
            fields: applied.fields,
            audit_warning,
        })
    }

    pub fn apply_row_paste(
        &self,
        token: &str,
        approval: &str,
        confirmation: &str,
    ) -> Result<RowPasteResult> {
        let (applied, audit_warning) = self.apply_row_plan(token, approval, confirmation, true)?;
        Ok(RowPasteResult {
            rows: applied.count,
            audit_warning,
        })
    }

    fn apply_row_plan(
        &self,
        token: &str,
        approval: &str,
        confirmation: &str,
        paste: bool,
    ) -> Result<(Applied, Option<String>)> {
        let plan = {
            let mut state = self.edits.lock()?;
            let plan = active_plan(&mut state.rows, token)?;
            if plan.approval.as_deref() != Some(approval)
                || matches!(plan.action, Action::Paste(_)) != paste
            {
                return Err("현재 행 작업을 다시 미리보세요.".into());
            }
            if plan.profile.environment == "PROD" && confirmation != "PROD" {
                return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
            }
            state.rows.remove(token).ok_or(EXPIRED)?
        };
        verify_profile(self, &plan.profile)?;
        let operation = match plan.action {
            Action::Insert(_) => "sqlite.row.insert",
            Action::Paste(_) => "sqlite.row.paste",
            Action::Delete { .. } => "sqlite.row.delete",
        };
        let correlation_id = Uuid::new_v4().to_string();
        let audit = |outcome, affected_count| AuditRecord {
            correlation_id: &correlation_id,
            operation,
            project_id: Some(&plan.profile.project_id),
            profile_id: Some(&plan.profile.id),
            environment: Some(&plan.profile.environment),
            object_name: Some(&plan.table),
            outcome,
            affected_count,
        };
        insert_audit(&self.connect()?, audit("started", None))?;
        let result = apply(self, &plan);
        let outcome = if result.is_ok() {
            "succeeded"
        } else {
            "failed"
        };
        let recorded = self.connect().and_then(|db| {
            insert_audit(
                &db,
                audit(
                    outcome,
                    result.as_ref().ok().map(|applied| applied.count as i64),
                ),
            )
        });
        match (result, recorded) {
            (Ok(applied), audit) => Ok((
                applied,
                audit
                    .err()
                    .map(|_| "행 작업은 저장됐지만 완료 감사 기록을 저장하지 못했습니다.".into()),
            )),
            (Err(error), Ok(())) => Err(error),
            (Err(error), Err(_)) => Err(format!("{error} 완료 감사 기록도 저장하지 못했습니다.")),
        }
    }

    pub fn cancel_row_change(&self, token: &str) -> Result<()> {
        self.edits.lock()?.rows.remove(token);
        Ok(())
    }
}

fn active_plan<'a>(plans: &'a mut HashMap<String, Plan>, token: &str) -> Result<&'a mut Plan> {
    if plans
        .get(token)
        .is_some_and(|plan| plan.created.elapsed() >= SESSION_LIFETIME)
    {
        plans.remove(token);
    }
    Ok(plans.get_mut(token).ok_or(EXPIRED)?)
}

fn prepare_insert(columns: &[InsertColumn], fields: Vec<RowInsertField>) -> Result<Values> {
    let mut inputs = HashMap::with_capacity(fields.len());
    for field in fields {
        if inputs.insert(field.column, field.input).is_some() {
            return Err("같은 열에 값을 두 번 입력했습니다.".into());
        }
    }
    let mut values = Values::default();
    for column in columns {
        if let Some(input) = inputs.remove(&column.name) {
            let value =
                parse_input(input).map_err(|error| format!("{} 열 · {error}", column.name))?;
            if !column.nullable && matches!(value, Value::Null) {
                return Err(format!("{} 열에 NULL을 입력할 수 없습니다.", column.name));
            }
            if display_value(ValueRef::from(&value)).truncated {
                return Err(format!(
                    "{} 열의 전체 값을 미리 볼 수 있도록 길이를 줄이세요.",
                    column.name
                ));
            }
            values.0.push((column.name.clone(), value));
        } else if column.required {
            return Err(format!("{} 열의 값을 입력하세요.", column.name));
        }
    }
    if !inputs.is_empty() {
        return Err("테이블에 없는 열이 포함되었습니다. 다시 조회하세요.".into());
    }
    Ok(values)
}

fn insert_columns(details: &ObjectDetails) -> Vec<InsertColumn> {
    // SQLite's INTEGER PRIMARY KEY aliases rowid only when it has no separate PK index.
    let rowid_key = !details.indexes.iter().any(|index| index.origin == "pk");
    details
        .columns
        .iter()
        .map(|column| {
            let auto_key = rowid_key
                && column.primary_key_position > 0
                && column.declared_type.eq_ignore_ascii_case("integer");
            let nullable = !column.not_null && column.primary_key_position == 0;
            InsertColumn {
                name: column.name.clone(),
                declared_type: column.declared_type.clone(),
                nullable,
                required: !nullable && !auto_key && column.default_value.is_none(),
                auto_key,
                default_value: column.default_value.clone(),
                editable: true,
            }
        })
        .collect()
}

fn ensure_delete_scope(db: &Connection, table: &str) -> Result<()> {
    let child: Option<String> = db.query_row(
        "SELECT child.name FROM pragma_table_list AS child
         CROSS JOIN pragma_foreign_key_list(child.name, 'main') AS fk
         WHERE child.schema = 'main' AND child.type = 'table'
           AND fk.\"table\" = ?1 COLLATE NOCASE AND fk.on_delete IN ('CASCADE', 'SET NULL', 'SET DEFAULT') LIMIT 1",
        [table], |row| row.get(0),
    ).optional().map_err(db_error)?;
    if let Some(child) = child {
        return Err(format!(
            "{child} 테이블에 연쇄 변경을 일으키는 외래 키가 있어 그리드에서 삭제할 수 없습니다."
        ));
    }
    Ok(())
}

struct Applied {
    count: usize,
    fields: Vec<RowChangeField>,
}

fn apply(store: &Store, plan: &Plan) -> Result<Applied> {
    ensure_identity(&plan.identity, &plan.profile.path)?;
    let mut db = open_edit_db(&plan.profile.path)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    plan.check_target(store, &tx)?;
    let details = editable_table(&tx, &plan.table)?;
    let before = tx.total_changes();
    let result = match &plan.action {
        Action::Insert(values) => Applied {
            count: 1,
            fields: execute_insert(&tx, &details, &values.0, true)?,
        },
        Action::Paste(rows) => {
            for (index, values) in rows.iter().enumerate() {
                execute_insert(&tx, &details, &values.0, false).map_err(|error| {
                    format!(
                        "붙여넣기 {}행 저장에 실패해 전체를 롤백했습니다. {error}",
                        index + 1
                    )
                })?;
            }
            Applied {
                count: rows.len(),
                fields: Vec::new(),
            }
        }
        Action::Delete { keys, fingerprint } => {
            ensure_delete_scope(&tx, &plan.table)?;
            let snapshot = read_row(&tx, &plan.table, &keys.0, &[])?;
            if &snapshot.fingerprint != fingerprint {
                return Err(
                    "미리보기 이후 행이 변경되어 삭제하지 않았습니다. 다시 조회하세요.".into(),
                );
            }
            let (predicate, values) = key_predicate(&keys.0);
            let sql = format!("DELETE FROM main.{} WHERE {predicate}", quote(&plan.table));
            if tx
                .execute(&sql, params_from_iter(values.iter()))
                .map_err(db_error)?
                != 1
            {
                return Err("삭제 대상이 한 행이 아니어서 롤백했습니다.".into());
            }
            Applied {
                count: 1,
                fields: Vec::new(),
            }
        }
    };
    if tx.total_changes() != before + result.count as u64 {
        return Err("예정된 행 외에 변경된 데이터가 있어 롤백했습니다.".into());
    }
    plan.check_target(store, &tx)?;
    tx.commit().map_err(|error| {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
            return format!(
                "제약조건 위반으로 전체 변경을 롤백했습니다. {}",
                db_error(error)
            );
        }
        format!(
            "커밋 결과를 확정하지 못했습니다. 재시도 전에 원본을 다시 조회하세요: {}",
            db_error(error)
        )
    })?;
    Ok(result)
}

fn execute_insert(
    tx: &Transaction<'_>,
    details: &ObjectDetails,
    values: &[(String, Value)],
    capture_row: bool,
) -> Result<Vec<RowChangeField>> {
    let table = quote(&details.object.name);
    let returned: Vec<_> = details
        .columns
        .iter()
        .filter(|column| capture_row || column.primary_key_position > 0)
        .collect();
    let projection = if capture_row {
        "*".into()
    } else {
        returned
            .iter()
            .map(|column| quote(&column.name))
            .collect::<Vec<_>>()
            .join(", ")
    };
    // Override schema-level REPLACE/IGNORE so an INSERT cannot delete another row or silently do nothing.
    let sql = if values.is_empty() {
        format!("INSERT OR ABORT INTO main.{table} DEFAULT VALUES RETURNING {projection}")
    } else {
        let columns = values
            .iter()
            .map(|(name, _)| quote(name))
            .collect::<Vec<_>>()
            .join(", ");
        let slots = vec!["?"; values.len()].join(", ");
        format!(
            "INSERT OR ABORT INTO main.{table} ({columns}) VALUES ({slots}) RETURNING {projection}"
        )
    };
    let mut statement = tx.prepare_cached(&sql).map_err(db_error)?;
    let mut rows = statement
        .query(params_from_iter(values.iter().map(|(_, value)| value)))
        .map_err(db_error)?;
    let row = rows
        .next()
        .map_err(db_error)?
        .ok_or("추가한 행을 확인하지 못했습니다.")?;
    let mut result = Vec::with_capacity(if capture_row { returned.len() } else { 0 });
    for (index, column) in returned.into_iter().enumerate() {
        let value = row.get_ref(index).map_err(db_error)?;
        let rendered = display_value(value);
        if column.primary_key_position > 0
            && (rendered.truncated
                || matches!(value, ValueRef::Null | ValueRef::Blob(_))
                || matches!(value, ValueRef::Text(text) if std::str::from_utf8(text).is_err()))
        {
            return Err("추가한 행의 기본 키를 확인할 수 없어 롤백했습니다.".into());
        }
        if capture_row {
            result.push(explicit(column.name.clone(), rendered));
        }
    }
    if rows.next().map_err(db_error)?.is_some() {
        return Err("추가 결과가 한 행이 아니어서 롤백했습니다.".into());
    }
    Ok(result)
}

fn explicit(name: String, cell: Cell) -> RowChangeField {
    RowChangeField {
        name,
        value: RowChangeValue::Explicit { cell },
    }
}
