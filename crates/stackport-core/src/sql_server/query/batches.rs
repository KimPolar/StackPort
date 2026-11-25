use crate::Result;

const MAX_BATCH_RUNS: usize = 100;

pub(super) struct Batch<'a> {
    pub sql: &'a str,
    pub first_line: u32,
    last_line: u32,
    pub repeat: usize,
}

pub(super) fn split(script: &str, first_line: u32, cursor: Option<u32>) -> Result<Vec<Batch<'_>>> {
    let mut batches = Vec::new();
    let mut lex = Lex::default();
    let (mut offset, mut start, mut start_line) = (0, 0, first_line);
    let mut line_number = first_line;
    let mut has_sql = false;
    for line in script.split_inclusive('\n') {
        let separator = if lex.is_plain() { go(line)? } else { None };
        if let Some(repeat) = separator {
            if has_sql {
                batches.push(Batch {
                    sql: &script[start..offset],
                    first_line: start_line,
                    last_line: line_number,
                    repeat,
                });
            }
            start = offset + line.len();
            start_line = line_number + 1;
            has_sql = false;
        } else {
            has_sql |= lex.scan(line);
        }
        offset += line.len();
        line_number += 1;
    }
    if has_sql {
        batches.push(Batch {
            sql: &script[start..],
            first_line: start_line,
            last_line: line_number,
            repeat: 1,
        });
    }
    if let Some(cursor) = cursor {
        batches.retain(|batch| (batch.first_line..=batch.last_line).contains(&cursor));
        for batch in &mut batches {
            batch.repeat = 1;
        }
    }
    if batches.is_empty() {
        return Err("실행할 SQL Server 배치가 없습니다.".into());
    }
    if batches.iter().map(|batch| batch.repeat).sum::<usize>() > MAX_BATCH_RUNS {
        return Err("한 번에 SQL Server 배치를 최대 100회 실행할 수 있습니다.".into());
    }
    Ok(batches)
}

fn go(line: &str) -> Result<Option<usize>> {
    let line = line.trim_start();
    let Some(prefix) = line.get(..2) else {
        return Ok(None);
    };
    if !prefix.eq_ignore_ascii_case("go") {
        return Ok(None);
    }
    let tail = &line[2..];
    let trimmed = tail.trim_start();
    let digits = if tail.len() != trimmed.len() {
        trimmed.bytes().take_while(u8::is_ascii_digit).count()
    } else {
        0
    };
    let mut lex = Lex::default();
    if lex.scan(&trimmed[digits..]) || !lex.is_plain() {
        return Ok(None);
    }
    if digits == 0 {
        return Ok(Some(1));
    }
    trimmed[..digits]
        .parse::<usize>()
        .ok()
        .filter(|count| (1..=MAX_BATCH_RUNS).contains(count))
        .map(Some)
        .ok_or_else(|| "GO 반복 횟수는 1~100 사이의 정수를 입력하세요.".into())
}

#[derive(Default)]
pub(super) struct Lex {
    quote_end: Option<u8>,
    comments: usize,
}

impl Lex {
    fn is_plain(&self) -> bool {
        self.quote_end.is_none() && self.comments == 0
    }

    fn scan(&mut self, line: &str) -> bool {
        self.scan_variables(line, |_| {})
    }

    pub(super) fn scan_variables(&mut self, line: &str, mut variable: impl FnMut(&str)) -> bool {
        let bytes = line.as_bytes();
        let mut index = 0;
        let mut has_sql = self.quote_end.is_some();
        while index < bytes.len() {
            let rest = &bytes[index..];
            let byte = rest[0];
            if let Some(end) = self.quote_end {
                if byte == end {
                    if rest.get(1) == Some(&end) {
                        index += 1;
                    } else {
                        self.quote_end = None;
                    }
                }
            } else if rest.starts_with(b"/*") {
                self.comments += 1;
                index += 1;
            } else if self.comments > 0 {
                if rest.starts_with(b"*/") {
                    self.comments -= 1;
                    index += 1;
                }
            } else if rest.starts_with(b"--") {
                break;
            } else if identifier_byte(byte) {
                let end = index
                    + rest
                        .iter()
                        .copied()
                        .take_while(|byte| identifier_byte(*byte))
                        .count();
                if byte == b'@' {
                    variable(&line[index..end]);
                }
                index = end;
                has_sql = true;
                continue;
            } else if !byte.is_ascii_whitespace() {
                has_sql = true;
                self.quote_end = match byte {
                    b'\'' | b'"' => Some(byte),
                    b'[' => Some(b']'),
                    _ => None,
                };
            }
            index += 1;
        }
        has_sql
    }
}

fn identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || !byte.is_ascii() || matches!(byte, b'_' | b'$' | b'#' | b'@')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_go_inside_strings_identifiers_and_nested_comments() {
        let script = "SELECT N'a''\nGO\nb', [c]]\nGO\nd]\n/* p /* q */\nGO\n*/\r\nGo 2 /* comment */ -- end\r\nSELECT 7";
        let batches = split(script, 3, None).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].first_line, 3);
        assert_eq!(batches[0].repeat, 2);
        assert!(batches[0].sql.contains("GO\nd]"));
        assert_eq!(batches[1].sql, "SELECT 7");
        assert_eq!(batches[1].first_line, 12);
        let current = split(script, 3, Some(8)).unwrap();
        assert_eq!(current[0].sql, batches[0].sql);
        assert_eq!(current[0].repeat, 1);
    }

    #[test]
    fn rejects_invalid_repeats_and_ignores_empty_batches() {
        assert!(split("SELECT 1\nGO 0\n", 1, None).is_err());
        assert!(split("SELECT 1\nGO 100\nSELECT 2", 1, None).is_err());
        assert!(split("-- comment\nGO\n/* comment */\n", 1, None).is_err());
        let batches = split("GO\nSELECT [good];\nGO-- next\nSELECT 2", 1, None).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].sql, "SELECT [good];\n");
    }
}
