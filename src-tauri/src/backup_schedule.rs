use stackport_core::{
    backup_artifact::{RemovalPreview, RemovalResult},
    backup_schedule::{
        BackupCapacity, BackupPlanState, BackupPlanWrite, BackupRun, ExpiredBackupPage,
    },
    PostgresProfile, Store,
};
use std::{
    sync::mpsc::{self, RecvTimeoutError, Sender},
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

pub(crate) struct Scheduler(Sender<()>);

impl Scheduler {
    pub(crate) fn start(app: AppHandle, store: Store) -> std::io::Result<Self> {
        let (stop, stopped) = mpsc::channel();
        std::thread::Builder::new()
            .name("backup-scheduler".into())
            .spawn(move || {
                while let Err(RecvTimeoutError::Timeout) =
                    stopped.recv_timeout(Duration::from_secs(2))
                {
                    if let Ok(Some(run)) = store.run_due_backup() {
                        let _ = app.emit("backup-finished", (run.engine, run.status));
                    }
                }
            })?;
        Ok(Self(stop))
    }

    pub(crate) fn stop(&self) {
        let _ = self.0.send(());
    }
}

#[tauri::command]
pub(crate) async fn postgres_backup_plan(store: State<'_, Store>, profile_id: String) -> Result<BackupPlanState, String> {
    let store = store.inner().clone();
    super::worker(move || store.postgres_backup_plan(&profile_id)).await
}

#[tauri::command]
pub(crate) async fn postgres_backup_capacity(store: State<'_, Store>, profile: PostgresProfile, directory: String) -> Result<BackupCapacity, String> {
    let store = store.inner().clone();
    super::worker(move || store.postgres_backup_capacity(&profile, &directory)).await
}

#[tauri::command]
pub(crate) async fn save_postgres_backup_plan(store: State<'_, Store>, profile: PostgresProfile, confirmation: String, input: BackupPlanWrite) -> Result<BackupPlanState, String> {
    let store = store.inner().clone();
    super::worker(move || store.save_postgres_backup_plan(&profile, &confirmation, input)).await
}

#[tauri::command]
pub(crate) async fn run_postgres_backup_plan(store: State<'_, Store>, profile: PostgresProfile, revision: i64, confirmation: String) -> Result<BackupRun, String> {
    let store = store.inner().clone();
    super::worker(move || store.run_postgres_backup_plan(&profile, revision, &confirmation)).await
}

#[tauri::command]
pub(crate) async fn pause_postgres_backup_plan(store: State<'_, Store>, profile_id: String, revision: i64) -> Result<BackupPlanState, String> {
    let store = store.inner().clone();
    super::worker(move || store.pause_postgres_backup_plan(&profile_id, revision)).await
}

#[tauri::command]
pub(crate) async fn sqlite_backup_plan(
    store: State<'_, Store>,
    profile_id: String,
) -> Result<BackupPlanState, String> {
    let store = store.inner().clone();
    super::worker(move || store.sqlite_backup_plan(&profile_id)).await
}

#[tauri::command]
pub(crate) async fn sqlite_backup_capacity(
    store: State<'_, Store>,
    profile_id: String,
    directory: String,
) -> Result<BackupCapacity, String> {
    let store = store.inner().clone();
    super::worker(move || store.sqlite_backup_capacity(&profile_id, &directory)).await
}

#[tauri::command]
pub(crate) async fn save_sqlite_backup_plan(
    store: State<'_, Store>,
    profile_id: String,
    input: BackupPlanWrite,
) -> Result<BackupPlanState, String> {
    let store = store.inner().clone();
    super::worker(move || store.save_sqlite_backup_plan(&profile_id, input)).await
}

#[tauri::command]
pub(crate) async fn run_sqlite_backup_plan(
    store: State<'_, Store>,
    profile_id: String,
    revision: i64,
) -> Result<BackupRun, String> {
    let store = store.inner().clone();
    super::worker(move || store.run_sqlite_backup_plan(&profile_id, revision)).await
}

#[tauri::command]
pub(crate) async fn pause_sqlite_backup_plan(
    store: State<'_, Store>,
    profile_id: String,
    revision: i64,
) -> Result<BackupPlanState, String> {
    let store = store.inner().clone();
    super::worker(move || store.pause_sqlite_backup_plan(&profile_id, revision)).await
}

#[tauri::command]
pub(crate) async fn verify_sqlite_backup_file(
    store: State<'_, Store>,
    profile_id: String,
    run_id: String,
) -> Result<i64, String> {
    let store = store.inner().clone();
    super::worker(move || store.verify_sqlite_backup_file(&profile_id, &run_id)).await
}

#[tauri::command]
pub(crate) async fn expired_sqlite_backups(
    store: State<'_, Store>,
    profile_id: String,
    before: Option<i64>,
) -> Result<ExpiredBackupPage, String> {
    let store = store.inner().clone();
    super::worker(move || store.expired_sqlite_backups(&profile_id, before)).await
}

#[tauri::command]
pub(crate) async fn preview_sqlite_backup_removal(
    store: State<'_, Store>,
    profile_id: String,
    run_id: String,
) -> Result<RemovalPreview, String> {
    let store = store.inner().clone();
    super::worker(move || store.preview_sqlite_backup_removal(&profile_id, &run_id)).await
}

#[tauri::command]
pub(crate) async fn remove_sqlite_backup_file(
    store: State<'_, Store>,
    token: String,
    confirmed: bool,
) -> Result<RemovalResult, String> {
    let store = store.inner().clone();
    super::worker(move || store.remove_sqlite_backup_file(&token, confirmed)).await
}
