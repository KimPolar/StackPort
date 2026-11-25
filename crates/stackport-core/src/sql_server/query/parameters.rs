use super::batches::{Batch, Lex};
use crate::Result;
use serde::Deserialize;
use std::{collections::BTreeSet, fmt::Write};
use tiberius::Command;

const MAX_INDEX: u16 = 64;
const VALUE_LIMIT: usize = 16 * 1024;

#[derive(Deserialize)]
pub(super) struct ParameterInput {
    index: u16,
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
    Boolean,
    Blob,
    Null,
}

pub(super) fn indexes(batches: &[Batch<'_>]) -> Result<Vec<u16>> {
    let [batch] = batches else {
        return Err("매개변수로 실행할 배치 하나를 선택하세요.".into());
    };
    if batch.repeat != 1 {
        return Err("매개변수 실행에서는 배치를 한 번 실행하세요.".into());
    }
    let mut lex = Lex::default();
    let mut indexes = BTreeSet::new();
    let mut invalid = false;
    for line in batch.sql.split_inclusive('\n') {
        lex.scan_variables(line, |variable| {
            let Some(number) = variable.strip_prefix("@P") else {
                return;
            };
            if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
                return;
            }
            match number.parse::<u16>() {
                Ok(index) if !number.starts_with('0') && (1..=MAX_INDEX).contains(&index) => {
                    indexes.insert(index);
                }
                _ => invalid = true,
            }
        });
    }
    if invalid || indexes.is_empty() {
        return Err("실행할 배치에서 @P1~@P64 형식의 매개변수를 사용하세요.".into());
    }
    Ok(indexes.into_iter().collect())
}

pub(super) struct Bindings<'a> {
    values: Vec<(u16, Value<'a>)>,
    pub masked: bool,
}

enum Value<'a> {
    Text(&'a str),
    Integer(i64),
    Decimal(&'a str, usize),
    Real(f64),
    Boolean(bool),
    Blob(Vec<u8>),
    Null,
}

impl<'a> Bindings<'a> {
    pub(super) fn new(batches: &[Batch<'_>], entries: &'a [ParameterInput]) -> Result<Self> {
        let expected = indexes(batches)?;
        if entries.len() != expected.len() {
            return Err("현재 배치의 매개변수 값을 다시 확인하세요.".into());
        }
        let mut entries = entries.iter().collect::<Vec<_>>();
        entries.sort_unstable_by_key(|entry| entry.index);
        let masked = entries.iter().any(|entry| entry.masked);
        let values = entries
            .into_iter()
            .zip(expected)
            .map(|(input, index)| {
                if input.index != index {
                    return Err("현재 배치의 매개변수 값을 다시 확인하세요.".into());
                }
                let value = parse(input).map_err(|message| format!("@P{index} · {message}"))?;
                Ok((index, value))
            })
            .collect::<Result<_>>()?;
        Ok(Self { values, masked })
    }

    pub(super) fn command<'query>(&'query self, sql: &'query str) -> Command<'query> {
        let mut definitions = String::new();
        for (index, value) in &self.values {
            if !definitions.is_empty() {
                definitions.push_str(", ");
            }
            let _ = write!(definitions, "@P{index} ");
            definitions.push_str(match value {
                Value::Text(_) | Value::Null => "nvarchar(max)",
                Value::Integer(_) => "bigint",
                Value::Real(_) => "float",
                Value::Boolean(_) => "bit",
                Value::Blob(_) => "varbinary(max)",
                Value::Decimal(_, scale) => {
                    let _ = write!(definitions, "decimal(38,{scale})");
                    continue;
                }
            });
        }
        let mut command = Command::new("sys.sp_executesql");
        command.bind_param("@stmt", sql);
        command.bind_param("@params", definitions);
        for (index, value) in &self.values {
            let name = format!("@P{index}");
            match value {
                Value::Text(value) | Value::Decimal(value, _) => command.bind_param(name, *value),
                Value::Integer(value) => command.bind_param(name, *value),
                Value::Real(value) => command.bind_param(name, *value),
                Value::Boolean(value) => command.bind_param(name, *value),
                Value::Blob(value) => command.bind_param(name, value.clone()),
                Value::Null => command.bind_param(name, None::<&str>),
            }
        }
        command
    }
}

fn parse(input: &ParameterInput) -> std::result::Result<Value<'_>, &'static str> {
    if matches!(input.kind, Kind::Null) {
        return Ok(Value::Null);
    }
    let value = input.value.as_deref().ok_or("값을 입력하세요.")?;
    if value.len() > VALUE_LIMIT {
        return Err("값은 UTF-8 기준 16 KiB 이내로 입력하세요.");
    }
    let trimmed = value.trim();
    match input.kind {
        Kind::Text => Ok(Value::Text(value)),
        Kind::Integer => trimmed
            .parse::<i64>()
            .map(Value::Integer)
            .map_err(|_| "64비트 정수 범위를 확인하세요."),
        Kind::Decimal => decimal(trimmed),
        Kind::Real => trimmed
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(Value::Real)
            .ok_or("유한한 실수를 입력하세요."),
        Kind::Boolean => match trimmed {
            "1" | "true" => Ok(Value::Boolean(true)),
            "0" | "false" => Ok(Value::Boolean(false)),
            _ => Err("true, false, 1 또는 0을 입력하세요."),
        },
        Kind::Blob => {
            if !trimmed.len().is_multiple_of(2)
                || !trimmed.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("짝수 자리의 16진수를 입력하세요.");
            }
            let bytes = (0..trimmed.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(&trimmed[index..index + 2], 16))
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| "짝수 자리의 16진수를 입력하세요.")?;
            Ok(Value::Blob(bytes))
        }
        Kind::Null => Ok(Value::Null),
    }
}

