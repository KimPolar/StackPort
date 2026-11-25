use super::{
    catalog::{catalog_page, get, offset, CatalogPage, CATALOG_LIMIT},
    query_error, required_text, Manager,
};
use crate::Result;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tiberius::{FromSql, Row};

const INDEXES: &str = "
SELECT i.name, i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint,
       i.is_disabled, i.is_hypothetical, i.has_filter,
       SUBSTRING(i.filter_definition, 1, 4096),
       CAST(CASE WHEN DATALENGTH(i.filter_definition) > DATALENGTH(SUBSTRING(i.filter_definition, 1, 4096))
            THEN 1 ELSE 0 END AS bit),
       stats.partition_count, CONVERT(nvarchar(24), stats.estimated_rows),
       (SELECT c.name AS name, ic.key_ordinal AS key_position,
               CASE WHEN i.type IN (1, 2) AND ic.key_ordinal > 0 THEN ic.is_descending_key END AS descending,
               CAST(CASE WHEN i.type IN (1, 2) AND ic.is_included_column = 1 THEN 1 ELSE 0 END AS bit) AS included,
               ic.partition_ordinal AS partition_position
        FROM sys.index_columns AS ic
        JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
        ORDER BY CASE WHEN ic.key_ordinal = 0 THEN 1 ELSE 0 END, ic.key_ordinal, ic.index_column_id
        FOR JSON PATH)
FROM sys.indexes AS i
OUTER APPLY (
    SELECT COUNT(*) AS partition_count, SUM(p.[rows]) AS estimated_rows
    FROM sys.partitions AS p WHERE p.object_id = i.object_id AND p.index_id = i.index_id
) AS stats
WHERE i.object_id = @P1 AND i.index_id > 0 AND i.name IS NOT NULL
ORDER BY i.name, i.index_id
OFFSET @P2 ROWS FETCH NEXT @P3 ROWS ONLY";

const CONSTRAINTS: &str = "
WITH object_constraints AS (
    SELECT k.name, k.object_id, RTRIM(k.type) AS kind, k.unique_index_id AS index_id,
           0 AS column_id, CAST(NULL AS nvarchar(max)) AS expression,
           COALESCE(i.is_disabled, CAST(0 AS bit)) AS disabled, CAST(0 AS bit) AS untrusted
    FROM sys.key_constraints AS k
    LEFT JOIN sys.indexes AS i ON i.object_id = k.parent_object_id AND i.index_id = k.unique_index_id
    WHERE k.parent_object_id = @P1
    UNION ALL
    SELECT c.name, c.object_id, 'C', 0, c.parent_column_id, c.definition, c.is_disabled, c.is_not_trusted
    FROM sys.check_constraints AS c WHERE c.parent_object_id = @P1
    UNION ALL
    SELECT d.name, d.object_id, 'D', 0, d.parent_column_id, d.definition, CAST(0 AS bit), CAST(0 AS bit)
    FROM sys.default_constraints AS d WHERE d.parent_object_id = @P1
)
SELECT k.name, k.kind, c.name, SUBSTRING(k.expression, 1, 4096),
       CAST(CASE WHEN DATALENGTH(k.expression) > DATALENGTH(SUBSTRING(k.expression, 1, 4096))
            THEN 1 ELSE 0 END AS bit),
       k.disabled, k.untrusted,
       (SELECT c.name AS name, ic.key_ordinal AS key_position,
               CASE WHEN i.type IN (1, 2) THEN ic.is_descending_key END AS descending
        FROM sys.index_columns AS ic
        JOIN sys.indexes AS i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE ic.object_id = @P1 AND ic.index_id = k.index_id AND ic.key_ordinal > 0
        ORDER BY ic.key_ordinal FOR JSON PATH)
FROM object_constraints AS k
LEFT JOIN sys.columns AS c ON c.object_id = @P1 AND c.column_id = k.column_id
ORDER BY k.name, k.object_id
OFFSET @P2 ROWS FETCH NEXT @P3 ROWS ONLY";

const FOREIGN_KEYS: &str = "
SELECT f.name, src.object_id, ss.name, src.name, dst.object_id, ds.name, dst.name,
       f.update_referential_action_desc, f.delete_referential_action_desc,
       f.is_disabled, f.is_not_trusted,
       (SELECT sc.name AS source, dc.name AS target
        FROM sys.foreign_key_columns AS fc
        LEFT JOIN sys.columns AS sc ON sc.object_id = src.object_id AND sc.column_id = fc.parent_column_id
        LEFT JOIN sys.columns AS dc ON dc.object_id = dst.object_id AND dc.column_id = fc.referenced_column_id
        WHERE fc.constraint_object_id = f.object_id
        ORDER BY fc.constraint_column_id FOR JSON PATH, INCLUDE_NULL_VALUES)
FROM sys.foreign_keys AS f
JOIN sys.objects AS src ON src.object_id = f.parent_object_id
JOIN sys.schemas AS ss ON ss.schema_id = src.schema_id
LEFT JOIN sys.objects AS dst ON dst.object_id = f.referenced_object_id
LEFT JOIN sys.schemas AS ds ON ds.schema_id = dst.schema_id
WHERE f.parent_object_id = @P1 OR f.referenced_object_id = @P1
ORDER BY f.name, f.object_id
OFFSET @P2 ROWS FETCH NEXT @P3 ROWS ONLY";

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StructureSection {
    Indexes,
    Constraints,
    ForeignKeys,
}

#[derive(Serialize)]
#[serde(tag = "section", rename_all = "snake_case")]
pub enum Structure {
    Indexes(CatalogPage<Index>),
    Constraints(CatalogPage<Constraint>),
    ForeignKeys(CatalogPage<ForeignKey>),
}

