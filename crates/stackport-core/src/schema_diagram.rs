use super::{db_error, open_schema_db, ForeignKeyInfo, Result, Store};
use serde::Serialize;
use std::path::Path;

const TABLE_LIMIT: usize = 512;
const FIELD_LIMIT: usize = 30_000;

#[derive(Debug, Serialize)]
pub struct DiagramColumn {
    pub name: String,
    pub declared_type: String,
    pub primary_key_position: i64,
}

#[derive(Debug, Serialize)]
pub struct DiagramTable {
    pub name: String,
    pub columns: Vec<DiagramColumn>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
}

impl Store {
    pub fn schema_diagram(&self, profile_id: &str) -> Result<Vec<DiagramTable>> {
        let profile = self.profile(profile_id)?;
        let db = open_schema_db(Path::new(&profile.path))?;
        let mut names = db
            .prepare(
                "SELECT name FROM pragma_table_list
             WHERE schema = 'main' AND type IN ('table', 'virtual')
               AND substr(name, 1, 7) <> 'sqlite_' COLLATE NOCASE
             ORDER BY name COLLATE NOCASE LIMIT ?1",
            )
            .map_err(db_error)?;
        let names = names
            .query_map([TABLE_LIMIT + 1], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        if names.len() > TABLE_LIMIT {
            return Err(format!(
                "관계도는 테이블을 최대 {TABLE_LIMIT}개까지 열 수 있습니다."
            ));
        }

        let mut fields = db
            .prepare(
                "SELECT name, type, pk FROM pragma_table_xinfo(?1, 'main')
             WHERE hidden <> 1 ORDER BY cid LIMIT ?2",
            )
            .map_err(db_error)?;
        let mut remaining = FIELD_LIMIT;
        let mut tables = Vec::with_capacity(names.len());
        for name in names {
            let columns = fields
                .query_map(rusqlite::params![name, remaining + 1], |row| {
                    Ok(DiagramColumn {
                        name: row.get(0)?,
                        declared_type: row.get(1)?,
                        primary_key_position: row.get(2)?,
                    })
                })
                .map_err(db_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(db_error)?;
            remaining = remaining.checked_sub(columns.len()).ok_or_else(|| {
                "관계도로 표시할 수 있는 열과 외래 키의 합계를 초과했습니다.".to_owned()
            })?;
            let foreign_keys = Self::object_foreign_keys(&db, &name, (remaining + 1) as i64)?;
            remaining = remaining.checked_sub(foreign_keys.len()).ok_or_else(|| {
                "관계도로 표시할 수 있는 열과 외래 키의 합계를 초과했습니다.".to_owned()
            })?;
            tables.push(DiagramTable {
                name,
                columns,
                foreign_keys,
            });
        }
        Ok(tables)
    }
}
