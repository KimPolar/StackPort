use crate::Result;
use serde::Serialize;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dialect {
    Postgres,
    Mysql { backslash: bool, ansi_quotes: bool },
    SqlServer,
    Oracle,
    Snowflake,
}

#[derive(Serialize)]
pub struct SqlExecutionReview {
    risks: Vec<Risk>,
    more_risks: bool,
}

#[derive(Serialize)]
struct Risk {
    line: u32,
    action: &'static str,
    kind: RiskKind,
    repeat: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RiskKind {
    DataChange,
    AllRows,
    Bulk,
    Schema,
    Opaque,
}

impl SqlExecutionReview {
    pub(crate) fn require_production_confirmation(
        &self,
        environment: &str,
        confirmation: &str,
    ) -> Result<()> {
        if environment == "PROD" && confirmation != "PROD" && !self.risks.is_empty() {
            return Err(
                "운영 연결에서 변경 가능성이 있는 SQL을 실행하려면 PROD를 입력하세요.".into(),
            );
        }
        Ok(())
    }

    fn push(&mut self, token: Token<'_>, action: &'static str, kind: RiskKind, repeat: usize) {
        if self.risks.len() < 100 {
            self.risks.push(Risk {
                line: token.line,
                action,
                kind,
                repeat,
            });
        } else {
            self.more_risks = true;
        }
    }
}

pub(crate) fn review<'a>(
    dialect: Dialect,
    parts: impl IntoIterator<Item = (&'a str, u32, usize)>,
) -> SqlExecutionReview {
    let mut review = SqlExecutionReview {
        risks: Vec::new(),
        more_risks: false,
    };
    for (sql, line, repeat) in parts {
        let tokens = tokenize(sql, line, dialect);
        if dialect == Dialect::SqlServer {
            if let Some(first) = tokens
                .first()
                .copied()
                .filter(|token| implicit_sql_server_call(*token))
            {
                review.push(first, "BATCH", RiskKind::Opaque, repeat);
            }
        }
        // T-SQL allows adjacent statements without semicolons. In other dialects
        // the native splitter has already identified a single executable unit.
        for (index, token) in tokens.iter().copied().enumerate() {
            let verb = command(token);
            if token.is("/*!") {
                review.push(token, "COMMENT", RiskKind::Opaque, repeat);
            } else if let Some(action) =
                verb.filter(|action| is_command(&tokens, index, dialect, action))
            {
                let rest = command_tail(&tokens[index + 1..], token.depth, dialect, action);
                let kind = classify(action, rest, token.depth, dialect);
                if let Some(kind) = kind {
                    review.push(token, action, kind, repeat);
                }
            }
        }
    }
    review
}

fn is_command(tokens: &[Token<'_>], index: usize, dialect: Dialect, action: &str) -> bool {
    let token = tokens[index];
    let previous = index.checked_sub(1).map(|before| tokens[before]);
    if previous.is_none_or(|before| before.is(";")) {
        return true;
    }
    if dialect == Dialect::SqlServer && token.depth == 0 {
        // FOR UPDATE and qualified names do not start a statement. The MERGE
        // branch verbs are already covered by the bulk MERGE warning.
        return !previous
            .is_some_and(|before| before.is("FOR") || before.is(".") || before.is("THEN"));
    }
    if dialect == Dialect::Oracle
        && index == 5
        && tokens[0].is("<")
        && tokens[1].is("<")
        && tokens[3].is(">")
        && tokens[4].is(">")
        && matches!(action, "BEGIN" | "DECLARE")
    {
        return true;
    }
    if previous.is_some_and(|before| before.is(")")) {
        return tokens[..index]
            .iter()
            .rev()
            .find(|before| {
                before.depth < token.depth || before.depth == token.depth && before.starts_command()
            })
            .is_some_and(|before| before.depth == token.depth && before.is("WITH"));
    }
    previous.is_some_and(|before| before.is("("))
        && tokens[..index - 1]
            .iter()
            .rev()
            .take(3)
            .any(|before| before.is("AS"))
}

fn implicit_sql_server_call(token: Token<'_>) -> bool {
    // A procedure name may be used in place of EXEC at the head of a batch.
    let starts_name =
        token.is("@value")
            || token.text.as_bytes().first().is_some_and(|byte| {
                byte.is_ascii_alphabetic() || matches!(*byte, b'_' | 0x80..=0xff)
            });
    starts_name
        && !token.starts_command()
        && ![
            "WITH", "WAITFOR", "SET", "PRINT", "IF", "WHILE", "COMMIT", "ROLLBACK", "SAVE",
            "RETURN", "END", "THROW", "GOTO", "BREAK", "CONTINUE",
        ]
        .iter()
        .any(|keyword| token.is(keyword))
}

fn command_tail<'a, 'sql>(
    tokens: &'a [Token<'sql>],
    depth: usize,
    dialect: Dialect,
    action: &str,
) -> &'a [Token<'sql>] {
    let end = tokens.iter().position(|token| {
        token.depth < depth
            || token.depth == depth
                && (token.is(";")
                    || dialect == Dialect::SqlServer
                        && command(*token)
                            .is_some_and(|next| next != "SELECT" || action != "INSERT"))
    });
    &tokens[..end.unwrap_or(tokens.len())]
}

