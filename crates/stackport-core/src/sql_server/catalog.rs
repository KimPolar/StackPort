use super::{query_error, required_text, Manager};
use crate::Result;
use serde::Serialize;
use tiberius::Row;

const CATALOG_LIMIT: usize = 50;
const ROW_LIMIT: usize = 50;
const COLUMN_LIMIT: usize = 64;
const VALUE_LIMIT: usize = 256;
const USER_OBJECT: &str = "o.is_ms_shipped = 0 AND o.type IN ('U', 'V')";

#[derive(Serialize)]
pub struct CatalogPage<T> {
    items: Vec<T>,
    has_next: bool,
}

#[derive(Serialize)]
pub struct Object {
    id: i32,
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
    bytes: u64,
    truncated: bool,
}

impl Manager {
    pub async fn schemas(&self, id: &str, search: &str, page: u32) -> Result<CatalogPage<String>> {
        validate_search(search)?;
        let sql = format!("SELECT s.name FROM sys.schemas AS s
            WHERE (@P1 = N'' OR CHARINDEX(@P1, s.name) > 0)
            AND EXISTS (SELECT 1 FROM sys.objects AS o WHERE o.schema_id = s.schema_id AND {USER_OBJECT})
            ORDER BY s.name, s.schema_id
            OFFSET @P2 ROWS FETCH NEXT {} ROWS ONLY", CATALOG_LIMIT + 1);
        let rows = self
            .rows(id, &sql, &[&search, &offset(page, CATALOG_LIMIT)])
            .await?;
        let items = rows
            .iter()
            .map(|row| required_text(row, 0).map(str::to_owned))
            .collect::<Result<_>>()?;
        Ok(catalog_page(items))
    }

    pub async fn objects(
        &self,
        id: &str,
        schema: &str,
        search: &str,
        page: u32,
    ) -> Result<CatalogPage<Object>> {
        validate_search(search)?;
        if !super::profiles::valid_identifier(schema) {
            return Err("SQL Server 스키마 이름을 확인하세요.".into());
        }
        let sql = format!(
            "SELECT o.object_id, s.name, o.name, RTRIM(o.type)
            FROM sys.objects AS o INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id
            WHERE {USER_OBJECT} AND s.name = @P1 AND (@P2 = N'' OR CHARINDEX(@P2, o.name) > 0)
            ORDER BY o.name, o.object_id
            OFFSET @P3 ROWS FETCH NEXT {} ROWS ONLY",
            CATALOG_LIMIT + 1
        );
        let rows = self
            .rows(id, &sql, &[&schema, &search, &offset(page, CATALOG_LIMIT)])
            .await?;
        Ok(catalog_page(
            rows.iter().map(decode_object).collect::<Result<_>>()?,
        ))
    }

    async fn object(&self, id: &str, object: i32) -> Result<Object> {
        let sql = format!(
            "SELECT o.object_id, s.name, o.name, RTRIM(o.type)
            FROM sys.objects AS o INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id
            WHERE {USER_OBJECT} AND o.object_id = @P1"
        );
        let rows = self.rows(id, &sql, &[&object]).await?;
        decode_object(
            rows.first()
                .ok_or("SQL Server 객체가 없거나 현재 계정에 공개되지 않았습니다.")?,
        )
    }

    pub async fn columns(&self, id: &str, object: i32) -> Result<CatalogPage<Column>> {
        self.object(id, object).await?;
        self.column_page(id, object).await
    }

    async fn column_page(&self, id: &str, object: i32) -> Result<CatalogPage<Column>> {
        let sql = format!("SELECT TOP ({})
            c.name, t.name, COALESCE(bt.name, t.name), c.is_nullable, c.is_identity,
            c.max_length, c.precision, c.scale
            FROM sys.columns AS c INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
            LEFT JOIN sys.types AS bt ON bt.user_type_id = c.system_type_id AND bt.user_type_id = bt.system_type_id
            WHERE c.object_id = @P1 AND c.is_hidden = 0 ORDER BY c.column_id", COLUMN_LIMIT + 1);
        let rows = self.rows(id, &sql, &[&object]).await?;
        let mut items = rows.iter().map(decode_column).collect::<Result<Vec<_>>>()?;
        let has_next = items.len() > COLUMN_LIMIT;
        items.truncate(COLUMN_LIMIT);
        Ok(CatalogPage { items, has_next })
    }

    pub async fn data(&self, id: &str, object: i32, page: u32) -> Result<DataPage> {
        let target = self.object(id, object).await?;
        let CatalogPage {
            items: columns,
            has_next: more_columns,
        } = self.column_page(id, object).await?;
        if columns.is_empty() {
            return Err("SQL Server 계정에 공개된 열이 없습니다.".into());
        }
        let keys = self.rows(id, "SELECT c.name, ic.is_descending_key FROM sys.indexes AS i
            INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            INNER JOIN sys.columns AS c ON c.object_id = i.object_id AND c.column_id = ic.column_id
            WHERE i.object_id = @P1 AND i.is_primary_key = 1 AND ic.key_ordinal > 0
            ORDER BY ic.key_ordinal", &[&object]).await?;
        let keys = keys
            .iter()
            .map(|row| {
                let direction = if get::<bool>(row, 1)? { "DESC" } else { "ASC" };
                Ok(format!("{} {direction}", ident(required_text(row, 0)?)))
            })
            .collect::<Result<Vec<_>>>()?;
        let stable_order = !keys.is_empty();
        let select = columns
            .iter()
            .map(value_expression)
            .collect::<Vec<_>>()
            .join(", ");
        let table = format!("{}.{}", ident(&target.schema), ident(&target.name));
        let result = if stable_order {
            let sql = format!(
                "SELECT {select} FROM {table} ORDER BY {}
                OFFSET @P1 ROWS FETCH NEXT {} ROWS ONLY",
                keys.join(", "),
                ROW_LIMIT + 1
            );
            self.rows(id, &sql, &[&offset(page, ROW_LIMIT)]).await?
        } else {
            if page != 0 {
                return Err("기본 키가 없어 첫 페이지를 다시 열어야 합니다.".into());
            }
            let sql = format!("SELECT TOP ({ROW_LIMIT}) {select} FROM {table}");
            self.rows(id, &sql, &[]).await?
        };
        let has_next = result.len() > ROW_LIMIT;
        let rows = result
            .iter()
            .take(ROW_LIMIT)
            .map(|row| {
                columns
                    .iter()
                    .enumerate()
                    .map(|(index, column)| decode_value(row, index, column))
                    .collect::<Result<Vec<_>>>()
            })
            .collect::<Result<_>>()?;
        Ok(DataPage {
            columns,
            rows,
            has_next,
            more_columns,
            stable_order,
        })
    }
}

fn offset(page: u32, limit: usize) -> i64 {
    i64::from(page) * limit as i64
}

fn catalog_page<T>(mut items: Vec<T>) -> CatalogPage<T> {
    let has_next = items.len() > CATALOG_LIMIT;
    items.truncate(CATALOG_LIMIT);
    CatalogPage { items, has_next }
}

fn validate_search(value: &str) -> Result<()> {
    if value.encode_utf16().count() > 128 || value.contains('\0') {
        return Err("SQL Server 검색어는 128자 이하여야 합니다.".into());
    }
    Ok(())
}

fn get<'a, T: tiberius::FromSql<'a>>(row: &'a Row, index: usize) -> Result<T> {
    row.try_get(index)
        .map_err(query_error)?
        .ok_or_else(|| "SQL Server 응답에서 필요한 값을 읽을 수 없습니다.".into())
}

fn decode_object(row: &Row) -> Result<Object> {
    Ok(Object {
        id: get(row, 0)?,
        schema: required_text(row, 1)?.into(),
        name: required_text(row, 2)?.into(),
        kind: if required_text(row, 3)? == "V" {
            "view"
        } else {
            "table"
        },
    })
}

fn decode_column(row: &Row) -> Result<Column> {
    let declared = required_text(row, 1)?;
    let native_type = required_text(row, 2)?.to_owned();
    let data_type = if declared == native_type {
        type_display(declared, get(row, 5)?, get(row, 6)?, get(row, 7)?)
    } else {
        declared.into()
    };
    Ok(Column {
        name: required_text(row, 0)?.into(),
        data_type,
        nullable: get(row, 3)?,
        identity: get(row, 4)?,
        native_type,
    })
}

fn type_display(name: &str, length: i16, precision: u8, scale: u8) -> String {
    match name {
        "char" | "varchar" | "nchar" | "nvarchar" | "binary" | "varbinary" => {
            let units = if name.starts_with('n') {
                length / 2
            } else {
                length
            };
            let size = if length == -1 {
                "max".into()
            } else {
                units.to_string()
            };
            format!("{name}({size})")
        }
        "decimal" | "numeric" => format!("{name}({precision},{scale})"),
        "time" | "datetime2" | "datetimeoffset" => format!("{name}({scale})"),
        _ => name.into(),
    }
}

fn ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

fn is_binary(column: &Column) -> bool {
    matches!(
        column.native_type.as_str(),
        "binary" | "varbinary" | "image" | "timestamp" | "rowversion"
    )
}

fn value_expression(column: &Column) -> String {
    let name = ident(&column.name);
    if is_binary(column) {
        return format!("CONVERT(nvarchar({}), SUBSTRING(CONVERT(varbinary(max), {name}), 1, {VALUE_LIMIT}), 2),
            CONVERT(bigint, DATALENGTH({name}))", VALUE_LIMIT * 2);
    }
    let raw = match column.native_type.as_str() {
        "float" | "real" => format!("CONVERT(nvarchar(max), {name}, 3)"),
        "money" | "smallmoney" => format!("CONVERT(nvarchar(max), {name}, 2)"),
        "date" | "datetime" | "datetime2" | "datetimeoffset" | "smalldatetime" | "time" => {
            format!("CONVERT(nvarchar(max), {name}, 126)")
        }
        "geometry" | "geography" => format!("{name}.STAsText()"),
        "hierarchyid" => format!("{name}.ToString()"),
        "bit" | "tinyint" | "smallint" | "int" | "bigint" | "decimal" | "numeric" | "char"
        | "varchar" | "nchar" | "nvarchar" | "text" | "ntext" | "xml" | "uniqueidentifier"
        | "json" => format!("CONVERT(nvarchar(max), {name})"),
        _ => format!("CASE WHEN {name} IS NULL THEN NULL ELSE N'[미리보기 미지원]' END"),
    };
    format!("LEFT(({raw}) COLLATE Latin1_General_100_CI_AS_SC, {VALUE_LIMIT}), CONVERT(bigint, DATALENGTH({raw}))")
}

fn decode_value(row: &Row, index: usize, column: &Column) -> Result<Option<Value>> {
    let Some(text) = row.try_get::<&str, _>(index * 2).map_err(query_error)? else {
        return Ok(None);
    };
    let bytes = get::<i64>(row, index * 2 + 1)? as u64;
    let (encoding, preview_bytes) = if is_binary(column) {
        ("hex", (text.len() / 2) as u64)
    } else {
        ("utf8", (text.encode_utf16().count() * 2) as u64)
    };
    Ok(Some(Value {
        text: text.into(),
        encoding,
        bytes,
        truncated: bytes > preview_bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delimits_identifiers_and_displays_native_lengths() {
        assert_eq!(ident("view]; SELECT"), "[view]]; SELECT]");
        assert_eq!(type_display("nvarchar", 80, 0, 0), "nvarchar(40)");
        assert_eq!(type_display("varbinary", -1, 0, 0), "varbinary(max)");
        assert_eq!(type_display("decimal", 13, 24, 6), "decimal(24,6)");
    }
}
