use super::{after_quote, word_byte, SqlMode, MAX_PARAMETERS, MAX_SQL};
use crate::Result;
use serde::Deserialize;

const MAX_STATEMENTS: usize = 100;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Scope {
    Document,
    Current { cursor_byte: usize },
    Selection { start_byte: usize, end_byte: usize },
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Part<'a> {
    pub(super) sql: &'a str,
    pub(super) line: u32,
    pub(super) parameters: usize,
    pub(super) delimiter: &'a str,
    end: usize,
}

pub(super) fn parts<'a>(source: &'a str, scope: &Scope, mode: SqlMode) -> Result<Vec<Part<'a>>> {
    if source.len() > MAX_SQL || source.contains('\0') {
        return Err("SQL은 NUL 문자 없이 128 KiB 이내로 입력하세요.".into());
    }
    let parts = match *scope {
        Scope::Document => scan(source, 1, ";", mode)?.0,
        Scope::Current { cursor_byte } => {
            if !source.is_char_boundary(cursor_byte) {
                return Err("SQL 커서 위치를 확인하세요.".into());
            }
            let mut parts = scan(source, 1, ";", mode)?.0;
            let index = parts
                .iter()
                .position(|part| cursor_byte < part.end)
                .unwrap_or_else(|| parts.len().saturating_sub(1));
            if parts.is_empty() {
                parts
            } else {
                vec![parts.swap_remove(index)]
            }
        }
        Scope::Selection {
            start_byte,
            end_byte,
        } => {
            let selection = source
                .get(start_byte..end_byte)
                .ok_or("SQL 선택 범위를 확인하세요.")?;
            let prefix = &source[..start_byte];
            let line = 1 + prefix.bytes().filter(|byte| *byte == b'\n').count() as u32;
            let delimiter = scan(prefix, 1, ";", mode).map_or(";", |(_, delimiter)| delimiter);
            scan(selection, line, delimiter, mode)?.0
        }
    };
    if parts.is_empty() {
        return Err("실행할 SQL 문장이 없습니다.".into());
    }
    if parts.len() > MAX_STATEMENTS {
        return Err("한 번에 SQL 문장을 최대 100개 실행할 수 있습니다.".into());
    }
    if parameter_count(&parts) > MAX_PARAMETERS {
        return Err("SQL 매개변수는 최대 64개까지 입력할 수 있습니다.".into());
    }
    Ok(parts)
}

pub(super) fn parameter_count(parts: &[Part<'_>]) -> usize {
    parts.iter().map(|part| part.parameters).sum()
}

fn scan<'a>(
    source: &'a str,
    mut line: u32,
    mut delimiter: &'a str,
    mode: SqlMode,
) -> Result<(Vec<Part<'a>>, &'a str)> {
    let bytes = source.as_bytes();
    let mut parts = Vec::new();
    let mut start = None;
    let mut parameters = 0;
    let mut at = 0;
    while at < bytes.len() {
        let tail = &bytes[at..];
        if start.is_none() && (at == 0 || bytes[at - 1] == b'\n') {
            let width = tail
                .iter()
                .position(|byte| *byte == b'\n')
                .unwrap_or(tail.len());
            if let Some(new_delimiter) = delimiter_line(&source[at..at + width])? {
                delimiter = new_delimiter;
                at += width;
                continue;
            }
        }
        if tail.starts_with(delimiter.as_bytes()) {
            finish(
                source,
                start.take(),
                at,
                at + delimiter.len(),
                parameters,
                delimiter,
                &mut parts,
            );
            parameters = 0;
            at += delimiter.len();
            continue;
        }
        let next = match tail[0] {
            byte if byte.is_ascii_whitespace() => at + 1,
            b'#' => line_end(bytes, at),
            b'-' if tail.starts_with(b"--")
                && tail
                    .get(2)
                    .is_none_or(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control()) =>
            {
                line_end(bytes, at)
            }
            b'/' if tail.starts_with(b"/*") => {
                if tail.starts_with(b"/*!") || tail.starts_with(b"/*M!") {
                    start.get_or_insert((at, line));
                }
                tail[2..]
                    .windows(2)
                    .position(|pair| pair == b"*/")
                    .map_or(bytes.len(), |end| at + 4 + end)
            }
            quote @ (b'\'' | b'"' | b'`') => {
                start.get_or_insert((at, line));
                let escapes =
                    !mode.no_backslash && (quote == b'\'' || quote == b'"' && !mode.ansi_quotes);
                bytes.len() - after_quote(&tail[1..], quote, escapes).map_or(0, <[u8]>::len)
            }
            byte => {
                start.get_or_insert((at, line));
                parameters += usize::from(byte == b'?');
                at + 1
            }
        };
        line += bytes[at..next]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count() as u32;
        at = next;
    }
    finish(
        source,
        start,
        source.len(),
        source.len(),
        parameters,
        delimiter,
        &mut parts,
    );
    Ok((parts, delimiter))
}

