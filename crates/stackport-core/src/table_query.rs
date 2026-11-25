//! SQL clauses for database object browsers. Identifiers come from a schema snapshot,
//! operators are fixed, and filter values are bound separately.

use super::{quote_identifier, Result, Store};
use rusqlite::{types::Value, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Deserialize)]
pub struct TableQuery {
    object: String,
    #[serde(flatten)]
    clauses: TableQueryClauses,
}

#[derive(Default, Deserialize, Serialize)]
pub struct TableQueryClauses {
    filters: Vec<Filter>,
    conjunction: Conjunction,
    sort: Vec<Sort>,
}

#[derive(Deserialize, Serialize)]
struct Filter {
    column: String,
    condition: Condition,
}

#[derive(Deserialize, Serialize)]
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

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub(crate) enum FilterValue {
    Text(String),
    Date(String),
    Integer(String),
    Real(String),
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Conjunction {
    #[default]
    All,
    Any,
}

#[derive(Deserialize, Serialize)]
struct Sort {
    column: String,
    direction: SortDirection,
    nulls: NullOrder,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum SortDirection {
    Asc,
    Desc,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum NullOrder {
    Default,
    First,
    Last,
}

pub(crate) enum TableQueryDialect {
    Sqlite,
    Postgres,
    Mysql,
}

pub(crate) enum FilterOperand {
    Comparison,
    Contains,
}

impl TableQueryDialect {
    fn identifier(&self, name: &str) -> String {
        match self {
            Self::Mysql => crate::mysql::quoted(name),
            Self::Sqlite | Self::Postgres => quote_identifier(name),
        }
    }

    fn contains(&self, column: &str, parameter: &str) -> String {
        match self {
            Self::Sqlite => format!("instr({column}, {parameter}) > 0"),
            Self::Postgres => {
                format!("pg_catalog.strpos({column}::pg_catalog.text, {parameter}) > 0")
            }
            Self::Mysql => format!("LOCATE({parameter}, {column}) > 0"),
        }
    }

    fn order(&self, column: &str, direction: &str, nulls: &NullOrder) -> String {
        match (self, nulls) {
            (_, NullOrder::Default) => format!("{column} {direction}"),
            (Self::Mysql, NullOrder::First) => {
                format!("{column} IS NULL DESC, {column} {direction}")
            }
            (Self::Mysql, NullOrder::Last) => format!("{column} IS NULL ASC, {column} {direction}"),
            (_, NullOrder::First) => format!("{column} {direction} NULLS FIRST"),
            (_, NullOrder::Last) => format!("{column} {direction} NULLS LAST"),
        }
    }
}

impl TableQuery {
    pub(crate) fn sql(&self, db: &Connection) -> Result<(String, Vec<Value>)> {
        let object = Store::read_object(db, &self.object)?;
        let columns = Store::object_columns(db, &object.name)?;
        let names = columns
            .iter()
            .filter(|column| column.hidden != 1)
            .map(|column| column.name.as_str());
        let mut keys: Vec<_> = columns
            .iter()
            .filter(|column| column.primary_key_position > 0 && column.hidden != 1)
            .collect();
        keys.sort_by_key(|column| column.primary_key_position);
        let mut params = Vec::new();
        let suffix = self.clauses.suffix(
            TableQueryDialect::Sqlite,
            "sp_source",
            names,
            keys.into_iter().map(|column| column.name.as_str()),
            |_, value, _| {
                params.push(value.sqlite_value()?);
                Ok("?".into())
            },
        )?;
        Ok((
            format!(
                "SELECT sp_source.*\nFROM main.{} AS sp_source{suffix}",
                quote_identifier(&object.name)
            ),
            params,
        ))
    }
}

impl TableQueryClauses {
    pub(crate) fn validate_preset(&self, sqlite: bool) -> Result<()> {
        let mut seen = HashSet::new();
        self.validate_count()?;
        if self.filters.is_empty() && self.sort.is_empty() {
            return Err("저장할 필터 또는 정렬을 추가하세요.".into());
        }
        let validate = |value: &FilterValue| -> Result<()> {
            bounded_filter_text(value.text())?;
            if sqlite {
                value.sqlite_value()?;
            }
            Ok(())
        };
        for filter in &self.filters {
            if filter.column.contains('\0') {
                return Err("필터 열 이름을 확인하세요.".into());
            }
            use Condition::*;
            match &filter.condition {
                Eq { value }
                | Ne { value }
                | Lt { value }
                | Le { value }
                | Gt { value }
                | Ge { value } => validate(value)?,
                Between { from, to } => {
                    matching_range(from, to)?;
                    validate(from)?;
                    validate(to)?;
                }
                Contains { value } => bounded_filter_text(value)?,
                IsNull | IsNotNull => {}
            }
        }
        for sort in &self.sort {
            if sort.column.contains('\0') || !seen.insert(sort.column.as_str()) {
                return Err("중복되거나 잘못된 정렬 열을 확인하세요.".into());
            }
        }
        Ok(())
    }

    fn validate_count(&self) -> Result<()> {
        if self.filters.len() > 16 || self.sort.len() > 8 {
            return Err("필터는 최대 16개, 정렬 열은 최대 8개까지 선택할 수 있습니다.".into());
        }
        Ok(())
    }

    pub(crate) fn suffix<'a>(
        &self,
        dialect: TableQueryDialect,
        qualifier: &str,
        columns: impl IntoIterator<Item = &'a str>,
        primary_keys: impl IntoIterator<Item = &'a str>,
        mut bind: impl FnMut(&str, &FilterValue, FilterOperand) -> Result<String>,
    ) -> Result<String> {
        self.validate_count()?;
        let columns: HashSet<_> = columns.into_iter().collect();
        let source_column = |name: &str| {
            if !columns.contains(name) {
                return Err(
                    "테이블 또는 뷰에 표시되는 열만 필터와 정렬에 사용할 수 있습니다.".into(),
                );
            }
            Ok::<_, String>(format!("{qualifier}.{}", dialect.identifier(name)))
        };
        let mut sql = String::new();
        let mut conditions = Vec::new();
        for filter in &self.filters {
            let column = source_column(&filter.column)?;
            conditions.push(filter.condition.sql(&column, &dialect, |value, operand| {
                bind(&filter.column, value, operand)
            })?);
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
            let column = source_column(&sort.column)?;
            if !seen.insert(sort.column.as_str()) {
                return Err("같은 열을 두 번 정렬할 수 없습니다.".into());
            }
            let direction = match sort.direction {
                SortDirection::Asc => "ASC",
                SortDirection::Desc => "DESC",
            };
            order.push(dialect.order(&column, direction, &sort.nulls));
        }
        // An available primary key resolves ties in the requested sort and
        // also gives plain table browsing a predictable default order.
        for key in primary_keys {
            if !seen.contains(key) {
                order.push(format!("{qualifier}.{} ASC", dialect.identifier(key)));
            }
        }
        if !order.is_empty() {
            sql.push_str("\nORDER BY ");
            sql.push_str(&order.join(", "));
        }
        Ok(sql)
    }
}

impl Condition {
    fn sql(
        &self,
        column: &str,
        dialect: &TableQueryDialect,
        mut bind: impl FnMut(&FilterValue, FilterOperand) -> Result<String>,
    ) -> Result<String> {
        let (operator, value) = match self {
            Self::Eq { value } => ("=", value),
            Self::Ne { value } => ("<>", value),
            Self::Lt { value } => ("<", value),
            Self::Le { value } => ("<=", value),
            Self::Gt { value } => (">", value),
            Self::Ge { value } => (">=", value),
            Self::Between { from, to } => {
                matching_range(from, to)?;
                return Ok(format!(
                    "{column} BETWEEN {} AND {}",
                    bind(from, FilterOperand::Comparison)?,
                    bind(to, FilterOperand::Comparison)?
                ));
            }
            Self::Contains { value } => {
                let parameter = bind(&FilterValue::Text(value.clone()), FilterOperand::Contains)?;
                return Ok(dialect.contains(column, &parameter));
            }
            Self::IsNull => return Ok(format!("{column} IS NULL")),
            Self::IsNotNull => return Ok(format!("{column} IS NOT NULL")),
        };
        Ok(format!(
            "{column} {operator} {}",
            bind(value, FilterOperand::Comparison)?
        ))
    }
}

impl FilterValue {
    pub(crate) fn text(&self) -> &str {
        match self {
            Self::Text(value) | Self::Date(value) | Self::Integer(value) | Self::Real(value) => {
                value
            }
        }
    }

    fn sqlite_value(&self) -> Result<Value> {
        match self {
            Self::Text(value) | Self::Date(value) => text_value(value),
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

fn matching_range(from: &FilterValue, to: &FilterValue) -> Result<()> {
    if std::mem::discriminant(from) != std::mem::discriminant(to) {
        return Err("범위의 시작 값과 끝 값은 형식이 같아야 합니다.".into());
    }
    Ok(())
}

pub(crate) fn bounded_filter_text(value: &str) -> Result<()> {
    if value.contains('\0') || value.chars().take(4097).count() > 4096 {
        return Err("필터 값은 NUL 문자 없이 4096자 이하여야 합니다.".into());
    }
    Ok(())
}

fn text_value(value: &str) -> Result<Value> {
    if value.chars().take(4097).count() > 4096 {
        return Err("텍스트 필터 값은 4096자까지 입력할 수 있습니다.".into());
    }
    Ok(Value::Text(value.into()))
}
