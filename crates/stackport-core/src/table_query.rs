//! SQL for the SQLite object browser. Identifiers come from a schema snapshot,
//! operators are fixed, and filter values are bound separately.

use super::{quote_identifier, ColumnInfo, Result, Store};
use rusqlite::{types::Value, Connection};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Deserialize)]
pub struct TableQuery {
    object: String,
    filters: Vec<Filter>,
    conjunction: Conjunction,
    sort: Vec<Sort>,
}

#[derive(Deserialize)]
struct Filter {
    column: String,
    condition: Condition,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Condition {
    Eq { value: FilterValue },
    Ne { value: FilterValue },
    Lt { value: FilterValue },
    Le { value: FilterValue },
    Gt { value: FilterValue },
    Ge { value: FilterValue },
    Between { from: FilterValue, to: FilterValue },
    Contains { value: String },
    IsNull,
    IsNotNull,
}

#[derive(Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
enum FilterValue {
    Text(String),
    Integer(String),
    Real(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Conjunction {
    All,
    Any,
}

#[derive(Deserialize)]
struct Sort {
    column: String,
    direction: SortDirection,
    nulls: NullOrder,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum SortDirection {
    Asc,
    Desc,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum NullOrder {
    Default,
    First,
    Last,
}

impl TableQuery {
    pub(crate) fn sql(&self, db: &Connection) -> Result<(String, Vec<Value>)> {
        if self.filters.len() > 16 || self.sort.len() > 8 {
            return Err("필터는 최대 16개, 정렬 열은 최대 8개까지 선택할 수 있습니다.".into());
        }
        let object = Store::read_object(db, &self.object)?;
        let columns = Store::object_columns(db, &object.name)?;
        let mut sql = format!(
            "SELECT sp_source.*\nFROM main.{} AS sp_source",
            quote_identifier(&object.name)
        );
        let mut params = Vec::new();
        let mut conditions = Vec::new();
        for filter in &self.filters {
            let column = source_column(&columns, &filter.column)?;
            conditions.push(filter.condition.sql(&column, &mut params)?);
        }
        if !conditions.is_empty() {
            let separator = match self.conjunction {
                Conjunction::All => " AND ",
                Conjunction::Any => " OR ",
            };
            sql.push_str("\nWHERE ");
            sql.push_str(&conditions.join(separator));
        }

        let mut seen = HashSet::new();
        let mut order = Vec::new();
        for sort in &self.sort {
            let column = source_column(&columns, &sort.column)?;
            if !seen.insert(sort.column.as_str()) {
                return Err("같은 열을 두 번 정렬할 수 없습니다.".into());
            }
            let direction = match sort.direction {
                SortDirection::Asc => "ASC",
                SortDirection::Desc => "DESC",
            };
            let nulls = match sort.nulls {
                NullOrder::Default => "",
                NullOrder::First => " NULLS FIRST",
                NullOrder::Last => " NULLS LAST",
            };
            order.push(format!("{column} {direction}{nulls}"));
        }
        // An available primary key resolves ties in the requested sort and
        // also gives plain table browsing a predictable default order.
        let mut primary_keys: Vec<_> = columns
            .iter()
            .filter(|column| column.primary_key_position > 0 && column.hidden != 1)
            .collect();
        primary_keys.sort_by_key(|column| column.primary_key_position);
        for key in primary_keys {
            if !seen.contains(key.name.as_str()) {
                order.push(format!("sp_source.{} ASC", quote_identifier(&key.name)));
            }
        }
        if !order.is_empty() {
            sql.push_str("\nORDER BY ");
            sql.push_str(&order.join(", "));
        }
        Ok((sql, params))
    }
}

impl Condition {
    fn sql(&self, column: &str, params: &mut Vec<Value>) -> Result<String> {
        let (operator, value) = match self {
            Self::Eq { value } => ("=", value),
            Self::Ne { value } => ("<>", value),
            Self::Lt { value } => ("<", value),
            Self::Le { value } => ("<=", value),
            Self::Gt { value } => (">", value),
            Self::Ge { value } => (">=", value),
            Self::Between { from, to } => {
                if std::mem::discriminant(from) != std::mem::discriminant(to) {
                    return Err("범위의 시작 값과 끝 값은 형식이 같아야 합니다.".into());
                }
                params.push(from.sqlite_value()?);
                params.push(to.sqlite_value()?);
                return Ok(format!("{column} BETWEEN ? AND ?"));
            }
            Self::Contains { value } => {
                params.push(text_value(value)?);
                return Ok(format!("instr({column}, ?) > 0"));
            }
            Self::IsNull => return Ok(format!("{column} IS NULL")),
            Self::IsNotNull => return Ok(format!("{column} IS NOT NULL")),
        };
        params.push(value.sqlite_value()?);
        Ok(format!("{column} {operator} ?"))
    }
}

impl FilterValue {
    fn sqlite_value(&self) -> Result<Value> {
        match self {
            Self::Text(value) => text_value(value),
            Self::Integer(value) => value
                .trim()
                .parse::<i64>()
                .map(Value::Integer)
                .map_err(|_| "필터 값에 64비트 정수를 입력하세요.".into()),
            Self::Real(value) => value
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite())
                .map(Value::Real)
                .ok_or_else(|| "필터 값에 유한한 실수를 입력하세요.".into()),
        }
    }
}

fn text_value(value: &str) -> Result<Value> {
    if value.chars().take(4097).count() > 4096 {
        return Err("텍스트 필터 값은 4096자까지 입력할 수 있습니다.".into());
    }
    Ok(Value::Text(value.into()))
}

fn source_column(columns: &[ColumnInfo], name: &str) -> Result<String> {
    let column = columns
        .iter()
        .find(|column| column.name == name && column.hidden != 1)
        .ok_or("테이블 또는 뷰에 표시되는 열만 필터와 정렬에 사용할 수 있습니다.")?;
    Ok(format!("sp_source.{}", quote_identifier(&column.name)))
}
