//! A short-lived, preview-before-apply SQLite row edit session.
//!
//! Only ordinary tables with stable non-NULL primary keys and without triggers
//! or generated columns are editable. Key/unique columns and large/BLOB values
//! remain read-only. These restrictions avoid hidden cascading changes until a
//! full impact planner exists.

mod row;
pub use row::{
    InsertColumn, RowChange, RowChangeField, RowChangePreview, RowChangeResult, RowChangeSession,
    RowChangeValue, RowInsertField, RowPastePreview, RowPasteResult,
};

pub(crate) const PASTE_ROWS: usize = 100;
pub(crate) const PASTE_COLUMNS: usize = 64;
pub(crate) const PASTE_BYTES: usize = 256 * 1024;

use super::quote_identifier as quote;
use super::{
    display_value, insert_audit, open_schema_db, AuditRecord, Cell, ObjectDetails, Profile, Result,
    Store,
};
use rusqlite::{
    params_from_iter,
    types::{Value, ValueRef},
    Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use same_file::Handle;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use uuid::Uuid;
use zeroize::Zeroize;

const SESSION_LIFETIME: Duration = Duration::from_secs(300);
const MAX_CHANGES: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditKey {
    pub name: String,
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EditInput {
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditField {
    pub name: String,
    pub declared_type: String,
    pub current: Cell,
    pub editable: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EditSession {
    pub token: String,
    pub table: String,
    pub environment: String,
    pub keys: Vec<EditKey>,
    pub fields: Vec<EditField>,
    pub expires_seconds: u64,
    pub max_changes: usize,
}

#[derive(Debug, Serialize)]
pub struct EditPreview {
    pub column: String,
    pub before: Cell,
    pub after: Cell,
}

#[derive(Debug, Serialize)]
pub struct EditResult {
    pub actual: Cell,
    pub audit_warning: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditCellChange {
    pub column: String,
    pub input: EditInput,
}

#[derive(Debug, Serialize)]
pub struct EditRowPreview {
    pub approval: String,
    pub changes: Vec<EditPreview>,
}

#[derive(Debug, Serialize)]
pub struct SavedEditCell {
    pub column: String,
    pub actual: Cell,
}

#[derive(Debug, Serialize)]
pub struct EditRowResult {
    pub cells: Vec<SavedEditCell>,
    pub audit_warning: Option<String>,
}

struct FieldValue {
    name: String,
    value: Option<Value>,
    editable: bool,
}

struct Change {
    column: String,
    after: Value,
}

impl Drop for Change {
    fn drop(&mut self) {
        wipe_value(&mut self.after);
    }
}

struct ApprovedChanges {
    approval: Option<String>,
    cells: Vec<Change>,
}

struct PendingEdit {
    profile: Profile,
    table: String,
    identity: Handle,
    schema_version: i64,
    keys: Vec<(String, Value)>,
    fingerprint: [u8; 32],
    fields: Vec<FieldValue>,
    changes: Option<ApprovedChanges>,
    created: Instant,
}

impl Drop for PendingEdit {
    fn drop(&mut self) {
        for (_, value) in &mut self.keys {
            wipe_value(value);
        }
        for field in &mut self.fields {
            if let Some(value) = &mut field.value {
                wipe_value(value);
            }
        }
        self.fingerprint.zeroize();
    }
}

#[derive(Default)]
struct EditState {
    pending: HashMap<String, PendingEdit>,
    rows: HashMap<String, row::Plan>,
    reaper_started: bool,
}

impl EditState {
    fn expire(&mut self) {
        self.pending
            .retain(|_, plan| plan.created.elapsed() < SESSION_LIFETIME);
        self.rows
            .retain(|_, plan| plan.created.elapsed() < SESSION_LIFETIME);
    }
}

#[derive(Default)]
pub(crate) struct EditManager {
    state: Mutex<EditState>,
}

impl EditManager {
    fn lock(&self) -> Result<MutexGuard<'_, EditState>> {
        self.state
            .lock()
            .map_err(|_| "편집 세션 상태를 사용할 수 없습니다. 앱을 다시 시작하세요.".into())
    }

    fn active_state(self: &Arc<Self>) -> Result<MutexGuard<'_, EditState>> {
        let mut state = self.lock()?;
        state.expire();
        if !state.reaper_started {
            let weak = Arc::downgrade(self);
            std::thread::Builder::new()
                .name("stackport-edit-expiry".into())
                .spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(30));
                    let Some(manager) = weak.upgrade() else {
                        break;
                    };
                    if let Ok(mut state) = manager.state.lock() {
                        state.expire();
                    };
                })
                .map_err(|e| format!("편집 세션 정리 작업을 시작할 수 없습니다: {e}"))?;
            state.reaper_started = true;
        }
        Ok(state)
    }
}

