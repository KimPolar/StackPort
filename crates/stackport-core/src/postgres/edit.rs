use super::{
    catalog,
    parameters::Value,
    session::{field, pg_error, secret, Cell},
    PostgresProfile,
};
use crate::{insert_audit, quote_identifier as quote, AuditRecord, Result, Store};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::time::timeout;
use tokio_postgres::{Client, Error, IsolationLevel, Row, Transaction};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

pub(super) const LIFETIME: Duration = Duration::from_secs(300);
const DEADLINE: Duration = Duration::from_secs(12);
const VALUE_LIMIT: usize = 4096;
const KEY_LIMIT: usize = 512;
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
    column: String,
    data_type: String,
    keys: Vec<(String, String)>,
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

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PostgresEditOutcome {
    Applied { actual: Cell, audit_warning: bool },
    Unknown,
}

#[derive(PartialEq, Eq)]
struct Attribute {
    name: String,
    number: i16,
    data_type: String,
    type_oid: i64,
    typmod: i32,
    nullable: bool,
    default_sql: Option<String>,
}

pub(super) enum Access {
    Blocked(&'static str),
    Allowed(EditTable),
}

pub(super) struct EditTable {
    key: Vec<Attribute>,
    columns: Vec<Attribute>,
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
    pub(super) fn editable(&self, name: &str) -> bool {
        self.columns.iter().any(|column| column.name == name)
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
        "SELECT pg_catalog.pg_is_in_recovery(), pg_catalog.has_table_privilege(c.oid,'UPDATE'),
                NOT c.relispartition AND am.amname = 'heap'
                    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid OR i.inhparent = c.oid),
                NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)
                    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class = c.oid)
                    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped AND a.attgenerated <> '')
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_am am ON am.oid = c.relam WHERE c.oid::bigint = $1",
        &[&object],
    ).await.map_err(pg_error)?;
    if field::<bool>(&row, 0)? {
        return Ok(Access::Blocked("읽기 복제본에서는 편집할 수 없습니다."));
    }
    if !field::<bool>(&row, 1)? {
        return Ok(Access::Blocked("이 테이블에 UPDATE 권한이 없습니다."));
    }
    if !field::<bool>(&row, 2)? || !field::<bool>(&row, 3)? {
        return Ok(Access::Blocked(
            "상속·파티션·사용자 트리거·규칙·생성 열이 없는 일반 힙 테이블만 편집할 수 있습니다.",
        ));
    }

    let rows = tx.query(
        "SELECT a.attname::text, a.attnum, pg_catalog.format_type(a.atttypid, a.atttypmod),
                a.atttypid::bigint, a.atttypmod, NOT a.attnotnull,
                CASE WHEN keys.position IS NULL THEN pg_catalog.left(pg_catalog.pg_get_expr(d.adbin,d.adrelid), 4097) END,
                keys.position,
                a.attidentity = '' AND NOT EXISTS (
                    SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = a.attrelid AND i.indisunique
                    AND EXISTS (SELECT 1 FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinality)
                                WHERE k.ordinality <= i.indnkeyatts AND k.attnum = a.attnum)
                )
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
    for row in rows {
        let column = Attribute {
            name: field(&row, 0)?,
            number: field(&row, 1)?,
            data_type: field(&row, 2)?,
            type_oid: field(&row, 3)?,
            typmod: field(&row, 4)?,
            nullable: field(&row, 5)?,
            default_sql: field(&row, 6)?,
        };
        let supported = matches!(
            column.type_oid,
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
        );
        if let Some(position) = field::<Option<i32>>(&row, 7)? {
            if !supported || column.nullable {
                return Ok(Access::Blocked(
                    "기본 키의 데이터 타입을 안전하게 편집할 수 없습니다.",
                ));
            }
            keys.push((position, column));
        } else if supported && field::<bool>(&row, 8)? {
            columns.push(column);
        }
    }
    if keys.is_empty() {
        return Ok(Access::Blocked(
            "편집하려면 즉시 검증되는 기본 키가 필요합니다.",
        ));
    }
    if columns.is_empty() {
        return Ok(Access::Blocked("이 테이블에 편집 가능한 열이 없습니다."));
    }
    keys.sort_by_key(|(index, _)| *index);
    Ok(Access::Allowed(EditTable {
        key: keys.into_iter().map(|(_, key)| key).collect(),
        columns,
    }))
}

