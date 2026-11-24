use crate::{db_error, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

pub(super) const SCHEMA: &str = "CREATE TABLE workspace_resume (
    slot INTEGER PRIMARY KEY CHECK(slot IN (0, 1)),
    revision INTEGER NOT NULL CHECK(revision > 0),
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
    explorer_open INTEGER NOT NULL CHECK(explorer_open IN (0, 1)),
    layout TEXT NOT NULL CHECK(length(layout) <= 4096)
);";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeTool {
    Workspace,
    Terminal,
    Files,
    Rdp,
    Network,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeDirection {
    Side,
    Stack,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResumeLayout {
    Tool {
        tool: ResumeTool,
    },
    Split {
        direction: ResumeDirection,
        size: u8,
        first: Box<ResumeLayout>,
        second: Box<ResumeLayout>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceResume {
    pub project_id: Option<String>,
    pub profile_id: Option<String>,
    pub explorer_open: bool,
    pub layout: ResumeLayout,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceResumeRecord {
    pub revision: i64,
    pub state: Option<WorkspaceResume>,
    pub recovered: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorkspaceResumeWrite {
    Saved { revision: i64 },
    Conflict { revision: i64 },
}

struct StoredResume {
    revision: i64,
    project_id: Option<String>,
    profile_id: Option<String>,
    explorer_open: bool,
    layout: String,
}

impl StoredResume {
    fn decode(&self) -> Option<WorkspaceResume> {
        let layout = serde_json::from_str(&self.layout).ok()?;
        if !valid_layout(&layout, 0, &mut Vec::new()) {
            return None;
        }
        Some(WorkspaceResume {
            project_id: self.project_id.clone(),
            profile_id: self.profile_id.clone(),
            explorer_open: self.explorer_open,
            layout,
        })
    }
}

fn valid_layout(layout: &ResumeLayout, depth: usize, tools: &mut Vec<ResumeTool>) -> bool {
    if depth > 3 {
        return false;
    }
    match layout {
        ResumeLayout::Tool { tool } => {
            if tools.len() == 4 || tools.contains(tool) {
                return false;
            }
            tools.push(*tool);
            true
        }
        ResumeLayout::Split {
            size,
            first,
            second,
            ..
        } => {
            (25..=75).contains(size)
                && valid_layout(first, depth + 1, tools)
                && valid_layout(second, depth + 1, tools)
        }
    }
}

fn snapshot(db: &Connection, slot: u8) -> Result<Option<StoredResume>> {
    db.query_row(
        "SELECT revision, project_id, profile_id, explorer_open, layout FROM workspace_resume WHERE slot=?1",
        [slot],
        |row| Ok(StoredResume {
            revision: row.get(0)?,
            project_id: row.get(1)?,
            profile_id: row.get(2)?,
            explorer_open: row.get(3)?,
            layout: row.get(4)?,
        }),
    )
    .optional()
    .map_err(db_error)
}

fn retain_live_selection(db: &Connection, state: &mut WorkspaceResume) -> Result<()> {
    if let Some(project) = &state.project_id {
        let active: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects p WHERE p.id=?1
                 AND NOT EXISTS(SELECT 1 FROM project_archives a WHERE a.project_id=p.id))",
                [project],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !active {
            state.project_id = None;
        }
    }
    if let (Some(project), Some(profile)) = (&state.project_id, &state.profile_id) {
        let belongs: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM profiles WHERE id=?1 AND project_id=?2)",
                [profile, project],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if belongs {
            return Ok(());
        }
    }
    state.profile_id = None;
    Ok(())
}

impl Store {
    pub fn workspace_resume(&self) -> Result<WorkspaceResumeRecord> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(db_error)?;
        let current = snapshot(&tx, 0)?;
        let revision = current.as_ref().map_or(0, |saved| saved.revision);
        let mut state = current.as_ref().and_then(StoredResume::decode);
        let recovered = current.is_some() && state.is_none();
        if recovered {
            state = snapshot(&tx, 1)?.and_then(|saved| saved.decode());
        }
        if let Some(state) = &mut state {
            retain_live_selection(&tx, state)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(WorkspaceResumeRecord {
            revision,
            state,
            recovered,
        })
    }

    pub fn save_workspace_resume(
        &self,
        expected_revision: i64,
        mut state: WorkspaceResume,
    ) -> Result<WorkspaceResumeWrite> {
        if !valid_layout(&state.layout, 0, &mut Vec::new()) {
            return Err("잘못된 작업 공간 배치입니다.".into());
        }
        let layout = serde_json::to_string(&state.layout)
            .map_err(|_| "작업 공간 배치를 저장할 수 없습니다.".to_owned())?;
        let mut db = self.connect()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let current = snapshot(&tx, 0)?;
        let revision = current.as_ref().map_or(0, |saved| saved.revision);
        if revision != expected_revision {
            return Ok(WorkspaceResumeWrite::Conflict { revision });
        }
        let next = revision
            .checked_add(1)
            .ok_or("작업 공간 저장 버전 한도를 넘었습니다.")?;
        retain_live_selection(&tx, &mut state)?;
        if current.as_ref().and_then(StoredResume::decode).is_some() {
            tx.execute(
                "INSERT OR REPLACE INTO workspace_resume(slot, revision, project_id, profile_id, explorer_open, layout)
                 SELECT 1, revision, project_id, profile_id, explorer_open, layout FROM workspace_resume WHERE slot=0",
                [],
            )
            .map_err(db_error)?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO workspace_resume(slot, revision, project_id, profile_id, explorer_open, layout)
             VALUES (0, ?1, ?2, ?3, ?4, ?5)",
            params![next, state.project_id, state.profile_id, state.explorer_open, layout],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(WorkspaceResumeWrite::Saved { revision: next })
    }
}
