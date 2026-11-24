use super::{
    db_error, insert_audit, open_schema_db, open_user_db, quote_identifier, schema_compare,
    snapshot_sqlite, sql_statement::statement_ranges, AuditRecord, Profile, Result, Store,
};
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    Connection, OpenFlags, TransactionBehavior,
};
use same_file::Handle;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

const REVIEW_LIFETIME: Duration = Duration::from_secs(600);
const MAX_OBJECTS: usize = 32;

#[derive(Default)]
pub(crate) struct SchemaSyncManager {
    reviews: Mutex<HashMap<String, PendingSync>>,
}

#[derive(Debug, Serialize)]
pub struct SchemaSyncPreview {
    pub token: String,
    pub objects: Vec<String>,
    pub sql: String,
    pub requires_production_confirmation: bool,
}

#[derive(Debug, Serialize)]
pub struct SchemaSyncReport {
    pub objects: usize,
    pub backup_path: String,
    pub audit_warning: Option<String>,
}

struct PendingSync {
    created: Instant,
    source: Profile,
    source_identity: Handle,
    source_digest: [u8; 32],
    target: Profile,
    target_identity: Handle,
    target_digest: [u8; 32],
    objects: Vec<(String, String)>,
    steps: Vec<Step>,
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum StepKind {
    Table,
    DropView,
    View,
    Index,
    Trigger,
}

struct Step {
    kind: StepKind,
    object: String,
    sql: String,
}

impl Store {
    pub fn preview_schema_sync(
        &self,
        source: &str,
        target: &str,
        names: &[String],
    ) -> Result<SchemaSyncPreview> {
        let requested: BTreeSet<_> = names.iter().map(|name| name.to_ascii_lowercase()).collect();
        if requested.is_empty() || requested.len() > MAX_OBJECTS || requested.len() != names.len() {
            return Err(format!(
                "적용할 객체를 중복 없이 1~{MAX_OBJECTS}개 선택하세요."
            ));
        }
        let source = self.profile(source)?;
        let target = self.profile(target)?;
        let workspace = identity(&self.path)?;
        let source_identity = identity(&source.path)?;
        let target_identity = identity(&target.path)?;
        if source_identity == target_identity
            || source_identity == workspace
            || target_identity == workspace
        {
            return Err("서로 다른 사용자 데이터베이스 파일을 선택하세요.".into());
        }
        let source_db = open_schema_db(Path::new(&source.path))?;
        let target_db = open_schema_db(Path::new(&target.path))?;
        let source_names = schema_compare::catalog_names(&source_db)?;
        let target_names = schema_compare::catalog_names(&target_db)?;
        let mut steps = Vec::new();
        let mut objects = Vec::new();
        for key in requested {
            let name = source_names
                .get(&key)
                .ok_or("기준에 있는 객체를 선택하세요.")?;
            let before = target_names.get(&key);
            let change = schema_compare::object_difference(
                &source_db,
                name,
                &target_db,
                before.map(String::as_str),
            )?
            .ok_or("선택한 객체의 구조가 일치합니다. 다시 비교하세요.")?;
            let draft = change.draft_sql.filter(|_| change.can_apply).ok_or_else(|| {
                format!("{name} 변경은 직접 적용할 수 없습니다. 새 테이블·뷰 또는 출력 열이 같은 뷰를 선택하세요.")
            })?;
            for range in statement_ranges(&draft) {
                let sql = draft[range].trim_end();
                let kind = if sql == "BEGIN;" || sql == "COMMIT;" {
                    continue;
                } else if sql.starts_with("CREATE TABLE ") {
                    StepKind::Table
                } else if sql.starts_with("DROP VIEW main.") {
                    StepKind::DropView
                } else if sql.starts_with("CREATE VIEW ") {
                    StepKind::View
                } else if sql.starts_with("CREATE INDEX ")
                    || sql.starts_with("CREATE UNIQUE INDEX ")
                {
                    StepKind::Index
                } else if sql.starts_with("CREATE TRIGGER ") {
                    StepKind::Trigger
                } else {
                    return Err("적용 범위에 포함할 수 없는 정의 SQL입니다.".into());
                };
                steps.push(Step {
                    kind,
                    object: name.clone(),
                    sql: sql.into(),
                });
            }
            objects.push((name.clone(), change.source_kind.expect("source present")));
        }
        steps.sort_by(|left, right| left.kind.cmp(&right.kind));
        let source_digest = digest(&source_db)?;
        let target_digest = digest(&target_db)?;
        ensure_identity(&source_identity, &source.path)?;
        ensure_identity(&target_identity, &target.path)?;
        let token = Uuid::new_v4().to_string();
        let sql = format!(
            "BEGIN IMMEDIATE;\n\n{}COMMIT;\n",
            steps
                .iter()
                .map(|step| format!("{}\n\n", step.sql))
                .collect::<String>()
        );
        if sql.len() > 4 * 1024 * 1024 {
            return Err("스키마 변경 미리보기가 4 MiB를 초과했습니다.".into());
        }
        let preview = SchemaSyncPreview {
            token: token.clone(),
            objects: objects.iter().map(|(name, _)| name.clone()).collect(),
            sql,
            requires_production_confirmation: target.environment == "PROD",
        };
        let mut reviews = self
            .schema_sync
            .reviews
            .lock()
            .map_err(|_| "스키마 적용 작업을 열 수 없습니다.")?;
        reviews.retain(|_, review| review.created.elapsed() < REVIEW_LIFETIME);
        if reviews.len() >= 16 {
            return Err("열려 있는 스키마 미리보기를 닫고 다시 시도하세요.".into());
        }
        reviews.insert(
            token,
            PendingSync {
                created: Instant::now(),
                source,
                source_identity,
                source_digest,
                target,
                target_identity,
                target_digest,
                objects,
                steps,
            },
        );
        Ok(preview)
    }

