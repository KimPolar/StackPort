use crate::postgres::session::VALUE_LENGTH;
use chrono::{NaiveDate, NaiveTime, TimeDelta};
use serde::Serialize;
use std::{error::Error, fmt::Write, str};
use tokio_postgres::types::{FromSql, Kind, Type};
use uuid::Uuid;

#[derive(Serialize)]
pub(super) struct PreviewCell {
    pub(super) value: Option<String>,
    truncated: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    hex: bool,
}

impl PreviewCell {
    pub(super) fn text(input: Option<&str>) -> Self {
        let value = input.map(|value| value.chars().take(VALUE_LENGTH).collect::<String>());
        let truncated = value
            .as_deref()
            .zip(input)
            .is_some_and(|(preview, original)| preview.len() != original.len());
        Self {
            value,
            truncated,
            hex: false,
        }
    }

    fn binary(input: &[u8]) -> Self {
        let mut value = String::new();
        for byte in input.iter().take(VALUE_LENGTH / 2) {
            let _ = write!(value, "{byte:02x}");
        }
        Self {
            value: Some(value),
            truncated: input.len() > VALUE_LENGTH / 2,
            hex: true,
        }
    }
}

pub(super) struct WireValue<'a>(&'a [u8]);

impl<'a> FromSql<'a> for WireValue<'a> {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn Error + Send + Sync>> {
        Ok(Self(raw))
    }

    fn accepts(_: &Type) -> bool {
        true
    }
}

impl WireValue<'_> {
    pub(super) fn preview(&self, ty: &Type) -> PreviewCell {
        let mut ty = ty;
        while let Kind::Domain(base) = ty.kind() {
            ty = base;
        }
        let raw = self.0;
        match *ty {
            Type::TEXT
            | Type::VARCHAR
            | Type::BPCHAR
            | Type::NAME
            | Type::UNKNOWN
            | Type::XML
            | Type::JSON => return utf8(raw, raw),
            Type::JSONB if raw.first() == Some(&1) => return utf8(&raw[1..], raw),
            _ if matches!(ty.kind(), Kind::Enum(_)) => return utf8(raw, raw),
            _ => {}
        }
        render(raw, ty).map_or_else(
            || PreviewCell::binary(raw),
            |value| PreviewCell::text(Some(&value)),
        )
    }
}

fn utf8(bytes: &[u8], raw: &[u8]) -> PreviewCell {
    str::from_utf8(bytes).ok().map_or_else(
        || PreviewCell::binary(raw),
        |value| PreviewCell::text(Some(value)),
    )
}

fn render(raw: &[u8], ty: &Type) -> Option<String> {
    Some(match *ty {
        Type::BOOL => match raw {
            [0] => "false".into(),
            [1] => "true".into(),
            _ => return None,
        },
        Type::INT2 => i16::from_be_bytes(raw.try_into().ok()?).to_string(),
        Type::INT4 => i32::from_be_bytes(raw.try_into().ok()?).to_string(),
        Type::INT8 => i64::from_be_bytes(raw.try_into().ok()?).to_string(),
        Type::OID => u32::from_be_bytes(raw.try_into().ok()?).to_string(),
        Type::FLOAT4 => {
            let value = f32::from_be_bytes(raw.try_into().ok()?);
            infinity(f64::from(value)).map_or_else(|| value.to_string(), str::to_owned)
        }
        Type::FLOAT8 => {
            let value = f64::from_be_bytes(raw.try_into().ok()?);
            infinity(value).map_or_else(|| value.to_string(), str::to_owned)
        }
        Type::NUMERIC => numeric(raw)?,
        Type::UUID => Uuid::from_slice(raw).ok()?.to_string(),
        Type::DATE => match i32::from_be_bytes(raw.try_into().ok()?) {
            i32::MAX => "infinity".into(),
            i32::MIN => "-infinity".into(),
            days => pg_epoch()
                .checked_add_signed(TimeDelta::days(i64::from(days)))?
                .to_string(),
        },
        Type::TIME => match i64::from_be_bytes(raw.try_into().ok()?) {
            86_400_000_000 => "24:00:00".into(),
            micros => NaiveTime::from_num_seconds_from_midnight_opt(
                (micros / 1_000_000).try_into().ok()?,
                (micros % 1_000_000 * 1000).try_into().ok()?,
            )?
            .to_string(),
        },
        Type::TIMESTAMP | Type::TIMESTAMPTZ => match i64::from_be_bytes(raw.try_into().ok()?) {
            i64::MAX => "infinity".into(),
            i64::MIN => "-infinity".into(),
            micros => {
                let value = pg_epoch()
                    .and_hms_opt(0, 0, 0)?
                    .checked_add_signed(TimeDelta::microseconds(micros))?;
                if *ty == Type::TIMESTAMPTZ {
                    format!("{value}+00")
                } else {
                    value.to_string()
                }
            }
        },
        _ => return None,
    })
}

fn infinity(value: f64) -> Option<&'static str> {
    if value == f64::INFINITY {
        Some("Infinity")
    } else if value == f64::NEG_INFINITY {
        Some("-Infinity")
    } else {
        None
    }
}

fn pg_epoch() -> NaiveDate {
    NaiveDate::from_ymd_opt(2000, 1, 1).expect("PostgreSQL epoch")
}

fn numeric(raw: &[u8]) -> Option<String> {
    let [n1, n0, w1, w0, s1, s0, d1, d0, digits @ ..] = raw else {
        return None;
    };
    let count = usize::from(u16::from_be_bytes([*n1, *n0]));
    if digits.len() != count * 2 {
        return None;
    }
    let weight = i32::from(i16::from_be_bytes([*w1, *w0]));
    let sign = u16::from_be_bytes([*s1, *s0]);
    let scale = u16::from_be_bytes([*d1, *d0]);
    let mut result = match sign {
        0x0000 => String::new(),
        0x4000 => "-".into(),
        0xc000 => return Some("NaN".into()),
        0xd000 => return Some("Infinity".into()),
        0xf000 => return Some("-Infinity".into()),
        _ => return None,
    };
    let digit = |place| {
        let index = usize::try_from(weight - place)
            .ok()
            .filter(|&index| index < count);
        index.map_or(0, |index| {
            u16::from_be_bytes([digits[index * 2], digits[index * 2 + 1]])
        })
    };
    let lead = weight.max(0);
    write!(result, "{}", digit(lead)).ok()?;
    for place in (0..lead).rev() {
        if result.len() > VALUE_LENGTH {
            return Some(result);
        }
        write!(result, "{:04}", digit(place)).ok()?;
    }
    if scale > 0 {
        result.push('.');
        let whole = result.len();
        for group in 1..=i32::from(scale.div_ceil(4)) {
            if result.len() > VALUE_LENGTH {
                break;
            }
            write!(result, "{:04}", digit(-group)).ok()?;
        }
        result.truncate(whole + usize::from(scale));
    }
    Some(result)
}
