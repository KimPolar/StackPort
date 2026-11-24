use crate::Result;
use serde::Deserialize;
use std::ops::Range;

pub(super) const MAX_SQL_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PostgresSqlScope {
    Document,
    Selection { start: usize, end: usize },
    Current { cursor: usize },
}

pub(super) fn statement(source: &str, scope: PostgresSqlScope) -> Result<Range<usize>> {
    if source.len() > MAX_SQL_BYTES || source.contains('\0') {
        return Err("SQL은 NUL 문자 없이 256 KiB 이하여야 합니다.".into());
    }
    let spans = match scope {
        PostgresSqlScope::Document => ranges(source, None)?,
        PostgresSqlScope::Selection { start, end } => {
            let start = byte_at_utf16(source, start)?;
            let end = byte_at_utf16(source, end)?;
            let selected = source
                .get(start..end)
                .ok_or("SQL 선택 범위를 확인하세요.")?;
            ranges(selected, None)?
                .into_iter()
                .map(|range| start + range.start..start + range.end)
                .collect()
        }
        PostgresSqlScope::Current { cursor } => {
            let cursor = byte_at_utf16(source, cursor)?;
            let spans = ranges(source, Some(cursor))?;
            return spans
                .last()
                .cloned()
                .ok_or_else(|| "실행할 SQL 문장이 없습니다.".into());
        }
    };
    match spans.as_slice() {
        [span] => Ok(span.clone()),
        [] => Err("실행할 SQL 문장이 없습니다.".into()),
        _ => Err(
            "한 번에 한 문장을 실행하세요. 선택 영역 또는 현재 문장을 실행할 수 있습니다.".into(),
        ),
    }
}

fn byte_at_utf16(source: &str, target: usize) -> Result<usize> {
    let mut offset = 0;
    for (byte, ch) in source.char_indices() {
        if offset == target {
            return Ok(byte);
        }
        offset += ch.len_utf16();
        if offset > target {
            break;
        }
    }
    if offset == target {
        return Ok(source.len());
    }
    Err("SQL 선택 범위를 확인하세요.".into())
}

fn ranges(source: &str, cursor: Option<usize>) -> Result<Vec<Range<usize>>> {
    let bytes = source.as_bytes();
    let mut spans = Vec::new();
    let mut start = None;
    let mut end = 0;
    let mut index = 0;
    while index < bytes.len() {
        let tail = &bytes[index..];
        let next = match tail[0] {
            b' ' | b'\t' | b'\r' | b'\n' | 0x0b | 0x0c => {
                index += 1;
                continue;
            }
            b'-' if tail.starts_with(b"--") => {
                index += tail
                    .iter()
                    .position(|byte| matches!(byte, b'\r' | b'\n'))
                    .unwrap_or(tail.len());
                continue;
            }
            b'/' if tail.starts_with(b"/*") => {
                index += block_comment(tail)?;
                continue;
            }
            b';' => {
                if let Some(first) = start.take() {
                    spans.push(first..end);
                    if cursor.is_some_and(|cursor| cursor <= index) {
                        return Ok(spans);
                    }
                }
                index += 1;
                continue;
            }
            b'e' | b'E' if tail.get(1) == Some(&b'\'') => 1 + quoted(&tail[1..], b'\'', true)?,
            quote @ (b'\'' | b'"') => quoted(tail, quote, false)?,
            b'$' => dollar_quote(source, index)?.unwrap_or(1),
            byte if identifier_start(byte) => tail
                .iter()
                .take_while(|&&b| identifier_part(b) || b == b'$')
                .count(),
            _ => 1,
        };
        start.get_or_insert(index);
        index += next;
        end = index;
    }
    if let Some(first) = start {
        spans.push(first..end);
    }
    Ok(spans)
}

fn block_comment(bytes: &[u8]) -> Result<usize> {
    let mut depth = 1;
    let mut index = 2;
    while let Some(pair) = bytes.get(index..index + 2) {
        if pair == b"/*" {
            depth += 1;
        } else if pair == b"*/" {
            depth -= 1;
            if depth == 0 {
                return Ok(index + 2);
            }
        } else {
            index += 1;
            continue;
        }
        index += 2;
    }
    Err("닫히지 않은 PostgreSQL 블록 주석이 있습니다.".into())
}

fn quoted(bytes: &[u8], quote: u8, escape: bool) -> Result<usize> {
    let mut index = 1;
    while let Some(&byte) = bytes.get(index) {
        if escape && byte == b'\\' {
            index += 2;
        } else if byte == quote {
            if bytes.get(index + 1) != Some(&quote) {
                return Ok(index + 1);
            }
            index += 2;
        } else {
            index += 1;
        }
    }
    Err("닫히지 않은 PostgreSQL 문자열 또는 식별자가 있습니다.".into())
}

fn dollar_quote(source: &str, index: usize) -> Result<Option<usize>> {
    let tail = &source.as_bytes()[index..];
    let end = match tail.get(1).copied() {
        Some(b'$') => 1,
        Some(byte) if identifier_start(byte) => {
            1 + tail[1..]
                .iter()
                .take_while(|&&b| identifier_part(b))
                .count()
        }
        _ => return Ok(None),
    };
    if tail.get(end) != Some(&b'$') {
        return Ok(None);
    }
    let delimiter = &source[index..=index + end];
    let body = &source[index + end + 1..];
    let close = body
        .find(delimiter)
        .ok_or("닫히지 않은 PostgreSQL 달러 인용 문자열이 있습니다.")?;
    Ok(Some(delimiter.len() * 2 + close))
}

fn identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || matches!(byte, b'_' | 0x80..=0xff)
}

fn identifier_part(byte: u8) -> bool {
    identifier_start(byte) || byte.is_ascii_digit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_postgres_quoting_comments_and_optional_delimiters() {
        let sql = r#"/* outer /* nested ; */ end */ SELECT '$x$;', $한글$semi; ' quote$한글$, E'escaped\';', "double;name", id$tag$; -- tail
            VALUES (U&'a\0062;');"#;
        let spans = ranges(sql, None).unwrap();
        assert_eq!(spans.len(), 2);
        assert!(sql[spans[0].clone()].ends_with("id$tag$"));
        assert_eq!(&sql[spans[1].clone()], r"VALUES (U&'a\0062;')");
        assert!(statement(sql, PostgresSqlScope::Document).is_err());
        assert!(ranges("SELECT $x$unterminated;", None).is_err());
        assert!(ranges("/* unclosed", None).is_err());
    }

    #[test]
    fn selects_statement_and_slice_using_editor_utf16_offsets() {
        let source = "SELECT '🧪'; -- first\nSELECT 2;";
        assert_eq!(
            &source[statement(source, PostgresSqlScope::Current { cursor: 7 }).unwrap()],
            "SELECT '🧪'"
        );
        let start = source.find("SELECT 2").unwrap();
        let utf16 = source[..start].encode_utf16().count();
        let end = source.encode_utf16().count();
        assert_eq!(
            &source[statement(source, PostgresSqlScope::Selection { start: utf16, end }).unwrap()],
            "SELECT 2"
        );
        assert!(statement(source, PostgresSqlScope::Current { cursor: 9 }).is_err());
    }

    #[test]
    fn a_later_incomplete_statement_does_not_prevent_running_the_current_one() {
        let source = "SELECT 7   ; SELECT 'unfinished";
        let selection = statement(source, PostgresSqlScope::Current { cursor: 10 }).unwrap();
        assert_eq!(&source[selection], "SELECT 7");
        assert!(statement(source, PostgresSqlScope::Current { cursor: 16 }).is_err());
    }
}