impl Store {
    /// Read a fresh row and hold an in-memory fingerprint; no database write
    /// or audit event is performed when beginning an edit.
    pub fn begin_cell_edit(
        &self,
        profile_id: &str,
        table: &str,
        keys: Vec<EditKey>,
    ) -> Result<EditSession> {
        let profile = self.profile(profile_id)?;
        if !matches!(profile.environment.as_str(), "DEV" | "STAGING" | "PROD") {
            return Err("유효하지 않은 연결 환경입니다. 수정 전에 연결 설정을 확인하세요.".into());
        }
        let identity = file_handle(&profile.path)?;
        let metadata = file_handle(&self.path)?;
        if identity == metadata {
            return Err("StackPort 작업 공간 파일은 이 기능으로 편집할 수 없습니다.".into());
        }
        let db = open_schema_db(Path::new(&profile.path))?;
        ensure_identity(&identity, &profile.path)?;
        let schema_version = schema_version(&db)?;
        let details = editable_table(&db, table)?;
        let parsed_keys = validate_keys(&details, &keys)?;
        let snapshot = read_row(&db, table, &parsed_keys, &[])?;
        let unique_columns: HashSet<&str> = details
            .indexes
            .iter()
            .filter(|index| index.unique)
            .flat_map(|index| {
                index
                    .columns
                    .iter()
                    .filter_map(|column| column.name.as_deref())
            })
            .collect();
        let mut fields = Vec::with_capacity(snapshot.fields.len());
        let mut plan_fields = Vec::with_capacity(snapshot.fields.len());
        for field in snapshot.fields {
            let column = details
                .columns
                .iter()
                .find(|column| column.name == field.name)
                .ok_or("조회된 열과 테이블 구조가 일치하지 않습니다.")?;
            let reason = if column.primary_key_position > 0 {
                Some("기본 키는 편집할 수 없습니다.")
            } else if unique_columns.contains(column.name.as_str()) {
                Some("고유 키에 속한 열은 편집할 수 없습니다.")
            } else if field.value.is_none() {
                Some("BLOB, 유효하지 않은 문자 또는 긴 값은 아직 편집할 수 없습니다.")
            } else {
                None
            };
            let editable = reason.is_none();
            fields.push(EditField {
                name: field.name.clone(),
                declared_type: column.declared_type.clone(),
                current: field.display,
                editable,
                reason: reason.map(str::to_owned),
            });
            plan_fields.push(FieldValue {
                name: field.name,
                value: field.value,
                editable,
            });
        }
        if !fields.iter().any(|field| field.editable) {
            return Err("이 행에는 현재 편집할 수 있는 열이 없습니다.".into());
        }
        let token = Uuid::new_v4().to_string();
        let session = EditSession {
            token: token.clone(),
            table: table.into(),
            environment: profile.environment.clone(),
            keys,
            fields,
            expires_seconds: SESSION_LIFETIME.as_secs(),
            max_changes: MAX_CHANGES,
        };
        self.edits.active_state()?.pending.insert(
            token,
            PendingEdit {
                profile,
                table: table.into(),
                identity,
                schema_version,
                keys: parsed_keys,
                fingerprint: snapshot.fingerprint,
                fields: plan_fields,
                changes: None,
                created: Instant::now(),
            },
        );
        Ok(session)
    }

