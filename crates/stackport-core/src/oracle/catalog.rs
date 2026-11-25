use super::{query_error, Manager};
use crate::Result;
use oracledb::{Connection, Row, ToDbValue};
use serde::Serialize;

const PAGE_LIMIT: i64 = 50;
const COLUMN_LIMIT: i64 = 64;
const VALUE_LIMIT: i64 = 256;
const OBJECTS: &str = "o.oracle_maintained = 'N' AND o.subobject_name IS NULL
    AND o.object_type IN ('TABLE','VIEW')";
// A grantee can see the underlying table in ALL_OBJECTS even when its materialized-view row is hidden.
const OBJECT_KIND: &str = "CASE WHEN o.object_type = 'TABLE' AND EXISTS (
    SELECT 1 FROM all_mviews m WHERE m.owner = o.owner AND m.mview_name = o.object_name
    ) THEN 'MATERIALIZED VIEW' ELSE o.object_type END";

#[derive(Serialize)]
pub struct CatalogPage<T> {
    items: Vec<T>,
    has_next: bool,
}

#[derive(Serialize)]
pub struct Object {
    id: i64,
    schema: String,
    name: String,
    kind: &'static str,
}

#[derive(Serialize)]
pub struct Column {
    name: String,
    data_type: String,
    nullable: bool,
    identity: bool,
    #[serde(skip)]
    native_type: String,
}

#[derive(Serialize)]
pub struct DataPage {
    columns: Vec<Column>,
    rows: Vec<Vec<Option<Value>>>,
    has_next: bool,
    more_columns: bool,
    stable_order: bool,
}

#[derive(Serialize)]
struct Value {
    text: String,
    encoding: &'static str,
    bytes: Option<i64>,
    truncated: bool,
}

impl Manager {
    pub async fn schemas(
        &self,
        id: &str,
        search: String,
        page: u32,
    ) -> Result<CatalogPage<String>> {
        validate_search(&search)?;
        self.read(id, move |connection| {
            let sql = format!(
                "SELECT DISTINCT o.owner FROM all_objects o WHERE {OBJECTS}
                AND INSTR(UPPER(o.owner), UPPER(NVL(:term, o.owner))) > 0
                ORDER BY o.owner OFFSET :skip ROWS FETCH NEXT :limit ROWS ONLY"
            );
            let rows = rows(
                connection,
                &sql,
                &[&search, &offset(page), &(PAGE_LIMIT + 1)],
            )?;
            Ok(catalog_page(
                rows.iter()
                    .map(|row| row.get::<String>(0).map_err(query_error))
                    .collect::<Result<_>>()?,
            ))
        })
        .await
    }

    pub async fn objects(
        &self,
        id: &str,
        schema: String,
        search: String,
        page: u32,
    ) -> Result<CatalogPage<Object>> {
        validate_search(&search)?;
        if schema.is_empty() || schema.len() > 128 || schema.contains('\0') {
            return Err("Oracle 스키마 이름을 확인하세요.".into());
        }
        self.read(id, move |connection| {
            let sql = format!(
                "SELECT o.object_id, o.owner, o.object_name, {OBJECT_KIND}
                FROM all_objects o WHERE {OBJECTS} AND o.owner = :owner
                AND INSTR(UPPER(o.object_name), UPPER(NVL(:term, o.object_name))) > 0
                ORDER BY o.object_name, o.object_id OFFSET :skip ROWS FETCH NEXT :limit ROWS ONLY"
            );
            let rows = rows(
                connection,
                &sql,
                &[&schema, &search, &offset(page), &(PAGE_LIMIT + 1)],
            )?;
            Ok(catalog_page(
                rows.iter().map(decode_object).collect::<Result<_>>()?,
            ))
        })
        .await
    }

    pub async fn columns(&self, id: &str, object: i64) -> Result<CatalogPage<Column>> {
        self.read(id, move |connection| {
            columns(connection, &find_object(connection, object)?)
        })
        .await
    }

    pub async fn data(&self, id: &str, object: i64, page: u32) -> Result<DataPage> {
        self.read(id, move |connection| data(connection, object, page))
            .await
    }
}

fn rows(connection: &Connection, sql: &str, values: &[&dyn ToDbValue]) -> Result<Vec<Row>> {
    connection
        .query(sql, values)
        .map_err(query_error)?
        .map(|row| row.map_err(query_error))
        .collect()
}

fn find_object(connection: &Connection, id: i64) -> Result<Object> {
    let sql = format!(
        "SELECT o.object_id, o.owner, o.object_name, {OBJECT_KIND}
        FROM all_objects o WHERE {OBJECTS} AND o.object_id = :id"
    );
    let rows = rows(connection, &sql, &[&id])?;
    decode_object(
        rows.first()
            .ok_or("Oracle 객체가 없거나 현재 계정에 공개되지 않았습니다.")?,
    )
}

