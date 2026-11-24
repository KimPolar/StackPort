use super::{
    catalog,
    parameters::Value,
    session::{field, pg_error, secret, Cell},
    PostgresProfile,
};
use crate::{insert_audit, quote_identifier as quote, AuditRecord, Result, Store};
use bytes::BytesMut;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fmt,
    time::{Duration, Instant},
};
use tokio::time::timeout;
use tokio_postgres::types::{to_sql_checked, BorrowToSql, FromSql, IsNull, ToSql, Type};
use tokio_postgres::{Client, Error, IsolationLevel, Row, Transaction};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

pub(super) mod grid;
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
        (self.supported() || self.type_oid == 17) && self.identity != "a"
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
    target: EditTarget,
    fields: Vec<Attribute>,
    stamp: PostgresRowStamp,
    change: Option<Approved>,
}

struct EditTarget {
    object: i64,
    table: String,
    key: Vec<Attribute>,
}

struct Approved {
    approval: Uuid,
    cells: Vec<Change>,
}

struct Change {
    column: String,
    input: ApprovedValue,
    normalized: Option<Zeroizing<String>>,
}

enum ApprovedValue {
    Default,
    Null,
    Value(ServerValue),
}

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

fn preview_value_projection(expression: &str) -> [String; 2] {
    let text = format!("({expression})::pg_catalog.text");
    [
        format!("pg_catalog.left({text}, {})", VALUE_LIMIT + 1),
        format!("CASE WHEN pg_catalog.char_length({text}) <= {VALUE_LIMIT} AND pg_catalog.pg_column_size({expression}) <= {} THEN {expression} END", VALUE_LIMIT * 4 + 64),
    ]
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
}

fn checked_field<'a>(
    fields: &'a [Attribute],
    table: &EditTable,
    column: &str,
) -> Result<&'a Attribute> {
    let old = fields
        .iter()
        .find(|field| field.name == column)
        .ok_or("선택한 열을 다시 열어 현재 값을 확인하세요.")?;
    if !table.columns.contains(old) {
        return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
    }
    Ok(old)
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

async fn read_target(tx: &Transaction<'_>, object: i64) -> Result<(EditTarget, EditTable)> {
    let relation = catalog::relation(tx, object).await?;
    let edit = access(tx, object, relation.kind).await?.allowed()?;
    if let Some(reason) = edit.update_reason() {
        return Err(reason.into());
    }
    let target = EditTarget {
        object,
        table: format!("{}.{}", quote(&relation.schema), quote(&relation.name)),
        key: edit.key.clone(),
    };
    Ok((target, edit))
}

