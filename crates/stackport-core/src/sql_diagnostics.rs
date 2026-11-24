//! Prepare read-only SQLite statements without stepping them or saving the SQL.

use crate::{
    db_error, open_user_db,
    sql_statement::{statement_ranges, token_end_at},
    Result, Store,
};
use rusqlite::{Error, ErrorCode};
use serde::Serialize;
use std::{
    path::Path,
    time::{Duration, Instant},
};

const MAX_SQL_BYTES: usize = 256 * 1024;
const MAX_STATEMENTS: usize = 32;
const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SqlDiagnostics {
    Report {
        checked: usize,
        partial: bool,
        issues: Vec<Diagnostic>,
    },
    TooLarge,
}

#[derive(Serialize)]
pub struct Diagnostic {
    kind: Kind,
    message: String,
    start: usize,
    end: usize,
    line: usize,
    column: usize,
    precise: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Syntax,
    Object,
    Type,
    Policy,
    Sqlite,
}

impl Store {
    pub fn diagnose_sql(&self, profile_id: &str, sql: &str) -> Result<SqlDiagnostics> {
        if sql.len() > MAX_SQL_BYTES {
            return Ok(SqlDiagnostics::TooLarge);
        }
        if let Some(start) = sql.find('\0') {
            let issue = diagnostic(
                sql,
                Kind::Syntax,
                "NUL 문자가 있는 SQL은 사용할 수 없습니다.",
                start,
                start + 1,
                true,
            );
            return Ok(SqlDiagnostics::Report {
                checked: 0,
                partial: false,
                issues: vec![issue],
            });
        }
        let mut ranges = statement_ranges(sql).peekable();
        if ranges.peek().is_none() {
            return Ok(SqlDiagnostics::Report {
                checked: 0,
                partial: false,
                issues: Vec::new(),
            });
        }
        let db = open_user_db(Path::new(&self.profile(profile_id)?.path))?;
        db.busy_timeout(Duration::from_millis(200))
            .map_err(db_error)?;
        let started = Instant::now();
        db.progress_handler(1_000, Some(move || started.elapsed() >= DIAGNOSTIC_TIMEOUT));
        let mut checked = 0;
        let mut issues = Vec::new();
        for range in ranges {
            if checked == MAX_STATEMENTS || started.elapsed() >= DIAGNOSTIC_TIMEOUT {
                return Ok(SqlDiagnostics::Report {
                    checked,
                    partial: true,
                    issues,
                });
            }
            let statement = &sql[range.clone()];
            match db.prepare(statement) {
                Ok(prepared) if prepared.readonly() && prepared.column_count() > 0 => {}
                Ok(_) => issues.push(diagnostic(
                    sql,
                    Kind::Policy,
                    READ_ONLY,
                    range.start,
                    range.start,
                    false,
                )),
                Err(error)
                    if error.sqlite_error_code() == Some(ErrorCode::OperationInterrupted) =>
                {
                    return Ok(SqlDiagnostics::Report {
                        checked,
                        partial: true,
                        issues,
                    });
                }
                Err(error)
                    if matches!(
                        error.sqlite_error_code(),
                        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
                    ) =>
                {
                    return Err(
                        "SQLite 데이터베이스가 사용 중입니다. 잠시 후 다시 검사하세요.".into(),
                    );
                }
                Err(error) => issues.push(from_sqlite_error(sql, statement, range.start, error)),
            }
            checked += 1;
        }
        Ok(SqlDiagnostics::Report {
            checked,
            partial: false,
            issues,
        })
    }
}

const READ_ONLY: &str = "이 연결에서는 읽기 전용 쿼리만 실행할 수 있습니다.";