fn classify(action: &str, rest: &[Token<'_>], depth: usize, dialect: Dialect) -> Option<RiskKind> {
    let top = |word| {
        rest.iter()
            .any(|token| token.depth == depth && token.is(word))
    };
    Some(match action {
        "UPDATE" | "DELETE" => {
            let condition = rest
                .iter()
                .position(|token| token.depth == depth && token.is("WHERE"));
            if condition.is_none_or(|where_at| always_true(&rest[where_at + 1..], depth)) {
                RiskKind::AllRows
            } else {
                RiskKind::DataChange
            }
        }
        "INSERT" | "REPLACE"
            if top("SELECT") || dialect == Dialect::SqlServer && !top("VALUES") =>
        {
            RiskKind::Bulk
        }
        "INSERT" | "REPLACE" => RiskKind::DataChange,
        "COPY" if dialect == Dialect::Postgres && !top("FROM") => RiskKind::Opaque,
        "MERGE" | "COPY" | "BULK" | "LOAD" => RiskKind::Bulk,
        "SELECT" if matches!(dialect, Dialect::Postgres | Dialect::SqlServer) && top("INTO") => {
            RiskKind::Schema
        }
        "SELECT"
            if matches!(dialect, Dialect::Mysql { .. })
                && top("INTO")
                && (top("OUTFILE") || top("DUMPFILE")) =>
        {
            RiskKind::Opaque
        }
        "TRUNCATE" => RiskKind::AllRows,
        "CREATE" | "ALTER" | "DROP" | "RENAME" | "GRANT" | "REVOKE" => RiskKind::Schema,
        "CALL" | "DO" | "EXEC" | "EXECUTE" => RiskKind::Opaque,
        "BEGIN" | "DECLARE" if dialect == Dialect::Oracle => RiskKind::Opaque,
        "EXPLAIN"
            if rest
                .iter()
                .any(|token| token.is("ANALYZE") || token.is("ANALYSE")) =>
        {
            RiskKind::Opaque
        }
        _ => return None,
    })
}

fn always_true(condition: &[Token<'_>], depth: usize) -> bool {
    let suffix = condition.iter().take_while(|token| {
        token.depth != depth
            || !["ORDER", "LIMIT", "RETURNING", "OPTION", "OUTPUT"]
                .iter()
                .any(|keyword| token.is(keyword))
    });
    let mut plain = suffix.filter(|token| !token.is("(") && !token.is(")"));
    match (plain.next(), plain.next(), plain.next(), plain.next()) {
        (Some(value), None, None, None) => value.is("TRUE"),
        (Some(left), Some(op), Some(right), None) => left.is("1") && op.is("=") && right.is("1"),
        _ => false,
    }
}

fn command(token: Token<'_>) -> Option<&'static str> {
    [
        "SELECT", "UPDATE", "DELETE", "INSERT", "REPLACE", "MERGE", "COPY", "BULK", "LOAD",
        "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "CALL", "DO", "EXEC",
        "EXECUTE", "BEGIN", "DECLARE", "EXPLAIN",
    ]
    .into_iter()
    .find(|action| token.is(action))
}

#[derive(Clone, Copy)]
struct Token<'a> {
    text: &'a str,
    depth: usize,
    line: u32,
}

impl Token<'_> {
    fn is(self, text: &str) -> bool {
        self.text.eq_ignore_ascii_case(text)
    }

    fn starts_command(self) -> bool {
        self.is("WITH") || command(self).is_some()
    }
}

fn tokenize(mut sql: &str, mut line: u32, dialect: Dialect) -> Vec<Token<'_>> {
    let mut tokens = Vec::new();
    let mut depth = 0_usize;
    while let Some(&byte) = sql.as_bytes().first() {
        let mut text = "";
        let length = if byte.is_ascii_whitespace() {
            1
        } else if sql.starts_with("--")
            && (!matches!(dialect, Dialect::Mysql { .. })
                || sql.as_bytes().get(2).is_none_or(|byte| *byte <= b' '))
            || byte == b'#' && matches!(dialect, Dialect::Mysql { .. })
        {
            sql.find(['\r', '\n']).unwrap_or(sql.len())
        } else if sql.starts_with("/*") {
            if matches!(dialect, Dialect::Mysql { .. })
                && (sql.starts_with("/*!") || sql.starts_with("/*M!"))
            {
                text = "/*!";
            }
            block_end(
                sql,
                matches!(
                    dialect,
                    Dialect::Postgres | Dialect::SqlServer | Dialect::Snowflake
                ),
            )
        } else if let Some(length) = string_end(sql, dialect) {
            text = "@value";
            length
        } else if is_word(byte) {
            let length = sql.bytes().take_while(|byte| is_word(*byte)).count();
            text = &sql[..length];
            length
        } else {
            text = &sql[..1];
            1
        };
        if text == ")" {
            depth = depth.saturating_sub(1);
        }
        if !text.is_empty() {
            tokens.push(Token { text, depth, line });
        }
        if text == "(" {
            depth += 1;
        }
        line += sql.as_bytes()[..length]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count() as u32;
        sql = &sql[length..];
    }
    tokens
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$' | b'@' | b'#' | b':' | 0x80..=0xff)
}