pub(super) struct Plan {
    pub token: Uuid,
    pub created: Instant,
    object: i64,
    table: String,
    column: Attribute,
    key: Vec<Attribute>,
    stamp: PostgresRowStamp,
    change: Option<Change>,
}

struct Change {
    approval: Uuid,
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
        column,
        key: keys,
        stamp,
        created: Instant::now(),
        change: None,
    };
    let current = read_current(&tx, &plan).await?;
    tx.commit().await.map_err(pg_error)?;
    let ui = PostgresEditSession {
        token: plan.token.to_string(),
        table: plan.table.clone(),
        column: plan.column.name.clone(),
        data_type: plan.column.data_type.clone(),
        keys: plan
            .key
            .iter()
            .zip(plan.stamp.keys.iter())
            .map(|(key, value)| (key.name.clone(), value.clone()))
            .collect(),
        current,
        nullable: plan.column.nullable,
        default_sql: visible_default(&plan.column).map(str::to_owned),
    };
    Ok((plan, ui))
}

pub(super) async fn preview(
    client: &mut Client,
    plan: &mut Plan,
    input: PostgresEditInput,
) -> Result<PostgresEditPreview> {
    let tx = client
        .build_transaction()
        .read_only(true)
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(pg_error)?;
    recheck(&tx, plan).await?;
    let before = read_current(&tx, plan).await?;
    let normalized: Option<Zeroizing<String>> = match &input {
        PostgresEditInput::Null if !plan.column.nullable => {
            return Err("이 열에는 NULL을 저장할 수 없습니다.".into())
        }
        PostgresEditInput::Null => None,
        PostgresEditInput::Default if visible_default(&plan.column).is_none() => {
            return Err("확인할 수 있는 서버 기본값이 없습니다.".into());
        }
        PostgresEditInput::Default => None,
        PostgresEditInput::Text { value } => {
            let chars = value.chars().take(VALUE_LIMIT + 1).count();
            if chars > VALUE_LIMIT || value.contains('\0') {
                return Err("변경 값은 NUL 문자 없이 4096자 이하여야 합니다.".into());
            }
            if matches!(plan.column.type_oid, 1042 | 1043)
                && plan.column.typmod >= 4
                && chars > (plan.column.typmod - 4) as usize
            {
                return Err("문자열이 열의 길이 제한을 초과합니다.".into());
            }
            let sql = format!(
                "SELECT pg_catalog.left(($1::{})::pg_catalog.text, {})",
                plan.column.data_type,
                VALUE_LIMIT + 1
            );
            let mut rows = query(&tx, &sql, &[bind(value.to_string())]).await?;
            Some(Zeroizing::new(field(&exactly_one(&mut rows)?, 0)?))
        }
    };
    let use_default = matches!(input, PostgresEditInput::Default);
    let after = cell(normalized.as_ref().map(|text| text.to_string()))?;
    if !use_default && before.value == after.value {
        return Err("변경할 값이 기존 값과 같습니다.".into());
    }
    tx.commit().await.map_err(pg_error)?;
    let approval = Uuid::new_v4();
    plan.change = Some(Change {
        approval,
        input,
        normalized,
    });
    Ok(PostgresEditPreview {
        approval: approval.to_string(),
        before,
        after,
        use_default,
    })
}

