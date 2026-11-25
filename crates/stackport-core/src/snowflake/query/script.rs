use crate::Result;

const MAX_STATEMENTS: usize = 100;

#[derive(Debug)]
pub(super) struct Statement<'a> {
    pub sql: &'a str,
    pub line: u32,
    end: usize,
}

#[derive(Clone, Copy)]
enum Quoted {
    String,
    Identifier,
    Dollar,
    Comment(usize),
}

pub(super) fn split(
    source: &str,
    first_line: u32,
    cursor: Option<usize>,
) -> Result<Vec<Statement<'_>>> {
    let bytes = source.as_bytes();
    let mut statements = Vec::new();
    let mut start = None;
    let mut quote = None;
    let mut line = first_line;
    let mut index = 0;
    while index < bytes.len() {
        let tail = &bytes[index..];
        if tail[0] == b'\n' {
            line += 1;
        }
        if let Some(quoted) = quote {
            match quoted {
                Quoted::String if tail[0] == b'\\' && tail.len() > 1 => {
                    line += u32::from(tail[1] == b'\n');
                    index += 2;
                    continue;
                }
                Quoted::String if tail.starts_with(b"''") => {
                    index += 2;
                    continue;
                }
                Quoted::Identifier if tail.starts_with(b"\"\"") => {
                    index += 2;
                    continue;
                }
                Quoted::Dollar if tail.starts_with(b"$$") => {
                    quote = None;
                    index += 2;
                    continue;
                }
                Quoted::Comment(depth) if tail.starts_with(b"/*") => {
                    quote = Some(Quoted::Comment(depth + 1));
                    index += 2;
                    continue;
                }
                Quoted::Comment(depth) if tail.starts_with(b"*/") => {
                    quote = (depth > 1).then_some(Quoted::Comment(depth - 1));
                    index += 2;
                    continue;
                }
                Quoted::String if tail[0] == b'\'' => quote = None,
                Quoted::Identifier if tail[0] == b'"' => quote = None,
                _ => {}
            }
        } else if tail.starts_with(b"--") {
            index += tail
                .iter()
                .position(|byte| *byte == b'\n')
                .unwrap_or(tail.len());
            continue;
        } else if tail.starts_with(b"/*") {
            quote = Some(Quoted::Comment(1));
            index += 2;
            continue;
        } else if tail[0] == b';' {
            finish(source, start.take(), index, index + 1, &mut statements);
        } else if !tail[0].is_ascii_whitespace() {
            start.get_or_insert((index, line));
            match tail[0] {
                b'\'' => quote = Some(Quoted::String),
                b'"' => quote = Some(Quoted::Identifier),
                b'$' if tail.starts_with(b"$$")
                    && (index == 0 || !identifier_byte(bytes[index - 1])) =>
                {
                    quote = Some(Quoted::Dollar);
                    index += 2;
                    continue;
                }
                _ => {}
            }
        }
        index += 1;
    }
    finish(source, start, source.len(), source.len(), &mut statements);
    if statements.is_empty() {
        return Err("실행할 Snowflake SQL 문장이 없습니다.".into());
    }
    if let Some(cursor) = cursor {
        if cursor > source.len() || !source.is_char_boundary(cursor) {
            return Err("Snowflake SQL 커서 위치를 확인하세요.".into());
        }
        let index = statements
            .iter()
            .position(|statement| cursor < statement.end)
            .unwrap_or(statements.len() - 1);
        return Ok(vec![statements.swap_remove(index)]);
    }
    if statements.len() > MAX_STATEMENTS {
        return Err("한 번에 Snowflake SQL 문장을 최대 100개 실행할 수 있습니다.".into());
    }
    Ok(statements)
}

fn finish<'a>(
    source: &'a str,
    start: Option<(usize, u32)>,
    sql_end: usize,
    end: usize,
    statements: &mut Vec<Statement<'a>>,
) {
    if let Some((start, line)) = start {
        statements.push(Statement {
            sql: source[start..sql_end].trim_end(),
            line,
            end,
        });
    }
}

fn identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || !byte.is_ascii() || matches!(byte, b'_' | b'$')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_quoted_delimiters_and_scripting_blocks() {
        let source = "-- heading;\nSELECT 'it''s; b', 'it\\'s; c', \"a\"\";b\", COLUMN$$ID FROM t;\n\n/* outer; /* inner; */ */\nEXECUTE IMMEDIATE $$\nBEGIN RETURN '한글;'; END;\n$$;\nSELECT 3; -- trailing comment";
        let statements = split(source, 10, None).unwrap();
        assert_eq!(
            statements
                .iter()
                .map(|statement| statement.line)
                .collect::<Vec<_>>(),
            [11, 14, 17]
        );
        assert!(statements[0].sql.ends_with("COLUMN$$ID FROM t"));
        assert!(statements[1]
            .sql
            .ends_with("BEGIN RETURN '한글;'; END;\n$$"));
        let position = source.find("한글").unwrap();
        assert_eq!(
            split(source, 10, Some(position)).unwrap()[0].sql,
            statements[1].sql
        );
        assert!(split(source, 10, Some(position + 1)).is_err());
    }

    #[test]
    fn drops_empty_statements_and_retains_transaction_boundaries() {
        let source = "; BEGIN TRANSACTION; -- begin\n; INSERT INTO t VALUES (1); COMMIT;";
        let sql = split(source, 1, None)
            .unwrap()
            .into_iter()
            .map(|statement| statement.sql)
            .collect::<Vec<_>>();
        assert_eq!(
            sql,
            ["BEGIN TRANSACTION", "INSERT INTO t VALUES (1)", "COMMIT"]
        );
        assert!(split("-- only a comment;", 1, None).is_err());
    }
}
