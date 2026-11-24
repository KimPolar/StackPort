use super::session::{field, kind, pg_error};
use crate::Result;
use serde::{Deserialize, Serialize};
use tokio_postgres::Client;

const PAGE_SIZE: usize = 40;

#[derive(Deserialize)]
pub struct PostgresSearchInput {
    schema: Option<u32>,
    kind: Option<SearchKind>,
    field: SearchField,
    term: String,
    page: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum SearchKind {
    Table,
    Partitioned,
    View,
    Materialized,
}

impl SearchKind {
    fn catalog_kind(&self) -> &'static str {
        match self {
            Self::Table => "r",
            Self::Partitioned => "p",
            Self::View => "v",
            Self::Materialized => "m",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum SearchField {
    Name,
    Column,
    Comment,
    Definition,
}

#[derive(Serialize)]
pub struct PostgresSearchPage {
    hits: Vec<SearchHit>,
    has_next: bool,
}

#[derive(Serialize)]
struct SearchHit {
    id: i64,
    schema_id: i64,
    schema: String,
    name: String,
    kind: &'static str,
    section: String,
    excerpt: String,
}

impl PostgresSearchInput {
    pub(super) fn validate(&self) -> Result<()> {
        let term = self.term.trim();
        if self.schema == Some(0)
            || self.term.len() > 1024
            || self.term.contains('\0')
            || (term.is_empty() && self.kind.is_none())
        {
            return Err("검색어를 입력하거나 객체 종류를 선택하세요.".into());
        }
        Ok(())
    }
}

pub(super) async fn objects(
    client: &Client,
    input: PostgresSearchInput,
) -> Result<PostgresSearchPage> {
    let term = input.term.trim();
    let catalog_kind = input.kind.as_ref().map(SearchKind::catalog_kind);
    let candidates = match (term.is_empty(), input.field) {
        (true, _) | (_, SearchField::Name) => NAME,
        (_, SearchField::Column) => COLUMN,
        (_, SearchField::Comment) => COMMENT,
        (_, SearchField::Definition) => DEFINITION,
    };
    // Only fixed catalog expressions are interpolated. All user input is bound.
    let sql = format!(
        "WITH eligible AS MATERIALIZED (
            SELECT c.oid, n.oid AS schema_id, n.nspname, c.relname, c.relkind,
                   c.relpartbound, c.relispartition
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE ($1::oid IS NULL OR n.oid = $1)
              AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
              AND c.relkind IN ('r','p','v','m') AND ($2::text IS NULL OR c.relkind::text = $2)
              AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
              AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
         )
         SELECT c.oid::bigint, c.schema_id::bigint, c.nspname::text, c.relname::text, c.relkind::text,
                found.section, pg_catalog.substr(found.content, greatest(found.position - 35, 1), 180)
         FROM eligible c
         CROSS JOIN LATERAL (
            SELECT candidate.content, candidate.section,
                   pg_catalog.strpos(pg_catalog.lower(candidate.content), pg_catalog.lower($3::text)) AS position
            FROM ({candidates}) AS candidate(content, section, priority, entry)
            WHERE pg_catalog.strpos(pg_catalog.lower(candidate.content), pg_catalog.lower($3::text)) > 0
            ORDER BY candidate.priority, candidate.entry LIMIT 1
         ) found
         ORDER BY c.nspname, c.relname, c.oid LIMIT $4 OFFSET $5"
    );
    let limit = PAGE_SIZE as i64 + 1;
    let offset = i64::from(input.page) * PAGE_SIZE as i64;
    let rows = client
        .query(
            &sql,
            &[&input.schema, &catalog_kind, &term, &limit, &offset],
        )
        .await
        .map_err(pg_error)?;
    let has_next = rows.len() > PAGE_SIZE;
    let hits = rows
        .iter()
        .take(PAGE_SIZE)
        .map(|row| {
            Ok(SearchHit {
                id: field(row, 0)?,
                schema_id: field(row, 1)?,
                schema: field(row, 2)?,
                name: field(row, 3)?,
                kind: kind(field::<String>(row, 4)?.as_str())?,
                section: field(row, 5)?,
                excerpt: field(row, 6)?,
            })
        })
        .collect::<Result<_>>()?;
    Ok(PostgresSearchPage { hits, has_next })
}

const NAME: &str = "SELECT c.relname::text, 'overview'::text, 0, 0::bigint";
const COLUMN: &str = "SELECT a.attname::text, 'columns'::text, 0, a.attnum::bigint
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped";
const COMMENT: &str = "SELECT pg_catalog.obj_description(c.oid, 'pg_class'), 'overview', 0, 0::bigint
    UNION ALL SELECT pg_catalog.col_description(c.oid, a.attnum), 'columns', 1, a.attnum::bigint
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped";
const DEFINITION: &str = "SELECT pg_catalog.pg_get_viewdef(c.oid), 'overview', 0, 0::bigint WHERE c.relkind IN ('v', 'm')
    UNION ALL SELECT pg_catalog.pg_get_partkeydef(c.oid), 'overview', 1, 0::bigint WHERE c.relkind = 'p'
    UNION ALL SELECT pg_catalog.pg_get_expr(c.relpartbound, c.oid), 'overview', 2, 0::bigint WHERE c.relispartition
    UNION ALL SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid), 'columns', 3, d.adnum::bigint
    FROM pg_catalog.pg_attrdef d WHERE d.adrelid = c.oid
    UNION ALL SELECT pg_catalog.pg_get_constraintdef(k.oid), 'constraints', 4, k.oid::bigint
    FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid AND c.relkind IN ('r', 'p')
    UNION ALL SELECT pg_catalog.pg_get_indexdef(i.indexrelid), 'indexes', 5, i.indexrelid::bigint
    FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid
    UNION ALL SELECT pg_catalog.pg_get_triggerdef(t.oid), 'triggers', 6, t.oid::bigint
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal";
