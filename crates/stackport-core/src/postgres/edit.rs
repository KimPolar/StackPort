use super::{
    catalog,
    parameters::Value,
    session::{field, pg_error, secret, Cell},
    PostgresProfile,
};
use crate::{insert_audit, quote_identifier as quote, AuditRecord, Result, Store};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use tokio::time::timeout;
use tokio_postgres::types::ToSql;
use tokio_postgres::{Client, Error, IsolationLevel, Row, Transaction};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

pub(super) mod row;

pub(super) const LIFETIME: Duration = Duration::from_secs(300);
const DEADLINE: Duration = Duration::from_secs(12);
const VALUE_LIMIT: usize = 4096;
const KEY_LIMIT: usize = 512;
const CELL_LIMIT: usize = 16;
const STALE: &str = "행이 변경되었거나 편집 권한이 달라졌습니다. 다시 조회하세요.";
pub(super) const EXPIRED: &str = "편집 세션이 만료되었습니다. 행을 다시 선택하세요.";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresRowStamp {
    tuple: String,
    version: String,
    keys: Vec<String>,
}

impl PostgresRowStamp {
    const PROJECTION: &str = "ctid::pg_catalog.text, xmin::pg_catalog.text";

    fn check(&self, row: &Row, offset: usize) -> Result<()> {
        if field::<String>(row, offset)? != self.tuple
            || field::<String>(row, offset + 1)? != self.version
        {
            return Err(STALE.into());
        }
        Ok(())
    }

    fn values(&self) -> Vec<Value> {
        self.keys.iter().cloned().map(bind).collect()
    }
}

