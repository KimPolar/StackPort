use rusqlite::Connection;
use stackport_core::{
    ResumeDirection, ResumeLayout, ResumeTool, Store, WorkspaceResume, WorkspaceResumeWrite,
};

fn tool(tool: ResumeTool) -> ResumeLayout {
    ResumeLayout::Tool { tool }
}

fn state(explorer_open: bool) -> WorkspaceResume {
    WorkspaceResume {
        project_id: None,
        profile_id: None,
        explorer_open,
        layout: ResumeLayout::Split {
            direction: ResumeDirection::Stack,
            size: 60,
            first: Box::new(tool(ResumeTool::Workspace)),
            second: Box::new(tool(ResumeTool::Terminal)),
        },
    }
}

#[test]
fn keeps_the_last_valid_snapshot_and_rejects_a_stale_writer() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let first_window = Store::open(&path).unwrap();
    let second_window = Store::open(&path).unwrap();
    assert_eq!(first_window.workspace_resume().unwrap().revision, 0);
    assert_eq!(
        first_window.save_workspace_resume(0, state(true)).unwrap(),
        WorkspaceResumeWrite::Saved { revision: 1 }
    );
    assert_eq!(
        second_window
            .save_workspace_resume(0, state(false))
            .unwrap(),
        WorkspaceResumeWrite::Conflict { revision: 1 }
    );
    assert_eq!(
        second_window
            .save_workspace_resume(1, state(false))
            .unwrap(),
        WorkspaceResumeWrite::Saved { revision: 2 }
    );
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE workspace_resume SET layout='damaged' WHERE slot=0",
            [],
        )
        .unwrap();
    let record = Store::open(&path).unwrap().workspace_resume().unwrap();
    assert!(record.recovered);
    assert_eq!(record.revision, 2);
    assert_eq!(record.state, Some(state(true)));

    assert_eq!(
        first_window.save_workspace_resume(2, state(false)).unwrap(),
        WorkspaceResumeWrite::Saved { revision: 3 }
    );
    let db = Connection::open(path).unwrap();
    let backup: String = db
        .query_row(
            "SELECT layout FROM workspace_resume WHERE slot=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<ResumeLayout>(&backup).unwrap(),
        state(true).layout
    );
}

#[test]
fn discards_invalid_references_and_rejects_duplicate_tools() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(path).unwrap();
    let project = store.create_project("Project").unwrap();
    let other_project = store.create_project("Other").unwrap();
    let database = directory.path().join("fixture.sqlite");
    Connection::open(&database)
        .unwrap()
        .execute_batch("CREATE TABLE items (id INTEGER PRIMARY KEY)")
        .unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "DB", database.to_str().unwrap(), "DEV")
        .unwrap();
    let mut requested = state(false);
    requested.project_id = Some(other_project.id);
    requested.profile_id = Some(profile.id.clone());
    store.save_workspace_resume(0, requested.clone()).unwrap();
    assert!(store
        .workspace_resume()
        .unwrap()
        .state
        .unwrap()
        .profile_id
        .is_none());

    requested.project_id = Some(project.id.clone());
    store.save_workspace_resume(1, requested.clone()).unwrap();
    assert_eq!(
        store.workspace_resume().unwrap().state,
        Some(requested.clone())
    );
    store.archive_project(&project.id).unwrap();
    let restored = store.workspace_resume().unwrap().state.unwrap();
    assert!(restored.project_id.is_none());
    assert!(restored.profile_id.is_none());
    assert_eq!(restored.layout, requested.layout);

    requested.layout = ResumeLayout::Split {
        direction: ResumeDirection::Side,
        size: 50,
        first: Box::new(tool(ResumeTool::Workspace)),
        second: Box::new(tool(ResumeTool::Workspace)),
    };
    assert!(store.save_workspace_resume(2, requested).is_err());
    assert_eq!(store.workspace_resume().unwrap().revision, 2);
}

#[test]
fn only_one_window_can_save_the_same_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let first = Store::open(&path).unwrap();
    let second = Store::open(&path).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let writers = [(first, true), (second, false)].map(|(store, explorer_open)| {
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            (
                explorer_open,
                store
                    .save_workspace_resume(0, state(explorer_open))
                    .unwrap(),
            )
        })
    });
    let results = writers.map(|writer| writer.join().unwrap());
    let mut winners = results
        .iter()
        .filter(|(_, result)| *result == WorkspaceResumeWrite::Saved { revision: 1 });
    let (explorer_open, _) = winners.next().unwrap();
    assert!(winners.next().is_none());
    assert!(results
        .iter()
        .any(|(_, result)| *result == WorkspaceResumeWrite::Conflict { revision: 1 }));
    let current = Store::open(&path).unwrap().workspace_resume().unwrap();
    assert_eq!(current.state, Some(state(*explorer_open)));
}
