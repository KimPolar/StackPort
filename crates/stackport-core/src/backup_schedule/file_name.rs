use super::{unix_now, PlanEngine};
use crate::Result;
use chrono::{DateTime, Utc};
use uuid::Uuid;

pub(super) const DEFAULT_TEMPLATE: &str = "{prefix}-{utc}";
const MAX_STEM: usize = 120;
const BAD_TEMPLATE: &str =
    "파일 이름 규칙에는 글자, 숫자, 하이픈, 밑줄과 표시된 변수만 사용하세요.";

pub(super) fn validate_prefix(prefix: &str) -> Result<()> {
    if prefix.is_empty()
        || prefix.len() > 40
        || !prefix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(
            "백업 이름 접두어는 영문, 숫자, 하이픈, 밑줄을 사용해 1~40자로 입력하세요.".into(),
        );
    }
    Ok(())
}

pub(super) fn validate_template(template: &str, prefix: &str) -> Result<()> {
    // PostgreSQL and scheduled are the longest possible engine and trigger names.
    render_stem(
        template,
        prefix,
        DateTime::UNIX_EPOCH,
        "postgres",
        "scheduled",
    )
    .map(|_| ())
}

pub fn preview_backup_file_name(
    prefix: &str,
    template: &str,
    postgres: bool,
    scheduled: bool,
) -> Result<String> {
    preview_file_name(prefix, template, if postgres { PlanEngine::Postgres } else { PlanEngine::Sqlite }, scheduled)
}

pub fn preview_mysql_backup_file_name(prefix: &str, template: &str, scheduled: bool) -> Result<String> {
    preview_file_name(prefix, template, PlanEngine::Mysql, scheduled)
}

pub fn preview_redis_backup_file_name(prefix: &str, template: &str, scheduled: bool) -> Result<String> {
    preview_file_name(prefix, template, PlanEngine::Redis, scheduled)
}

fn preview_file_name(prefix: &str, template: &str, engine: PlanEngine, scheduled: bool) -> Result<String> {
    validate_template(template.trim(), prefix.trim())?;
    let trigger = if scheduled { "scheduled" } else { "manual" };
    backup_file_name(
        template.trim(),
        prefix.trim(),
        unix_now()?,
        engine,
        trigger,
        Uuid::nil(),
    )
}

pub(super) fn backup_file_name(
    template: &str,
    prefix: &str,
    at: i64,
    engine: PlanEngine,
    trigger: &str,
    id: Uuid,
) -> Result<String> {
    let time = DateTime::<Utc>::from_timestamp(at, 0).ok_or("백업 시각을 확인할 수 없습니다.")?;
    let (engine, extension) = match engine {
        PlanEngine::Postgres => ("postgres", "backup"),
        PlanEngine::Sqlite => ("sqlite", "sqlite"),
        PlanEngine::Mysql => ("mysql", "sql"),
        PlanEngine::Redis => ("redis", "rdb"),
    };
    let stem = render_stem(template, prefix, time, engine, trigger)?;
    Ok(format!("{stem}-{id}.{extension}"))
}

fn render_stem(
    template: &str,
    prefix: &str,
    timestamp: DateTime<Utc>,
    engine: &str,
    trigger: &str,
) -> Result<String> {
    validate_prefix(prefix)?;
    if template.is_empty() || template.chars().count() > MAX_STEM {
        return Err("파일 이름 규칙을 1~120자로 입력하세요.".into());
    }
    let utc = timestamp.format("%Y%m%dT%H%M%SZ").to_string();
    let date = timestamp.format("%Y-%m-%d").to_string();
    let time = timestamp.format("%H%M%S").to_string();
    let mut stem = String::new();
    let mut remaining = template;
    loop {
        let (literal, variable) = match remaining.split_once('{') {
            Some((literal, variable)) => (literal, Some(variable)),
            None => (remaining, None),
        };
        if !literal
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '-' | '_'))
        {
            return Err(BAD_TEMPLATE.into());
        }
        stem.push_str(literal);
        let Some(variable) = variable else { break };
        let (name, tail) = variable.split_once('}').ok_or(BAD_TEMPLATE)?;
        stem.push_str(match name {
            "prefix" => prefix,
            "utc" => &utc,
            "date" => &date,
            "time" => &time,
            "engine" => engine,
            "trigger" => trigger,
            _ => return Err("지원하지 않는 파일 이름 변수가 있습니다.".into()),
        });
        remaining = tail;
    }
    if stem.encode_utf16().count() > MAX_STEM {
        return Err("변수를 적용한 백업 이름은 120자 이하여야 합니다.".into());
    }
    Ok(stem)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_preserve_the_default_and_render_the_same_rule_for_each_engine() {
        let at = DateTime::parse_from_rfc3339("2026-01-05T06:07:08Z")
            .unwrap()
            .timestamp();
        let id = Uuid::nil();
        assert_eq!(
            backup_file_name(DEFAULT_TEMPLATE, "source", at, PlanEngine::Sqlite, "manual", id).unwrap(),
            format!("source-20260105T060708Z-{id}.sqlite")
        );
        assert_eq!(
            backup_file_name(
                "백업_{engine}_{date}_{time}_{trigger}-{prefix}",
                "source",
                at,
                PlanEngine::Postgres,
                "retry",
                id
            )
            .unwrap(),
            format!("백업_postgres_2026-01-05_060708_retry-source-{id}.backup")
        );
    }

    #[test]
    fn rules_reject_paths_extensions_unknown_variables_and_excessive_expansion() {
        for invalid in [
            "",
            "../{prefix}",
            "dir\\{utc}",
            "C:{date}",
            "a.sqlite",
            "{id}",
            "{prefix",
            "name}",
            "a b",
        ] {
            assert!(validate_template(invalid, "source").is_err(), "{invalid}");
        }
        assert!(validate_template(&"{prefix}".repeat(4), &"a".repeat(31)).is_err());
        assert!(validate_template(&"𐐀".repeat(61), "source").is_err());
        assert!(validate_template("CON", "source").is_ok()); // The required ID suffix makes this a regular name.
    }
}