    pub fn preview_cell_edit(
        &self,
        token: &str,
        column: &str,
        input: EditInput,
    ) -> Result<EditPreview> {
        self.stage_cell_changes(
            token,
            vec![EditCellChange {
                column: column.into(),
                input,
            }],
            None,
        )?
        .into_iter()
        .next()
        .ok_or_else(|| "미리 볼 변경이 없습니다.".into())
    }

    pub fn preview_row_edit(
        &self,
        token: &str,
        cells: Vec<EditCellChange>,
    ) -> Result<EditRowPreview> {
        let approval = Uuid::new_v4().to_string();
        let changes = self.stage_cell_changes(token, cells, Some(approval.clone()))?;
        Ok(EditRowPreview { approval, changes })
    }

    fn stage_cell_changes(
        &self,
        token: &str,
        cells: Vec<EditCellChange>,
        approval: Option<String>,
    ) -> Result<Vec<EditPreview>> {
        let mut state = self.edits.lock()?;
        let plan = state
            .pending
            .get_mut(token)
            .ok_or("편집 세션이 없거나 만료되었습니다. 행을 다시 선택하세요.")?;
        if plan.created.elapsed() >= SESSION_LIFETIME {
            state.pending.remove(token);
            return Err("편집 세션이 만료되었습니다. 행을 다시 선택하세요.".into());
        }
        // A failed or superseded preview must never leave an older approved
        // change available for application.
        plan.changes = None;
        if cells.is_empty() || cells.len() > MAX_CHANGES {
            return Err(format!(
                "한 행에서 변경할 열을 1~{MAX_CHANGES}개 선택하세요."
            ));
        }
        verify_profile(self, &plan.profile)?;
        ensure_identity(&plan.identity, &plan.profile.path)?;
        let db = open_schema_db(Path::new(&plan.profile.path))?;
        ensure_identity(&plan.identity, &plan.profile.path)?;
        if schema_version(&db)? != plan.schema_version {
            return Err("테이블 구조가 변경되었습니다. 행을 다시 선택하세요.".into());
        }
        let details = editable_table(&db, &plan.table)?;
        let snapshot = read_row(&db, &plan.table, &plan.keys, &[])?;
        if snapshot.fingerprint != plan.fingerprint {
            return Err(
                "편집을 시작한 뒤 행이 변경되었습니다. 새로고침 후 다시 선택하세요.".into(),
            );
        }
        let mut seen = HashSet::with_capacity(cells.len());
        let mut previews = Vec::with_capacity(cells.len());
        let mut changes = Vec::with_capacity(cells.len());
        for EditCellChange { column, input } in cells {
            if !seen.insert(column.clone()) {
                return Err(format!("{column} 열이 중복되었습니다."));
            }
            let field = plan
                .fields
                .iter()
                .find(|field| field.name == column && field.editable)
                .ok_or("선택한 열은 편집할 수 없습니다.")?;
            ensure_column_allowed(&details, &column)?;
            let before = field.value.as_ref().ok_or("이 값은 편집할 수 없습니다.")?;
            let after = parse_input(input).map_err(|error| format!("{column} · {error}"))?;
            if values_equal(before, &after) {
                continue;
            }
            let rendered = display_value(ValueRef::from(&after));
            if rendered.truncated {
                return Err(format!(
                    "{column} 열의 전체 값을 미리 볼 수 있도록 길이를 줄이세요."
                ));
            }
            previews.push(EditPreview {
                column: column.clone(),
                before: display_value(ValueRef::from(before)),
                after: rendered,
            });
            changes.push(Change { column, after });
        }
        if changes.is_empty() {
            return Err("변경할 값이 기존 값과 같습니다.".into());
        }
        plan.changes = Some(ApprovedChanges {
            approval,
            cells: changes,
        });
        Ok(previews)
    }

    /// Apply a previously previewed change once. PROD requires an additional
    /// exact confirmation, and the entire row is checked again under a lock.
    pub fn apply_cell_edit(
        &self,
        token: &str,
        production_confirmation: &str,
    ) -> Result<EditResult> {
        let report = self.apply_staged_cells(token, None, production_confirmation)?;
        let saved = report
            .cells
            .into_iter()
            .next()
            .ok_or("변경 결과를 확인할 수 없습니다.")?;
        Ok(EditResult {
            actual: saved.actual,
            audit_warning: report.audit_warning,
        })
    }

