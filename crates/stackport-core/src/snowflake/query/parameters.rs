use super::{super::api::Binding, script::Statement};
use crate::{native_table_filter, Result};
use serde::Deserialize;

const MAX_PARAMETERS: usize = 64;
const VALUE_LIMIT: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ParameterInput {
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

pub(super) fn parameter_count(statements: &[Statement<'_>]) -> Result<usize> {
    let [statement] = statements else {
        return Err("Snowflake 매개변수로 실행할 문장 하나를 선택하세요.".into());
    };
    match statement.placeholders {
        0 => Err("실행할 Snowflake 문장에 ? 매개변수가 없습니다.".into()),
        1..=MAX_PARAMETERS => Ok(statement.placeholders),
        _ => Err("Snowflake 매개변수는 한 문장에 최대 64개까지 입력할 수 있습니다.".into()),
    }
}

#[derive(Default)]
pub(super) struct Bindings<'a> {
    pub(super) values: Vec<Binding<'a>>,
    pub(super) masked: bool,
}

impl<'a> Bindings<'a> {
    pub(super) fn new(
        statements: &[Statement<'_>],
        parameters: &'a [ParameterInput],
    ) -> Result<Self> {
        if parameters.is_empty() {
            return Ok(Self::default());
        }
        if parameter_count(statements)? != parameters.len() {
            return Err("Snowflake 문장의 ? 개수와 입력한 값을 확인하세요.".into());
        }
        let values = parameters
            .iter()
            .enumerate()
            .map(|(index, parameter)| {
                parameter
                    .binding()
                    .map_err(|error| format!("?{} · {error}", index + 1))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            values,
            masked: parameters.iter().any(|parameter| parameter.masked),
        })
    }
}

impl ParameterInput {
    fn binding(&self) -> std::result::Result<Binding<'_>, &'static str> {
        if matches!(self.kind, Kind::Null) {
            return Ok(Binding {
                data_type: "ANY",
                value: None,
            });
        }
        let value = self.value.as_deref().ok_or("값을 입력하세요.")?;
        if value.len() > VALUE_LIMIT {
            return Err("값은 UTF-8 기준 16 KiB 이내로 입력하세요.");
        }
        let trimmed = value.trim();
        let (data_type, value) = match self.kind {
            Kind::Text => ("TEXT", value),
            Kind::Integer => {
                trimmed
                    .parse::<i64>()
                    .map_err(|_| "64비트 정수를 입력하세요.")?;
                ("FIXED", trimmed)
            }
            Kind::Decimal => {
                native_table_filter::decimal_shape(trimmed)
                    .map_err(|_| "지수 표기 없이 최대 38자리 십진수를 입력하세요.")?;
                ("DECFLOAT", trimmed)
            }
            Kind::Real => {
                native_table_filter::finite_float(trimmed)
                    .map_err(|_| "유한한 실수를 입력하세요.")?;
                ("REAL", trimmed)
            }
            Kind::Boolean => (
                "BOOLEAN",
                match trimmed {
                    "true" | "1" => "true",
                    "false" | "0" => "false",
                    _ => return Err("true, false, 1 또는 0을 입력하세요."),
                },
            ),
            Kind::Blob => {
                if !trimmed.len().is_multiple_of(2)
                    || !trimmed.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err("짝수 자리의 16진수를 입력하세요.");
                }
                ("BINARY", trimmed)
            }
            Kind::Null => unreachable!(),
        };
        Ok(Binding {
            data_type,
            value: Some(value),
        })
    }
}