impl Drop for PostgresRowStamp {
    fn drop(&mut self) {
        self.keys.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PostgresEditInput {
    Text {
        #[serde(deserialize_with = "secret")]
        value: Zeroizing<String>,
    },
    Null,
    Default,
}

#[derive(Serialize)]
pub struct PostgresEditSession {
    token: String,
    table: String,
    keys: Vec<(String, String)>,
    columns: Vec<String>,
    #[serde(flatten)]
    first: PostgresEditField,
}

#[derive(Serialize)]
pub struct PostgresEditField {
    column: String,
    data_type: String,
    current: Cell,
    nullable: bool,
    default_sql: Option<String>,
}

#[derive(Serialize)]
pub struct PostgresEditPreview {
    approval: String,
    before: Cell,
    after: Cell,
    use_default: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresCellChange {
    pub(super) column: String,
    pub(super) input: PostgresEditInput,
}

#[derive(Serialize)]
pub struct PostgresRowEditPreview {
    approval: String,
    changes: Vec<CellPreview>,
}

#[derive(Serialize)]
struct CellPreview {
    column: String,
    before: Cell,
    after: Cell,
    default_sql: Option<String>,
}

impl PostgresRowEditPreview {
    pub(super) fn single(self) -> Result<PostgresEditPreview> {
        let change = self
            .changes
            .into_iter()
            .next()
            .ok_or("미리 볼 변경이 없습니다.")?;
        Ok(PostgresEditPreview {
            approval: self.approval,
            before: change.before,
            after: change.after,
            use_default: change.default_sql.is_some(),
        })
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PostgresEditOutcome {
    Applied {
        actual: Cell,
        affected_cells: usize,
        audit_warning: bool,
    },
    Unknown,
}

#[derive(Clone, PartialEq, Eq)]
struct Attribute {
    name: String,
    number: i16,
    data_type: String,
    type_oid: i64,
    typmod: i32,
    nullable: bool,
    default_sql: Option<String>,
    default_oid: Option<i64>,
    identity: String,
}

impl Attribute {
    fn supported(&self) -> bool {
        matches!(
            self.type_oid,
            16 | 20
                | 21
                | 23
                | 25
                | 114
                | 142
                | 700
                | 701
                | 1042
                | 1043
                | 1082
                | 1083
                | 1114
                | 1184
                | 1186
                | 1266
                | 1700
                | 2950
                | 3802
        )
    }

    fn insertable(&self) -> bool {
        self.supported() && self.identity != "a"
    }

    fn required_for_insert(&self) -> bool {
        !self.nullable && self.default_sql.is_none() && self.identity.is_empty()
    }
}

pub(super) enum Access {
    Blocked(&'static str),
    Allowed(EditTable),
}

pub(super) struct EditTable {
    key: Vec<Attribute>,
    columns: Vec<Attribute>,
    shape: Vec<Attribute>,
    can_update: bool,
    can_insert: bool,
    can_delete: bool,
    delete_cascades: bool,
}

impl Access {
    fn allowed(self) -> Result<EditTable> {
        match self {
            Self::Allowed(table) => Ok(table),
            Self::Blocked(reason) => Err(reason.into()),
        }
    }
}

impl EditTable {
    pub(super) fn update_reason(&self) -> Option<&'static str> {
        if !self.can_update {
            return Some("이 테이블에 UPDATE 권한이 없습니다.");
        }
        self.columns
            .is_empty()
            .then_some("이 테이블에 편집 가능한 열이 없습니다.")
    }

    pub(super) fn allow_insert(&self) -> bool {
        self.can_insert
            && !self
                .shape
                .iter()
                .any(|column| column.required_for_insert() && !column.insertable())
    }

    pub(super) fn allow_paste(&self) -> bool {
        self.allow_insert() && self.shape.iter().any(Attribute::insertable)
    }

    pub(super) fn allow_delete(&self) -> bool {
        self.can_delete && !self.delete_cascades
    }

    pub(super) fn delete_reason(&self) -> Option<&'static str> {
        (self.can_delete && self.delete_cascades)
            .then_some("연쇄 변경을 일으키는 외래 키가 있어 그리드에서 삭제할 수 없습니다.")
    }

    pub(super) fn editable(&self, name: &str) -> bool {
        self.can_update && self.columns.iter().any(|column| column.name == name)
    }

    pub(super) fn row_projection(&self) -> String {
        self.key
            .iter()
            .map(|key| bounded(&key.name, KEY_LIMIT))
            .chain([PostgresRowStamp::PROJECTION.to_owned()])
            .collect::<Vec<_>>()
            .join(", ")
    }

    pub(super) fn stamp(&self, row: &Row, offset: usize) -> Result<Option<PostgresRowStamp>> {
        let mut keys = Vec::with_capacity(self.key.len());
        for index in offset..offset + self.key.len() {
            let mut value: String = field(row, index)?;
            if value.chars().take(KEY_LIMIT + 1).count() > KEY_LIMIT || value.contains('\0') {
                value.zeroize();
                keys.zeroize();
                return Ok(None);
            }
            keys.push(value);
        }
        Ok(Some(PostgresRowStamp {
            tuple: field(row, offset + keys.len())?,
            version: field(row, offset + keys.len() + 1)?,
            keys,
        }))
    }
}

pub(super) async fn access(tx: &Transaction<'_>, object: i64, kind: &str) -> Result<Access> {
    if kind != "table" {
        return Ok(Access::Blocked(
            "일반 테이블만 그리드에서 편집할 수 있습니다.",
        ));
    }
    let row = tx.query_one(
        "SELECT pg_catalog.pg_is_in_recovery(), NOT c.relispartition AND am.amname = 'heap'
                    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid OR i.inhparent = c.oid),
                NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)
                    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class = c.oid)
                    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped AND a.attgenerated <> ''),
                pg_catalog.has_table_privilege(c.oid,'UPDATE'), pg_catalog.has_table_privilege(c.oid,'INSERT'),
                pg_catalog.has_table_privilege(c.oid,'DELETE'),
                EXISTS (SELECT 1 FROM pg_catalog.pg_constraint fk WHERE fk.contype='f' AND fk.confrelid=c.oid AND fk.confdeltype IN ('c','n','d'))
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_am am ON am.oid = c.relam WHERE c.oid::bigint = $1",
        &[&object],
    ).await.map_err(pg_error)?;
    if field::<bool>(&row, 0)? {
        return Ok(Access::Blocked("읽기 복제본에서는 편집할 수 없습니다."));
    }
    if !field::<bool>(&row, 1)? || !field::<bool>(&row, 2)? {
        return Ok(Access::Blocked(
            "상속·파티션·사용자 트리거·규칙·생성 열이 없는 일반 힙 테이블만 편집할 수 있습니다.",
        ));
    }
    let can_update = field(&row, 3)?;
    let can_insert = field(&row, 4)?;
    let can_delete = field(&row, 5)?;
    let delete_cascades = field(&row, 6)?;
    if !(can_update || can_insert || can_delete) {
        return Ok(Access::Blocked("이 테이블에 UPDATE 권한이 없습니다."));
    }