    pub fn apply_row_edit(
        &self,
        token: &str,
        approval: &str,
        production_confirmation: &str,
    ) -> Result<EditRowResult> {
        self.apply_staged_cells(token, Some(approval), production_confirmation)
    }

    fn apply_staged_cells(
        &self,
        token: &str,
        approval: Option<&str>,
        production_confirmation: &str,
    ) -> Result<EditRowResult> {
        let plan = {
            let mut state = self.edits.lock()?;
            let item = state
                .pending
                .get(token)
                .ok_or("편집 세션이 없거나 만료되었습니다. 행을 다시 선택하세요.")?;
            if item.created.elapsed() >= SESSION_LIFETIME {
                state.pending.remove(token);
                return Err("편집 세션이 만료되었습니다. 행을 다시 선택하세요.".into());
            }
            if item.profile.environment == "PROD" && production_confirmation != "PROD" {
                return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
            }
            if !item
                .changes
                .as_ref()
                .is_some_and(|staged| staged.approval.as_deref() == approval)
            {
                return Err("현재 변경 내용을 다시 미리보세요.".into());
            }
            state.pending.remove(token).expect("checked pending edit")
        };
        verify_profile(self, &plan.profile)?;
        let correlation_id = Uuid::new_v4().to_string();
        let changes = &plan.changes.as_ref().expect("preview checked").cells;
        let (operation, target) = if let [change] = changes.as_slice() {
            (
                "sqlite.cell.update",
                format!("{} · {}", plan.table, change.column),
            )
        } else {
            ("sqlite.row.update", plan.table.clone())
        };
        let audit = |outcome, affected_count| AuditRecord {
            correlation_id: &correlation_id,
            operation,
            project_id: Some(&plan.profile.project_id),
            profile_id: Some(&plan.profile.id),
            environment: Some(&plan.profile.environment),
            object_name: Some(&target),
            outcome,
            affected_count,
        };
        insert_audit(&self.connect()?, audit("started", None))?;
        let result = apply_changes(self, &plan, changes);
        let outcome = if result.is_ok() {
            "succeeded"
        } else {
            "failed"
        };
        let audit_result = self
            .connect()
            .and_then(|db| insert_audit(&db, audit(outcome, result.as_ref().ok().map(|_| 1))));
        match (result, audit_result) {
            (Ok(cells), Ok(())) => Ok(EditRowResult {
                cells,
                audit_warning: None,
            }),
            (Ok(cells), Err(_)) => Ok(EditRowResult {
                cells,
                audit_warning: Some(
                    "변경은 저장됐지만 완료 감사 기록을 저장하지 못했습니다.".into(),
                ),
            }),
            (Err(error), Ok(())) => Err(error),
            (Err(error), Err(_)) => Err(format!("{error} 완료 감사 기록도 저장하지 못했습니다.")),
        }
    }

    pub fn cancel_cell_edit(&self, token: &str) -> Result<()> {
        self.edits.lock()?.pending.remove(token);
        Ok(())
    }
}

