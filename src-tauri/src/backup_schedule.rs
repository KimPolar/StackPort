use stackport_core::{
    backup_artifact::{RemovalPreview, RemovalResult},
    backup_schedule::{
        BackupCalendar, BackupCapacity, BackupExecutionPolicy, BackupPlanState, BackupPlanWrite, BackupRun, CalendarOccurrence,
        ExpiredBackupPage, MAX_CONCURRENT_BACKUPS,
    },
    BackupTunnelRoute, PostgresProfile, SshTunnelManager, Store,
};
use std::{
    sync::mpsc::{self, RecvTimeoutError, Sender},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) struct Scheduler(Vec<Sender<()>>);

impl Scheduler {
    pub(crate) fn start(app: AppHandle, store: Store) -> std::io::Result<Self> {
        let mut workers = Vec::with_capacity(usize::from(MAX_CONCURRENT_BACKUPS));
        for index in 1..=MAX_CONCURRENT_BACKUPS {
            let (stop, stopped) = mpsc::channel();
            let app = app.clone();
            let store = store.clone();
            std::thread::Builder::new()
                .name(format!("backup-scheduler-{index}"))
                .spawn(move || {
                    while let Err(RecvTimeoutError::Timeout) =
                        stopped.recv_timeout(Duration::from_secs(2))
                    {
                        if let Ok(Some(run)) = store.run_due_backup(app.state::<SshTunnelManager>().inner()) {
                            let _ = app.emit("backup-finished", (run.engine, run.status));
                        }
                    }
                })?;
            workers.push(stop);
        }
        Ok(Self(workers))
    }

    pub(crate) fn stop(&self) {
        for worker in &self.0 {
            let _ = worker.send(());
        }
    }
}

#[tauri::command]
pub(crate) async fn set_backup_concurrency(store: State<'_, Store>, revision: i64, max_concurrent: u8) -> Result<BackupExecutionPolicy, String> {
    let store = store.inner().clone();
    super::worker(move || store.set_backup_concurrency(revision, max_concurrent)).await
}

#[tauri::command]
pub(crate) async fn preview_backup_calendar(input: BackupCalendar) -> Result<Vec<CalendarOccurrence>, String> {
    super::worker(move || stackport_core::backup_schedule::preview_backup_calendar(input)).await
}

#[tauri::command]
pub(crate) async fn postgres_backup_plan(store: State<'_, Store>, profile_id: String) -> Result<BackupPlanState, String> {
    let store = store.inner().clone();
    super::worker(move || store.postgres_backup_plan(&profile_id)).await
}

#[tauri::command]
pub(crate) async fn postgres_backup_capacity(app: AppHandle, store: State<'_, Store>, profile: PostgresProfile, directory: String, tunnel: Option<BackupTunnelRoute>) -> Result<BackupCapacity, String> {
    let store = store.inner().clone();
    super::worker(move || {
        let manager = app.state::<SshTunnelManager>();
        store.postgres_backup_capacity(&profile, &directory, tunnel.as_ref().map(|route| (manager.inner(), route)))
    }).await
}

#[tauri::command]
pub(crate) fn postgres_backup_tunnel_options(tunnels: State<'_, SshTunnelManager>, profile: PostgresProfile) -> Result<Vec<BackupTunnelRoute>, String> {
    tunnels.local_backup_routes(&profile.project_id, &profile.settings.host, profile.settings.port)
}

#[tauri::command]
pub(crate) async fn save_postgres_backup_plan(app: AppHandle, store: State<'_, Store>, profile: PostgresProfile, confirmation: String, input: BackupPlanWrite, tunnel: Option<BackupTunnelRoute>) -> Result<BackupPlanState, String> {
    let store = store.inner().clone();
    super::worker(move || {
        let manager = app.state::<SshTunnelManager>();
        store.save_postgres_backup_plan(&profile, &confirmation, input, tunnel.as_ref().map(|route| (manager.inner(), route)))
    }).await
}

#[tauri::command]
pub(crate) async fn run_postgres_backup_plan(app: AppHandle, store: State<'_, Store>, profile: PostgresProfile, revision: i64, confirmation: String) -> Result<BackupRun, String> {
    let store = store.inner().clone();
    super::worker(move || store.run_postgres_backup_plan(&profile, revision, &confirmation, app.state::<SshTunnelManager>().inner())).await
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
pub(crate) fn cancel_backup_plan_run(store: State<'_, Store>, profile_id: String, run_id: String) -> bool {
    store.cancel_backup_plan_run(&profile_id, &run_id)
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