pub(super) async fn apply(
    client: &mut Client,
    store: &Store,
    profile: &PostgresProfile,
    plan: Plan,
) -> Result<PostgresEditOutcome> {
    audit(store, profile, plan.token, "started").await?;
    let attempted = timeout(DEADLINE, update(client, &plan)).await;
    let (tx, actual) = match attempted {
        Ok(Ok(result)) => result,
        other => {
            let _ = audit(store, profile, plan.token, "failed").await;
            return match other {
                Ok(Err(error)) => Err(error),
                _ => Err("행 변경 시간이 초과되었습니다. 다시 조회하세요.".into()),
            };
        }
    };
    match timeout(DEADLINE, tx.commit()).await {
        Ok(Ok(())) => Ok(PostgresEditOutcome::Applied {
            actual,
            audit_warning: audit(store, profile, plan.token, "succeeded")
                .await
                .is_err(),
        }),
        Ok(Err(error))
            if error.code().is_some_and(|code| {
                matches!(&code.code()[..2], "23" | "40") && code.code() != "40003"
            }) =>
        {
            let _ = audit(store, profile, plan.token, "failed").await;
            Err(write_error(error))
        }
        _ => Ok(PostgresEditOutcome::Unknown),
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
    recheck(&tx, plan).await?;
    let mut values = plan.stamp.values();
    let predicate = predicate(plan);
    let lock = format!(
        "SELECT {} FROM ONLY {} WHERE {predicate} FOR UPDATE",
        PostgresRowStamp::PROJECTION,
        plan.table
    );
    let row = exactly_one(&mut query(&tx, &lock, &values).await?)?;
    plan.stamp.check(&row, 0)?;
    let change = plan
        .change
        .as_ref()
        .ok_or("변경 내용을 먼저 미리 보세요.")?;
    let expression = match &change.input {
        PostgresEditInput::Default => "DEFAULT".into(),
        PostgresEditInput::Null => "NULL".into(),
        PostgresEditInput::Text { value } => {
            values.push(bind(value.to_string()));
            format!("${}", values.len())
        }
    };
    let sql = format!(
        "UPDATE ONLY {} SET {} = {expression} WHERE {predicate} RETURNING {}",
        plan.table,
        quote(&plan.column.name),
        bounded(&plan.column.name, VALUE_LIMIT)
    );
    let actual = cell(field(
        &exactly_one(&mut query(&tx, &sql, &values).await?)?,
        0,
    )?)?;
    if !matches!(change.input, PostgresEditInput::Default)
        && actual.value.as_deref() != change.normalized.as_ref().map(|value| value.as_str())
    {
        return Err("서버의 변경 결과가 미리보기와 달라 롤백했습니다.".into());
    }
    Ok((tx, actual))
}

async fn recheck(tx: &Transaction<'_>, plan: &Plan) -> Result<()> {
    let relation = catalog::relation(tx, plan.object).await?;
    if format!("{}.{}", quote(&relation.schema), quote(&relation.name)) != plan.table {
        return Err(STALE.into());
    }
    let edit = access(tx, plan.object, relation.kind).await?.allowed()?;
    if plan.key != edit.key || !edit.columns.contains(&plan.column) {
        return Err("테이블 구조가 변경되었습니다. 다시 조회하세요.".into());
    }
    Ok(())
}

fn predicate(plan: &Plan) -> String {
    let mut where_sql = format!("tableoid::bigint = {}", plan.object);
    for (index, key) in plan.key.iter().enumerate() {
        where_sql.push_str(&format!(" AND {} = ${}", quote(&key.name), index + 1));
    }
    where_sql
}

async fn read_current(tx: &Transaction<'_>, plan: &Plan) -> Result<Cell> {
    let sql = format!(
        "SELECT {}, {} FROM ONLY {} WHERE {}",
        bounded(&plan.column.name, VALUE_LIMIT),
        PostgresRowStamp::PROJECTION,
        plan.table,
        predicate(plan)
    );
    let row = exactly_one(&mut query(tx, &sql, &plan.stamp.values()).await?)?;
    plan.stamp.check(&row, 1)?;
    cell(field(&row, 0)?)
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

async fn query(tx: &Transaction<'_>, sql: &str, values: &[Value]) -> Result<Vec<Row>> {
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
    outcome: &'static str,
) -> Result<()> {
    let store = store.clone();
    let profile = profile.clone();
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
                operation: "postgres.edit.cell",
                project_id: Some(&profile.project_id),
                profile_id: Some(&profile.id),
                environment: Some(&profile.settings.environment),
                object_name: None,
                outcome,
                affected_count: (outcome == "succeeded").then_some(1),
            },
        )
        .map_err(|_| "PostgreSQL 변경의 작업 기록을 저장할 수 없습니다.".into())
    })
    .await
    .map_err(|_| "PostgreSQL 변경의 작업 기록을 저장할 수 없습니다.")?
}