fn block_end(sql: &str, nested: bool) -> usize {
    let mut depth = 1;
    let mut offset = 2;
    while let Some(pair) = sql.as_bytes().get(offset..offset + 2) {
        match pair {
            b"/*" if nested => depth += 1,
            b"*/" => {
                depth -= 1;
                if depth == 0 {
                    return offset + 2;
                }
            }
            _ => {
                offset += 1;
                continue;
            }
        }
        offset += 2;
    }
    sql.len()
}

fn string_end(sql: &str, dialect: Dialect) -> Option<usize> {
    let bytes = sql.as_bytes();
    let first = bytes[0];
    if first == b'$' && matches!(dialect, Dialect::Postgres | Dialect::Snowflake) {
        let length =
            if dialect == Dialect::Postgres && !bytes.get(1).is_some_and(u8::is_ascii_digit) {
                1 + bytes[1..]
                    .iter()
                    .take_while(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(**byte, b'_' | 0x80..=0xff)
                    })
                    .count()
            } else {
                1
            };
        if bytes.get(length) == Some(&b'$') {
            let tag = &sql[..=length];
            return Some(
                sql[tag.len()..]
                    .find(tag)
                    .map_or(sql.len(), |index| index + 2 * tag.len()),
            );
        }
    }
    if dialect == Dialect::Oracle {
        let offset = if matches!(bytes.get(..2), Some(b"nq" | b"NQ" | b"Nq" | b"nQ")) {
            2
        } else {
            1
        };
        if matches!(bytes.get(offset - 1), Some(b'q' | b'Q')) && bytes.get(offset) == Some(&b'\'') {
            let tail = &sql[offset + 1..];
            let opener = tail.chars().next()?;
            let closer = match opener {
                '(' => ')',
                '[' => ']',
                '{' => '}',
                '<' => '>',
                other => other,
            };
            let marker = format!("{closer}'");
            return Some(
                tail[opener.len_utf8()..]
                    .find(&marker)
                    .map_or(sql.len(), |index| {
                        offset + 1 + opener.len_utf8() + index + marker.len()
                    }),
            );
        }
    }
    let (quote, start, escape) = match (dialect, first) {
        (Dialect::Postgres, b'e' | b'E') if bytes.get(1) == Some(&b'\'') => (b'\'', 2, true),
        (Dialect::SqlServer, b'[') => (b']', 1, false),
        (Dialect::Mysql { .. }, b'\x60') => (first, 1, false),
        (
            Dialect::Mysql {
                backslash,
                ansi_quotes,
            },
            b'\'' | b'"',
        ) => (first, 1, backslash && (first == b'\'' || !ansi_quotes)),
        (Dialect::Snowflake, b'\'') => (first, 1, true),
        (_, b'\'' | b'"') => (first, 1, false),
        _ => return None,
    };
    let mut index = start;
    while let Some(&byte) = bytes.get(index) {
        if byte == quote && bytes.get(index + 1) != Some(&quote) {
            return Some(index + 1);
        }
        index += if byte == quote || escape && byte == b'\\' {
            2
        } else {
            1
        };
    }
    Some(sql.len())
}

#[cfg(test)]
mod tests {
    use super::{review, Dialect, RiskKind};