fn columns(connection: &Connection, object: &Object) -> Result<CatalogPage<Column>> {
    let rows = rows(
        connection,
        "SELECT column_name, data_type, nullable, identity_column,
            data_precision, data_scale, char_length, char_used, data_length
        FROM all_tab_columns
        WHERE owner = :owner AND table_name = :name AND column_id IS NOT NULL
        ORDER BY column_id FETCH FIRST :limit ROWS ONLY",
        &[&object.schema, &object.name, &(COLUMN_LIMIT + 1)],
    )?;
    let mut items = rows.iter().map(decode_column).collect::<Result<Vec<_>>>()?;
    let has_next = items.len() > COLUMN_LIMIT as usize;
    items.truncate(COLUMN_LIMIT as usize);
    Ok(CatalogPage { items, has_next })
}

fn data(connection: &Connection, id: i64, page: u32) -> Result<DataPage> {
    let target = find_object(connection, id)?;
    let CatalogPage {
        items: columns,
        has_next: more_columns,
    } = columns(connection, &target)?;
    if columns.is_empty() {
        return Err("Oracle 계정에 공개된 열이 없습니다.".into());
    }
    let keys = rows(
        connection,
        "SELECT cc.column_name
        FROM all_constraints c
        JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
        WHERE c.owner = :owner AND c.table_name = :name AND c.constraint_type = 'P'
        AND c.status = 'ENABLED' AND c.validated = 'VALIDATED' ORDER BY cc.position",
        &[&target.schema, &target.name],
    )?;
    let keys = keys
        .iter()
        .map(|row| row.get::<&str>(0).map(ident).map_err(query_error))
        .collect::<Result<Vec<_>>>()?;
    let stable_order = !keys.is_empty();
    let table = format!("{}.{}", ident(&target.schema), ident(&target.name));
    let select = columns
        .iter()
        .enumerate()
        .map(|(index, column)| value_expression(column, index))
        .collect::<Vec<_>>()
        .join(", ");
    let result = if stable_order {
        let sql = format!("SELECT {select} FROM {table} ORDER BY {} OFFSET :skip ROWS FETCH NEXT :limit ROWS ONLY", keys.join(", "));
        rows(connection, &sql, &[&offset(page), &(PAGE_LIMIT + 1)])?
    } else {
        if page != 0 {
            return Err("기본 키가 없어 첫 페이지를 다시 열어야 합니다.".into());
        }
        let sql = format!("SELECT {select} FROM {table} WHERE ROWNUM <= :limit");
        rows(connection, &sql, &[&PAGE_LIMIT])?
    };
    let has_next = result.len() > PAGE_LIMIT as usize;
    let rows = result
        .iter()
        .take(PAGE_LIMIT as usize)
        .map(|row| {
            columns
                .iter()
                .enumerate()
                .map(|(index, column)| decode_value(row, index, column))
                .collect::<Result<Vec<_>>>()
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(DataPage {
        columns,
        rows,
        has_next,
        more_columns,
        stable_order,
    })
}

fn offset(page: u32) -> i64 {
    i64::from(page) * PAGE_LIMIT
}

fn catalog_page<T>(mut items: Vec<T>) -> CatalogPage<T> {
    let has_next = items.len() > PAGE_LIMIT as usize;
    items.truncate(PAGE_LIMIT as usize);
    CatalogPage { items, has_next }
}

fn validate_search(value: &str) -> Result<()> {
    if value.len() > 512 || value.contains('\0') {
        return Err("Oracle 검색어는 512바이트 이하여야 합니다.".into());
    }
    Ok(())
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn decode_object(row: &Row) -> Result<Object> {
    Ok(Object {
        id: row.get(0).map_err(query_error)?,
        schema: row.get(1).map_err(query_error)?,
        name: row.get(2).map_err(query_error)?,
        kind: match row.get::<&str>(3).map_err(query_error)? {
            "MATERIALIZED VIEW" => "materialized_view",
            "VIEW" => "view",
            _ => "table",
        },
    })
}

fn decode_column(row: &Row) -> Result<Column> {
    let native_type = row.get::<String>(1).map_err(query_error)?;
    let data_type = match native_type.as_str() {
        "NUMBER" => match (
            row.get::<Option<i64>>(4).map_err(query_error)?,
            row.get::<Option<i64>>(5).map_err(query_error)?,
        ) {
            (Some(precision), Some(scale)) => format!("NUMBER({precision},{scale})"),
            (None, Some(scale)) => format!("NUMBER(*,{scale})"),
            _ => native_type.clone(),
        },
        "CHAR" | "VARCHAR2" => {
            let characters = row.get::<Option<&str>>(7).map_err(query_error)? == Some("C");
            let index = if characters { 6 } else { 8 };
            let units = if characters { "CHAR" } else { "BYTE" };
            format!(
                "{native_type}({} {units})",
                row.get::<i64>(index).map_err(query_error)?
            )
        }
        "NCHAR" | "NVARCHAR2" => {
            format!("{native_type}({})", row.get::<i64>(6).map_err(query_error)?)
        }
        "RAW" => format!("RAW({})", row.get::<i64>(8).map_err(query_error)?),
        _ => native_type.clone(),
    };
    Ok(Column {
        name: row.get(0).map_err(query_error)?,
        nullable: row.get::<&str>(2).map_err(query_error)? == "Y",
        identity: row.get::<&str>(3).map_err(query_error)? == "YES",
        data_type,
        native_type,
    })
}

fn is_binary(column: &Column) -> bool {
    matches!(column.native_type.as_str(), "RAW" | "BLOB")
}

fn value_expression(column: &Column, index: usize) -> String {
    let name = ident(&column.name);
    let unknown = || "CAST(NULL AS NUMBER)".to_owned();
    let limit = |length: &str| format!("{length} > {VALUE_LIMIT}");
    let (value, bytes, cropped) = match column.native_type.as_str() {
        "CHAR" | "NCHAR" | "VARCHAR2" | "NVARCHAR2" => (
            format!("SUBSTR4({name}, 1, {VALUE_LIMIT})"),
            format!("LENGTHB({name})"),
            Some(limit(&format!("LENGTH4({name})"))),
        ),
        "RAW" => {
            let size = format!("UTL_RAW.LENGTH({name})");
            let cropped = limit(&size);
            (
                format!("SUBSTR(RAWTOHEX({name}), 1, {})", VALUE_LIMIT * 2),
                size,
                Some(cropped),
            )
        }
        "BLOB" => {
            let size = format!("DBMS_LOB.GETLENGTH({name})");
            let cropped = limit(&size);
            (
                format!("RAWTOHEX(DBMS_LOB.SUBSTR({name}, {VALUE_LIMIT}, 1))"),
                size,
                Some(cropped),
            )
        }
        "CLOB" | "NCLOB" => {
            let part = format!("DBMS_LOB.SUBSTR({name}, {VALUE_LIMIT}, 1)");
            let cropped = format!("DBMS_LOB.GETLENGTH({name}) > NVL(LENGTH2({part}), 0)");
            (part, unknown(), Some(cropped))
        }
        "NUMBER" | "FLOAT" | "BINARY_FLOAT" | "BINARY_DOUBLE" => (
            format!("TO_CHAR({name}, 'TM9', 'NLS_NUMERIC_CHARACTERS = ''.,''')"),
            unknown(),
            None,
        ),
        "DATE" => (
            format!("TO_CHAR({name}, 'YYYY-MM-DD\"T\"HH24:MI:SS')"),
            unknown(),
            None,
        ),
        native if native.starts_with("TIMESTAMP") => {
            let zone = if native.contains("TIME ZONE") {
                "TZH:TZM"
            } else {
                ""
            };
            (
                format!("TO_CHAR({name}, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF{zone}')"),
                unknown(),
                None,
            )
        }
        native if native.starts_with("INTERVAL") => (format!("TO_CHAR({name})"), unknown(), None),
        "ROWID" => (format!("ROWIDTOCHAR({name})"), unknown(), None),
        _ => (
            "CAST('[미리보기 미지원]' AS VARCHAR2(100))".into(),
            unknown(),
            None,
        ),
    };
    let truncated = cropped.map_or_else(
        || "0".into(),
        |predicate| format!("CASE WHEN {predicate} THEN 1 ELSE 0 END"),
    );
    format!(
        "{value} AS sp_value_{index}, {bytes} AS sp_bytes_{index}, {truncated} AS sp_trim_{index}"
    )
}

fn decode_value(row: &Row, index: usize, column: &Column) -> Result<Option<Value>> {
    let Some(text) = row.get::<Option<String>>(index * 3).map_err(query_error)? else {
        return Ok(None);
    };
    let bytes = row.get::<Option<i64>>(index * 3 + 1).map_err(query_error)?;
    let truncated = row.get::<i64>(index * 3 + 2).map_err(query_error)? == 1;
    let encoding = if is_binary(column) { "hex" } else { "utf8" };
    Ok(Some(Value {
        text,
        bytes,
        truncated,
        encoding,
    }))
}
