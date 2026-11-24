use super::{
    db_error, open_schema_db, quote_identifier, sql_statement::statement_ranges, ColumnInfo,
    ForeignKeyInfo, IndexInfo, ObjectDetails, Result, SchemaDefinition, Store,
};
use rusqlite::Connection;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

const MAX_OBJECTS: usize = 512;
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct SchemaComparison {
    pub unchanged: usize,
    pub changes: Vec<SchemaObjectDifference>,
}

#[derive(Debug, Serialize)]
pub struct SchemaComparisonConnection {
    pub id: String,
    pub name: String,
    pub environment: String,
    pub project_name: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SchemaDifferenceStatus {
    SourceOnly,
    TargetOnly,
    Changed,
}

#[derive(Debug, Serialize)]
pub struct SchemaObjectDifference {
    pub name: String,
    pub status: SchemaDifferenceStatus,
    pub source_kind: Option<String>,
    pub target_kind: Option<String>,
    pub source_ddl: Option<String>,
    pub target_ddl: Option<String>,
    pub members: Vec<SchemaMemberDifference>,
    pub draft_sql: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SchemaMemberDifference {
    pub category: &'static str,
    pub name: String,
    pub source: Option<String>,
    pub target: Option<String>,
}

impl Store {
    pub fn schema_comparison_connections(&self) -> Result<Vec<SchemaComparisonConnection>> {
        let db = self.connect()?;
        let mut statement = db.prepare(
            "SELECT profiles.id, profiles.name, profiles.environment, projects.name
             FROM profiles JOIN projects ON projects.id = profiles.project_id
             WHERE NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id = projects.id)
             ORDER BY projects.name COLLATE NOCASE, projects.id, profiles.name COLLATE NOCASE, profiles.id",
        ).map_err(db_error)?;
        let items = statement
            .query_map([], |row| {
                Ok(SchemaComparisonConnection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    environment: row.get(2)?,
                    project_name: row.get(3)?,
                })
            })
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        Ok(items)
    }

    pub fn compare_sqlite_schema(
        &self,
        source_id: &str,
        target_id: &str,
    ) -> Result<SchemaComparison> {
        if source_id == target_id {
            return Err("서로 다른 SQLite 연결을 선택하세요.".into());
        }
        let source = self.profile(source_id)?;
        let target = self.profile(target_id)?;
        let source_db = open_schema_db(Path::new(&source.path))?;
        let source_names = catalog_names(&source_db)?;
        let target_db = open_schema_db(Path::new(&target.path))?;
        let target_names = catalog_names(&target_db)?;
        let names: BTreeSet<_> = source_names.keys().chain(target_names.keys()).collect();
        let mut changes = Vec::new();
        let mut unchanged = 0;
        let mut size = 0;
        for name in names {
            let source = source_names
                .get(name)
                .map(|name| read_object(&source_db, name))
                .transpose()?;
            let target = target_names
                .get(name)
                .map(|name| read_object(&target_db, name))
                .transpose()?;
            if let Some(change) = compare_object(source, target) {
                size += serde_json::to_vec(&change)
                    .map_err(|_| "스키마 차이를 읽을 수 없습니다.")?
                    .len();
                if size > MAX_BYTES {
                    return Err("스키마 비교 결과가 8 MiB를 초과했습니다.".into());
                }
                changes.push(change);
            } else {
                unchanged += 1;
            }
        }
        Ok(SchemaComparison { unchanged, changes })
    }
}

fn catalog_names(db: &Connection) -> Result<BTreeMap<String, String>> {
    let names = Store::schema_object_names(db, true, None, MAX_OBJECTS + 1)?;
    if names.len() > MAX_OBJECTS {
        return Err(format!(
            "연결 하나당 최대 {MAX_OBJECTS}개 객체를 비교할 수 있습니다."
        ));
    }
    Ok(names
        .into_iter()
        .map(|name| (name.to_ascii_lowercase(), name))
        .collect())
}

struct ComparedObject {
    details: ObjectDetails,
    definitions: Vec<SchemaDefinition>,
    keys: Vec<Vec<ForeignKeyInfo>>,
}

