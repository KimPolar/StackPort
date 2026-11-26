use super::{run_from_row, BackupRun, RUN_COLUMNS, RUN_TABLES};
use crate::{db_error, Project, Result, Store};
use rusqlite::params;
use serde::{Deserialize, Serialize};

const PAGE_SIZE: usize = 40;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupHistoryFilter {
    project_id: Option<String>,
    status: Option<String>,
    trigger_kind: Option<String>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct BackupHistoryCursor {
    started_at: i64,
    rowid: i64,
}

#[derive(Serialize)]
pub struct BackupHistoryPage {
    entries: Vec<BackupHistoryEntry>,
    projects: Vec<HistoryProject>,
    next_before: Option<BackupHistoryCursor>,
}

#[derive(Serialize)]
struct HistoryProject {
    #[serde(flatten)]
    project: Project,
    archived: bool,
}

#[derive(Serialize)]
struct BackupHistoryEntry {
    #[serde(flatten)]
    run: BackupRun,
    project_id: String,
    project_name: String,
    profile_name: String,
    archived: bool,
}

impl Store {
    pub fn list_backup_history(
        &self,
        filter: BackupHistoryFilter,
        before: Option<BackupHistoryCursor>,
    ) -> Result<BackupHistoryPage> {
        if filter.status.as_deref().is_some_and(|status| {
            !matches!(
                status,
                "running"
                    | "succeeded"
                    | "failed"
                    | "interrupted"
                    | "cancelled"
                    | "timed_out"
                    | "skipped"
            )
        }) || filter
            .trigger_kind
            .as_deref()
            .is_some_and(|kind| !matches!(kind, "manual" | "scheduled" | "retry"))
        {
            return Err("유효하지 않은 백업 기록 필터입니다.".into());
        }
        if before.is_some_and(|cursor| cursor.rowid <= 0 || cursor.started_at < 0) {
            return Err("유효하지 않은 백업 기록 위치입니다.".into());
        }
        let workspace = self.backup_workspace_path()?;
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        let mut entries = {
            let mut query = tx.prepare(&format!(
                "SELECT {RUN_COLUMNS}, project.id, project.name, coalesce(s.name, pg.name), archive.project_id IS NOT NULL
                 {RUN_TABLES}
                 LEFT JOIN profiles s ON s.id=p.sqlite_profile_id
                 LEFT JOIN postgres_profiles pg ON pg.id=p.postgres_profile_id
                 JOIN projects project ON project.id=coalesce(s.project_id, pg.project_id)
                 LEFT JOIN project_archives archive ON archive.project_id=project.id
                 WHERE r.workspace_path=?2 AND (?1 IS NULL OR project.id=?1)
                 AND (?3 IS NULL OR r.status=?3) AND (?4 IS NULL OR r.trigger_kind=?4)
                 AND (?5 IS NULL OR (r.started_at, r.rowid) < (?5, ?6))
                 ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?7"
            )).map_err(db_error)?;
            let rows = query
                .query_map(
                    params![
                        filter.project_id,
                        workspace,
                        filter.status,
                        filter.trigger_kind,
                        before.map(|cursor| cursor.started_at),
                        before.map(|cursor| cursor.rowid),
                        (PAGE_SIZE + 1) as i64
                    ],
                    |row| {
                        let run = run_from_row(row)?;
                        let cursor = BackupHistoryCursor {
                            started_at: run.started_at,
                            rowid: row.get(17)?,
                        };
                        Ok((
                            cursor,
                            BackupHistoryEntry {
                                run,
                                project_id: row.get(21)?,
                                project_name: row.get(22)?,
                                profile_name: row.get(23)?,
                                archived: row.get(24)?,
                            },
                        ))
                    },
                )
                .map_err(db_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(db_error)?
        };
        let next_before = if entries.len() > PAGE_SIZE {
            entries.pop();
            entries.last().map(|(cursor, _)| *cursor)
        } else {
            None
        };
        let projects = {
            let mut query = tx
                .prepare(
                    "SELECT p.id, p.name, a.project_id IS NOT NULL
                 FROM projects p LEFT JOIN project_archives a ON a.project_id=p.id
                 ORDER BY p.name COLLATE NOCASE, p.id",
                )
                .map_err(db_error)?;
            let rows = query
                .query_map([], |row| {
                    Ok(HistoryProject {
                        project: Project {
                            id: row.get(0)?,
                            name: row.get(1)?,
                        },
                        archived: row.get(2)?,
                    })
                })
                .map_err(db_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(db_error)?
        };
        tx.commit().map_err(db_error)?;
        Ok(BackupHistoryPage {
            entries: entries.into_iter().map(|(_, run)| run).collect(),
            projects,
            next_before,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PostgresProfileInput;

    #[test]
    fn history_filters_both_engines_and_pages_tied_start_times_by_workspace() {
        let fixture = tempfile::tempdir().unwrap();
        let store = Store::open(fixture.path().join("workspace.sqlite")).unwrap();
        let sqlite_project = store.create_project("로컬 프로젝트").unwrap();
        let postgres_project = store.create_project("서버 프로젝트").unwrap();
        let source = fixture.path().join("source.sqlite");
        rusqlite::Connection::open(&source)
            .unwrap()
            .execute_batch("CREATE TABLE fixture(id INTEGER PRIMARY KEY);")
            .unwrap();
        let sqlite = store
            .create_sqlite_profile(
                &sqlite_project.id,
                "SQLite 테스트",
                source.to_str().unwrap(),
                "DEV",
            )
            .unwrap();
        let postgres = store
            .create_postgres_profile(
                &postgres_project.id,
                PostgresProfileInput {
                    name: "PostgreSQL 테스트".into(),
                    host: "localhost".into(),
                    port: 5432,
                    database: "postgres".into(),
                    username: "fixture".into(),
                    environment: "DEV".into(),
                    ca_path: None,
                },
            )
            .unwrap();
        let workspace = store.backup_workspace_path().unwrap();
        let db = store.connect().unwrap();
        for (id, sqlite_id, postgres_id, revision) in [
            (sqlite.id.as_str(), Some(sqlite.id.as_str()), None, None),
            (
                postgres.id.as_str(),
                None,
                Some(postgres.id.as_str()),
                Some(postgres.revision),
            ),
        ] {
            db.execute(
                "INSERT INTO backup_plans(profile_id, sqlite_profile_id, postgres_profile_id, postgres_revision,
                    revision, workspace_path, directory, prefix, retention_days, retry_limit)
                 VALUES(?1, ?2, ?3, ?4, 1, ?5, 'fixture', 'fixture', 7, 0)",
                params![id, sqlite_id, postgres_id, revision, workspace],
            ).unwrap();
        }
        db.execute_batch("BEGIN").unwrap();
        for index in 0..83 {
            let (profile, status, trigger) = match index % 3 {
                0 => (&sqlite.id, "skipped", "scheduled"),
                1 => (&postgres.id, "succeeded", "manual"),
                _ => (&postgres.id, "failed", "retry"),
            };
            db.execute(
                "INSERT INTO backup_runs(id, profile_id, workspace_path, trigger_kind, status, started_at, path)
                 VALUES(?1, ?2, ?3, ?4, ?5, 1800000000, '')",
                params![format!("backup-{index}"), profile, workspace, trigger, status],
            ).unwrap();
        }
        db.execute(
            "INSERT INTO backup_runs(id, profile_id, workspace_path, trigger_kind, status, started_at, path)
             VALUES('copied-workspace', ?1, 'different workspace', 'manual', 'succeeded', 1800100000, '')",
            [&sqlite.id],
        ).unwrap();
        db.execute_batch("COMMIT").unwrap();
        store.archive_project(&postgres_project.id).unwrap();

        let first = store
            .list_backup_history(BackupHistoryFilter::default(), None)
            .unwrap();
        assert_eq!(first.entries.len(), PAGE_SIZE);
        assert_eq!(first.entries[0].run.id, "backup-82");
        let archive = first
            .projects
            .iter()
            .find(|item| item.project.id == postgres_project.id)
            .unwrap();
        assert!(archive.archived);
        let second = store
            .list_backup_history(BackupHistoryFilter::default(), first.next_before)
            .unwrap();
        let third = store
            .list_backup_history(BackupHistoryFilter::default(), second.next_before)
            .unwrap();
        assert!(third.next_before.is_none());
        let ids = [first, second, third]
            .into_iter()
            .flat_map(|page| page.entries.into_iter().map(|entry| entry.run.id));
        assert!(ids.eq((0..83).rev().map(|index| format!("backup-{index}"))));

        let selected = store
            .list_backup_history(
                BackupHistoryFilter {
                    project_id: Some(postgres_project.id.clone()),
                    status: Some("failed".into()),
                    trigger_kind: Some("retry".into()),
                },
                None,
            )
            .unwrap();
        assert_eq!(selected.entries.len(), 27);
        assert!(selected
            .entries
            .iter()
            .all(|entry| entry.run.engine == "PostgreSQL"
                && entry.archived
                && entry.profile_name == "PostgreSQL 테스트"
                && entry.project_name == postgres_project.name
                && entry.run.status == "failed"
                && entry.run.retry_attempt == Some(1)));
        let sqlite_only = store
            .list_backup_history(
                BackupHistoryFilter {
                    project_id: Some(sqlite_project.id),
                    status: Some("skipped".into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(sqlite_only.entries.len(), 28);
        assert!(sqlite_only
            .entries
            .iter()
            .all(|entry| entry.run.engine == "SQLite" && !entry.archived));
        assert!(store
            .list_backup_history(
                BackupHistoryFilter {
                    status: Some("invalid".into()),
                    ..Default::default()
                },
                None
            )
            .is_err());
    }
}
