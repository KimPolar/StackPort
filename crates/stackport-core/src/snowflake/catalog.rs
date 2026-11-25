use super::{api::Row, profiles::valid_identifier, Manager, Session};
use crate::{
    native_table_filter as input,
    table_query::{bounded_filter_text, FilterOperand, FilterValue, TableQueryDialect},
    Result, TableQueryClauses,
};
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
    query_sql: String,
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

    pub async fn data(
        &self,
        id: &str,
        object: String,
        page: u32,
        clauses: TableQueryClauses,
    ) -> Result<DataPage> {
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
        let (query_sql, parameters) =
            preview_query(&session.database, &schema, &name, &columns.items, &clauses)?;
        let bindings: Vec<_> = parameters.iter().map(String::as_str).collect();
        let rows = session.api.query(&query_sql, &bindings, DATA_ROWS).await?;
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
            query_sql,
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

    fn preview_expression(&self) -> String {
        let name = format!("sp_source.{}", quote(&self.name));
        match self.native_type.as_str() {
            "BINARY" | "VARBINARY" => name,
            "DATE" => format!("TO_VARCHAR({name}, 'YYYY-MM-DD')"),
            "TIME" => format!("TO_VARCHAR({name}, 'HH24:MI:SS.FF9')"),
            "TIMESTAMP_NTZ" => format!("TO_VARCHAR({name}, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF9')"),
            "TIMESTAMP_LTZ" | "TIMESTAMP_TZ" => {
                format!("TO_VARCHAR({name}, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF9TZH:TZM')")
            }
            "VECTOR" => format!("TO_VARCHAR({name}::ARRAY)"),
            _ => format!("TO_VARCHAR({name})"),
        }
    }
}

fn preview_query(
    database: &str,
    schema: &str,
    name: &str,
    columns: &[Column],
    clauses: &TableQueryClauses,
) -> Result<(String, Vec<String>)> {
    let table = [database, schema, name].map(quote).join(".");
    let mut projection = Vec::with_capacity(columns.len() * 2);
    for column in columns {
        let expression = column.preview_expression();
        projection.push(if column.binary() {
            format!("HEX_ENCODE(SUBSTR({expression}, 1, {CELL_LIMIT}))")
        } else {
            format!("LEFT({expression}, {CELL_LIMIT})")
        });
        projection.push(format!("OCTET_LENGTH({expression})"));
    }
    let mut parameters = Vec::new();
    clauses.validate_sort(|name| {
        columns
            .iter()
            .any(|column| column.name == name && sortable(&column.native_type))
    })?;
    let suffix = clauses.suffix(
        TableQueryDialect::Snowflake,
        "sp_source",
        columns.iter().map(|column| column.name.as_str()),
        [],
        |name, value, operation| {
            let column = columns
                .iter()
                .find(|column| column.name == name)
                .ok_or(input::UNSUPPORTED)?;
            filter_binding(&column.native_type, value, operation, &mut parameters)
        },
    )?;
    Ok((
        format!(
            "SELECT {}\nFROM {table} AS sp_source{suffix}\nLIMIT {DATA_ROWS}",
            projection.join(", ")
        ),
        parameters,
    ))
}

fn sortable(native: &str) -> bool {
    matches!(
        native,
        "TEXT"
            | "VARCHAR"
            | "CHAR"
            | "STRING"
            | "NUMBER"
            | "FIXED"
            | "DECIMAL"
            | "NUMERIC"
            | "FLOAT"
            | "REAL"
            | "DOUBLE"
            | "DOUBLE PRECISION"
            | "DECFLOAT"
            | "BOOLEAN"
            | "DATE"
            | "TIME"
            | "TIMESTAMP_NTZ"
            | "TIMESTAMP_LTZ"
            | "TIMESTAMP_TZ"
            | "BINARY"
            | "VARBINARY"
    )
}