fn read_object(db: &Connection, name: &str) -> Result<ComparedObject> {
    let details = Store::describe_object_on(db, name)
        .map_err(|error| format!("{name} 구조를 읽을 수 없습니다. {error}"))?;
    let mut keys = BTreeMap::<_, Vec<_>>::new();
    for key in &details.foreign_keys {
        keys.entry(key.id).or_default().push(key.clone());
    }
    Ok(ComparedObject {
        details,
        definitions: Store::schema_definitions(db, name)?,
        keys: keys.into_values().collect(),
    })
}

fn compare_object(
    source: Option<ComparedObject>,
    target: Option<ComparedObject>,
) -> Option<SchemaObjectDifference> {
    let source_object = source.as_ref().map(|value| &value.details.object);
    let target_object = target.as_ref().map(|value| &value.details.object);
    let name = source_object.or(target_object)?.name.clone();
    let source_kind = source_object.map(|value| value.kind.clone());
    let target_kind = target_object.map(|value| value.kind.clone());
    let mut members = Vec::new();
    compare_members(
        &mut members,
        "열",
        source
            .as_ref()
            .map_or(&[], |value| value.details.columns.as_slice()),
        target
            .as_ref()
            .map_or(&[], |value| value.details.columns.as_slice()),
        |column| column.name.clone(),
        show_column,
    );
    compare_members(
        &mut members,
        "인덱스",
        source
            .as_ref()
            .map_or(&[], |value| value.details.indexes.as_slice()),
        target
            .as_ref()
            .map_or(&[], |value| value.details.indexes.as_slice()),
        |index| index.name.clone(),
        show_index,
    );
    compare_members(
        &mut members,
        "외래 키",
        source.as_ref().map_or(&[], |value| value.keys.as_slice()),
        target.as_ref().map_or(&[], |value| value.keys.as_slice()),
        |keys| format!("그룹 {}", keys[0].id + 1),
        |keys| show_foreign_key(keys),
    );
    for (kind, label) in [("index", "인덱스 SQL"), ("trigger", "트리거")] {
        let source_definitions = source
            .iter()
            .flat_map(|value| &value.definitions)
            .filter(|value| value.kind == kind);
        let target_definitions = target
            .iter()
            .flat_map(|value| &value.definitions)
            .filter(|value| value.kind == kind);
        collect_differences(
            &mut members,
            label,
            source_definitions,
            target_definitions,
            |definition| definition.name.clone(),
            |definition| definition.sql.clone(),
        );
    }
    let source_ddl = source_object.and_then(|value| value.ddl.clone());
    let target_ddl = target_object.and_then(|value| value.ddl.clone());
    let status = match (&source, &target) {
        (Some(_), None) => SchemaDifferenceStatus::SourceOnly,
        (None, Some(_)) => SchemaDifferenceStatus::TargetOnly,
        _ if !members.is_empty()
            || source_ddl != target_ddl
            || source_kind != target_kind
            || source_object.map(|value| &value.name) != target_object.map(|value| &value.name) =>
        {
            SchemaDifferenceStatus::Changed
        }
        _ => return None,
    };
    let draft_sql = match (&status, source.as_ref(), target.as_ref()) {
        (SchemaDifferenceStatus::SourceOnly, Some(source), _) => {
            create_draft(source).map(|sql| format!("BEGIN;\n\n{sql}COMMIT;\n"))
        }
        (SchemaDifferenceStatus::TargetOnly, _, Some(target)) => {
            let kind = if target.details.object.kind == "view" {
                "VIEW"
            } else {
                "TABLE"
            };
            Some(format!("DROP {kind} main.{};\n", quote_identifier(&name)))
        }
        (SchemaDifferenceStatus::Changed, Some(source), Some(target))
            if source_kind.as_deref() == Some("view")
                && target_kind.as_deref() == Some("view")
                && source_ddl != target_ddl =>
        {
            create_draft(source).map(|sql| {
                format!(
                    "BEGIN;\n\nDROP VIEW main.{};\n\n{sql}COMMIT;\n",
                    quote_identifier(&target.details.object.name)
                )
            })
        }
        _ => None,
    };
    Some(SchemaObjectDifference {
        name,
        status,
        source_kind,
        target_kind,
        source_ddl,
        target_ddl,
        members,
        draft_sql,
    })
}

fn compare_members<T: Eq>(
    changes: &mut Vec<SchemaMemberDifference>,
    category: &'static str,
    source: &[T],
    target: &[T],
    label: impl Fn(&T) -> String,
    display: impl Fn(&T) -> String,
) {
    collect_differences(
        changes,
        category,
        source.iter(),
        target.iter(),
        label,
        display,
    );
}