    let rows = tx.query(
        "SELECT a.attname::text, a.attnum, pg_catalog.format_type(a.atttypid, a.atttypmod),
                a.atttypid::bigint, a.atttypmod, NOT a.attnotnull,
                pg_catalog.left(pg_catalog.pg_get_expr(d.adbin,d.adrelid), 4097),
                keys.position,
                a.attidentity = '' AND NOT EXISTS (
                    SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = a.attrelid AND i.indisunique
                    AND EXISTS (SELECT 1 FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinality)
                                WHERE k.ordinality <= i.indnkeyatts AND k.attnum = a.attnum)
                ), d.oid::bigint, a.attidentity::text
         FROM pg_catalog.pg_attribute a
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN LATERAL (
           SELECT k.ordinality::integer AS position FROM pg_catalog.pg_index i
           CROSS JOIN pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinality)
           WHERE i.indrelid = a.attrelid AND i.indisprimary AND i.indisvalid AND i.indisready AND i.indimmediate
                 AND k.ordinality <= i.indnkeyatts AND k.attnum = a.attnum
         ) keys ON true
         WHERE a.attrelid::bigint = $1 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum", &[&object],
    ).await.map_err(pg_error)?;
    let mut keys = Vec::new();
    let mut columns = Vec::new();
    let mut shape = Vec::new();
    for row in rows {
        let column = Attribute {
            name: field(&row, 0)?,
            number: field(&row, 1)?,
            data_type: field(&row, 2)?,
            type_oid: field(&row, 3)?,
            typmod: field(&row, 4)?,
            nullable: field(&row, 5)?,
            default_sql: field(&row, 6)?,
            default_oid: field(&row, 9)?,
            identity: field(&row, 10)?,
        };
        if let Some(position) = field::<Option<i32>>(&row, 7)? {
            if !column.supported() || column.nullable {
                return Ok(Access::Blocked(
                    "기본 키의 데이터 타입을 안전하게 편집할 수 없습니다.",
                ));
            }
            keys.push((position, column.clone()));
        } else if can_update && column.supported() && field::<bool>(&row, 8)? {
            columns.push(column.clone());
        }
        shape.push(column);
    }
    if keys.is_empty() {
        return Ok(Access::Blocked(
            "편집하려면 즉시 검증되는 기본 키가 필요합니다.",
        ));
    }
    keys.sort_by_key(|(index, _)| *index);
    Ok(Access::Allowed(EditTable {
        key: keys.into_iter().map(|(_, key)| key).collect(),
        columns,
        shape,
        can_update,
        can_insert,
        can_delete,
        delete_cascades,
    }))
}

pub(super) struct Plan {
    pub token: Uuid,
    pub created: Instant,
    object: i64,
    table: String,
    fields: Vec<Attribute>,
    key: Vec<Attribute>,
    stamp: PostgresRowStamp,
    change: Option<Approved>,
}

struct Approved {
    approval: Uuid,
    cells: Vec<Change>,
}

struct Change {
    column: String,
    input: PostgresEditInput,
    normalized: Option<Zeroizing<String>>,
}

impl Plan {
    pub(super) fn approved(&self, approval: Uuid) -> bool {
        self.change
            .as_ref()
            .is_some_and(|change| change.approval == approval)
    }

    pub(super) fn clear_preview(&mut self) {
        self.change = None;
    }

    pub(super) fn first_column(&self) -> String {
        self.fields[0].name.clone()
    }

    fn checked_field(&self, table: &EditTable, column: &str) -> Result<&Attribute> {
        let old = self
            .fields
            .iter()
            .find(|field| field.name == column)
            .ok_or("선택한 열을 다시 열어 현재 값을 확인하세요.")?;
        if !table.columns.contains(old) {
            return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
        }
        Ok(old)
    }
}

