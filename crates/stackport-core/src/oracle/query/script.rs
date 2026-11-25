use crate::Result;

const STATEMENT_LIMIT: usize = 100;

#[derive(Debug)]
pub(super) struct Statement<'a> {
    pub sql: &'a str,
    pub line: u32,
    end: usize,
}

#[derive(Clone, Copy)]
enum Quoted {
    Comment,
    Regular(u8),
    Alternative(char),
}

pub(super) fn split(
    script: &str,
    first_line: u32,
    cursor: Option<usize>,
) -> Result<Vec<Statement<'_>>> {
    let mut parser = Parser {
        source: script,
        statements: Vec::new(),
        start: None,
        head: Vec::new(),
        quote: None,
        label: false,
        last_semicolon: None,
    };
    let mut offset = 0;
    let mut line_number = first_line;
    for line in script.split_inclusive('\n') {
        if parser.quote.is_none() && line.trim() == "/" {
            parser.finish(offset, offset + line.len());
        } else {
            parser.scan_line(line, offset, line_number);
        }
        offset += line.len();
        line_number += 1;
    }
    parser.finish(script.len(), script.len());
    if let Some(cursor) = cursor {
        if cursor > script.len() || !script.is_char_boundary(cursor) {
            return Err("Oracle SQL 커서 위치를 확인하세요.".into());
        }
        let index = parser
            .statements
            .iter()
            .position(|statement| cursor < statement.end)
            .unwrap_or_else(|| parser.statements.len().saturating_sub(1));
        return parser
            .statements
            .into_iter()
            .nth(index)
            .map(|statement| vec![statement])
            .ok_or_else(|| "실행할 Oracle SQL 문장이 없습니다.".into());
    }
    if parser.statements.is_empty() {
        return Err("실행할 Oracle SQL 문장이 없습니다.".into());
    }
    if parser.statements.len() > STATEMENT_LIMIT {
        return Err("한 번에 Oracle SQL 문장을 최대 100개 실행할 수 있습니다.".into());
    }
    Ok(parser.statements)
}

struct Parser<'a> {
    source: &'a str,
    statements: Vec<Statement<'a>>,
    start: Option<(usize, u32)>,
    head: Vec<&'a str>,
    quote: Option<Quoted>,
    label: bool,
    last_semicolon: Option<usize>,
}

