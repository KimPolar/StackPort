use stackport_core::{DatabaseFolder, DatabaseFolderEngine, DatabaseFolderState, Store};
use tauri::State;

#[tauri::command]
pub(crate) async fn list_database_folders(
    store: State<'_, Store>,
    project_id: String,
) -> Result<DatabaseFolderState, String> {
    let store = store.inner().clone();
    super::worker(move || store.database_folders(&project_id)).await
}

#[tauri::command]
pub(crate) async fn create_database_folder(
    store: State<'_, Store>,
    project_id: String,
    parent_id: Option<String>,
    name: String,
) -> Result<DatabaseFolder, String> {
    let store = store.inner().clone();
    super::worker(move || store.create_database_folder(&project_id, parent_id.as_deref(), &name))
        .await
}

#[tauri::command]
pub(crate) async fn update_database_folder(
    store: State<'_, Store>,
    project_id: String,
    id: String,
    revision: i64,
    parent_id: Option<String>,
    name: String,
) -> Result<DatabaseFolder, String> {
    let store = store.inner().clone();
    super::worker(move || {
        store.update_database_folder(&project_id, &id, revision, parent_id.as_deref(), &name)
    })
    .await
}

#[tauri::command]
pub(crate) async fn move_database_connection(
    store: State<'_, Store>,
    project_id: String,
    engine: DatabaseFolderEngine,
    profile_id: String,
    previous_folder_id: Option<String>,
    folder_id: Option<String>,
) -> Result<(), String> {
    let store = store.inner().clone();
    super::worker(move || {
        store.move_database_connection(
            &project_id,
            engine,
            &profile_id,
            previous_folder_id.as_deref(),
            folder_id.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_database_folder(
    store: State<'_, Store>,
    project_id: String,
    id: String,
    revision: i64,
) -> Result<(), String> {
    let store = store.inner().clone();
    super::worker(move || store.delete_database_folder(&project_id, &id, revision)).await
}