fn apply_changes(
    store: &Store,
    plan: &PendingEdit,
    changes: &[Change],
) -> Result<Vec<SavedEditCell>> {
    ensure_identity(&plan.identity, &plan.profile.path)?;
    let mut db = open_edit_db(&plan.profile.path)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(super::db_error)?;
    ensure_identity(&plan.identity, &plan.profile.path)?;
    if schema_version(&tx)? != plan.schema_version {
        return Err("테이블 구조가 변경되었습니다. 행을 다시 선택하세요.".into());
    }
    let details = editable_table(&tx, &plan.table)?;
    for change in changes {
        ensure_column_allowed(&details, &change.column)?;
    }
    let columns: Vec<_> = changes
        .iter()
        .map(|change| change.column.as_str())
        .collect();
    let before = read_row(&tx, &plan.table, &plan.keys, &columns)?;
    if before.fingerprint != plan.fingerprint {
        return Err("편집을 시작한 뒤 행이 변경되어 적용하지 않았습니다.".into());
    }
    let (predicate, keys) = key_predicate(&plan.keys);
    let assignments = columns
        .iter()
        .map(|name| format!("{} = ?", quote(name)))
        .collect::<Vec<_>>()
        .join(", ");
    let values = changes
        .iter()
        .map(|change| &change.after)
        .chain(keys.iter());
    let sql = format!(
        "UPDATE OR ABORT main.{} SET {assignments} WHERE {predicate}",
        quote(&plan.table)
    );
    let total_before = tx.total_changes();
    let changed = tx
        .execute(&sql, params_from_iter(values))
        .map_err(super::db_error)?;
    if changed != 1 || tx.total_changes() != total_before + 1 {
        return Err("변경 대상이 한 행이 아니어서 적용하지 않았습니다.".into());
    }
    let after = read_row(&tx, &plan.table, &plan.keys, &columns)?;
    if before.other_fingerprint != after.other_fingerprint {
        return Err("선택한 열 외의 값이 변경되어 롤백했습니다.".into());
    }
    let mut saved = Vec::with_capacity(changes.len());
    for change in changes {
        let actual = after
            .fields
            .iter()
            .find(|field| field.name == change.column)
            .and_then(|field| field.value.as_ref())
            .ok_or("변경 결과를 검증하지 못해 롤백했습니다.")?;
        if !values_equal(actual, &change.after) {
            return Err(format!(
                "SQLite가 {} 열의 값 형식을 변환해 롤백했습니다. 값의 형식을 확인하세요.",
                change.column
            ));
        }
        saved.push(SavedEditCell {
            column: change.column.clone(),
            actual: display_value(ValueRef::from(actual)),
        });
    }
    ensure_identity(&plan.identity, &plan.profile.path)?;
    verify_profile(store, &plan.profile)?;
    tx.commit().map_err(|error| {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
            return format!(
                "제약조건 위반으로 변경을 롤백했습니다. {}",
                super::db_error(error)
            );
        }
        format!(
            "커밋 결과를 확정하지 못했습니다. 재시도 전에 원본을 다시 조회하세요: {}",
            super::db_error(error)
        )
    })?;
    Ok(saved)
}

fn open_edit_db(path: &str) -> Result<Connection> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(super::db_error)?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(super::db_error)?;
    db.pragma_update(None, "foreign_keys", true)
        .map_err(super::db_error)?;
    db.pragma_update(None, "trusted_schema", false)
        .map_err(super::db_error)?;
    Ok(db)
}

fn editable_table(db: &Connection, table: &str) -> Result<ObjectDetails> {
    let details = Store::describe_object_on(db, table)?;
    if details.object.kind != "table" {
        return Err("테이블만 편집할 수 있습니다.".into());
    }
    let table_type: Option<String> = db
        .query_row(
            "SELECT type FROM pragma_table_list WHERE schema='main' AND name=?1",
            [table],
            |row| row.get(0),
        )
        .optional()
        .map_err(super::db_error)?;
    if table_type.as_deref() != Some("table") {
        return Err("가상 테이블과 내부 테이블은 아직 편집할 수 없습니다.".into());
    }
    let triggers: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND tbl_name=?1",
            [table],
            |row| row.get(0),
        )
        .map_err(super::db_error)?;
    if triggers != 0 {
        return Err("트리거가 있는 테이블은 영향 분석을 지원할 때까지 편집할 수 없습니다.".into());
    }
    if details.columns.iter().any(|column| column.hidden != 0) {
        return Err("생성 열 또는 숨김 열이 있는 테이블은 아직 편집할 수 없습니다.".into());
    }
    if !details
        .columns
        .iter()
        .any(|column| column.primary_key_position > 0)
    {
        return Err("기본 키가 없는 테이블은 읽기 전용입니다.".into());
    }
    Ok(details)
}