pub(super) async fn begin(
    client: &mut Client,
    object: i64,
    stamp: PostgresRowStamp,
    column: &str,
) -> Result<(Plan, PostgresEditSession)> {
    if stamp.tuple.len() > 32 || stamp.version.parse::<u32>().is_err() {
        return Err(STALE.into());
    }
    let tx = client
        .build_transaction()
        .read_only(true)
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(pg_error)?;
    let relation = catalog::relation(&tx, object).await?;
    let edit = access(&tx, object, relation.kind).await?.allowed()?;
    if let Some(reason) = edit.update_reason() {
        return Err(reason.into());
    }
    let columns = edit
        .columns
        .iter()
        .map(|field| field.name.clone())
        .collect();
    let column = edit
        .columns
        .into_iter()
        .find(|field| field.name == column)
        .ok_or("선택한 열은 편집할 수 없습니다.")?;
    let table = format!("{}.{}", quote(&relation.schema), quote(&relation.name));
    let keys = edit.key;
    if stamp.keys.len() != keys.len()
        || stamp.keys.iter().any(|value| {
            value.chars().take(KEY_LIMIT + 1).count() > KEY_LIMIT || value.contains('\0')
        })
    {
        return Err("행의 기본 키를 확인할 수 없습니다. 다시 조회하세요.".into());
    }
    let plan = Plan {
        token: Uuid::new_v4(),
        object,
        table,
        fields: vec![column],
        key: keys,
        stamp,
        created: Instant::now(),
        change: None,
    };
    let first = read_field(&tx, &plan, &plan.fields[0]).await?;
    tx.commit().await.map_err(pg_error)?;
    let ui = PostgresEditSession {
        token: plan.token.to_string(),
        table: plan.table.clone(),
        keys: plan
            .key
            .iter()
            .zip(plan.stamp.keys.iter())
            .map(|(key, value)| (key.name.clone(), value.clone()))
            .collect(),
        columns,
        first,
    };
    Ok((plan, ui))
}

pub(super) async fn open_field(
    client: &mut Client,
    plan: &mut Plan,
    column: &str,
) -> Result<PostgresEditField> {
    let tx = client
        .build_transaction()
        .read_only(true)
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(pg_error)?;
    let table = recheck(&tx, plan).await?;
    let field = table
        .columns
        .into_iter()
        .find(|field| field.name == column)
        .ok_or("선택한 열은 편집할 수 없습니다.")?;
    let stored = plan.fields.iter().find(|item| item.name == column);
    if stored.is_some_and(|old| old != &field) {
        return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
    }
    let response = read_field(&tx, plan, &field).await?;
    tx.commit().await.map_err(pg_error)?;
    if stored.is_none() {
        plan.fields.push(field);
    }
    Ok(response)
}

pub(super) async fn preview(
    client: &mut Client,
    plan: &mut Plan,
    inputs: Vec<PostgresCellChange>,
) -> Result<PostgresRowEditPreview> {
    if inputs.is_empty() || inputs.len() > CELL_LIMIT {
        return Err("한 행에서 1~16개 셀의 변경을 선택하세요.".into());
    }
    let tx = client
        .build_transaction()
        .read_only(true)
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(pg_error)?;
    let table = recheck(&tx, plan).await?;
    let mut seen = HashSet::new();
    let mut projection = Vec::with_capacity(inputs.len() * 2);
    let mut values = plan.stamp.values();
    for change in &inputs {
        if !seen.insert(change.column.as_str()) {
            return Err("같은 열을 두 번 변경할 수 없습니다.".into());
        }
        let column = plan.checked_field(&table, &change.column)?;
        projection.push(bounded(&column.name, VALUE_LIMIT));
        projection.push(preview_expression(column, &change.input, &mut values)?);
    }
    let row = read_row(&tx, plan, &projection.join(", "), &values).await?;
    plan.stamp.check(&row, projection.len())?;
    let mut changes = Vec::new();
    let mut staged = Vec::new();
    for (index, change) in inputs.into_iter().enumerate() {
        let before = cell(field(&row, index * 2)?)?;
        let after = cell(field(&row, index * 2 + 1)?)?;
        let default_sql = if matches!(change.input, PostgresEditInput::Default) {
            visible_default(plan.checked_field(&table, &change.column)?).map(str::to_owned)
        } else {
            None
        };
        if default_sql.is_none() && before.value == after.value {
            continue;
        }
        staged.push(Change {
            column: change.column.clone(),
            input: change.input,
            normalized: after
                .value
                .as_ref()
                .map(|value| Zeroizing::new(value.clone())),
        });
        changes.push(CellPreview {
            column: change.column,
            before,
            after,
            default_sql,
        });
    }
    if changes.is_empty() {
        return Err("변경할 값이 기존 값과 같습니다.".into());
    }
    tx.commit().await.map_err(pg_error)?;
    let approval = Uuid::new_v4();
    plan.change = Some(Approved {
        approval,
        cells: staged,
    });
    Ok(PostgresRowEditPreview {
        approval: approval.to_string(),
        changes,
    })
}

