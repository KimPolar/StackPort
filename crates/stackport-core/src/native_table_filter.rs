use crate::Result;

pub(crate) const INVALID: &str = "필터 값의 형식이나 범위를 확인하세요.";
pub(crate) const UNSUPPORTED: &str = "이 열의 형식은 NULL 조건으로 필터링할 수 있습니다.";

pub(crate) fn decimal_shape(value: &str) -> Result<(usize, usize)> {
    let digits = value.strip_prefix(['+', '-']).unwrap_or(value);
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let precision = (whole.trim_start_matches('0').len() + fraction.len()).max(1);
    if whole.len() + fraction.len() == 0
        || precision > 38
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|byte| byte.is_ascii_digit())
    {
        return Err("숫자 필터에 최대 38자리 십진수를 입력하세요.".into());
    }
    Ok((precision, fraction.len()))
}

pub(crate) fn finite_float(value: &str) -> Result<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .ok_or_else(|| INVALID.into())
}

pub(crate) fn boolean(value: &str) -> Result<bool> {
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" => Ok(true),
        "0" | "false" => Ok(false),
        _ => Err("불리언 필터에 true 또는 false를 입력하세요.".into()),
    }
}

pub(crate) fn date(value: &str) -> Result<&str> {
    fn digits(value: &str, length: usize) -> Option<u32> {
        if value.len() != length || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        value.parse().ok()
    }
    let result = (|| {
        let (year, rest) = value.split_once('-')?;
        let (month, day) = rest.split_once('-')?;
        let year = digits(year, 4)?;
        let month = digits(month, 2)?;
        let day = digits(day, 2)?;
        let days = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
            2 => 28,
            _ => 0,
        };
        (year != 0 && (1..=days).contains(&day)).then_some(value)
    })();
    result.ok_or_else(|| "날짜 필터에 실제 날짜를 YYYY-MM-DD 형식으로 입력하세요.".into())
}

pub(crate) fn time(value: &str, scale: usize) -> Result<String> {
    let (clock, fraction) = value.split_once('.').unwrap_or((value, ""));
    let parts: Vec<_> = clock.split(':').collect();
    let [hour, minute, second] = parts.as_slice() else {
        return Err(INVALID.into());
    };
    let valid = |part: &str, max| {
        part.len() == 2
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && part.parse::<u8>().is_ok_and(|number| number <= max)
    };
    if !valid(hour, 23)
        || !valid(minute, 59)
        || !valid(second, 59)
        || fraction.len() > scale
        || (value.contains('.') && fraction.is_empty())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("시간 필터에 HH:MM:SS 또는 소수점 이하가 붙은 시간을 입력하세요.".into());
    }
    Ok(if scale > 0 {
        format!(
            "{clock}.{}",
            if fraction.is_empty() { "0" } else { fraction }
        )
    } else {
        clock.into()
    })
}

pub(crate) fn timestamp(
    value: &str,
    scale: usize,
    zoned: bool,
) -> Result<(String, Option<String>)> {
    let (day, clock) = value.split_once(['T', ' ']).unwrap_or((value, "00:00:00"));
    let (clock, offset) = if let Some(stripped) = clock.strip_suffix('Z') {
        (stripped, Some("+00:00"))
    } else if let Some(index) = clock.find(['+', '-']) {
        (&clock[..index], Some(&clock[index..]))
    } else {
        (clock, None)
    };
    if !zoned && offset.is_some() {
        return Err("시간대가 없는 열에는 시간대 오프셋을 입력하지 마세요.".into());
    }
    let offset = if zoned {
        let offset = offset.unwrap_or("+00:00");
        let bytes = offset.as_bytes();
        if bytes.len() != 6
            || bytes[3] != b':'
            || !matches!(bytes[0], b'+' | b'-')
            || ![bytes[1], bytes[2], bytes[4], bytes[5]]
                .iter()
                .all(u8::is_ascii_digit)
        {
            return Err("시간대 오프셋을 ±HH:MM 형식으로 입력하세요.".into());
        }
        let hours = (bytes[1] - b'0') * 10 + bytes[2] - b'0';
        let minutes = (bytes[4] - b'0') * 10 + bytes[5] - b'0';
        if hours > 14 || minutes > 59 || (hours == 14 && minutes != 0) {
            return Err("시간대 오프셋 범위는 -14:00부터 +14:00까지입니다.".into());
        }
        Some(offset.into())
    } else {
        None
    };
    Ok((
        format!("{}T{}", date(day)?, time(clock.trim_end(), scale)?),
        offset,
    ))
}
