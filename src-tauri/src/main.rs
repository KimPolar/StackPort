#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use stackport_core::{BackupReport, DatabaseObject, Profile, Project, QueryPage, Store};
use tauri::{Manager, State};

async fn worker<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("작업을 완료할 수 없습니다: {error}"))?
}

#[tauri::command]
async fn list_projects(store: State<'_, Store>) -> Result<Vec<Project>, String> {
    let store = store.inner().clone();
    worker(move || store.list_projects()).await
}

#[tauri::command]
async fn create_project(store: State<'_, Store>, name: String) -> Result<Project, String> {
    let store = store.inner().clone();
    worker(move || store.create_project(&name)).await
}

#[tauri::command]
async fn rename_project(store: State<'_, Store>, id: String, name: String) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.rename_project(&id, &name)).await
}

#[tauri::command]
async fn delete_project(store: State<'_, Store>, id: String) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_project(&id)).await
}

#[tauri::command]
async fn list_profiles(
    store: State<'_, Store>,
    project_id: String,
) -> Result<Vec<Profile>, String> {
    let store = store.inner().clone();
    worker(move || store.list_profiles(&project_id)).await
}

#[tauri::command]
async fn create_sqlite_profile(
    store: State<'_, Store>,
    project_id: String,
    name: String,
    path: String,
    environment: String,
) -> Result<Profile, String> {
    let store = store.inner().clone();
    worker(move || store.create_sqlite_profile(&project_id, &name, &path, &environment)).await
}

#[tauri::command]
async fn delete_profile(store: State<'_, Store>, id: String) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_profile(&id)).await
}

#[tauri::command]
async fn list_objects(
    store: State<'_, Store>,
    profile_id: String,
) -> Result<Vec<DatabaseObject>, String> {
    let store = store.inner().clone();
    worker(move || store.objects(&profile_id)).await
}

#[tauri::command]
async fn run_query(
    store: State<'_, Store>,
    profile_id: String,
    sql: String,
    page: u32,
) -> Result<QueryPage, String> {
    let store = store.inner().clone();
    worker(move || store.query(&profile_id, &sql, page)).await
}

#[tauri::command]
async fn choose_sqlite_file() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("SQLite 데이터베이스 선택")
            .add_filter("SQLite", &["sqlite", "sqlite3", "db", "db3"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn choose_backup_directory() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("백업을 저장할 폴더 선택")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn backup_sqlite(
    store: State<'_, Store>,
    profile_id: String,
    destination: String,
) -> Result<BackupReport, String> {
    let store = store.inner().clone();
    worker(move || store.backup_sqlite(&profile_id, &destination)).await
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = match std::env::var_os("STACKPORT_DATA_DIR") {
                Some(path) => std::path::PathBuf::from(path),
                None => app.path().app_data_dir()?,
            };
            let path = directory.join("workspace.sqlite");
            let store = Store::open(path).map_err(std::io::Error::other)?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            rename_project,
            delete_project,
            list_profiles,
            create_sqlite_profile,
            delete_profile,
            list_objects,
            run_query,
            choose_sqlite_file,
            choose_backup_directory,
            backup_sqlite
        ])
        .run(tauri::generate_context!())
        .expect("StackPort 실행 실패");
}
