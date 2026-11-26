use stackport_core::{
    backup_schedule::{BackupCapacity, BackupPlanState, BackupPlanWrite, BackupRun},
    Store,
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
            .name("sqlite-backup-scheduler".into())
            .spawn(move || {
                while let Err(RecvTimeoutError::Timeout) =
                    stopped.recv_timeout(Duration::from_secs(2))
                {
                    if let Ok(Some(run)) = store.run_due_sqlite_backup() {
                        let _ = app.emit("sqlite-backup-finished", run.status);
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