impl<'a> Parser<'a> {
    fn scan_line(&mut self, line: &'a str, offset: usize, line_number: u32) {
        let bytes = line.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            let rest = &bytes[index..];
            if let Some(quote) = self.quote {
                let consumed = match quote {
                    Quoted::Comment if rest.starts_with(b"*/") => 2,
                    Quoted::Regular(end) if rest.starts_with(&[end, end]) => {
                        index += 2;
                        continue;
                    }
                    Quoted::Regular(end) if rest[0] == end => 1,
                    Quoted::Alternative(end)
                        if line.get(index..).is_some_and(|tail| {
                            tail.starts_with(end)
                                && tail.as_bytes().get(end.len_utf8()) == Some(&b'\'')
                        }) =>
                    {
                        end.len_utf8() + 1
                    }
                    _ => 0,
                };
                if consumed > 0 {
                    self.quote = None;
                }
                index += consumed.max(1);
                continue;
            }
            if rest.starts_with(b"--") {
                break;
            }
            if rest.starts_with(b"/*") {
                self.quote = Some(Quoted::Comment);
                index += 2;
                continue;
            }
            if rest[0].is_ascii_whitespace() {
                index += 1;
                continue;
            }
            if rest[0] == b';' && self.mode() == Mode::Sql {
                self.finish(offset + index, offset + index + 1);
                index += 1;
                continue;
            }
            self.last_semicolon = (rest[0] == b';').then_some(offset + index);
            if self.start.is_none() {
                self.start = Some((offset + index, line_number));
                self.label = rest.starts_with(b"<<");
            }
            if matches!(rest[0], b'\'' | b'"') {
                self.quote = Some(Quoted::Regular(rest[0]));
            } else if word_byte(rest[0]) {
                let length = rest
                    .iter()
                    .copied()
                    .take_while(|byte| word_byte(*byte))
                    .count();
                let word = &line[index..index + length];
                if self.head.len() < 6 {
                    self.head.push(word);
                }
                index += length;
                if (word.eq_ignore_ascii_case("q") || word.eq_ignore_ascii_case("nq"))
                    && bytes.get(index) == Some(&b'\'')
                {
                    if let Some(open) = line[index + 1..]
                        .chars()
                        .next()
                        .filter(|ch| !ch.is_whitespace())
                    {
                        self.quote = Some(Quoted::Alternative(match open {
                            '[' => ']',
                            '{' => '}',
                            '(' => ')',
                            '<' => '>',
                            other => other,
                        }));
                        index += 1 + open.len_utf8();
                    }
                }
                continue;
            }
            index += 1;
        }
    }

    fn mode(&self) -> Mode {
        let is = |index: usize, expected: &str| {
            self.head
                .get(index)
                .is_some_and(|word| word.eq_ignore_ascii_case(expected))
        };
        if self.label || is(0, "BEGIN") || is(0, "DECLARE") {
            return Mode::PlSql;
        }
        if is(0, "WITH") && (is(1, "FUNCTION") || is(1, "PROCEDURE")) {
            return Mode::WithPlSql;
        }
        if is(0, "CREATE") {
            let mut index = if is(1, "OR") && is(2, "REPLACE") {
                3
            } else {
                1
            };
            if is(index, "EDITIONABLE") || is(index, "NONEDITIONABLE") {
                index += 1;
            }
            if ["PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE"]
                .iter()
                .any(|word| is(index, word))
                || (is(index, "TYPE") && is(index + 1, "BODY"))
            {
                return Mode::PlSql;
            }
        }
        Mode::Sql
    }

    fn finish(&mut self, sql_end: usize, end: usize) {
        if let Some((start, line)) = self.start.take() {
            let sql_end = if self.mode() == Mode::WithPlSql {
                self.last_semicolon.unwrap_or(sql_end)
            } else {
                sql_end
            };
            let sql = self.source[start..sql_end].trim_end();
            self.statements.push(Statement { sql, line, end });
        }
        self.head.clear();
        self.label = false;
        self.last_semicolon = None;
    }
}

#[derive(PartialEq, Eq)]
enum Mode {
    Sql,
    PlSql,
    WithPlSql,
}

fn word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || !byte.is_ascii() || matches!(byte, b'_' | b'$' | b'#')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_pl_sql_and_quoted_delimiters() {
        let script = "-- 시작\nSELECT q'[한글;\n/\n abc]' AS s FROM dual;\nBEGIN\n  NULL; -- ;\nEND;\n/\nSELECT 'it''s;' FROM dual;";
        let parts = split(script, 6, None).unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].line, 7);
        assert_eq!(parts[0].sql, "SELECT q'[한글;\n/\n abc]' AS s FROM dual");
        assert_eq!(parts[1].sql, "BEGIN\n  NULL; -- ;\nEND;");
        assert_eq!(parts[2].line, 14);
        let cursor = script.find("NULL").unwrap();
        assert_eq!(split(script, 6, Some(cursor)).unwrap()[0].sql, parts[1].sql);
    }

    #[test]
    fn preserves_stored_programs_and_discards_extra_slash_delimiters() {
        let source = "CREATE OR REPLACE EDITIONABLE PROCEDURE p IS\nBEGIN NULL; END;\n/\nSELECT 1 FROM dual;\n/\n";
        let parts = split(source, 1, None).unwrap();
        assert!(parts[0].sql.ends_with("NULL; END;"));
        assert_eq!(parts[1].sql, "SELECT 1 FROM dual");
        assert!(split("/* nothing to run */\n/\n;", 1, None).is_err());
        assert_eq!(
            split("<<do_it>> BEGIN NULL; END;", 1, None).unwrap().len(),
            1
        );
        let within =
            "WITH FUNCTION one RETURN INT IS BEGIN RETURN 1; END; SELECT one() FROM dual; -- final comment\n/";
        assert!(split(within, 1, None).unwrap()[0]
            .sql
            .ends_with("SELECT one() FROM dual"));
    }
}
