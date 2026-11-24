use crate::{db_error, open_user_db, sql_statement::statement_ranges, Result, Store};
use rusqlite::{Connection, Statement};
use std::{
    path::Path,
    time::{Duration, Instant},
};

const MAX_SQL_BYTES: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_millis(750);

impl Store {
    pub fn validate_sql_alias_rename(
        &self,
        profile_id: &str,
        original: &str,
        changed: &str,
    ) -> Result<()> {
        let original = single_statement(original)?;
        let changed = single_statement(changed)?;
        let db = open_user_db(Path::new(&self.profile(profile_id)?.path))?;
        db.busy_timeout(Duration::from_millis(200))
            .map_err(db_error)?;
        validate(&db, original, changed)
    }
}

fn single_statement(sql: &str) -> Result<&str> {
    if sql.len() > MAX_SQL_BYTES || sql.contains('\0') {
        return Err("별칭 변경은 UTF-8로 256 KiB 이하의 SQL을 지원합니다.".into());
    }
    let mut ranges = statement_ranges(sql);
    match (ranges.next(), ranges.next()) {
        (Some(range), None) => Ok(&sql[range]),
        _ => Err("별칭을 변경할 SQL 문장 하나가 필요합니다.".into()),
    }
}

fn prepare_query<'db>(db: &'db Connection, sql: &str) -> Result<Statement<'db>> {
    let query = db.prepare(sql).map_err(db_error)?;
    if !query.readonly() || query.is_explain() != 0 || query.column_count() == 0 {
        return Err("별칭 변경 확인에는 결과 열이 있는 읽기 전용 SQL이 필요합니다.".into());
    }
    Ok(query)
}

fn validate(db: &Connection, original: &str, changed: &str) -> Result<()> {
    let start = Instant::now();
    db.progress_handler(1_000, Some(move || start.elapsed() >= TIMEOUT));
    {
        let before = prepare_query(db, original)?;
        let after = prepare_query(db, changed)?;
        if before.column_names() != after.column_names() {
            return Err("별칭을 변경하면 결과 열 이름이 바뀝니다. 해당 식에 열 이름을 지정하고 다시 시도하세요.".into());
        }
    }
    // EXPLAIN emits the program for comparison without evaluating the query.
    let mut before = db
        .prepare(&format!("EXPLAIN {original}"))
        .map_err(db_error)?;
    let mut after = db
        .prepare(&format!("EXPLAIN {changed}"))
        .map_err(db_error)?;
    let columns = before.column_names();
    if before.is_explain() != 1 || after.is_explain() != 1 || columns != after.column_names() {
        return Err("SQLite에서 두 쿼리의 참조를 비교할 수 없습니다.".into());
    }
    // Compare the output of the same SQLite build, ignoring optional debug comments.
    let operands = columns
        .iter()
        .enumerate()
        .filter_map(|(index, name)| (*name != "comment").then_some(index))
        .collect::<Vec<_>>();
    let mut before = before.raw_query();
    let mut after = after.raw_query();
    loop {
        if start.elapsed() >= TIMEOUT {
            return Err("별칭 변경 확인 시간이 초과되었습니다.".into());
        }
        match (
            before.next().map_err(db_error)?,
            after.next().map_err(db_error)?,
        ) {
            (None, None) => return Ok(()),
            (Some(left), Some(right)) => {
                for &index in &operands {
                    if left.get_ref(index).map_err(db_error)?
                        != right.get_ref(index).map_err(db_error)?
                    {
                        return Err(
                            "SQLite에서 변경 전후의 참조가 같은지 확인할 수 없습니다.".into()
                        );
                    }
                }
            }
            _ => return Err("SQLite에서 변경 전후의 참조가 같은지 확인할 수 없습니다.".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_resolved_queries_without_evaluating_them() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE people(id, name); CREATE TABLE teams(id, name);")
            .unwrap();
        assert!(validate(
            &db,
            "SELECT p.id, abs(?1) FROM people AS p WHERE EXISTS (SELECT 1 FROM teams AS t WHERE t.id = p.id)",
            "SELECT \"담당자\".id, abs(?1) FROM people AS \"담당자\" WHERE EXISTS (SELECT 1 FROM teams AS t WHERE t.id = \"담당자\".id)",
        ).is_ok());
        assert!(validate(
            &db,
            "SELECT p.id + 1 FROM people p",
            "SELECT renamed.id + 1 FROM people renamed"
        )
        .unwrap_err()
        .contains("결과 열 이름"));
        assert!(validate(
            &db,
            "SELECT (SELECT p.id FROM teams t) AS id FROM people p",
            "SELECT (SELECT t.id FROM teams t) AS id FROM people p",
        )
        .is_err());
        assert!(validate(
            &db,
            "SELECT abs(-9223372036854775808)",
            "SELECT abs(-9223372036854775808)"
        )
        .is_ok());
        assert!(single_statement("SELECT 1; SELECT 2;").is_err());
    }
}