fn collect_differences<'a, T: Eq + 'a>(
    changes: &mut Vec<SchemaMemberDifference>,
    category: &'static str,
    source: impl Iterator<Item = &'a T>,
    target: impl Iterator<Item = &'a T>,
    label: impl Fn(&T) -> String,
    display: impl Fn(&T) -> String,
) {
    let source: BTreeMap<_, _> = source
        .map(|item| (label(item).to_ascii_lowercase(), item))
        .collect();
    let target: BTreeMap<_, _> = target
        .map(|item| (label(item).to_ascii_lowercase(), item))
        .collect();
    let names: BTreeSet<_> = source.keys().chain(target.keys()).collect();
    for name in names {
        let before = source.get(name).copied();
        let after = target.get(name).copied();
        if before == after {
            continue;
        }
        if let Some(item) = before.or(after) {
            changes.push(SchemaMemberDifference {
                category,
                name: label(item),
                source: before.map(&display),
                target: after.map(&display),
            });
        }
    }
}

fn show_column(column: &ColumnInfo) -> String {
    let mut text = format!(
        "{}\n순서 {} · {}",
        column.name,
        column.position + 1,
        if column.declared_type.is_empty() {
            "타입 미지정"
        } else {
            &column.declared_type
        }
    );
    if column.not_null {
        text.push_str(" · NOT NULL");
    }
    if let Some(default) = &column.default_value {
        text.push_str(&format!(" · DEFAULT {default}"));
    }
    if column.primary_key_position > 0 {
        text.push_str(&format!(" · PK {}", column.primary_key_position));
    }
    match column.hidden {
        1 => text.push_str(" · 숨김"),
        2 => text.push_str(" · 가상 생성 열"),
        3 => text.push_str(" · 저장 생성 열"),
        _ => {}
    }
    text
}

fn show_index(index: &IndexInfo) -> String {
    let mut flags = Vec::new();
    if index.unique {
        flags.push("고유");
    }
    if index.partial {
        flags.push("부분");
    }
    match index.origin.as_str() {
        "pk" => flags.push("기본 키"),
        "u" => flags.push("고유 제약"),
        _ => {}
    }
    let columns = index
        .columns
        .iter()
        .map(|column| {
            let name = column.name.as_deref().unwrap_or("(표현식 또는 rowid)");
            let order = if column.descending { "DESC" } else { "ASC" };
            format!(
                "{name} {order}{}",
                column
                    .collation
                    .as_ref()
                    .map_or_else(String::new, |collation| format!(" COLLATE {collation}"))
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    [index.name.as_str(), &flags.join(" · "), &columns]
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn show_foreign_key(keys: &[ForeignKeyInfo]) -> String {
    let pairs = keys.iter().map(|key| {
        format!(
            "{} → {}.{}",
            key.from_column,
            key.target_table,
            key.to_column
                .clone()
                .unwrap_or_else(|| format!("기본 키 {}번째 열", key.sequence + 1))
        )
    });
    let actions = format!("수정 {} · 삭제 {}", keys[0].on_update, keys[0].on_delete);
    pairs
        .chain(std::iter::once(actions))
        .collect::<Vec<_>>()
        .join("\n")
}

fn create_draft(source: &ComparedObject) -> Option<String> {
    let definition = source.details.object.ddl.as_deref()?;
    if !definition.starts_with("CREATE TABLE ") && !definition.starts_with("CREATE VIEW ") {
        return None;
    }
    if source
        .definitions
        .iter()
        .any(|value| match value.kind.as_str() {
            "index" => {
                !value.sql.starts_with("CREATE INDEX ")
                    && !value.sql.starts_with("CREATE UNIQUE INDEX ")
            }
            "trigger" => !value.sql.starts_with("CREATE TRIGGER "),
            _ => true,
        })
    {
        return None;
    }
    let mut output = String::new();
    for sql in std::iter::once(definition).chain(
        source
            .definitions
            .iter()
            .map(|definition| definition.sql.as_str()),
    ) {
        let mut statements = statement_ranges(sql);
        let statement = sql[statements.next()?].trim_end();
        if statements.next().is_some() || statement.contains('\0') {
            return None;
        }
        output.push_str(statement);
        if !statement.ends_with(';') {
            output.push_str("\n;");
        }
        output.push_str("\n\n");
    }
    Some(output)
}
