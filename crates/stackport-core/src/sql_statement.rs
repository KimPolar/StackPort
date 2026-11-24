use crate::{text_draft::UTF8_BOM, Result};
use std::ops::Range;

#[derive(Clone, Copy)]
enum Token<'a> {
    Trivia,
    Semicolon,
    Word(&'a [u8]),
    Other,
}

impl Token<'_> {
    fn is(self, keyword: &[u8]) -> bool {
        matches!(self, Self::Word(word) if word.eq_ignore_ascii_case(keyword))
    }
}

fn whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0c)
}

fn identifier(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$' | 0x80..=0xff)
}

fn quoted(bytes: &[u8], end: u8) -> usize {
    let mut next = 1;
    while let Some(&byte) = bytes.get(next) {
        next += 1;
        if byte == end {
            if end == b']' || bytes.get(next) != Some(&end) {
                break;
            }
            next += 1;
        }
    }
    next
}

fn parameter(bytes: &[u8]) -> usize {
    let mut end = 1;
    let mut has_identifier = false;
    while let Some(&byte) = bytes.get(end) {
        if identifier(byte) {
            has_identifier = true;
            end += 1;
        } else if bytes[end..].starts_with(b"::") {
            end += 2;
        } else {
            break;
        }
    }
    if has_identifier && bytes.get(end) == Some(&b'(') {
        end += 1;
        while let Some(&byte) = bytes.get(end) {
            if whitespace(byte) {
                break;
            }
            end += 1;
            if byte == b')' {
                break;
            }
        }
    }
    end
}

fn next_token(bytes: &[u8]) -> (Token<'_>, usize) {
    match bytes[0] {
        b';' => (Token::Semicolon, 1),
        _ if bytes.starts_with(UTF8_BOM) => (Token::Trivia, UTF8_BOM.len()),
        byte if whitespace(byte) => (Token::Trivia, 1),
        b'-' if bytes.starts_with(b"--") => (
            Token::Trivia,
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .unwrap_or(bytes.len()),
        ),
        b'/' if bytes.starts_with(b"/*") => (
            Token::Trivia,
            bytes[2..]
                .windows(2)
                .position(|pair| pair == b"*/")
                .map_or(bytes.len(), |end| end + 4),
        ),
        end @ (b'\'' | b'"' | b'`') => (Token::Other, quoted(bytes, end)),
        b'[' => (Token::Other, quoted(bytes, b']')),
        b'$' | b':' | b'@' | b'#' => (Token::Other, parameter(bytes)),
        byte if identifier(byte) => {
            let len = bytes.iter().take_while(|&&byte| identifier(byte)).count();
            (Token::Word(&bytes[..len]), len)
        }
        _ => (Token::Other, 1),
    }
}

#[derive(Clone, Copy)]
enum Statement {
    Start,
    Explain,
    ExplainQuery,
    ExplainPlan,
    Create,
    Plain,
    Trigger,
    TriggerAfterSemicolon,
    TriggerAfterEnd,
}

impl Statement {
    fn with(self, token: Token<'_>) -> Self {
        use Statement::*;
        match self {
            Start if token.is(b"explain") => Explain,
            Explain if token.is(b"query") => ExplainQuery,
            ExplainQuery if token.is(b"plan") => ExplainPlan,
            Start | Explain | ExplainPlan if token.is(b"create") => Create,
            Create if token.is(b"temp") || token.is(b"temporary") => Create,
            Create if token.is(b"trigger") => Trigger,
            TriggerAfterSemicolon if token.is(b"end") => TriggerAfterEnd,
            Trigger | TriggerAfterSemicolon | TriggerAfterEnd => Trigger,
            _ => Plain,
        }
    }
}

pub(crate) fn statement_ranges(sql: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    let mut end = 0;
    std::iter::from_fn(move || {
        let mut start = None;
        let mut statement = Statement::Start;
        while end < sql.len() {
            let token_start = end;
            let (token, len) = next_token(&sql.as_bytes()[end..]);
            end += len;
            match token {
                Token::Trivia => {}
                Token::Semicolon => {
                    use Statement::*;
                    match statement {
                        Trigger | TriggerAfterSemicolon => statement = TriggerAfterSemicolon,
                        _ => {
                            if let Some(start) = start {
                                return Some(start..end);
                            }
                            statement = Start;
                        }
                    }
                }
                _ => {
                    start.get_or_insert(token_start);
                    statement = statement.with(token);
                }
            }
        }
        start.map(|start| start..end)
    })
}

pub(crate) fn token_end_at(sql: &str, start: usize) -> usize {
    if start == sql.len() {
        return start;
    }
    start + next_token(&sql.as_bytes()[start..]).1
}

/// Return the SQLite statement at a WebView UTF-16 caret offset.
/// SQLite still prepares and authorizes the selected statement before execution.
pub fn sqlite_statement_at(sql: &str, caret: usize) -> Result<Option<&str>> {
    if sql.as_bytes().contains(&0) {
        return Err("NUL 문자가 있는 SQL은 실행할 수 없습니다.".into());
    }
    let mut units = 0;
    let mut offset = sql.len();
    for (index, ch) in sql.char_indices() {
        if units >= caret {
            offset = index;
            break;
        }
        units += ch.len_utf16();
    }
    if units < caret {
        return Err("SQL 커서 위치가 문서 범위를 벗어났습니다.".into());
    }

    let mut at_previous_end = None;
    for range in statement_ranges(sql) {
        if offset < range.start {
            break;
        }
        let end = range.end;
        if offset < end || (offset == end && end == sql.len()) {
            return Ok(Some(&sql[range]));
        }
        at_previous_end = (offset == end).then(|| &sql[range]);
    }
    Ok(at_previous_end)
}