fn ensure_column_allowed(details: &ObjectDetails, name: &str) -> Result<()> {
    let column = details
        .columns
        .iter()
        .find(|column| column.name == name)
        .ok_or("열을 찾을 수 없습니다.")?;
    if column.primary_key_position > 0
        || column.hidden != 0
        || details
            .indexes
            .iter()
            .filter(|index| index.unique)
            .any(|index| {
                index
                    .columns
                    .iter()
                    .any(|field| field.name.as_deref() == Some(name))
            })
    {
        return Err("기본 키, 고유 키 또는 생성 열은 편집할 수 없습니다.".into());
    }
    Ok(())
}

fn validate_keys(details: &ObjectDetails, input: &[EditKey]) -> Result<Vec<(String, Value)>> {
    let mut columns: Vec<_> = details
        .columns
        .iter()
        .filter(|column| column.primary_key_position > 0)
        .collect();
    columns.sort_by_key(|column| column.primary_key_position);
    if input.len() != columns.len() {
        return Err("기본 키 전체를 지정해야 합니다.".into());
    }
    columns
        .into_iter()
        .map(|column| {
            let matches: Vec<_> = input.iter().filter(|key| key.name == column.name).collect();
            if matches.len() != 1 {
                return Err("기본 키가 누락되었거나 중복되었습니다.".into());
            }
            let value = parse_input(EditInput {
                kind: matches[0].kind.clone(),
                value: matches[0].value.clone(),
            })?;
            if matches!(value, Value::Null | Value::Blob(_)) {
                return Err("NULL 또는 BLOB 기본 키는 아직 편집할 수 없습니다.".into());
            }
            Ok((column.name.clone(), value))
        })
        .collect()
}

fn parse_input(input: EditInput) -> Result<Value> {
    match input.kind.as_str() {
        "null" => Ok(Value::Null),
        "text" => Ok(Value::Text(input.value)),
        "integer" => input
            .value
            .trim()
            .parse::<i64>()
            .map(Value::Integer)
            .map_err(|_| "유효한 64비트 정수를 입력하세요.".into()),
        "real" => {
            let value = input
                .value
                .trim()
                .parse::<f64>()
                .map_err(|_| "유효한 실수를 입력하세요.")?;
            if !value.is_finite() {
                return Err("유한한 실수를 입력하세요.".into());
            }
            Ok(Value::Real(value))
        }
        _ => Err("지원하지 않는 값 형식입니다.".into()),
    }
}

struct SnapshotField {
    name: String,
    display: Cell,
    value: Option<Value>,
}
struct RowSnapshot {
    fingerprint: [u8; 32],
    other_fingerprint: [u8; 32],
    fields: Vec<SnapshotField>,
}

fn read_row(
    db: &Connection,
    table: &str,
    keys: &[(String, Value)],
    exclude: &[&str],
) -> Result<RowSnapshot> {
    let (predicate, values) = key_predicate(keys);
    let sql = format!(
        "SELECT * FROM main.{} WHERE {predicate} LIMIT 2",
        quote(table)
    );
    let mut statement = db.prepare(&sql).map_err(super::db_error)?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let mut rows = statement
        .query(params_from_iter(values.iter()))
        .map_err(super::db_error)?;
    let row = rows
        .next()
        .map_err(super::db_error)?
        .ok_or("기본 키에 해당하는 행을 찾을 수 없습니다. 새로고침하세요.")?;
    let mut all = Sha256::new();
    let mut others = Sha256::new();
    let mut fields = Vec::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        let value = row.get_ref(index).map_err(super::db_error)?;
        hash_value(&mut all, name, value);
        if !exclude.contains(&name.as_str()) {
            hash_value(&mut others, name, value);
        }
        let display = display_value(value);
        let owned = if display.truncated {
            None
        } else {
            owned_value(value)
        };
        fields.push(SnapshotField {
            name: name.clone(),
            display,
            value: owned,
        });
    }
    if rows.next().map_err(super::db_error)?.is_some() {
        return Err("기본 키가 한 행을 식별하지 못합니다. 변경할 수 없습니다.".into());
    }
    Ok(RowSnapshot {
        fingerprint: all.finalize().into(),
        other_fingerprint: others.finalize().into(),
        fields,
    })
}