fn preview_expression(
    column: &Attribute,
    input: &PostgresEditInput,
    values: &mut Vec<Value>,
) -> Result<String> {
    Ok(match cast_input(column, input, values)? {
        Some(expression) => format!(
            "pg_catalog.left(({expression})::pg_catalog.text, {})",
            VALUE_LIMIT + 1
        ),
        None => "NULL::pg_catalog.text".into(),
    })
}

fn cast_input(
    column: &Attribute,
    input: &PostgresEditInput,
    values: &mut Vec<Value>,
) -> Result<Option<String>> {
    let fail = |reason: &str| format!("{} · {reason}", column.name);
    match input {
        PostgresEditInput::Null if !column.nullable => {
            Err(fail("이 열에는 NULL을 저장할 수 없습니다."))
        }
        PostgresEditInput::Default if visible_default(column).is_none() => {
            Err(fail("확인할 수 있는 서버 기본값이 없습니다."))
        }
        PostgresEditInput::Null | PostgresEditInput::Default => Ok(None),
        PostgresEditInput::Text { value } => {
            let chars = value.chars().take(VALUE_LIMIT + 1).count();
            if chars > VALUE_LIMIT || value.contains('\0') {
                return Err(fail("변경 값은 NUL 문자 없이 4096자 이하여야 합니다."));
            }
            if matches!(column.type_oid, 1042 | 1043)
                && column.typmod >= 4
                && chars > (column.typmod - 4) as usize
            {
                return Err(fail("문자열이 열의 길이 제한을 초과합니다."));
            }
            values.push(bind(value.to_string()));
            Ok(Some(format!("${}::{}", values.len(), column.data_type)))
        }
    }
}

pub(super) async fn apply(
    client: &mut Client,
    store: &Store,
    profile: &PostgresProfile,
    plan: Plan,
) -> Result<PostgresEditOutcome> {
    let affected_cells = plan
        .change
        .as_ref()
        .ok_or("변경 내용을 먼저 미리 보세요.")?
        .cells
        .len();
    let operation = if affected_cells == 1 {
        "postgres.edit.cell"
    } else {
        "postgres.edit.row"
    };
    audit(store, profile, plan.token, operation, None, "started", 1).await?;
    let attempted = timeout(DEADLINE, update(client, &plan)).await;
    let (tx, actual) = match attempted {
        Ok(Ok(result)) => result,
        other => {
            let _ = audit(store, profile, plan.token, operation, None, "failed", 1).await;
            return match other {
                Ok(Err(error)) => Err(error),
                _ => Err("행 변경 시간이 초과되었습니다. 다시 조회하세요.".into()),
            };
        }
    };
    match commit(tx).await {
        Ok(true) => Ok(PostgresEditOutcome::Applied {
            actual,
            affected_cells,
            audit_warning: audit(store, profile, plan.token, operation, None, "succeeded", 1)
                .await
                .is_err(),
        }),
        Err(error) => {
            let _ = audit(store, profile, plan.token, operation, None, "failed", 1).await;
            Err(error)
        }
        Ok(false) => Ok(PostgresEditOutcome::Unknown),
    }
}