fn decimal(value: &str) -> std::result::Result<Value<'_>, &'static str> {
    let unsigned = value.strip_prefix(['+', '-']).unwrap_or(value);
    let (integer, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if (integer.is_empty() && fraction.is_empty())
        || !integer
            .bytes()
            .chain(fraction.bytes())
            .all(|byte| byte.is_ascii_digit())
        || integer.trim_start_matches('0').len() + fraction.len() > 38
    {
        return Err("소수는 지수 표기 없이 정수부와 소수부를 합해 최대 38자리로 입력하세요.");
    }
    // SQL Server applies the declared DECIMAL type to this RPC value without
    // passing through a binary float or the driver's inferred NUMERIC precision.
    Ok(Value::Decimal(value, fraction.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_server::query::batches::split;

    #[test]
    fn finds_only_numbered_variables_in_the_intended_scope() {
        let sql = "SELECT @P3, @P1, @P3, N'@P5', [@P6]]x], \"@P7\", @@P8, @P9suffix, @P5끝;\n/* /* @P2 */ @P4 */ -- @P11\nGO\nSELECT @P12";
        assert_eq!(indexes(&split(sql, 1, Some(1)).unwrap()).unwrap(), [1, 3]);
        assert_eq!(indexes(&split(sql, 1, Some(4)).unwrap()).unwrap(), [12]);
        assert!(indexes(&split(sql, 1, None).unwrap()).is_err());
        for invalid in ["@P0", "@P001", "@P65", "@P65536"] {
            let sql = format!("SELECT @P1, {invalid}");
            assert!(indexes(&split(&sql, 1, None).unwrap()).is_err());
        }
    }

    #[test]
    fn validates_precision_without_converting_decimal_values() {
        for valid in [
            "-.0000123",
            "+1.",
            "0000",
            "99999999999999999999999999999999999999",
            "0.12345678901234567890123456789012345678",
        ] {
            assert!(decimal(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "-.",
            "1e-10",
            "1.2.3",
            "123456789012345678901234567890123456789",
            "1.12345678901234567890123456789012345678",
        ] {
            assert!(decimal(invalid).is_err(), "{invalid}");
        }
    }
}
