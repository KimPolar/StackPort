use rusqlite::Connection;

pub fn restore_legacy_preset_schema(db: &Connection, has_mysql: bool) {
    let (mysql_column, mysql_value) = if has_mysql {
        ("mysql_id TEXT REFERENCES mysql_profiles(id) ON DELETE CASCADE,", "mysql_id,")
    } else {
        ("", "")
    };
    db.execute_batch(&format!(
        "ALTER TABLE table_query_presets RENAME TO current_presets;
         CREATE TABLE table_query_presets (
            id TEXT PRIMARY KEY,
            sqlite_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
            postgres_id TEXT REFERENCES postgres_profiles(id) ON DELETE CASCADE,
            {mysql_column}
            target_key TEXT NOT NULL, schema_name TEXT NOT NULL, object_name TEXT NOT NULL,
            name TEXT NOT NULL COLLATE NOCASE, clauses TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0)
         );
         INSERT INTO table_query_presets
            SELECT id, sqlite_id, postgres_id, {mysql_value} target_key,
                   schema_name, object_name, name, clauses, revision FROM current_presets;
         DROP TABLE current_presets;"
    ))
    .unwrap();
}