fn hash_value(hash: &mut Sha256, name: &str, value: ValueRef<'_>) {
    hash.update((name.len() as u64).to_be_bytes());
    hash.update(name.as_bytes());
    match value {
        ValueRef::Null => hash.update([0]),
        ValueRef::Integer(value) => {
            hash.update([1]);
            hash.update(value.to_be_bytes());
        }
        ValueRef::Real(value) => {
            hash.update([2]);
            hash.update(value.to_bits().to_be_bytes());
        }
        ValueRef::Text(value) => {
            hash.update([3]);
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        }
        ValueRef::Blob(value) => {
            hash.update([4]);
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        }
    }
}

fn owned_value(value: ValueRef<'_>) -> Option<Value> {
    match value {
        ValueRef::Null => Some(Value::Null),
        ValueRef::Integer(value) => Some(Value::Integer(value)),
        ValueRef::Real(value) if value.is_finite() => Some(Value::Real(value)),
        ValueRef::Text(value) => std::str::from_utf8(value)
            .ok()
            .map(|text| Value::Text(text.to_owned())),
        _ => None,
    }
}

fn key_predicate(keys: &[(String, Value)]) -> (String, Vec<Value>) {
    let mut clauses = Vec::with_capacity(keys.len());
    let mut values = Vec::with_capacity(keys.len() * 2);
    for (name, value) in keys {
        clauses.push(format!(
            "typeof({}) = ? AND {} COLLATE BINARY IS ?",
            quote(name),
            quote(name)
        ));
        let kind = match value {
            Value::Integer(_) => "integer",
            Value::Real(_) => "real",
            Value::Text(_) => "text",
            Value::Null => "null",
            Value::Blob(_) => "blob",
        };
        values.push(Value::Text(kind.into()));
        values.push(value.clone());
    }
    (clauses.join(" AND "), values)
}

fn schema_version(db: &Connection) -> Result<i64> {
    db.pragma_query_value(None, "schema_version", |row| row.get(0))
        .map_err(super::db_error)
}
fn file_handle(path: impl AsRef<Path>) -> Result<Handle> {
    Handle::from_path(path).map_err(|e| format!("데이터베이스 파일을 확인할 수 없습니다: {e}"))
}
fn ensure_identity(expected: &Handle, path: &str) -> Result<()> {
    if &file_handle(path)? != expected {
        Err("데이터베이스 파일이 교체되어 변경을 중단했습니다.".into())
    } else {
        Ok(())
    }
}
fn verify_profile(store: &Store, profile: &Profile) -> Result<()> {
    let current = store.profile(&profile.id)?;
    if current.project_id != profile.project_id
        || current.path != profile.path
        || current.environment != profile.environment
    {
        return Err("연결 설정이 변경되어 편집을 중단했습니다.".into());
    }
    Ok(())
}
fn wipe_value(value: &mut Value) {
    match value {
        Value::Text(text) => text.zeroize(),
        Value::Blob(bytes) => bytes.zeroize(),
        _ => {}
    }
}

fn values_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Real(a), Value::Real(b)) => a.to_bits() == b.to_bits(),
        _ => left == right,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_edit_cannot_be_previewed_or_applied() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.sqlite");
        Connection::open(&source).unwrap().execute_batch("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'old');").unwrap();
        let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
        let project = store.create_project("test").unwrap();
        let profile = store
            .create_sqlite_profile(&project.id, "db", source.to_str().unwrap(), "DEV")
            .unwrap();
        let session = store
            .begin_cell_edit(
                &profile.id,
                "items",
                vec![EditKey {
                    name: "id".into(),
                    kind: "integer".into(),
                    value: "1".into(),
                }],
            )
            .unwrap();
        {
            let mut state = store.edits.lock().unwrap();
            state.pending.get_mut(&session.token).unwrap().created =
                Instant::now() - SESSION_LIFETIME;
        }
        assert!(store
            .preview_cell_edit(
                &session.token,
                "value",
                EditInput {
                    kind: "text".into(),
                    value: "new".into()
                }
            )
            .is_err());
        assert!(store.apply_cell_edit(&session.token, "").is_err());
        assert_eq!(
            Connection::open(source)
                .unwrap()
                .query_row("SELECT value FROM items", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "old"
        );
    }
}