async fn commit(tx: Transaction<'_>) -> Result<bool> {
    match timeout(DEADLINE, tx.commit()).await {
        Ok(Ok(())) => Ok(true),
        Ok(Err(error))
            if error.code().is_some_and(|code| {
                matches!(&code.code()[..2], "23" | "40") && code.code() != "40003"
            }) =>
        {
            Err(write_error(error))
        }
        _ => Ok(false),
    }
}

async fn update<'a>(client: &'a mut Client, plan: &Plan) -> Result<(Transaction<'a>, Cell)> {
    let tx = client
        .build_transaction()
        .read_only(false)
        .isolation_level(IsolationLevel::ReadCommitted)
        .start()
        .await
        .map_err(write_error)?;
    tx.batch_execute(&format!(
        "LOCK TABLE ONLY {} IN SHARE UPDATE EXCLUSIVE MODE",
        plan.table
    ))
    .await
    .map_err(write_error)?;
    let table = recheck(&tx, plan).await?;
    let change = plan
        .change
        .as_ref()
        .ok_or("변경 내용을 먼저 미리 보세요.")?;
    for cell in &change.cells {
        plan.checked_field(&table, &cell.column)?;
    }
    let mut values = plan.stamp.values();
    let predicate = predicate(plan);
    let lock = format!(
        "SELECT {} FROM ONLY {} WHERE {predicate} FOR UPDATE",
        PostgresRowStamp::PROJECTION,
        plan.table
    );
    let row = exactly_one(&mut query(&tx, &lock, &values).await?)?;
    plan.stamp.check(&row, 0)?;
    let mut assignments = Vec::with_capacity(change.cells.len());
    let mut returned = Vec::with_capacity(change.cells.len());
    for cell in &change.cells {
        let expression = match &cell.input {
            PostgresEditInput::Default => "DEFAULT".into(),
            PostgresEditInput::Null => "NULL".into(),
            PostgresEditInput::Text { value } => {
                values.push(bind(value.to_string()));
                format!("${}", values.len())
            }
        };
        assignments.push(format!("{} = {expression}", quote(&cell.column)));
        returned.push(bounded(&cell.column, VALUE_LIMIT));
    }
    let sql = format!(
        "UPDATE ONLY {} SET {} WHERE {predicate} RETURNING {}",
        plan.table,
        assignments.join(", "),
        returned.join(", "),
    );
    let row = exactly_one(&mut query(&tx, &sql, &values).await?)?;
    let mut first = None;
    for (index, change) in change.cells.iter().enumerate() {
        let actual = cell(field(&row, index)?)?;
        if !matches!(change.input, PostgresEditInput::Default)
            && actual.value.as_deref() != change.normalized.as_ref().map(|value| value.as_str())
        {
            return Err(format!(
                "{} · 서버의 변경 결과가 미리보기와 달라 롤백했습니다.",
                change.column
            ));
        }
        if index == 0 {
            first = Some(actual);
        }
    }
    Ok((tx, first.ok_or("서버에서 확인할 변경이 없습니다.")?))
}

async fn recheck(tx: &Transaction<'_>, plan: &Plan) -> Result<EditTable> {
    let relation = catalog::relation(tx, plan.object).await?;
    if format!("{}.{}", quote(&relation.schema), quote(&relation.name)) != plan.table {
        return Err(STALE.into());
    }
    let edit = access(tx, plan.object, relation.kind).await?.allowed()?;
    if let Some(reason) = edit.update_reason() {
        return Err(reason.into());
    }
    if plan.key != edit.key {
        return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
    }
    Ok(edit)
}

fn predicate(plan: &Plan) -> String {
    key_predicate(plan.object, &plan.key)
}

fn key_predicate(object: i64, keys: &[Attribute]) -> String {
    let mut where_sql = format!("tableoid::bigint = {object}");
    for (index, key) in keys.iter().enumerate() {
        where_sql.push_str(&format!(" AND {} = ${}", quote(&key.name), index + 1));
    }
    where_sql
}

async fn read_field(
    tx: &Transaction<'_>,
    plan: &Plan,
    column: &Attribute,
) -> Result<PostgresEditField> {
    let row = read_row(
        tx,
        plan,
        &bounded(&column.name, VALUE_LIMIT),
        &plan.stamp.values(),
    )
    .await?;
    plan.stamp.check(&row, 1)?;
    Ok(PostgresEditField {
        column: column.name.clone(),
        data_type: column.data_type.clone(),
        nullable: column.nullable,
        current: cell(field(&row, 0)?)?,
        default_sql: visible_default(column).map(str::to_owned),
    })
}