fn from_sqlite_error(sql: &str, statement: &str, offset: usize, error: Error) -> Diagnostic {
    let code = error.sqlite_error_code();
    let (message, token) = match error {
        Error::SqlInputError { msg, offset, .. } => (msg, usize::try_from(offset).ok()),
        Error::SqliteFailure(_, Some(msg)) => (msg, None),
        other => (other.to_string(), None),
    };
    let kind = if matches!(
        code,
        Some(ErrorCode::AuthorizationForStatementDenied | ErrorCode::ReadOnly)
    ) || message.starts_with("not authorized")
    {
        Kind::Policy
    } else if code == Some(ErrorCode::TypeMismatch) || message.starts_with("datatype mismatch") {
        Kind::Type
    } else if [
        "no such table:",
        "no such column:",
        "no such function:",
        "no such index:",
        "ambiguous column name:",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
    {
        Kind::Object
    } else if message.contains("syntax error")
        || message == "incomplete input"
        || message.starts_with("unrecognized token:")
    {
        Kind::Syntax
    } else {
        Kind::Sqlite
    };
    let message = if matches!(kind, Kind::Policy) {
        READ_ONLY
    } else {
        &message
    };
    let token = token.filter(|&start| statement.is_char_boundary(start));
    let (start, end, precise) = match token {
        Some(start) => (
            offset + start,
            offset + token_end_at(statement, start),
            true,
        ),
        None => (offset, offset, false),
    };
    diagnostic(sql, kind, message, start, end, precise)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn diagnoses_multiple_statements_with_utf16_ranges_and_never_steps_them() {
        let directory = tempfile::tempdir().unwrap();
        let workspace_path = directory.path().join("workspace.sqlite");
        let store = Store::open(&workspace_path).unwrap();
        let project = store.create_project("test").unwrap();
        let path = directory.path().join("user.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE people(name TEXT); INSERT INTO people VALUES ('untouched');",
        )
        .unwrap();
        let profile = store
            .create_sqlite_profile(&project.id, "dev", path.to_str().unwrap(), "DEV")
            .unwrap();
        let workspace_before = std::fs::read(&workspace_path).unwrap();
        let input = "SELECT '한😀';\nSELECT '한😀', FROM people;\nSELECT absent FROM people;\nSELECT * FROM missing;\nDELETE FROM people;\nSELECT abs(-9223372036854775808);";
        let SqlDiagnostics::Report {
            checked,
            partial,
            issues,
        } = store.diagnose_sql(&profile.id, input).unwrap()
        else {
            panic!("expected report")
        };
        assert_eq!(checked, 6);
        assert!(!partial);
        assert_eq!(issues.len(), 4);
        let syntax = &issues[0];
        assert!(matches!(syntax.kind, Kind::Syntax));
        assert_eq!(syntax.line, 2);
        assert_eq!(syntax.column, 14);
        assert!(syntax.precise);
        assert_eq!(
            String::from_utf16(&input.encode_utf16().collect::<Vec<_>>()[syntax.start..syntax.end])
                .unwrap(),
            "FROM"
        );
        assert!(matches!(issues[1].kind, Kind::Object));
        assert!(matches!(issues[2].kind, Kind::Object));
        assert!(matches!(issues[3].kind, Kind::Policy));
        let value: String = db
            .query_row("SELECT name FROM people", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "untouched");
        let SqlDiagnostics::Report { issues, .. } = store
            .diagnose_sql(
                &profile.id,
                "PRAGMA user_version = 42; SELECT load_extension('fixture');",
            )
            .unwrap()
        else {
            panic!("expected report")
        };
        assert_eq!(issues.len(), 2);
        assert!(issues
            .iter()
            .all(|issue| matches!(issue.kind, Kind::Policy)));
        assert_eq!(
            db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(std::fs::read(&workspace_path).unwrap(), workspace_before);
        assert!(matches!(
            store
                .diagnose_sql(&profile.id, &"SELECT 1;".repeat(33))
                .unwrap(),
            SqlDiagnostics::Report {
                checked: 32,
                partial: true,
                ..
            }
        ));
        assert!(matches!(
            store
                .diagnose_sql(&profile.id, &"한".repeat(MAX_SQL_BYTES / 2))
                .unwrap(),
            SqlDiagnostics::TooLarge
        ));
    }
}

fn diagnostic(
    sql: &str,
    kind: Kind,
    message: &str,
    start: usize,
    end: usize,
    precise: bool,
) -> Diagnostic {
    let prefix = &sql[..start];
    let start = prefix.encode_utf16().count();
    let end = start + sql[prefix.len()..end].encode_utf16().count();
    let line = prefix.bytes().filter(|&byte| byte == b'\n').count() + 1;
    let column = prefix
        .rsplit('\n')
        .next()
        .unwrap_or_default()
        .chars()
        .count()
        + 1;
    Diagnostic {
        kind,
        message: message.chars().take(600).collect(),
        start,
        end,
        line,
        column,
        precise,
    }
}