#[derive(Serialize)]
pub struct Index {
    name: String,
    method: String,
    unique: bool,
    primary_key: bool,
    unique_constraint: bool,
    disabled: bool,
    hypothetical: bool,
    has_filter: bool,
    filter: Option<Expression>,
    partitions: i32,
    estimated_rows: Option<String>,
    columns: Vec<IndexColumn>,
}

#[derive(Deserialize, Serialize)]
struct KeyColumn {
    name: String,
    key_position: u8,
    descending: Option<bool>,
}

#[derive(Deserialize, Serialize)]
struct IndexColumn {
    #[serde(flatten)]
    key: KeyColumn,
    included: bool,
    partition_position: u8,
}

#[derive(Serialize)]
pub struct Constraint {
    name: String,
    kind: String,
    column: Option<String>,
    expression: Option<Expression>,
    disabled: bool,
    untrusted: bool,
    columns: Vec<KeyColumn>,
}

#[derive(Serialize)]
struct Expression {
    text: String,
    truncated: bool,
}

#[derive(Serialize)]
pub struct ForeignKey {
    name: String,
    source: Table,
    target: Option<Table>,
    direction: Direction,
    on_update: String,
    on_delete: String,
    disabled: bool,
    untrusted: bool,
    columns: Vec<ColumnPair>,
}

#[derive(Serialize)]
struct Table {
    id: i32,
    schema: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Direction {
    Incoming,
    Outgoing,
    SelfReference,
}

#[derive(Deserialize, Serialize)]
struct ColumnPair {
    source: Option<String>,
    target: Option<String>,
}

impl Manager {
    pub async fn structure(
        &self,
        id: &str,
        object: i32,
        section: StructureSection,
        page: u32,
    ) -> Result<Structure> {
        self.object(id, object).await?;
        let sql = match section {
            StructureSection::Indexes => INDEXES,
            StructureSection::Constraints => CONSTRAINTS,
            StructureSection::ForeignKeys => FOREIGN_KEYS,
        };
        let limit = (CATALOG_LIMIT + 1) as i64;
        let rows = self
            .rows(id, sql, &[&object, &offset(page, CATALOG_LIMIT), &limit])
            .await?;
        Ok(match section {
            StructureSection::Indexes => {
                Structure::Indexes(catalog_page(rows.iter().map(index).collect::<Result<_>>()?))
            }
            StructureSection::Constraints => Structure::Constraints(catalog_page(
                rows.iter().map(constraint).collect::<Result<_>>()?,
            )),
            StructureSection::ForeignKeys => Structure::ForeignKeys(catalog_page(
                rows.iter()
                    .map(|row| foreign_key(row, object))
                    .collect::<Result<_>>()?,
            )),
        })
    }
}

fn index(row: &Row) -> Result<Index> {
    Ok(Index {
        name: required_text(row, 0)?.into(),
        method: required_text(row, 1)?.into(),
        unique: get(row, 2)?,
        primary_key: get(row, 3)?,
        unique_constraint: get(row, 4)?,
        disabled: get(row, 5)?,
        hypothetical: get(row, 6)?,
        has_filter: get(row, 7)?,
        filter: expression(row, 8, 9)?,
        partitions: get(row, 10)?,
        estimated_rows: optional_text(row, 11)?,
        columns: metadata_columns(row, 12)?,
    })
}

fn constraint(row: &Row) -> Result<Constraint> {
    Ok(Constraint {
        name: required_text(row, 0)?.into(),
        kind: required_text(row, 1)?.into(),
        column: optional_text(row, 2)?,
        expression: expression(row, 3, 4)?,
        disabled: get(row, 5)?,
        untrusted: get(row, 6)?,
        columns: metadata_columns(row, 7)?,
    })
}

fn foreign_key(row: &Row, current: i32) -> Result<ForeignKey> {
    let source =
        table(row, 1)?.ok_or("SQL Server 외래 키의 참조하는 테이블을 찾을 수 없습니다.")?;
    let target = table(row, 4)?;
    let direction = if source.id != current {
        Direction::Incoming
    } else if target.as_ref().is_some_and(|target| target.id == current) {
        Direction::SelfReference
    } else {
        Direction::Outgoing
    };
    Ok(ForeignKey {
        name: required_text(row, 0)?.into(),
        source,
        target,
        direction,
        on_update: required_text(row, 7)?.into(),
        on_delete: required_text(row, 8)?.into(),
        disabled: get(row, 9)?,
        untrusted: get(row, 10)?,
        columns: metadata_columns(row, 11)?,
    })
}

fn table(row: &Row, start: usize) -> Result<Option<Table>> {
    let (Some(id), Some(schema), Some(name)) = (
        optional::<i32>(row, start)?,
        optional_text(row, start + 1)?,
        optional_text(row, start + 2)?,
    ) else {
        return Ok(None);
    };
    Ok(Some(Table { id, schema, name }))
}

fn expression(row: &Row, text: usize, truncated: usize) -> Result<Option<Expression>> {
    let Some(text) = optional_text(row, text)? else {
        return Ok(None);
    };
    Ok(Some(Expression {
        text,
        truncated: get(row, truncated)?,
    }))
}

fn optional_text(row: &Row, column: usize) -> Result<Option<String>> {
    optional::<&str>(row, column).map(|value| value.map(str::to_owned))
}

fn optional<'a, T: FromSql<'a>>(row: &'a Row, column: usize) -> Result<Option<T>> {
    row.try_get(column).map_err(query_error)
}

fn metadata_columns<T: DeserializeOwned>(row: &Row, column: usize) -> Result<Vec<T>> {
    let value = optional::<&str>(row, column)?.unwrap_or("[]");
    serde_json::from_str(value).map_err(|_| "SQL Server 구조의 열 목록을 읽을 수 없습니다.".into())
}