    pub fn cancel_schema_sync(&self, token: &str) -> Result<()> {
        self.schema_sync
            .reviews
            .lock()
            .map_err(|_| "스키마 적용 작업을 열 수 없습니다.")?
            .remove(token);
        Ok(())
    }

    pub fn apply_schema_sync(
        &self,
        token: &str,
        destination: &str,
        confirmed: bool,
        production: &str,
    ) -> Result<SchemaSyncReport> {
        if !confirmed {
            return Err("검토한 스키마 변경을 확인하세요.".into());
        }
        let review = {
            let mut reviews = self
                .schema_sync
                .reviews
                .lock()
                .map_err(|_| "스키마 적용 작업을 열 수 없습니다.")?;
            reviews.retain(|_, review| review.created.elapsed() < REVIEW_LIFETIME);
            let review = reviews
                .get(token)
                .ok_or("스키마 미리보기가 만료되었습니다. 다시 검토하세요.")?;
            if review.target.environment == "PROD" && production != "PROD" {
                return Err("운영 환경 변경을 확인하려면 PROD를 입력하세요.".into());
            }
            reviews.remove(token).expect("checked review")
        };
        let audit = |outcome, affected_count| AuditRecord {
            correlation_id: token,
            operation: "sqlite.schema.sync",
            project_id: Some(&review.target.project_id),
            profile_id: Some(&review.target.id),
            environment: Some(&review.target.environment),
            object_name: None,
            outcome,
            affected_count,
        };
        insert_audit(&self.connect()?, audit("started", None))?;
        let mut result = apply_review(self, &review, destination);
        let (status, count) = match &result {
            Ok(report) => ("succeeded", Some(report.objects as i64)),
            Err(_) => ("failed", None),
        };
        if self
            .connect()
            .and_then(|db| insert_audit(&db, audit(status, count)))
            .is_err()
        {
            let warning = "완료 작업 기록을 저장하지 못했습니다.";
            match &mut result {
                Ok(report) => report.audit_warning = Some(warning.into()),
                Err(error) => error.push_str(&format!(" {warning}")),
            }
        }
        result
    }
}

fn apply_review(
    store: &Store,
    review: &PendingSync,
    destination: &str,
) -> Result<SchemaSyncReport> {
    if store.profile(&review.source.id)? != review.source
        || store.profile(&review.target.id)? != review.target
    {
        return Err("연결 설정이 변경되었습니다. 다시 검토하세요.".into());
    }
    ensure_identity(&review.source_identity, &review.source.path)?;
    ensure_identity(&review.target_identity, &review.target.path)?;
    let source_db = open_schema_db(Path::new(&review.source.path))?;
    if digest(&source_db)? != review.source_digest {
        return Err("기준 구조가 변경되었습니다. 다시 검토하세요.".into());
    }
    let mut target = Connection::open_with_flags(
        &review.target.path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(db_error)?;
    target
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    target
        .pragma_update(None, "foreign_keys", true)
        .map_err(db_error)?;
    target
        .pragma_update(None, "trusted_schema", false)
        .map_err(db_error)?;
    let tx = target
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    ensure_identity(&review.target_identity, &review.target.path)?;
    if digest(&tx)? != review.target_digest {
        return Err("대상 구조가 변경되었습니다. 다시 검토하세요.".into());
    }
    let backup_source = open_user_db(Path::new(&review.target.path))?;
    ensure_identity(&review.target_identity, &review.target.path)?;
    let path = Path::new(destination.trim());
    if !path.is_absolute()
        || path
            .file_name()
            .and_then(|value| value.to_str())
            .is_none_or(|name| !super::local_file::valid_filename(name))
    {
        return Err("새 백업 파일의 절대 경로를 입력하세요.".into());
    }
    let backup = snapshot_sqlite(&backup_source, path, None)?;
    drop(backup_source);

    let result = (|| {
        let started = Instant::now();
        tx.progress_handler(
            10_000,
            Some(move || started.elapsed() > Duration::from_secs(30)),
        );
        for step in &review.steps {
            execute_step(&tx, step)?;
        }
        for (name, kind) in &review.objects {
            if schema_compare::object_difference(&source_db, name, &tx, Some(name))?.is_some() {
                return Err(format!("{name} 적용 결과가 기준 구조와 일치하지 않습니다."));
            }
            if kind == "table" {
                tx.prepare(&format!(
                    "EXPLAIN INSERT INTO main.{} DEFAULT VALUES",
                    quote_identifier(name)
                ))
                .map_err(db_error)?;
            }
        }
        for name in Store::schema_object_names(&tx, true, None, 1025)? {
            if Store::read_object(&tx, &name)?.kind == "view" {
                Store::object_columns(&tx, &name)?;
            }
        }
        let mut check = tx
            .prepare("PRAGMA main.foreign_key_check")
            .map_err(db_error)?;
        if check
            .query([])
            .map_err(db_error)?
            .next()
            .map_err(db_error)?
            .is_some()
        {
            return Err("외래 키 검증에 실패했습니다.".into());
        }
        drop(check);
        ensure_identity(&review.target_identity, &review.target.path)?;
        tx.commit().map_err(db_error)?;
        Ok(SchemaSyncReport {
            objects: review.objects.len(),
            backup_path: backup.path.clone(),
            audit_warning: None,
        })
    })();
    result.map_err(|error: String| {
        format!(
            "{error} 대상 변경을 되돌렸습니다. 사전 백업: {}",
            backup.path
        )
    })
}

fn execute_step(db: &Connection, step: &Step) -> Result<()> {
    let name = step.object.clone();
    let allowed_kind = match step.kind {
        StepKind::Table => "table",
        StepKind::View => "view",
        StepKind::DropView => "drop_view",
        StepKind::Index => "index",
        StepKind::Trigger => "trigger",
    };
    db.authorizer(Some(move |context: AuthContext<'_>| {
        let main = context.database_name == Some("main");
        let allowed = match context.action {
            AuthAction::CreateTable { table_name } => {
                main && allowed_kind == "table"
                    && (table_name.eq_ignore_ascii_case(&name) || table_name == "sqlite_sequence")
            }
            AuthAction::CreateView { view_name } => {
                main && allowed_kind == "view" && view_name.eq_ignore_ascii_case(&name)
            }
            AuthAction::DropView { view_name } => {
                main && allowed_kind == "drop_view" && view_name.eq_ignore_ascii_case(&name)
            }
            AuthAction::CreateIndex { table_name, .. } => {
                main && matches!(allowed_kind, "index" | "table")
                    && table_name.eq_ignore_ascii_case(&name)
            }
            AuthAction::CreateTrigger { table_name, .. } => {
                main && allowed_kind == "trigger" && table_name.eq_ignore_ascii_case(&name)
            }
            AuthAction::DropTrigger { table_name, .. } => {
                main && allowed_kind == "drop_view" && table_name.eq_ignore_ascii_case(&name)
            }
            AuthAction::Insert { table_name }
            | AuthAction::Update { table_name, .. }
            | AuthAction::Delete { table_name } => {
                main && matches!(table_name, "sqlite_master" | "sqlite_schema")
                    || matches!(context.action, AuthAction::Delete { .. })
                        && main
                        && allowed_kind == "drop_view"
                        && table_name.eq_ignore_ascii_case(&name)
            }
            AuthAction::Read { .. } | AuthAction::Reindex { .. } => main,
            AuthAction::Select => matches!(allowed_kind, "view" | "trigger"),
            AuthAction::Function { function_name } => {
                allowed_kind == "index" && !function_name.eq_ignore_ascii_case("load_extension")
            }
            _ => false,
        };
        if allowed {
            Authorization::Allow
        } else {
            Authorization::Deny
        }
    }));
    let result = db
        .execute(&step.sql, [])
        .map_err(|error| format!("{} 적용 실패. {}", step.object, db_error(error)));
    db.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    result.map(|_| ())
}

fn digest(db: &Connection) -> Result<[u8; 32]> {
    let version: i64 = db
        .pragma_query_value(None, "schema_version", |row| row.get(0))
        .map_err(db_error)?;
    let mut hash = Sha256::new();
    hash.update(version.to_le_bytes());
    let mut statement = db.prepare("SELECT type, name, tbl_name, coalesce(sql,'') FROM main.sqlite_schema ORDER BY type, name").map_err(db_error)?;
    let mut rows = statement.query([]).map_err(db_error)?;
    while let Some(row) = rows.next().map_err(db_error)? {
        for index in 0..4 {
            let field: String = row.get(index).map_err(db_error)?;
            hash.update((field.len() as u64).to_le_bytes());
            hash.update(field.as_bytes());
        }
    }
    Ok(hash.finalize().into())
}

fn identity(path: impl AsRef<Path>) -> Result<Handle> {
    Handle::from_path(path)
        .map_err(|error| format!("데이터베이스 파일을 확인할 수 없습니다: {error}"))
}

fn ensure_identity(expected: &Handle, path: &str) -> Result<()> {
    if &identity(path)? != expected {
        return Err("데이터베이스 파일이 교체되었습니다. 다시 검토하세요.".into());
    }
    Ok(())
}