    #[test]
    fn finds_updates_and_deletes_in_the_outer_command_and_writable_ctes() {
        let plan = review(Dialect::Postgres, [
            ("UPDATE t SET v = (SELECT v FROM b WHERE id = 1)", 3, 1),
            ("DELETE FROM t WHERE (1 = 1)", 8, 1),
            ("WITH gone AS (DELETE FROM t RETURNING id) SELECT id FROM gone", 10, 1),
            ("WITH ids AS (SELECT id FROM b WHERE id = 2)\nUPDATE t SET v = 1 WHERE id IN (SELECT id FROM ids)", 12, 1),
            ("INSERT INTO t SELECT * FROM b", 14, 1),
            ("DROP TABLE t", 16, 1),
            ("TRUNCATE TABLE b", 17, 1),
        ]);
        let issues = plan
            .risks
            .iter()
            .map(|risk| (risk.line, risk.action, risk.kind))
            .collect::<Vec<_>>();
        assert_eq!(
            issues,
            [
                (3, "UPDATE", RiskKind::AllRows),
                (8, "DELETE", RiskKind::AllRows),
                (10, "DELETE", RiskKind::AllRows),
                (13, "UPDATE", RiskKind::DataChange),
                (14, "INSERT", RiskKind::Bulk),
                (16, "DROP", RiskKind::Schema),
                (17, "TRUNCATE", RiskKind::AllRows),
            ]
        );
        let implicit_call = review(Dialect::SqlServer, [("dbo.finance_recalculate", 19, 1)]);
        assert_eq!(implicit_call.risks[0].kind, RiskKind::Opaque);
    }

    #[test]
    fn honors_sql_server_statement_starts_without_semicolons_and_go_repeats() {
        let result = review(
            Dialect::SqlServer,
            [(
                "SELECT '[DROP TABLE b]' AS msg, [UPDATE] FROM dbo.t\n\
             UPDATE dbo.t SET v = (SELECT v FROM b WHERE id = 1)\n\
             SELECT id FROM dbo.t WHERE id = 2\n\
             DELETE FROM dbo.t WHERE id = 3;\n\
             EXEC sp_executesql N'UPDATE dbo.t SET v = 1'",
                41,
                3,
            )],
        );
        let issues = result
            .risks
            .iter()
            .map(|risk| (risk.line, risk.kind, risk.repeat))
            .collect::<Vec<_>>();
        assert_eq!(
            issues,
            [
                (42, RiskKind::AllRows, 3),
                (44, RiskKind::DataChange, 3),
                (45, RiskKind::Opaque, 3)
            ]
        );
    }

    #[test]
    fn suppresses_literals_and_comments_and_applies_mysql_quoting_mode() {
        let mysql = Dialect::Mysql {
            backslash: true,
            ansi_quotes: false,
        };
        let standard = Dialect::Mysql {
            backslash: false,
            ansi_quotes: false,
        };
        let sql = r#"UPDATE t SET v = 'secret\'; fake WHERE id=1' -- comment
"#;
        assert_eq!(
            review(mysql, [(sql, 1, 1)]).risks[0].kind,
            RiskKind::AllRows
        );
        assert_eq!(
            review(standard, [(sql, 1, 1)]).risks[0].kind,
            RiskKind::AllRows
        );
        let mode_sql = r"UPDATE t SET v = 'slash\' WHERE id=1";
        assert_eq!(
            review(mysql, [(mode_sql, 1, 1)]).risks[0].kind,
            RiskKind::AllRows
        );
        assert_eq!(
            review(standard, [(mode_sql, 1, 1)]).risks[0].kind,
            RiskKind::DataChange
        );
        assert_eq!(
            review(mysql, [("SELECT 1 /*! SQL_NO_CACHE */", 1, 1)]).risks[0].kind,
            RiskKind::Opaque
        );

        for (dialect, select) in [
            (Dialect::Postgres, "/* comment /* DELETE */ nested */ SELECT E'where\\'DROP', $한글$DROP TABLE t$한글$"),
            (Dialect::Oracle, "SELECT nq'[DELETE FROM t; DROP TABLE t]' FROM dual"),
            (Dialect::Snowflake, "SELECT $$DROP TABLE t;$$, 'UPDATE'"),
        ] {
            assert!(review(dialect, [(select, 1, 1)]).risks.is_empty());
        }
        let block = review(Dialect::Oracle, [("<<job>>\nBEGIN\n  NULL;\nEND;", 7, 1)]);
        assert_eq!(block.risks[0].line, 8);
        assert_eq!(block.risks[0].kind, RiskKind::Opaque);
        let report = review(mysql, [(sql, 1, 1)]);
        assert!(!serde_json::to_string(&report).unwrap().contains("secret"));
        assert!(report.require_production_confirmation("PROD", "").is_err());
        assert!(report
            .require_production_confirmation("PROD", "PROD")
            .is_ok());
        assert!(report.require_production_confirmation("DEV", "").is_ok());
    }
}