fn filter_binding(
    native: &str,
    value: &FilterValue,
    operation: FilterOperand,
    parameters: &mut Vec<String>,
) -> Result<String> {
    let text = value.text();
    bounded_filter_text(text)?;
    let character = matches!(native, "TEXT" | "VARCHAR" | "CHAR" | "STRING");
    if matches!(operation, FilterOperand::Contains) && !character {
        return Err("포함 조건은 문자열 열에 사용할 수 있습니다.".into());
    }
    let trimmed = text.trim();
    let (bound, expression) = match native {
        "TEXT" | "VARCHAR" | "CHAR" | "STRING" => (text.into(), "?".into()),
        "NUMBER" | "FIXED" | "DECIMAL" | "NUMERIC" => {
            let (precision, scale) = input::decimal_shape(trimmed)?;
            (
                trimmed.into(),
                format!("TO_DECIMAL(?, {precision}, {scale})"),
            )
        }
        "FLOAT" | "REAL" | "DOUBLE" | "DOUBLE PRECISION" => {
            input::finite_float(trimmed)?;
            (trimmed.into(), "TO_DOUBLE(?)".into())
        }
        "DECFLOAT" => {
            input::decimal_shape(trimmed)?;
            (trimmed.into(), "TO_DECFLOAT(?)".into())
        }
        "BOOLEAN" => (input::boolean(trimmed)?.to_string(), "TO_BOOLEAN(?)".into()),
        "DATE" => (
            input::date(trimmed)?.into(),
            "TO_DATE(?, 'YYYY-MM-DD')".into(),
        ),
        "TIME" => (
            input::time(trimmed, 9)?,
            "TO_TIME(?, 'HH24:MI:SS.FF9')".into(),
        ),
        "TIMESTAMP_NTZ" | "TIMESTAMP_LTZ" | "TIMESTAMP_TZ" => {
            let (mut timestamp, offset) = input::timestamp(trimmed, 9, native != "TIMESTAMP_NTZ")?;
            let expression = if let Some(offset) = offset {
                timestamp.push(' ');
                timestamp.push_str(&offset);
                "TO_TIMESTAMP_TZ(?, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF9 TZH:TZM')"
            } else {
                "TO_TIMESTAMP_NTZ(?, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF9')"
            };
            (timestamp, expression.into())
        }
        _ => return Err(input::UNSUPPORTED.into()),
    };
    parameters.push(bound);
    Ok(expression)
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
        let (sql, bindings) = preview_query(
            "DB",
            &schema,
            &name,
            &columns,
            &TableQueryClauses::default(),
        )
        .unwrap();
        assert!(bindings.is_empty());
        assert!(sql.contains("LEFT(TO_VARCHAR(sp_source.\"n\"\"ame\"), 256)"));
        assert!(sql.contains("\"DB\".\"Case.Schema\".\"T\"\"able\" AS sp_source\nLIMIT 50"));
        assert!(sql.contains("HEX_ENCODE(SUBSTR(sp_source.\"blob\", 1, 256))"));
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

    #[test]
    fn preview_binds_exact_filters_and_sorts_before_the_limit() {
        let amount = "9007199254740993.123456789";
        let literal = "a' OR 1=1 -- %_";
        let clauses = serde_json::from_value(serde_json::json!({
            "conjunction": "any",
            "filters": [
                {"column": "amount", "condition": {"kind": "eq",
                    "value": {"kind": "text", "value": amount}}},
                {"column": "label", "condition": {"kind": "contains", "value": literal}}
            ],
            "sort": [
                {"column": "amount", "direction": "desc", "nulls": "last"},
                {"column": "label", "direction": "asc", "nulls": "first"}
            ]
        }))
        .unwrap();
        let (sql, values) = preview_query(
            "DB",
            "PUBLIC",
            "ITEMS",
            &[column("amount", "NUMBER"), column("label", "TEXT")],
            &clauses,
        )
        .unwrap();
        assert_eq!(values, [amount, literal]);
        assert!(!sql.contains(literal) && !sql.contains(amount));
        assert!(sql.contains("TO_DECIMAL(?, 25, 9)"));
        assert!(sql.contains(" OR CONTAINS(sp_source.\"label\", ?)"));
        assert!(sql.ends_with(
            "ORDER BY sp_source.\"amount\" DESC NULLS LAST, sp_source.\"label\" ASC NULLS FIRST\nLIMIT 50"
        ));
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
