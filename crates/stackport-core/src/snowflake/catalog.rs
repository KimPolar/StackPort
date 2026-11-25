use super::{api::Row, profiles::valid_identifier, Manager, Session};
use crate::Result;
use serde::Serialize;

const CATALOG_ROWS: usize = 50;
const DATA_ROWS: usize = 50;
const PREVIEW_COLUMNS: usize = 64;
const CELL_LIMIT: usize = 256;
const INVALID_RESULT: &str = "Snowflake 조회 결과의 형식이 올바르지 않습니다.";

#[derive(Serialize)]
pub struct CatalogPage<T> {
    items: Vec<T>,
    has_next: bool,
}

impl<T> CatalogPage<T> {
    fn new(mut items: Vec<T>, limit: usize) -> Self {
        let has_next = items.len() > limit;
        items.truncate(limit);
        Self { items, has_next }
    }
}

#[derive(Serialize)]
pub struct Object {
    id: String,
    schema: String,
    name: String,
    kind: ObjectKind,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ObjectKind {
    Table,
    View,
    MaterializedView,
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
    rows: Vec<Vec<Option<Cell>>>,
    has_next: bool,
    stable_order: bool,
    more_columns: bool,
}

#[derive(Serialize)]
struct Cell {
    text: String,
    encoding: &'static str,
    bytes: usize,
    truncated: bool,
}

impl Manager {
    pub async fn schemas(
        &self,
        id: &str,
        search: String,
        page: u32,
    ) -> Result<CatalogPage<String>> {
        let session = self.session(id)?;
        let _operation = session.operation()?;
        let offset = page_offset(page)?;
        let condition = search_clause(&search, "SCHEMA_NAME")?;
        let mut bindings = Vec::new();
        if !condition.is_empty() {
            bindings.push(search.trim());
        }
        let information = format!("{}.INFORMATION_SCHEMA", quote(&session.database));
        let sql = format!(
            "SELECT SCHEMA_NAME FROM {information}.SCHEMATA WHERE TRUE{condition} \
                           ORDER BY SCHEMA_NAME LIMIT {limit} OFFSET {offset}",
            limit = CATALOG_ROWS + 1
        );
        let rows = session.api.query(&sql, &bindings, CATALOG_ROWS + 1).await?;
        let names = rows
            .into_iter()
            .map(|row| {
                let [name] = exact(row)?;
                identifier(name)
            })
            .collect::<Result<_>>()?;
        Ok(CatalogPage::new(names, CATALOG_ROWS))
    }

    pub async fn objects(
        &self,
        id: &str,
        schema: String,
        search: String,
        page: u32,
    ) -> Result<CatalogPage<Object>> {
        if !valid_identifier(&schema) {
            return Err("Snowflake 스키마 이름을 확인하세요.".into());
        }
        let session = self.session(id)?;
        let _operation = session.operation()?;
        let offset = page_offset(page)?;
        let condition = search_clause(&search, "TABLE_NAME")?;
        let mut bindings = vec![schema.as_str()];
        if !condition.is_empty() {
            bindings.push(search.trim());
        }
        let information = format!("{}.INFORMATION_SCHEMA", quote(&session.database));
        let sql = format!("SELECT TABLE_NAME, TABLE_TYPE FROM {information}.TABLES \
                           WHERE TABLE_SCHEMA = ?{condition} ORDER BY TABLE_NAME LIMIT {limit} OFFSET {offset}",
            limit = CATALOG_ROWS + 1);
        let rows = session.api.query(&sql, &bindings, CATALOG_ROWS + 1).await?;
        let objects = rows
            .into_iter()
            .map(|row| {
                let [name, kind] = exact(row)?;
                let name = identifier(name)?;
                let kind = match kind.as_deref().ok_or(INVALID_RESULT)? {
                    "VIEW" => ObjectKind::View,
                    "MATERIALIZED VIEW" => ObjectKind::MaterializedView,
                    _ => ObjectKind::Table,
                };
                let id = serde_json::to_string(&[&schema, &name]).map_err(|_| INVALID_RESULT)?;
                Ok(Object {
                    id,
                    schema: schema.clone(),
                    name,
                    kind,
                })
            })
            .collect::<Result<_>>()?;
        Ok(CatalogPage::new(objects, CATALOG_ROWS))
    }

