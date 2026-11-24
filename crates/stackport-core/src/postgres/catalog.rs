use super::session::{field, kind, pg_error};
use crate::Result;
use serde::{Deserialize, Serialize};
use tokio_postgres::{Row, Transaction};

const PAGE_SIZE: usize = 32;
const DEFINITION_LIMIT: usize = 16_384;
const COMMENT_LIMIT: usize = 2_048;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PostgresStructureSection {
    Overview,
    Columns,
    Constraints,
    Indexes,
    Triggers,
    Partitions,
}

#[derive(Serialize)]
#[serde(tag = "section", rename_all = "snake_case")]
pub enum PostgresStructure {
    Overview {
        overview: Overview,
    },
    Columns {
        columns: Vec<Column>,
        has_next: bool,
    },
    Constraints {
        constraints: Vec<Constraint>,
        has_next: bool,
    },
    Indexes {
        indexes: Vec<Index>,
        has_next: bool,
    },
    Triggers {
        triggers: Vec<Trigger>,
        has_next: bool,
    },
    Partitions {
        partitions: Vec<Partition>,
        has_next: bool,
    },
}

#[derive(Serialize)]
pub struct Fragment {
    text: String,
    truncated: bool,
}

#[derive(Serialize)]
pub struct Overview {
    owner: String,
    persistence: String,
    access: Vec<&'static str>,
    row_security: bool,
    force_row_security: bool,
    populated: Option<bool>,
    comment: Option<Fragment>,
    view_sql: Option<Fragment>,
    partition_key: Option<Fragment>,
    partition_bound: Option<Fragment>,
}

#[derive(Serialize)]
pub struct Column {
    position: i32,
    name: String,
    data_type: String,
    not_null: bool,
    identity: String,
    generated: String,
    expression: Option<Fragment>,
    collation: Option<String>,
    comment: Option<Fragment>,
}

#[derive(Serialize)]
pub struct Constraint {
    name: String,
    kind: String,
    validated: bool,
    deferrable: bool,
    initially_deferred: bool,
    columns: Vec<String>,
    reference: Option<Reference>,
    definition: Option<Fragment>,
}

#[derive(Serialize)]
struct Reference {
    schema: String,
    name: String,
    columns: Vec<String>,
    target: Option<RelatedObject>,
}

#[derive(Serialize)]
struct RelatedObject {
    id: i64,
    schema_id: i64,
    kind: &'static str,
}

#[derive(Serialize)]
pub struct Index {
    name: String,
    method: String,
    unique: bool,
    primary: bool,
    valid: bool,
    ready: bool,
    partial: bool,
    size_bytes: Option<i64>,
    definition: Option<Fragment>,
}

#[derive(Serialize)]
pub struct Trigger {
    name: String,
    enabled: String,
    definition: Option<Fragment>,
}

#[derive(Serialize)]
pub struct Partition {
    schema: String,
    name: String,
    partitioned: bool,
    bound: Option<Fragment>,
    target: Option<RelatedObject>,
}

pub(super) struct Relation {
    pub schema: String,
    pub name: String,
    pub kind: &'static str,
}

pub(super) async fn relation(tx: &Transaction<'_>, object: i64) -> Result<Relation> {
    let row = tx.query_opt(
        "SELECT n.nspname::text, c.relname::text, c.relkind::text, pg_catalog.has_table_privilege(c.oid, 'SELECT')
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid::bigint = $1 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND c.relkind IN ('r','p','v','m')", &[&object],
    ).await.map_err(pg_error)?.ok_or("조회할 수 있는 PostgreSQL 객체를 찾을 수 없습니다.")?;
    if !field::<bool>(&row, 3)? {
        return Err("이 객체에 SELECT 권한이 없습니다.".into());
    }
    Ok(Relation {
        schema: field(&row, 0)?,
        name: field(&row, 1)?,
        kind: kind(field::<String>(&row, 2)?.as_str())?,
    })
}

