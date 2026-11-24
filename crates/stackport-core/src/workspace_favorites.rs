use crate::{db_error, open_user_db, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub(crate) const SCHEMA: &str = "CREATE TABLE workspace_favorites (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK(scope IN ('personal', 'project')),
    kind TEXT NOT NULL,
    sqlite_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
    postgres_id TEXT REFERENCES postgres_profiles(id) ON DELETE CASCADE,
    ssh_id TEXT REFERENCES ssh_profiles(id) ON DELETE CASCADE,
    object_name TEXT NOT NULL DEFAULT '',
    CHECK ((sqlite_id IS NOT NULL) + (postgres_id IS NOT NULL) + (ssh_id IS NOT NULL) = 1),
    CHECK ((kind IN ('sqlite', 'sqlite_object') AND sqlite_id IS NOT NULL)
        OR (kind = 'postgres' AND postgres_id IS NOT NULL)
        OR (kind = 'ssh' AND ssh_id IS NOT NULL)),
    CHECK (kind = 'sqlite_object' OR object_name = ''),
    UNIQUE (project_id, scope, kind, sqlite_id, object_name),
    UNIQUE (project_id, scope, kind, postgres_id, object_name),
    UNIQUE (project_id, scope, kind, ssh_id, object_name)
);
CREATE INDEX workspace_favorite_sqlite_ref ON workspace_favorites(sqlite_id);
CREATE INDEX workspace_favorite_postgres_ref ON workspace_favorites(postgres_id);
CREATE INDEX workspace_favorite_ssh_ref ON workspace_favorites(ssh_id);";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FavoriteScope {
    Personal,
    Project,
}

impl FavoriteScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Project => "project",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FavoriteTarget {
    Sqlite {
        profile_id: String,
    },
    SqliteObject {
        profile_id: String,
        object_name: String,
    },
    Postgres {
        profile_id: String,
    },
    Ssh {
        profile_id: String,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct WorkspaceFavorite {
    pub scope: FavoriteScope,
    pub target: FavoriteTarget,
}

impl FavoriteTarget {
    fn identity(&self) -> (&'static str, &str, &str) {
        match self {
            Self::Sqlite { profile_id } => ("sqlite", profile_id, ""),
            Self::SqliteObject {
                profile_id,
                object_name,
            } => ("sqlite_object", profile_id, object_name),
            Self::Postgres { profile_id } => ("postgres", profile_id, ""),
            Self::Ssh { profile_id } => ("ssh", profile_id, ""),
        }
    }

    fn verify(&self, db: &Connection, project: &str) -> Result<()> {
        let (_, profile_id, _) = self.identity();
        let sql = match self {
            Self::Sqlite { .. } | Self::SqliteObject { .. } => {
                "SELECT path FROM profiles WHERE id = ?1 AND project_id = ?2"
            }
            Self::Postgres { .. } => {
                "SELECT '' FROM postgres_profiles WHERE id = ?1 AND project_id = ?2"
            }
            Self::Ssh { .. } => "SELECT '' FROM ssh_profiles WHERE id = ?1 AND project_id = ?2",
        };
        let path: String = db
            .query_row(sql, params![profile_id, project], |row| row.get(0))
            .optional()
            .map_err(db_error)?
            .ok_or("이 프로젝트의 즐겨찾기 대상 연결을 찾을 수 없습니다.")?;
        if let Self::SqliteObject { object_name, .. } = self {
            let user_db = open_user_db(Path::new(&path))?;
            let exists: bool = user_db
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM main.sqlite_schema
                  WHERE name = ?1 AND type IN ('table', 'view')
                    AND substr(name, 1, 7) <> 'sqlite_' COLLATE NOCASE)",
                    [object_name],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            if !exists {
                return Err("즐겨찾기에 추가할 SQLite 테이블 또는 뷰를 찾을 수 없습니다.".into());
            }
        }
        Ok(())
    }
}

fn active_project(db: &Connection, project: &str) -> Result<()> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM project_archives WHERE project_id = ?1))",
            [project],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !exists {
        return Err("활성 프로젝트를 찾을 수 없습니다.".into());
    }
    Ok(())
}