    pub async fn columns(&self, id: &str, object: String) -> Result<CatalogPage<Column>> {
        let session = self.session(id)?;
        let _operation = session.operation()?;
        let [schema, name] = object_names(&object)?;
        visible_columns(&session, &schema, &name).await
    }

    pub async fn data(&self, id: &str, object: String, page: u32) -> Result<DataPage> {
        if page != 0 {
            return Err("Snowflake 미리보기는 최대 50행까지 제공합니다.".into());
        }
        let session = self.session(id)?;
        let _operation = session.operation()?;
        let [schema, name] = object_names(&object)?;
        let columns = visible_columns(&session, &schema, &name).await?;
        if columns.items.is_empty() {
            return Err("Snowflake 객체에 표시할 열이 없거나 조회 권한이 없습니다.".into());
        }
        let sql = preview_sql(&session.database, &schema, &name, &columns.items);
        let rows = session.api.query(&sql, &[], DATA_ROWS).await?;
        let rows = rows
            .into_iter()
            .map(|row| parse_preview_row(row, &columns.items))
            .collect::<Result<_>>()?;
        Ok(DataPage {
            columns: columns.items,
            rows,
            has_next: false,
            stable_order: false,
            more_columns: columns.has_next,
        })
    }
}

async fn visible_columns(
    session: &Session,
    schema: &str,
    name: &str,
) -> Result<CatalogPage<Column>> {
    let information = format!("{}.INFORMATION_SCHEMA", quote(&session.database));
    let sql = format!(
        "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, IS_IDENTITY, \
                       NUMERIC_PRECISION, NUMERIC_SCALE FROM {information}.COLUMNS \
                       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                       ORDER BY ORDINAL_POSITION LIMIT {limit}",
        limit = PREVIEW_COLUMNS + 1
    );
    let rows = session
        .api
        .query(&sql, &[schema, name], PREVIEW_COLUMNS + 1)
        .await?;
    let columns = rows
        .into_iter()
        .map(|row| {
            let [name, native_type, nullable, identity, precision, scale] = exact(row)?;
            let native_type = native_type.ok_or(INVALID_RESULT)?;
            let mut data_type = native_type.clone();
            if native_type == "NUMBER" {
                if let (Some(precision), Some(scale)) = (precision, scale) {
                    data_type = format!("{data_type}({precision},{scale})");
                }
            }
            Ok(Column {
                name: identifier(name)?,
                data_type,
                nullable: nullable.as_deref() == Some("YES"),
                identity: identity.as_deref() == Some("YES"),
                native_type,
            })
        })
        .collect::<Result<_>>()?;
    Ok(CatalogPage::new(columns, PREVIEW_COLUMNS))
}

fn page_offset(page: u32) -> Result<usize> {
    if page > 10_000 {
        return Err("Snowflake 탐색 페이지 범위를 벗어났습니다.".into());
    }
    Ok(page as usize * CATALOG_ROWS)
}

fn search_clause(search: &str, column: &str) -> Result<String> {
    if search.chars().count() > 128 || search.chars().any(char::is_control) {
        return Err("검색어는 128자 이내로 입력하세요.".into());
    }
    Ok(if search.trim().is_empty() {
        String::new()
    } else {
        format!(" AND CONTAINS(UPPER({column}), UPPER(?))")
    })
}

fn identifier(value: Option<String>) -> Result<String> {
    value
        .filter(|text| valid_identifier(text))
        .ok_or_else(|| INVALID_RESULT.into())
}

fn exact<const N: usize>(row: Row) -> Result<[Option<String>; N]> {
    row.try_into().map_err(|_| INVALID_RESULT.into())
}

fn object_names(object: &str) -> Result<[String; 2]> {
    if object.len() <= 4_096 {
        if let Ok(names) = serde_json::from_str::<[String; 2]>(object) {
            if names.iter().all(|name| valid_identifier(name)) {
                return Ok(names);
            }
        }
    }
    Err("Snowflake 목록에서 테이블 또는 뷰를 선택하세요.".into())
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

impl Column {
    fn binary(&self) -> bool {
        matches!(self.native_type.as_str(), "BINARY" | "VARBINARY")
    }

    fn preview_expression(&self, alias: &str) -> String {
        let name = quote(&self.name);
        let expression = match self.native_type.as_str() {
            "BINARY" | "VARBINARY" => name,
            "DATE" => format!("TO_VARCHAR({name}, 'YYYY-MM-DD')"),
            "TIME" => format!("TO_VARCHAR({name}, 'HH24:MI:SS.FF9')"),
            "TIMESTAMP_NTZ" => format!("TO_VARCHAR({name}, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF9')"),
            "TIMESTAMP_LTZ" | "TIMESTAMP_TZ" => {
                format!("TO_VARCHAR({name}, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF9TZH:TZM')")
            }
            "VECTOR" => format!("TO_VARCHAR({name}::ARRAY)"),
            _ => format!("TO_VARCHAR({name})"),
        };
        format!("{expression} AS {alias}")
    }
}

fn preview_sql(database: &str, schema: &str, name: &str, columns: &[Column]) -> String {
    let table = [database, schema, name].map(quote).join(".");
    let mut inner = Vec::with_capacity(columns.len());
    let mut outer = Vec::with_capacity(columns.len() * 2);
    for (index, column) in columns.iter().enumerate() {
        let alias = format!("C{index}");
        inner.push(column.preview_expression(&alias));
        if column.binary() {
            outer.push(format!("HEX_ENCODE(SUBSTR({alias}, 1, {CELL_LIMIT}))"));
        } else {
            outer.push(format!("LEFT({alias}, {CELL_LIMIT})"));
        }
        outer.push(format!("OCTET_LENGTH({alias})"));
    }
    format!(
        "SELECT {} FROM (SELECT {} FROM {table} LIMIT {DATA_ROWS}) AS SAMPLE_ROWS",
        outer.join(", "),
        inner.join(", ")
    )
}

fn parse_preview_row(row: Row, columns: &[Column]) -> Result<Vec<Option<Cell>>> {
    if row.len() != columns.len() * 2 {
        return Err(INVALID_RESULT.into());
    }
    let mut values = row.into_iter();
    columns
        .iter()
        .map(|column| {
            let text = values.next().flatten();
            let size = values.next().flatten();
            match (text, size) {
                (None, None) => Ok(None),
                (Some(text), Some(size)) => {
                    let bytes: usize = size.parse().map_err(|_| INVALID_RESULT)?;
                    let prefix = if column.binary() {
                        if text.len() % 2 != 0 || !text.bytes().all(|byte| byte.is_ascii_hexdigit())
                        {
                            return Err(INVALID_RESULT.into());
                        }
                        text.len() / 2
                    } else {
                        text.len()
                    };
                    if bytes < prefix {
                        return Err(INVALID_RESULT.into());
                    }
                    Ok(Some(Cell {
                        text,
                        encoding: if column.binary() { "hex" } else { "utf8" },
                        bytes,
                        truncated: bytes > prefix,
                    }))
                }
                _ => Err(INVALID_RESULT.into()),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_quotes_server_identifiers_and_keeps_exact_native_values() {
        let columns = [
            column("n\"ame", "NUMBER"),
            column("데이터", "TEXT"),
            column("blob", "BINARY"),
            column("missing", "TEXT"),
        ];
        let target = serde_json::to_string(&["Case.Schema", "T\"able"]).unwrap();
        let [schema, name] = object_names(&target).unwrap();
        let sql = preview_sql("DB", &schema, &name, &columns);
        assert!(sql.contains("TO_VARCHAR(\"n\"\"ame\") AS C0"));
        assert!(sql.contains("\"DB\".\"Case.Schema\".\"T\"\"able\" LIMIT 50"));
        assert!(sql.contains("HEX_ENCODE(SUBSTR(C2, 1, 256))"));
        let number = "123456789012345678901234567890.12345678";
        let row = [
            Some(number),
            Some("39"),
            Some("서울"),
            Some("10"),
            Some("00FF"),
            Some("9"),
            None,
            None,
        ]
        .map(|value| value.map(str::to_owned))
        .to_vec();
        let row = parse_preview_row(row, &columns).unwrap();
        assert_eq!(row[0].as_ref().unwrap().text, number);
        assert!(!row[0].as_ref().unwrap().truncated);
        assert!(row[1].as_ref().unwrap().truncated);
        let binary = row[2].as_ref().unwrap();
        assert_eq!(
            (binary.encoding, binary.bytes, binary.truncated),
            ("hex", 9, true)
        );
        assert!(row[3].is_none());
    }

    fn column(name: &str, data_type: &str) -> Column {
        Column {
            name: name.into(),
            data_type: data_type.into(),
            native_type: data_type.into(),
            nullable: true,
            identity: false,
        }
    }
}
