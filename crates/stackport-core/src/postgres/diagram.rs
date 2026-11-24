use super::session::{field, kind, pg_error};
use crate::Result;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use tokio_postgres::Transaction;

const TABLE_LIMIT: i64 = 150;
const COLUMN_LIMIT: i64 = 16_000;
const KEY_PAIR_LIMIT: i64 = 4_000;

#[derive(Serialize)]
pub struct PostgresSchemaDiagram {
    tables: Vec<Table>,
    foreign_keys: Vec<KeyPair>,
}

#[derive(Serialize)]
struct Table {
    id: u32,
    schema_id: u32,
    schema: String,
    name: String,
    label: String,
    kind: &'static str,
    columns: Vec<Column>,
}

#[derive(Serialize)]
struct Column {
    name: String,
    declared_type: String,
    primary_key_position: i32,
}

#[derive(Serialize)]
struct KeyPair {
    id: u32,
    source: u32,
    target: u32,
    sequence: i32,
    from_column: String,
    to_column: String,
    on_delete: String,
    on_update: String,
}

pub(super) async fn load(tx: &Transaction<'_>, schema: i64) -> Result<PostgresSchemaDiagram> {
    let schema = u32::try_from(schema).map_err(|_| "PostgreSQL 스키마 ID가 올바르지 않습니다.")?;
    if tx
        .query_opt(
            "SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.oid = $1
         AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')",
            &[&schema],
        )
        .await
        .map_err(pg_error)?
        .is_none()
    {
        return Err("조회할 수 있는 PostgreSQL 스키마를 찾을 수 없습니다.".into());
    }

    let roots: Vec<u32> = tx
        .query(
            "SELECT c.oid FROM pg_catalog.pg_class c WHERE c.relnamespace = $1
         AND c.relkind IN ('r','p') AND pg_catalog.has_table_privilege(c.oid, 'SELECT') LIMIT $2",
            &[&schema, &(TABLE_LIMIT + 1)],
        )
        .await
        .map_err(pg_error)?
        .iter()
        .map(|row| field(row, 0))
        .collect::<Result<_>>()?;
    if roots.len() as i64 > TABLE_LIMIT {
        return Err("스키마의 조회 가능한 테이블이 150개를 넘어 관계도를 열 수 없습니다.".into());
    }

    let rows = tx
        .query(FOREIGN_KEYS, &[&roots, &(KEY_PAIR_LIMIT + 1)])
        .await
        .map_err(pg_error)?;
    if rows.len() as i64 > KEY_PAIR_LIMIT {
        return Err("관계도의 외래 키 열 연결이 4,000개를 넘습니다.".into());
    }
    let mut ids: BTreeSet<u32> = roots.into_iter().collect();
    let mut foreign_keys = Vec::with_capacity(rows.len());
    for row in &rows {
        let key = KeyPair {
            id: field(row, 0)?,
            source: field(row, 1)?,
            target: field(row, 2)?,
            sequence: field(row, 3)?,
            from_column: field(row, 4)?,
            to_column: field(row, 5)?,
            on_delete: action(field(row, 6)?),
            on_update: action(field(row, 7)?),
        };
        ids.extend([key.source, key.target]);
        foreign_keys.push(key);
    }
    if ids.len() as i64 > TABLE_LIMIT {
        return Err(
            "다른 스키마의 연결된 테이블을 포함하면 관계도의 테이블이 150개를 넘습니다.".into(),
        );
    }
    let ids: Vec<u32> = ids.into_iter().collect();

    let rows = tx
        .query(COLUMNS, &[&ids, &(COLUMN_LIMIT + 1)])
        .await
        .map_err(pg_error)?;
    if rows.len() as i64 > COLUMN_LIMIT {
        return Err("관계도에 표시할 테이블의 열이 16,000개를 넘습니다.".into());
    }
    let mut columns: HashMap<u32, Vec<Column>> = HashMap::new();
    for row in &rows {
        columns.entry(field(row, 0)?).or_default().push(Column {
            name: field(row, 1)?,
            declared_type: field(row, 2)?,
            primary_key_position: field(row, 3)?,
        });
    }

    let rows = tx
        .query(
            "SELECT c.oid, n.oid, n.nspname::text, c.relname::text,
                pg_catalog.format('%I.%I', n.nspname, c.relname), c.relkind::text
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid = ANY($1::oid[]) ORDER BY n.oid <> $2, n.nspname, c.relname, c.oid",
            &[&ids, &schema],
        )
        .await
        .map_err(pg_error)?;
    let tables = rows
        .iter()
        .map(|row| {
            let id = field(row, 0)?;
            Ok(Table {
                id,
                schema_id: field(row, 1)?,
                schema: field(row, 2)?,
                name: field(row, 3)?,
                label: field(row, 4)?,
                kind: kind(field::<String>(row, 5)?.as_str())?,
                columns: columns.remove(&id).unwrap_or_default(),
            })
        })
        .collect::<Result<_>>()?;
    Ok(PostgresSchemaDiagram {
        tables,
        foreign_keys,
    })
}

fn action(code: i8) -> String {
    match code as u8 {
        b'a' => "NO ACTION",
        b'r' => "RESTRICT",
        b'c' => "CASCADE",
        b'n' => "SET NULL",
        b'd' => "SET DEFAULT",
        _ => "알 수 없음",
    }
    .into()
}

const FOREIGN_KEYS: &str = "
    SELECT k.oid, src.oid, dst.oid, (cols.position - 1)::integer,
           a.attname::text, b.attname::text, k.confdeltype, k.confupdtype
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class src ON src.oid = k.conrelid
    JOIN pg_catalog.pg_class dst ON dst.oid = k.confrelid
    JOIN pg_catalog.pg_namespace sn ON sn.oid = src.relnamespace
    JOIN pg_catalog.pg_namespace dn ON dn.oid = dst.relnamespace
    CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(k.conkey), pg_catalog.unnest(k.confkey))
        WITH ORDINALITY AS cols(source, target, position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = src.oid AND a.attnum = cols.source AND NOT a.attisdropped
    JOIN pg_catalog.pg_attribute b ON b.attrelid = dst.oid AND b.attnum = cols.target AND NOT b.attisdropped
    WHERE k.contype = 'f' AND k.conparentid = 0
      AND (k.conrelid = ANY($1::oid[]) OR k.confrelid = ANY($1::oid[]))
      AND src.relkind IN ('r','p') AND sn.nspname !~ '^pg_' AND sn.nspname <> 'information_schema'
      AND dst.relkind IN ('r','p') AND dn.nspname !~ '^pg_' AND dn.nspname <> 'information_schema'
      AND pg_catalog.has_schema_privilege(sn.oid, 'USAGE') AND pg_catalog.has_schema_privilege(dn.oid, 'USAGE')
      AND pg_catalog.has_table_privilege(src.oid, 'SELECT') AND pg_catalog.has_table_privilege(dst.oid, 'SELECT')
    ORDER BY k.oid, cols.position LIMIT $2";

const COLUMNS: &str = "
    SELECT a.attrelid, a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod),
           COALESCE(pg_catalog.array_position(pk.conkey, a.attnum), 0)
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_constraint pk ON pk.conrelid = a.attrelid AND pk.contype = 'p'
    WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attrelid, a.attnum LIMIT $2";
