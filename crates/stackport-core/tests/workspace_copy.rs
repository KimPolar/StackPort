#![cfg(windows)]

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use stackport_core::Store;
use std::{fs, path::Path};

fn text(path: &Path) -> &str {
    path.to_str().unwrap()
}

#[test]
fn workspace_copy_preserves_live_metadata_and_optional_trust_without_overwriting() {
    let dir = tempfile::tempdir().unwrap();
    let metadata = dir.path().join("workspace.sqlite");
    let store = Store::open(&metadata).unwrap();
    let live = Connection::open(&metadata).unwrap();
    live.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let project = store.create_project("copied from WAL").unwrap();
    let trust_file = dir.path().join("ssh-trust.sqlite");
    let trust = Connection::open(&trust_file).unwrap();
    trust
        .execute_batch(
            "CREATE TABLE fixture (host TEXT); INSERT INTO fixture VALUES ('pinned.example.test');",
        )
        .unwrap();
    let folder = dir.path().join("new-data");
    let preview = store.preview_workspace_copy(text(&folder), true).unwrap();
    assert!(preview.include_trust);
    assert!(!folder.exists());
    let report = store
        .copy_workspace(&preview.destination, true, preview.include_trust)
        .unwrap();
    assert_eq!(report.files.len(), 2);
    for file in report.files {
        let bytes = fs::read(folder.join(file.name)).unwrap();
        assert_eq!(file.bytes, bytes.len() as u64);
        assert_eq!(file.sha256, format!("{:x}", Sha256::digest(bytes)));
    }
    let ordered = Store::open(folder.join("workspace.sqlite")).unwrap();
    assert_eq!(ordered.list_projects().unwrap()[0], project);
    let copied_trust = Connection::open(folder.join("ssh-trust.sqlite")).unwrap();
    assert_eq!(
        copied_trust
            .query_row("SELECT host FROM fixture", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "pinned.example.test"
    );
    assert!(store.copy_workspace(text(&folder), true, true).is_err());
    let without = dir.path().join("without-trust");
    let report = store.copy_workspace(text(&without), false, false).unwrap();
    assert_eq!(report.files.len(), 1);
    assert!(!without.join("ssh-trust.sqlite").exists());
    let events = store.list_audit_events(None).unwrap().events;
    assert_eq!(events[0].operation, "workspace.copy");
    assert!(!serde_json::to_string(&events)
        .unwrap()
        .contains("without-trust"));
}

#[test]
fn workspace_copy_rechecks_preview_and_keeps_the_target_absent_on_failure() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("workspace.sqlite")).unwrap();
    let target = dir.path().join("target");
    let preview = store.preview_workspace_copy(text(&target), true).unwrap();
    assert!(!preview.include_trust);
    fs::write(
        dir.path().join("ssh-trust.sqlite"),
        b"not a sqlite database",
    )
    .unwrap();
    assert!(store
        .copy_workspace(&preview.destination, true, false)
        .unwrap_err()
        .contains("바뀌었습니다"));
    assert!(store.copy_workspace(text(&target), true, true).is_err());
    assert!(!target.exists());
    assert!(!fs::read_dir(dir.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".stackport-workspace-")));
}