pub(super) async fn structure(
    tx: &Transaction<'_>,
    object: i64,
    section: PostgresStructureSection,
    page: u32,
) -> Result<PostgresStructure> {
    relation(tx, object).await?;
    match section {
        PostgresStructureSection::Overview => Ok(PostgresStructure::Overview {
            overview: overview(tx, object).await?,
        }),
        PostgresStructureSection::Columns => {
            let (columns, has_next) = page_rows(tx, COLUMNS, object, page, column).await?;
            Ok(PostgresStructure::Columns { columns, has_next })
        }
        PostgresStructureSection::Constraints => {
            let (constraints, has_next) =
                page_rows(tx, CONSTRAINTS, object, page, constraint).await?;
            Ok(PostgresStructure::Constraints {
                constraints,
                has_next,
            })
        }
        PostgresStructureSection::Indexes => {
            let (indexes, has_next) = page_rows(tx, INDEXES, object, page, index).await?;
            Ok(PostgresStructure::Indexes { indexes, has_next })
        }
        PostgresStructureSection::Triggers => {
            let (triggers, has_next) = page_rows(tx, TRIGGERS, object, page, |row| {
                Ok(Trigger {
                    name: field(row, 0)?,
                    enabled: field(row, 1)?,
                    definition: definition(row, 2)?,
                })
            })
            .await?;
            Ok(PostgresStructure::Triggers { triggers, has_next })
        }
        PostgresStructureSection::Partitions => {
            let (partitions, has_next) = page_rows(tx, PARTITIONS, object, page, |row| {
                Ok(Partition {
                    schema: field(row, 0)?,
                    name: field(row, 1)?,
                    partitioned: field(row, 2)?,
                    bound: definition(row, 3)?,
                    target: related(row, 4)?,
                })
            })
            .await?;
            Ok(PostgresStructure::Partitions {
                partitions,
                has_next,
            })
        }
    }
}

async fn overview(tx: &Transaction<'_>, object: i64) -> Result<Overview> {
    let limit = DEFINITION_LIMIT as i32 + 1;
    let row = tx.query_one(
        "SELECT pg_catalog.pg_get_userbyid(c.relowner)::text, c.relpersistence::text,
                c.relrowsecurity, c.relforcerowsecurity, CASE WHEN c.relkind = 'm' THEN c.relispopulated END,
                pg_catalog.left(pg_catalog.obj_description(c.oid, 'pg_class'), 2049),
                CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.left(pg_catalog.pg_get_viewdef(c.oid, false), $2) END,
                pg_catalog.left(pg_catalog.pg_get_partkeydef(c.oid), $2),
                CASE WHEN c.relispartition THEN pg_catalog.left(pg_catalog.pg_get_expr(c.relpartbound, c.oid, false), $2) END,
                pg_catalog.has_table_privilege(c.oid, 'SELECT'), pg_catalog.has_table_privilege(c.oid, 'INSERT'),
                pg_catalog.has_table_privilege(c.oid, 'UPDATE'), pg_catalog.has_table_privilege(c.oid, 'DELETE'),
                pg_catalog.has_table_privilege(c.oid, 'TRUNCATE'), pg_catalog.has_table_privilege(c.oid, 'REFERENCES'),
                pg_catalog.has_table_privilege(c.oid, 'TRIGGER')
         FROM pg_catalog.pg_class c WHERE c.oid::bigint = $1", &[&object, &limit],
    ).await.map_err(pg_error)?;
    let mut access = Vec::new();
    for (index, privilege) in [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
    ]
    .into_iter()
    .enumerate()
    {
        if field::<bool>(&row, 9 + index)? {
            access.push(privilege);
        }
    }
    Ok(Overview {
        owner: field(&row, 0)?,
        persistence: field(&row, 1)?,
        row_security: field(&row, 2)?,
        force_row_security: field(&row, 3)?,
        populated: field(&row, 4)?,
        comment: fragment(&row, 5, COMMENT_LIMIT)?,
        view_sql: definition(&row, 6)?,
        partition_key: definition(&row, 7)?,
        partition_bound: definition(&row, 8)?,
        access,
    })
}

async fn page_rows<T>(
    tx: &Transaction<'_>,
    select: &str,
    object: i64,
    page: u32,
    decode: impl Fn(&Row) -> Result<T>,
) -> Result<(Vec<T>, bool)> {
    let sql = format!("{select} LIMIT {} OFFSET $2", PAGE_SIZE + 1);
    let limit = DEFINITION_LIMIT as i32 + 1;
    let offset = i64::from(page) * PAGE_SIZE as i64;
    let rows = tx
        .query(&sql, &[&object, &offset, &limit])
        .await
        .map_err(pg_error)?;
    let has_next = rows.len() > PAGE_SIZE;
    let values = rows
        .iter()
        .take(PAGE_SIZE)
        .map(decode)
        .collect::<Result<Vec<_>>>()?;
    Ok((values, has_next))
}

const COLUMNS: &str =
    "SELECT a.attnum::integer, a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod),
    a.attnotnull, a.attidentity::text, a.attgenerated::text,
    pg_catalog.left(pg_catalog.pg_get_expr(d.adbin, a.attrelid, false), $3),
    CASE WHEN col.oid IS NOT NULL THEN pg_catalog.format('%I.%I', n.nspname, col.collname) END,
    pg_catalog.left(pg_catalog.col_description(a.attrelid, a.attnum), 2049)
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_catalog.pg_collation col ON col.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = col.collnamespace
    WHERE a.attrelid::bigint = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum";