fn stamp_keys(target: &EditTarget, stamp: &PostgresRowStamp) -> Vec<(String, String)> {
    target
        .key
        .iter()
        .zip(&stamp.keys)
        .map(|(key, value)| (key.name.clone(), value.clone()))
        .collect()
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
    let tx = read_transaction(client).await?;
    let (target, edit) = read_target(&tx, object).await?;
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
    if stamp.keys.len() != target.key.len()
        || stamp.keys.iter().any(|value| {
            value.chars().take(KEY_LIMIT + 1).count() > KEY_LIMIT || value.contains('\0')
        })
    {
        return Err("행의 기본 키를 확인할 수 없습니다. 다시 조회하세요.".into());
    }
    let plan = Plan {
        token: Uuid::new_v4(),
        target,
        fields: vec![column],
        stamp,
        created: Instant::now(),
        change: None,
    };
    let first = read_field(&tx, &plan.target, &plan.stamp, &plan.fields[0]).await?;
    tx.commit().await.map_err(pg_error)?;
    let ui = PostgresEditSession {
        token: plan.token.to_string(),
        table: plan.target.table.clone(),
        keys: stamp_keys(&plan.target, &plan.stamp),
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
    let tx = read_transaction(client).await?;
    let table = recheck(&tx, &plan.target).await?;
    let field = table
        .columns
        .into_iter()
        .find(|field| field.name == column)
        .ok_or("선택한 열은 편집할 수 없습니다.")?;
    let stored = plan.fields.iter().find(|item| item.name == column);
    if stored.is_some_and(|old| old != &field) {
        return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
    }
    let response = read_field(&tx, &plan.target, &plan.stamp, &field).await?;
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
    let tx = read_transaction(client).await?;
    let table = recheck(&tx, &plan.target).await?;
    let (changes, staged) =
        preview_cells(&tx, &plan.target, &plan.stamp, &plan.fields, &table, inputs).await?;
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

async fn preview_cells(
    tx: &Transaction<'_>,
    target: &EditTarget,
    stamp: &PostgresRowStamp,
    fields: &[Attribute],
    table: &EditTable,
    inputs: Vec<PostgresCellChange>,
) -> Result<(Vec<CellPreview>, Vec<Change>)> {
    if inputs.is_empty() || inputs.len() > CELL_LIMIT {
        return Err("한 행에서 1~16개 셀의 변경을 선택하세요.".into());
    }
    let mut seen = HashSet::new();
    let mut projection = Vec::with_capacity(inputs.len() * 3);
    let mut values = stamp.values();
    for change in &inputs {
        if !seen.insert(change.column.as_str()) {
            return Err("같은 열을 두 번 변경할 수 없습니다.".into());
        }
        let column = checked_field(fields, table, &change.column)?;
        projection.push(bounded(&column.name, VALUE_LIMIT));
        let expression = cast_input(column, &change.input, &mut values)?
            .unwrap_or_else(|| "NULL::pg_catalog.text".into());
        projection.extend(preview_value_projection(&expression));
    }
    let row = read_row(tx, target, &projection.join(", "), &values).await?;
    stamp.check(&row, projection.len())?;
    let mut changes = Vec::new();
    let mut staged = Vec::new();
    for (index, change) in inputs.into_iter().enumerate() {
        let before = cell(field(&row, index * 3)?)?;
        let after = cell(field(&row, index * 3 + 1)?)?;
        let default_sql = if matches!(change.input, PostgresEditInput::Default) {
            visible_default(checked_field(fields, table, &change.column)?).map(str::to_owned)
        } else {
            None
        };
        if default_sql.is_none() && before.value == after.value {
            continue;
        }
        let binary: Option<ServerValue> = field(&row, index * 3 + 2)?;
        if after.value.is_some() != binary.is_some() {
            return Err("서버에서 표시한 값을 저장용 형식으로 확인하지 못했습니다.".into());
        }
        let input = match change.input {
            PostgresEditInput::Default => ApprovedValue::Default,
            _ => binary.map_or(ApprovedValue::Null, ApprovedValue::Value),
        };
        staged.push(Change {
            column: change.column.clone(),
            input,
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
    Ok((changes, staged))
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
    let tx = write_transaction(client, &plan.target).await?;
    let table = recheck(&tx, &plan.target).await?;
    let change = plan
        .change
        .as_ref()
        .ok_or("변경 내용을 먼저 미리 보세요.")?;
    for cell in &change.cells {
        checked_field(&plan.fields, &table, &cell.column)?;
    }
    let actual = update_cells(&tx, &plan.target, &plan.stamp, &change.cells).await?;
    Ok((tx, actual))
}

async fn write_transaction<'a>(
    client: &'a mut Client,
    target: &EditTarget,
) -> Result<Transaction<'a>> {
    let tx = client
        .build_transaction()
        .read_only(false)
        .isolation_level(IsolationLevel::ReadCommitted)
        .start()
        .await
        .map_err(write_error)?;
    tx.batch_execute(&format!(
        "LOCK TABLE ONLY {} IN SHARE UPDATE EXCLUSIVE MODE",
        target.table
    ))
    .await
    .map_err(write_error)?;
    Ok(tx)
}

async fn update_cells(
    tx: &Transaction<'_>,
    target: &EditTarget,
    stamp: &PostgresRowStamp,
    changes: &[Change],
) -> Result<Cell> {
    let mut values = stamp.values();
    let predicate = key_predicate(target.object, &target.key);
    let tuple = values.len() + 1;
    let version = tuple + 1;
    values.push(bind(stamp.tuple.clone()));
    values.push(bind(stamp.version.clone()));
    let mut bindings: Vec<&(dyn ToSql + Sync)> = values.iter().map(|value| value as _).collect();
    let mut assignments = Vec::with_capacity(changes.len());
    let mut returned = Vec::with_capacity(changes.len());
    for cell in changes {
        let expression = match &cell.input {
            ApprovedValue::Default => "DEFAULT".into(),
            ApprovedValue::Null => "NULL".into(),
            ApprovedValue::Value(value) => {
                bindings.push(value);
                format!("${}", bindings.len())
            }
        };
        assignments.push(format!("{} = {expression}", quote(&cell.column)));
        returned.push(bounded(&cell.column, VALUE_LIMIT));
    }
    let sql = format!(
        "UPDATE ONLY {} SET {} WHERE {predicate}
         AND ctid = ${tuple}::pg_catalog.tid AND xmin::pg_catalog.text = ${version}
         RETURNING {}",
        target.table,
        assignments.join(", "),
        returned.join(", "),
    );
    let row = exactly_one(&mut query_params(tx, &sql, bindings).await?)?;
    let mut first = None;
    for (index, change) in changes.iter().enumerate() {
        let actual = cell(field(&row, index)?)?;
        if !matches!(change.input, ApprovedValue::Default)
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
    first.ok_or("서버에서 확인할 변경이 없습니다.".into())
}

async fn recheck(tx: &Transaction<'_>, target: &EditTarget) -> Result<EditTable> {
    let (current, edit) = read_target(tx, target.object).await?;
    if current.table != target.table {
        return Err(STALE.into());
    }
    if target.key != current.key {
        return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
    }
    Ok(edit)
}

fn key_predicate(object: i64, keys: &[Attribute]) -> String {
    key_predicate_at(object, keys, 0)
}

fn key_predicate_at(object: i64, keys: &[Attribute], offset: usize) -> String {
    let mut where_sql = format!("tableoid::bigint = {object}");
    for (index, key) in keys.iter().enumerate() {
        where_sql.push_str(&format!(
            " AND {} = ${}",
            quote(&key.name),
            offset + index + 1
        ));
    }
    where_sql
}

async fn read_field(
    tx: &Transaction<'_>,
    target: &EditTarget,
    stamp: &PostgresRowStamp,
    column: &Attribute,
) -> Result<PostgresEditField> {
    let row = read_row(
        tx,
        target,
        &bounded(&column.name, VALUE_LIMIT),
        &stamp.values(),
    )
    .await?;
    stamp.check(&row, 1)?;
    Ok(edit_field(column, cell(field(&row, 0)?)?))
}

fn edit_field(column: &Attribute, current: Cell) -> PostgresEditField {
    PostgresEditField {
        column: column.name.clone(),
        data_type: column.data_type.clone(),
        nullable: column.nullable,
        current,
        default_sql: visible_default(column).map(str::to_owned),
    }
}

async fn read_row(
    tx: &Transaction<'_>,
    target: &EditTarget,
    projection: &str,
    values: &[Value],
) -> Result<Row> {
    let sql = format!(
        "SELECT {projection}, {} FROM ONLY {} WHERE {}",
        PostgresRowStamp::PROJECTION,
        target.table,
        key_predicate(target.object, &target.key)
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
    query_params(tx, sql, values.iter()).await
}

async fn query_params<P, I>(tx: &Transaction<'_>, sql: &str, values: I) -> Result<Vec<Row>>
where
    P: BorrowToSql,
    I: IntoIterator<Item = P>,
    I::IntoIter: ExactSizeIterator,
{
    let stmt = tx.prepare(sql).await.map_err(write_error)?;
    let portal = tx.bind_raw(&stmt, values).await.map_err(write_error)?;
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