async fn read_row(
    tx: &Transaction<'_>,
    plan: &Plan,
    projection: &str,
    values: &[Value],
) -> Result<Row> {
    let sql = format!(
        "SELECT {projection}, {} FROM ONLY {} WHERE {}",
        PostgresRowStamp::PROJECTION,
        plan.table,
        predicate(plan)
    );
    exactly_one(&mut query(tx, &sql, values).await?)
}

fn visible_default(column: &Attribute) -> Option<&str> {
    column
        .default_sql
        .as_deref()
        .filter(|sql| sql.chars().take(VALUE_LIMIT + 1).count() <= VALUE_LIMIT)
}

fn bind(value: String) -> Value {
    Value::Text {
        value: Zeroizing::new(value),
    }
}

fn bounded(column: &str, limit: usize) -> String {
    format!(
        "pg_catalog.left({}::pg_catalog.text, {})",
        quote(column),
        limit + 1
    )
}

fn cell(mut value: Option<String>) -> Result<Cell> {
    if let Some(text) = value.as_mut() {
        if text.chars().take(VALUE_LIMIT + 1).count() > VALUE_LIMIT {
            text.zeroize();
            return Err("전체 값을 표시할 수 없는 긴 셀은 편집할 수 없습니다.".into());
        }
    }
    Ok(Cell {
        value,
        truncated: false,
    })
}

fn exactly_one(rows: &mut Vec<Row>) -> Result<Row> {
    if rows.len() != 1 {
        return Err(STALE.into());
    }
    rows.pop().ok_or_else(|| STALE.into())
}

async fn query(tx: &Transaction<'_>, sql: &str, values: &[impl ToSql + Sync]) -> Result<Vec<Row>> {
    let stmt = tx.prepare(sql).await.map_err(write_error)?;
    let portal = tx
        .bind_raw(&stmt, values.iter())
        .await
        .map_err(write_error)?;
    tx.query_portal(&portal, 0).await.map_err(write_error)
}

fn write_error(error: Error) -> String {
    match error.code().map(|code| code.code()) {
        Some("42501" | "25006") => "서버가 행 변경 권한을 거부했습니다.".into(),
        Some("55P03" | "40P01" | "40001") => {
            "다른 작업과 충돌했습니다. 행을 다시 조회하세요.".into()
        }
        Some(code) if code.starts_with("22") => "열 타입에 맞는 값과 범위를 확인하세요.".into(),
        Some(code) if code.starts_with("23") => {
            format!("PostgreSQL 제약조건이 변경을 거부했습니다 (SQLSTATE {code}).")
        }
        _ => pg_error(error),
    }
}

async fn audit(
    store: &Store,
    profile: &PostgresProfile,
    token: Uuid,
    operation: &'static str,
    object: Option<&str>,
    outcome: &'static str,
    rows: usize,
) -> Result<()> {
    let store = store.clone();
    let profile = profile.clone();
    let object = object.map(str::to_owned);
    tokio::task::spawn_blocking(move || {
        if outcome == "started"
            && (store.postgres_profile(&profile.id)? != profile
                || !store
                    .list_projects()?
                    .iter()
                    .any(|project| project.id == profile.project_id))
        {
            return Err("PostgreSQL 연결 또는 프로젝트가 변경되었습니다. 다시 연결하세요.".into());
        }
        insert_audit(
            &store.connect()?,
            AuditRecord {
                correlation_id: &token.to_string(),
                operation,
                project_id: Some(&profile.project_id),
                profile_id: Some(&profile.id),
                environment: Some(&profile.settings.environment),
                object_name: object.as_deref(),
                outcome,
                affected_count: (outcome == "succeeded").then_some(rows as i64),
            },
        )
        .map_err(|_| "PostgreSQL 변경의 작업 기록을 저장할 수 없습니다.".into())
    })
    .await
    .map_err(|_| "PostgreSQL 변경의 작업 기록을 저장할 수 없습니다.")?
}