fn column(row: &Row) -> Result<Column> {
    Ok(Column {
        position: field(row, 0)?,
        name: field(row, 1)?,
        data_type: field(row, 2)?,
        not_null: field(row, 3)?,
        identity: field(row, 4)?,
        generated: field(row, 5)?,
        expression: definition(row, 6)?,
        collation: field(row, 7)?,
        comment: fragment(row, 8, COMMENT_LIMIT)?,
    })
}

const CONSTRAINTS: &str = "SELECT c.conname::text, c.contype::text, c.convalidated, c.condeferrable, c.condeferred,
    ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord),
    rn.nspname::text, r.relname::text,
    ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord),
    pg_catalog.left(pg_catalog.pg_get_constraintdef(c.oid, false), $3),
    COALESCE(rn.nspname !~ '^pg_' AND rn.nspname <> 'information_schema' AND r.relkind IN ('r','p')
        AND pg_catalog.has_schema_privilege(rn.oid, 'USAGE') AND pg_catalog.has_table_privilege(r.oid, 'SELECT'), false),
    r.oid::bigint, rn.oid::bigint, r.relkind::text
    FROM pg_catalog.pg_constraint c LEFT JOIN pg_catalog.pg_class r ON r.oid = c.confrelid
    LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = r.relnamespace
    WHERE c.conrelid::bigint = $1 ORDER BY c.contype, c.conname, c.oid";

fn constraint(row: &Row) -> Result<Constraint> {
    let reference = match (field(row, 6)?, field(row, 7)?) {
        (Some(schema), Some(name)) => Some(Reference {
            schema,
            name,
            columns: field(row, 8)?,
            target: related(row, 10)?,
        }),
        _ => None,
    };
    Ok(Constraint {
        name: field(row, 0)?,
        kind: field(row, 1)?,
        validated: field(row, 2)?,
        deferrable: field(row, 3)?,
        initially_deferred: field(row, 4)?,
        columns: field(row, 5)?,
        reference,
        definition: definition(row, 9)?,
    })
}

const INDEXES: &str =
    "SELECT r.relname::text, am.amname::text, i.indisunique, i.indisprimary, i.indisvalid,
    i.indisready, i.indpred IS NOT NULL,
    CASE WHEN r.relkind = 'i' THEN pg_catalog.pg_relation_size(r.oid) END,
    pg_catalog.left(pg_catalog.pg_get_indexdef(i.indexrelid), $3)
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class r ON r.oid = i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid = r.relam
    WHERE i.indrelid::bigint = $1 ORDER BY r.relname, i.indexrelid";

fn index(row: &Row) -> Result<Index> {
    Ok(Index {
        name: field(row, 0)?,
        method: field(row, 1)?,
        unique: field(row, 2)?,
        primary: field(row, 3)?,
        valid: field(row, 4)?,
        ready: field(row, 5)?,
        partial: field(row, 6)?,
        size_bytes: field(row, 7)?,
        definition: definition(row, 8)?,
    })
}

const TRIGGERS: &str = "SELECT t.tgname::text, t.tgenabled::text, pg_catalog.left(pg_catalog.pg_get_triggerdef(t.oid, false), $3)
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid::bigint = $1 AND NOT t.tgisinternal ORDER BY t.tgname, t.oid";

const PARTITIONS: &str = "SELECT n.nspname::text, child.relname::text, child.relkind = 'p',
    pg_catalog.left(pg_catalog.pg_get_expr(child.relpartbound, child.oid, false), $3),
    child.relkind IN ('r','p') AND pg_catalog.has_table_privilege(child.oid, 'SELECT'),
    child.oid::bigint, n.oid::bigint, child.relkind::text
    FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = child.relnamespace
    WHERE i.inhparent::bigint = $1 AND child.relispartition AND n.nspname !~ '^pg_'
    AND n.nspname <> 'information_schema' AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
    ORDER BY n.nspname, child.relname, child.oid";

fn related(row: &Row, start: usize) -> Result<Option<RelatedObject>> {
    if !field::<bool>(row, start)? {
        return Ok(None);
    }
    Ok(Some(RelatedObject {
        id: field(row, start + 1)?,
        schema_id: field(row, start + 2)?,
        kind: kind(field::<String>(row, start + 3)?.as_str())?,
    }))
}

fn definition(row: &Row, index: usize) -> Result<Option<Fragment>> {
    fragment(row, index, DEFINITION_LIMIT)
}

fn fragment(row: &Row, index: usize, limit: usize) -> Result<Option<Fragment>> {
    Ok(field::<Option<String>>(row, index)?.map(|mut text| {
        let end = text.char_indices().nth(limit).map(|(position, _)| position);
        if let Some(end) = end {
            text.truncate(end);
        }
        Fragment {
            text,
            truncated: end.is_some(),
        }
    }))
}
