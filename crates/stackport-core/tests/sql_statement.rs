use rusqlite::Connection;
use stackport_core::sqlite_statement_at;

fn utf16_at(sql: &str, needle: &str) -> usize {
    sql[..sql.find(needle).unwrap()].encode_utf16().count()
}

#[test]
fn ignores_comments_and_quoted_semicolons_and_uses_utf16_caret_offsets() {
    let sql = "SELECT * FROM unknown;\n-- only a comment ;\n\n\u{feff}SELECT '한😀; ''quoted''', 1 AS \"a;b\", 2 AS [c;d], 3 AS `e;``f` /* ; */;\nSELECT 9";
    let statement = "SELECT '한😀; ''quoted''', 1 AS \"a;b\", 2 AS [c;d], 3 AS `e;``f` /* ; */;";
    assert_eq!(
        sqlite_statement_at(sql, utf16_at(sql, "quoted")).unwrap(),
        Some(statement)
    );
    assert_eq!(
        sqlite_statement_at(sql, utf16_at(sql, "only a comment")).unwrap(),
        None
    );
    assert_eq!(
        sqlite_statement_at(sql, sql.encode_utf16().count()).unwrap(),
        Some("SELECT 9")
    );
    let db = Connection::open_in_memory().unwrap();
    let value: String = db.query_row(statement, [], |row| row.get(0)).unwrap();
    assert_eq!(value, "한😀; 'quoted'");
}

#[test]
fn keeps_trigger_blocks_and_sqlite_parameter_suffixes_together() {
    let trigger = concat!(
        "CREATE TEMP TRIGGER t AFTER INSERT ON numbers BEGIN\n",
        "    SELECT CASE WHEN new.n > 1 THEN ';' END;\n",
        "    SELECT 2; /* internal ; */\n",
        "END;",
    );
    let parameter = "SELECT $scope::key(a;b);";
    let sql = format!("{trigger}\n{parameter}\nSELECT 3;");
    for marker in ["CASE", "SELECT 2", "END;\n"] {
        assert_eq!(
            sqlite_statement_at(&sql, utf16_at(&sql, marker)).unwrap(),
            Some(trigger)
        );
    }
    assert_eq!(
        sqlite_statement_at(&sql, utf16_at(&sql, "b)")).unwrap(),
        Some(parameter)
    );
    assert_eq!(
        sqlite_statement_at(&sql, utf16_at(&sql, "SELECT 3")).unwrap(),
        Some("SELECT 3;")
    );
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE numbers(n INTEGER);")
        .unwrap();
    db.execute_batch(trigger).unwrap();
    let value: i64 = db.query_row(parameter, [42], |row| row.get(0)).unwrap();
    assert_eq!(value, 42);

    let explain = format!("EXPLAIN QUERY PLAN {trigger}\nSELECT 8;");
    assert_eq!(
        sqlite_statement_at(&explain, utf16_at(&explain, "SELECT 2")).unwrap(),
        Some(&explain[..explain.len() - "\nSELECT 8;".len()]),
    );
}

#[test]
fn handles_adjacent_statements_empty_input_and_invalid_carets() {
    let sql = "SELECT 1;SELECT 2;\n\n-- done";
    assert_eq!(sqlite_statement_at(sql, 9).unwrap(), Some("SELECT 2;"));
    assert_eq!(sqlite_statement_at(sql, 18).unwrap(), Some("SELECT 2;"));
    assert_eq!(sqlite_statement_at(sql, 19).unwrap(), None);
    assert_eq!(sqlite_statement_at(";; -- note", 1).unwrap(), None);
    assert_eq!(sqlite_statement_at("/* only comments", 0).unwrap(), None);
    assert_eq!(
        sqlite_statement_at("SELECT 'not finished", 12).unwrap(),
        Some("SELECT 'not finished")
    );
    assert!(sqlite_statement_at("SELECT 1\0;", 0).is_err());
    assert!(sqlite_statement_at("SELECT '😀'", 12).is_err());
}
