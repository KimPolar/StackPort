use crate::{json_import::decode_hex, native_table_filter, Result};
use oracledb::{OracleNumber, Statement, ToDbValue};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

const LIMIT: usize = 64;
const VALUE_LIMIT: usize = 16 * 1024;
const MISMATCH: &str = "실행 범위의 Oracle 바인드 변수와 입력한 값을 확인하세요.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ParameterInput {
    name: String,
    kind: Kind,
    value: Option<String>,
    #[serde(default)]
    masked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Text,
    Integer,
    Decimal,
    Real,
    Blob,
    Null,
}

pub(super) fn names(statements: &[Statement]) -> Result<Vec<&str>> {
    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for name in statements.iter().flat_map(Statement::bind_names) {
        if name.is_empty() || name.len() > 128 || name.contains('\0') {
            return Err("Oracle 바인드 변수 이름을 확인하세요.".into());
        }
        if seen.insert(name.as_str()) {
            if names.len() == LIMIT {
                return Err(
                    "Oracle 바인드 변수는 한 번에 최대 64개까지 입력할 수 있습니다.".into(),
                );
            }
            names.push(name.as_str());
        }
    }
    Ok(names)
}

pub(super) struct Bindings<'a> {
    values: HashMap<&'a str, Binding<'a>>,
    pub(super) masked: bool,
}

struct Binding<'a> {
    quoted_name: String,
    value: Value<'a>,
}

enum Value<'a> {
    Text(&'a str),
    Integer(i64),
    Decimal(OracleNumber),
    Real(f64),
    Blob(Vec<u8>),
    Null(Option<String>),
}

impl<'a> Bindings<'a> {
    pub(super) fn new(entries: &'a [ParameterInput]) -> Result<Self> {
        if entries.len() > LIMIT {
            return Err(MISMATCH.into());
        }
        let mut values = HashMap::with_capacity(entries.len());
        for entry in entries {
            if entry.name.is_empty()
                || entry.name.len() > 128
                || values.contains_key(entry.name.as_str())
            {
                return Err(MISMATCH.into());
            }
            let value = parse(entry).map_err(|message| format!(":{} · {message}", entry.name))?;
            values.insert(
                entry.name.as_str(),
                Binding {
                    quoted_name: format!("\"{}\"", entry.name),
                    value,
                },
            );
        }
        Ok(Self {
            values,
            masked: entries.iter().any(|entry| entry.masked),
        })
    }

    pub(super) fn validate(&self, statements: &[Statement]) -> Result<()> {
        let names = names(statements)?;
        if names.len() != self.values.len()
            || names.iter().any(|name| !self.values.contains_key(name))
        {
            return Err(MISMATCH.into());
        }
        Ok(())
    }

    pub(super) fn for_statement(&self, statement: &Statement) -> Vec<(&str, &dyn ToDbValue)> {
        statement
            .bind_names()
            .iter()
            .map(|name| {
                let binding = &self.values[name.as_str()];
                let value: &dyn ToDbValue = match &binding.value {
                    Value::Text(value) => value,
                    Value::Integer(value) => value,
                    Value::Decimal(value) => value,
                    Value::Real(value) => value,
                    Value::Blob(value) => value,
                    Value::Null(value) => value,
                };
                (binding.quoted_name.as_str(), value)
            })
            .collect()
    }
}

fn parse(input: &ParameterInput) -> std::result::Result<Value<'_>, &'static str> {
    if matches!(input.kind, Kind::Null) {
        return Ok(Value::Null(None));
    }
    let value = input.value.as_deref().ok_or("값을 입력하세요.")?;
    if value.len() > VALUE_LIMIT {
        return Err("값은 UTF-8 기준 16 KiB 이내로 입력하세요.");
    }
    let trimmed = value.trim();
    match input.kind {
        Kind::Text => Ok(Value::Text(value)),
        Kind::Integer => trimmed
            .parse()
            .map(Value::Integer)
            .map_err(|_| "64비트 정수를 입력하세요."),
        Kind::Decimal => {
            let message = "지수 표기 없이 최대 38자리 십진수를 입력하세요.";
            native_table_filter::decimal_shape(trimmed).map_err(|_| message)?;
            trimmed.parse().map(Value::Decimal).map_err(|_| message)
        }
        Kind::Real => native_table_filter::finite_float(trimmed)
            .map(Value::Real)
            .map_err(|_| "유한한 실수를 입력하세요."),
        Kind::Blob => decode_hex(trimmed)
            .map(Value::Blob)
            .map_err(|_| "짝수 자리의 16진수를 입력하세요."),
        Kind::Null => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(name: &str, kind: &str, value: &str) -> ParameterInput {
        serde_json::from_value(json!({"name":name,"kind":kind,"value":value,"masked":true}))
            .unwrap()
    }

    #[test]
    fn binds_exact_number_and_preserves_text_and_raw() {
        let decimal = input("N", "decimal", "-12345678901234567890123456789012.345678");
        let Value::Decimal(number) = parse(&decimal).unwrap() else {
            panic!("expected NUMBER");
        };
        assert_eq!(number.to_string(), decimal.value.unwrap());
        assert!(matches!(
            parse(&input("T", "text", " 한글 '")).unwrap(),
            Value::Text(" 한글 '")
        ));
        assert!(
            matches!(parse(&input("R", "blob", "00ffA1")).unwrap(), Value::Blob(bytes) if bytes == [0, 255, 161])
        );
        assert!(matches!(
            parse(&input("MISSING", "null", "")).unwrap(),
            Value::Null(None)
        ));
    }

    #[test]
    fn rejects_duplicate_names_invalid_values_and_oversize_input() {
        let duplicates = [input("P", "text", "가"), input("P", "text", "나")];
        assert!(Bindings::new(&duplicates).is_err());
        for (kind, text) in [
            ("integer", "9223372036854775808"),
            ("decimal", "1e3"),
            ("real", "NaN"),
            ("blob", "123"),
        ] {
            assert!(parse(&input("P", kind, text)).is_err());
        }
        assert!(parse(&input("P", "text", &"한".repeat(VALUE_LIMIT))).is_err());
    }
}