fn delimiter_line(line: &str) -> Result<Option<&str>> {
    let line = line.trim();
    let word = line
        .as_bytes()
        .iter()
        .take_while(|byte| word_byte(**byte))
        .count();
    if !line.as_bytes()[..word].eq_ignore_ascii_case(b"DELIMITER")
        || !line
            .as_bytes()
            .get(word)
            .is_none_or(u8::is_ascii_whitespace)
    {
        return Ok(None);
    }
    let delimiter = line[word..].trim();
    if delimiter.is_empty()
        || delimiter.len() > 16
        || delimiter.starts_with("--")
        || delimiter.starts_with("/*")
        || !delimiter.bytes().all(|byte| {
            byte.is_ascii_punctuation()
                && !matches!(byte, b'\'' | b'"' | b'`' | b'\\' | b'#' | b'?')
        })
    {
        return Err(
            "DELIMITER에는 공백 없는 구분 기호를 입력하세요. 예를 들어 // 또는 $$를 사용하세요."
                .into(),
        );
    }
    Ok(Some(delimiter))
}

fn line_end(bytes: &[u8], start: usize) -> usize {
    bytes[start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(bytes.len(), |end| start + end)
}

fn finish<'a>(
    source: &'a str,
    start: Option<(usize, u32)>,
    sql_end: usize,
    end: usize,
    parameters: usize,
    delimiter: &'a str,
    parts: &mut Vec<Part<'a>>,
) {
    if let Some((start, line)) = start {
        parts.push(Part {
            sql: source[start..sql_end].trim_end(),
            line,
            parameters,
            delimiter,
            end,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_client_delimiters_and_retains_procedure_body_for_every_scope() {
        let sql = "-- heading\nDELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\nSELECT '한글;?', 1;\nSELECT 2;\nEND$$\nDELIMITER ;\nCALL p();\nSELECT ?;";
        let document = parts(sql, &Scope::Document, SqlMode::default()).unwrap();
        assert_eq!(
            document
                .iter()
                .map(|part| (part.line, part.parameters))
                .collect::<Vec<_>>(),
            [(3, 0), (9, 0), (10, 1)]
        );
        let begin = sql.find("CREATE").unwrap();
        let end = sql.find("END$$").unwrap() + "END$$".len();
        let selection = parts(
            sql,
            &Scope::Selection {
                start_byte: begin,
                end_byte: end,
            },
            SqlMode::default(),
        )
        .unwrap();
        assert_eq!(selection[0].sql, document[0].sql);
        assert_eq!(selection[0].delimiter, "$$");
        let reopened = format!("DELIMITER {}\n{}", selection[0].delimiter, selection[0].sql);
        let reopened = parts(&reopened, &Scope::Document, SqlMode::default()).unwrap();
        assert_eq!(reopened[0].sql, document[0].sql);
        assert_eq!(
            parts(
                sql,
                &Scope::Current {
                    cursor_byte: sql.find("한글").unwrap()
                },
                SqlMode::default()
            )
            .unwrap()[0],
            document[0]
        );
    }

    #[test]
    fn skips_comments_and_counts_quoted_tokens_in_each_sql_mode() {
        let sql = "SELECT `?`, ?, 'it\\'s?' # ?\n; SELECT 1--2, ? /* ? */;";
        let document = parts(sql, &Scope::Document, SqlMode::default()).unwrap();
        assert_eq!(document.len(), 2);
        assert_eq!(parameter_count(&document), 2);
        let literal_backslash = "SELECT 'a\\'; SELECT ?;";
        assert_eq!(
            parts(
                literal_backslash,
                &Scope::Document,
                SqlMode::parse("NO_BACKSLASH_ESCAPES")
            )
            .unwrap()
            .len(),
            2
        );
    }
}