impl Store {
    pub fn list_workspace_favorites(&self, project_id: &str) -> Result<Vec<WorkspaceFavorite>> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        active_project(&tx, project_id)?;
        let mut statement = tx
            .prepare(
                "SELECT scope, kind, COALESCE(sqlite_id, postgres_id, ssh_id), object_name
             FROM workspace_favorites WHERE project_id = ?1 ORDER BY rowid",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get(2)?,
                    row.get(3)?,
                ))
            })
            .map_err(db_error)?;
        rows.map(|row| {
            let (scope, kind, profile_id, object_name) = row.map_err(db_error)?;
            let scope = match scope.as_str() {
                "personal" => FavoriteScope::Personal,
                "project" => FavoriteScope::Project,
                _ => return Err("저장된 즐겨찾기 범위를 확인할 수 없습니다.".into()),
            };
            let target = match kind.as_str() {
                "sqlite" => FavoriteTarget::Sqlite { profile_id },
                "sqlite_object" => FavoriteTarget::SqliteObject {
                    profile_id,
                    object_name,
                },
                "postgres" => FavoriteTarget::Postgres { profile_id },
                "ssh" => FavoriteTarget::Ssh { profile_id },
                _ => return Err("저장된 즐겨찾기 대상을 확인할 수 없습니다.".into()),
            };
            Ok(WorkspaceFavorite { scope, target })
        })
        .collect()
    }

    pub fn set_workspace_favorite(
        &self,
        project_id: &str,
        scope: FavoriteScope,
        target: &FavoriteTarget,
        present: bool,
    ) -> Result<()> {
        let (kind, profile_id, object_name) = target.identity();
        if object_name.len() > 16 * 1024 || object_name.contains('\0') {
            return Err("즐겨찾기 객체 이름을 확인하세요.".into());
        }
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        active_project(&tx, project_id)?;
        if present {
            let (sqlite_id, postgres_id, ssh_id) = match target {
                FavoriteTarget::Sqlite { .. } | FavoriteTarget::SqliteObject { .. } => {
                    (Some(profile_id), None, None)
                }
                FavoriteTarget::Postgres { .. } => (None, Some(profile_id), None),
                FavoriteTarget::Ssh { .. } => (None, None, Some(profile_id)),
            };
            let exists: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM workspace_favorites WHERE project_id = ?1 AND scope = ?2 AND kind = ?3
                 AND COALESCE(sqlite_id, postgres_id, ssh_id) = ?4 AND object_name = ?5)",
                params![project_id, scope.as_str(), kind, profile_id, object_name], |row| row.get(0),
            ).map_err(db_error)?;
            if !exists {
                target.verify(&tx, project_id)?;
                tx.execute(
                    "INSERT INTO workspace_favorites(project_id, scope, kind, sqlite_id, postgres_id, ssh_id, object_name)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![project_id, scope.as_str(), kind, sqlite_id, postgres_id, ssh_id, object_name],
                ).map_err(db_error)?;
            }
        } else {
            tx.execute(
                "DELETE FROM workspace_favorites WHERE project_id = ?1 AND scope = ?2 AND kind = ?3
                 AND COALESCE(sqlite_id, postgres_id, ssh_id) = ?4 AND object_name = ?5",
                params![project_id, scope.as_str(), kind, profile_id, object_name],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    }
}

pub(crate) fn copy_project_favorites(
    db: &Connection,
    source: &str,
    destination: &str,
    from_profile: &str,
    to_profile: &str,
) -> Result<usize> {
    db.execute(
        "INSERT INTO workspace_favorites(project_id, scope, kind, sqlite_id, postgres_id, ssh_id, object_name)
         SELECT ?2, scope, kind,
                CASE WHEN sqlite_id IS NOT NULL THEN ?4 END,
                CASE WHEN postgres_id IS NOT NULL THEN ?4 END,
                CASE WHEN ssh_id IS NOT NULL THEN ?4 END, object_name
         FROM workspace_favorites WHERE project_id = ?1 AND scope = 'project'
         AND COALESCE(sqlite_id, postgres_id, ssh_id) = ?3",
        params![source, destination, from_profile, to_profile],
    ).map_err(db_error)
}
