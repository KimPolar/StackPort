//! Read only the catalog fields needed by the SQLite editor.

use crate::{db_error, open_schema_db, Result, Store};
use rusqlite::params;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct SqlCompletionCatalog {
    relations: Vec<Relation>,
    columns: Vec<RelationColumns>,
    functions: Vec<String>,
}

#[derive(Serialize)]
struct Relation {
    name: String,
    kind: String,
}

#[derive(Serialize)]
struct RelationColumns {
    relation: String,
    names: Vec<String>,
}

impl Store {
    pub fn sql_completion_catalog(
        &self,
        profile_id: &str,
        prefix: &str,
        sources: Vec<String>,
    ) -> Result<SqlCompletionCatalog> {
        if prefix.len() > 4096
            || prefix.contains('\0')
            || sources.len() > 12
            || sources
                .iter()
                .any(|source| source.len() > 4096 || source.contains('\0'))
        {
            return Err("SQL 자동완성에 사용할 이름이 너무 길거나 항목이 너무 많습니다.".into());
        }
        let db = open_schema_db(Path::new(&self.profile(profile_id)?.path))?;
        let mut names = db.prepare(
            "SELECT name, type FROM main.sqlite_schema WHERE type IN ('table', 'view')
             AND substr(name, 1, 7) <> 'sqlite_' COLLATE NOCASE
             AND substr(name, 1, length(?1)) = ?1 COLLATE NOCASE ORDER BY name COLLATE NOCASE, name LIMIT 40",
        ).map_err(db_error)?;
        let relations = names
            .query_map([prefix], |row| {
                Ok(Relation {
                    name: row.get(0)?,
                    kind: row.get(1)?,
                })
            })
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;

        let mut fields = db.prepare(
            "SELECT x.name FROM main.sqlite_schema AS s JOIN pragma_table_xinfo(s.name, 'main') AS x
             WHERE s.name = ?1 COLLATE NOCASE AND s.type IN ('table', 'view')
             AND substr(s.name, 1, 7) <> 'sqlite_' COLLATE NOCASE AND x.hidden <> 1
             AND substr(x.name, 1, length(?2)) = ?2 COLLATE NOCASE ORDER BY x.name COLLATE NOCASE, x.cid LIMIT 40",
        ).map_err(db_error)?;
        let mut columns = Vec::new();
        for relation in sources {
            // A broken view can fail introspection while other relations remain usable.
            let names = fields
                .query_map(params![relation, prefix], |row| row.get(0))
                .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
            if let Ok(names) = names {
                columns.push(RelationColumns { relation, names });
            }
        }
        let mut routines = db
            .prepare(
                "SELECT DISTINCT name FROM pragma_function_list WHERE builtin = 1
             AND name NOT IN ('load_extension', 'current_date', 'current_time', 'current_timestamp')
             AND substr(name, 1, length(?1)) = ?1 COLLATE NOCASE
             ORDER BY name COLLATE NOCASE, name LIMIT 40",
            )
            .map_err(db_error)?;
        let functions = routines
            .query_map([prefix], |row| row.get(0))
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        Ok(SqlCompletionCatalog {
            relations,
            columns,
            functions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn lists_only_current_main_relations_columns_and_allowed_builtin_functions() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Store::open(directory.path().join("workspace.sqlite")).unwrap();
        let project = workspace.create_project("test").unwrap();
        let path = directory.path().join("user.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, generated AS (length(name)));
             CREATE VIEW people_view AS SELECT name FROM people;
             CREATE VIEW broken AS SELECT * FROM unavailable;",
        ).unwrap();
        let profile = workspace
            .create_sqlite_profile(&project.id, "dev", path.to_str().unwrap(), "DEV")
            .unwrap();
        let empty = workspace
            .sql_completion_catalog(
                &profile.id,
                "",
                vec![
                    "PEOPLE".into(),
                    "people_view".into(),
                    "broken".into(),
                    "sqlite_sequence".into(),
                ],
            )
            .unwrap();
        assert!(empty
            .relations
            .iter()
            .any(|item| item.name == "people_view" && item.kind == "view"));
        assert!(empty
            .relations
            .iter()
            .all(|item| !item.name.starts_with("sqlite_")));
        assert_eq!(
            empty
                .columns
                .iter()
                .find(|item| item.relation == "PEOPLE")
                .unwrap()
                .names,
            ["generated", "id", "name"]
        );
        assert_eq!(
            empty
                .columns
                .iter()
                .find(|item| item.relation == "people_view")
                .unwrap()
                .names,
            ["name"]
        );
        assert!(empty
            .columns
            .iter()
            .all(|item| item.relation != "sqlite_sequence" || item.names.is_empty()));
        let found = workspace
            .sql_completion_catalog(&profile.id, "COU", vec![])
            .unwrap();
        assert!(found.functions.contains(&"count".into()));
        assert!(workspace
            .sql_completion_catalog(&profile.id, "load_", vec![])
            .unwrap()
            .functions
            .is_empty());
        assert!(workspace
            .query(&profile.id, "SELECT * FROM pragma_function_list", 0)
            .is_err());
    }
}
