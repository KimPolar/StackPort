use super::{is_binary, MysqlColumn};
use crate::{
    table_query::{bounded_filter_text, FilterOperand, FilterValue},
    Result,
};
use mysql_async::Value;

pub(super) fn filter_binding(
    column: &MysqlColumn,
    input: &FilterValue,
    operand: FilterOperand,
    parameters: &mut Vec<Value>,
) -> Result<String> {
    let text = input.text();
    bounded_filter_text(text)?;
    let data_type = column.data_type.as_str();
    if is_binary(data_type) {
        return Err("바이너리·공간 열은 NULL 조건으로 필터링할 수 있습니다.".into());
    }

    if matches!(operand, FilterOperand::Contains) {
        parameters.push(Value::Bytes(text.as_bytes().to_vec()));
        return Ok("?".into());
    }

    let trimmed = text.trim();
    let invalid = "필터 값의 형식이나 범위를 확인하세요.";
    let (value, placeholder) = match data_type {
        "tinyint" | "smallint" | "mediumint" | "int" | "bigint" | "year" => {
            let value = trimmed
                .parse::<i64>()
                .map(Value::Int)
                .or_else(|_| trimmed.parse::<u64>().map(Value::UInt))
                .map_err(|_| invalid)?;
            (value, "CAST(? AS DECIMAL(20,0))".into())
        }
        "decimal" | "numeric" => {
            let scale = decimal_scale(trimmed).ok_or(invalid)?;
            (
                Value::Bytes(trimmed.as_bytes().to_vec()),
                format!("CAST(? AS DECIMAL(65,{scale}))"),
            )
        }
        "float" => {
            let value = trimmed
                .parse::<f32>()
                .ok()
                .filter(|value| value.is_finite())
                .ok_or(invalid)?;
            (Value::Float(value), "(? + 0e0)".into())
        }
        "double" => {
            let value = trimmed.parse::<f64>().ok().filter(|value| value.is_finite()).ok_or(invalid)?;
            (Value::Double(value), "(? + 0e0)".into())
        }
        "date" if valid_date(trimmed) => (Value::from(trimmed), "CAST(? AS DATE)".into()),
        "datetime" | "timestamp" if valid_datetime(trimmed) => {
            (Value::from(trimmed.replace('T', " ")), "CAST(? AS DATETIME(6))".into())
        }
        "time" if valid_time(trimmed) => (Value::from(trimmed), "CAST(? AS TIME(6))".into()),
        "date" | "datetime" | "timestamp" | "time" => {
            return Err("날짜·시간 필터 값을 YYYY-MM-DD, YYYY-MM-DD HH:MM:SS 또는 HH:MM:SS 형식으로 입력하세요.".into())
        }
        "json" => return Err("JSON 열은 포함 및 NULL 조건으로 필터링할 수 있습니다.".into()),
        _ => (Value::Bytes(text.as_bytes().to_vec()), "?".into()),
    };
    parameters.push(value);
    Ok(placeholder)
}

fn decimal_scale(value: &str) -> Option<usize> {
    let digits = value.strip_prefix(['+', '-']).unwrap_or(value);
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let width = whole.len() + fraction.len();
    (width > 0
        && whole.trim_start_matches('0').len() + fraction.len() <= 65
        && fraction.len() <= 30
        && whole
            .bytes()
            .chain(fraction.bytes())
            .all(|byte| byte.is_ascii_digit()))
    .then_some(fraction.len())
}

fn parse_digits(value: &str, width: usize) -> Option<u32> {
    if value.len() != width || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn valid_date(value: &str) -> bool {
    let Some((year, rest)) = value.split_once('-') else {
        return false;
    };
    let Some((month, day)) = rest.split_once('-') else {
        return false;
    };
    let (Some(year), Some(month), Some(day)) = (
        parse_digits(year, 4),
        parse_digits(month, 2),
        parse_digits(day, 2),
    ) else {
        return false;
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    year >= 1000 && (1..=days).contains(&day)
}

fn valid_datetime(value: &str) -> bool {
    if let Some((date, time)) = value.split_once([' ', 'T']) {
        valid_date(date) && valid_clock(time, 23)
    } else {
        valid_date(value)
    }
}

fn valid_time(value: &str) -> bool {
    valid_clock(value.strip_prefix('-').unwrap_or(value), 838)
}

fn valid_clock(value: &str, max_hours: u32) -> bool {
    let (clock, fraction) = value.split_once('.').unwrap_or((value, ""));
    let Some((hours, rest)) = clock.split_once(':') else {
        return false;
    };
    let Some((minutes, seconds)) = rest.split_once(':') else {
        return false;
    };
    let hour_width = if max_hours > 23 && hours.len() == 3 {
        3
    } else {
        2
    };
    parse_digits(hours, hour_width).is_some_and(|hours| hours <= max_hours)
        && parse_digits(minutes, 2).is_some_and(|minutes| minutes < 60)
        && parse_digits(seconds, 2).is_some_and(|seconds| seconds < 60)
        && fraction.len() <= 6
        && (!value.contains('.') || !fraction.is_empty())
        && fraction.bytes().all(|byte| byte.is_ascii_digit())
}
