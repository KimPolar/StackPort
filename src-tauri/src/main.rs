#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod data_location;
use data_location::{DataLocation, DataMode, RuntimeInfo};

use stackport_core::{
    ArchivedProject, AuditPage, BackupReport, CsvOptions, DatabaseObject, EditInput, EditKey, EditPreview, EditResult, ExportQuery,
    list_local_directory, local_ports, BrowseDirectory, EditSession, NetworkDiagnostics, NetworkManager,
    ObjectDetails, PortSnapshot, Profile, Project, QueryOutcome, RemotePath,
    RdpAvailability, RdpManager, RdpRequest, RdpSession,
    RestorePreview, RestoreReport, RouteDiagnostic, RouteFamily, RouteTool, SqlParameterValue, SshAuthentication,
    SshHostInfo, SshManager, SshProfile, SshProfileExportReport, SshProfileImportPreview,
    save_terminal_output, SftpAuthentication, SftpTransferOutcome, SftpTransferProgress, SftpManager,
    SftpOpened, SshProfileInput, SshTrustPage, Store, TableQuery, TerminalInfo,
    TerminalManager, TerminalOutputFormat, TerminalRead,
    WebDiagnostic, WebMethod, WorkspaceCopyPreview, WorkspaceCopyReport,
};
use std::sync::Arc;
use tauri::{ipc::Channel, Manager, RunEvent, State};

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
fn get_runtime_info(location: State<'_, DataLocation>) -> RuntimeInfo {
    location.info()
}

#[tauri::command]
async fn preview_workspace_copy(
    store: State<'_, Store>,
    destination: String,
    include_trust: bool,
) -> Result<WorkspaceCopyPreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_workspace_copy(&destination, include_trust)).await
}

#[tauri::command]
async fn copy_workspace(
    store: State<'_, Store>,
    destination: String,
    include_trust: bool,
    reviewed_trust: bool,
) -> Result<WorkspaceCopyReport, String> {
    let store = store.inner().clone();
    worker(move || store.copy_workspace(&destination, include_trust, reviewed_trust)).await
}

#[tauri::command]
async fn list_local_ports() -> Result<PortSnapshot, String> {
    worker(local_ports).await
}

#[tauri::command]
async fn rdp_availability(rdp: State<'_, Arc<RdpManager>>) -> Result<RdpAvailability, String> {
    let rdp = Arc::clone(rdp.inner());
    worker(move || Ok(rdp.availability())).await
}

#[tauri::command]
async fn open_rdp(rdp: State<'_, Arc<RdpManager>>, request: RdpRequest) -> Result<RdpSession, String> {
    let rdp = Arc::clone(rdp.inner());
    worker(move || rdp.open(&request)).await
}

#[tauri::command]
async fn list_rdp_clients(rdp: State<'_, Arc<RdpManager>>) -> Result<Vec<RdpSession>, String> {
    let rdp = Arc::clone(rdp.inner());
    worker(move || rdp.list()).await
}

#[tauri::command]
async fn disconnect_rdp(rdp: State<'_, Arc<RdpManager>>, id: String) -> Result<(), String> {
    let rdp = Arc::clone(rdp.inner());
    worker(move || rdp.disconnect(&id)).await
}

#[tauri::command]
async fn run_route_diagnostic(
    network: State<'_, Arc<NetworkManager>>,
    target: String,
    tool: RouteTool,
    family: RouteFamily,
) -> Result<RouteDiagnostic, String> {
    let network = Arc::clone(network.inner());
    worker(move || network.probe_route(&target, tool, family)).await
}

#[tauri::command]
async fn run_web_diagnostic(
    network: State<'_, Arc<NetworkManager>>,
    address: String,
    method: WebMethod,
    samples: u8,
) -> Result<WebDiagnostic, String> {
    let network = Arc::clone(network.inner());
    worker(move || network.probe_web(&address, method, samples)).await
}

#[tauri::command]
async fn export_terminal_output(
    destination: String,
    format: TerminalOutputFormat,
    text: String,
) -> Result<usize, String> {
    worker(move || save_terminal_output(&destination, format, &text)).await
}

#[tauri::command]
async fn list_archived_projects(store: State<'_, Store>) -> Result<Vec<ArchivedProject>, String> {
    let store = store.inner().clone();
    worker(move || store.list_archived_projects()).await
}

#[tauri::command]
async fn archive_project(store: State<'_, Store>, id: String) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.archive_project(&id)).await
}

#[tauri::command]
async fn unarchive_project(store: State<'_, Store>, id: String) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.unarchive_project(&id)).await
}

#[tauri::command]
async fn list_audit_events(
    store: State<'_, Store>,
    before: Option<i64>,
) -> Result<AuditPage, String> {
    let store = store.inner().clone();
    worker(move || store.list_audit_events(before)).await
}

#[tauri::command]
async fn create_project(store: State<'_, Store>, name: String) -> Result<Project, String> {
    let store = store.inner().clone();
    worker(move || store.create_project(&name)).await
}

#[tauri::command]
async fn duplicate_project(store: State<'_, Store>, source: String, name: String) -> Result<Project, String> {
    let store = store.inner().clone();
    worker(move || store.duplicate_project(&source, &name)).await
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
async fn list_ssh_profiles(
    store: State<'_, Store>,
    project_id: String,
) -> Result<Vec<SshProfile>, String> {
    let store = store.inner().clone();
    worker(move || store.list_ssh_profiles(&project_id)).await
}

#[tauri::command]
async fn create_ssh_profile(
    store: State<'_, Store>,
    project_id: String,
    input: SshProfileInput,
) -> Result<SshProfile, String> {
    let store = store.inner().clone();
    worker(move || store.create_ssh_profile(&project_id, input)).await
}

#[tauri::command]
async fn update_ssh_profile(
    store: State<'_, Store>,
    id: String,
    revision: i64,
    input: SshProfileInput,
) -> Result<SshProfile, String> {
    let store = store.inner().clone();
    worker(move || store.update_ssh_profile(&id, revision, input)).await
}

#[tauri::command]
async fn delete_ssh_profile(
    store: State<'_, Store>,
    id: String,
    revision: i64,
) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_ssh_profile(&id, revision)).await
}

#[tauri::command]
async fn preview_ssh_profile_import(
    store: State<'_, Store>,
    path: String,
) -> Result<SshProfileImportPreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_ssh_profile_import(&path)).await
}

#[tauri::command]
async fn import_ssh_profiles(
    store: State<'_, Store>,
    project_id: String,
    path: String,
    digest: String,
    selected: Vec<usize>,
) -> Result<Vec<SshProfile>, String> {
    let store = store.inner().clone();
    worker(move || store.import_ssh_profiles(&project_id, &path, &digest, selected)).await
}

#[tauri::command]
async fn export_ssh_profiles(
    store: State<'_, Store>,
    project_id: String,
    expected: Vec<SshProfile>,
    destination: String,
) -> Result<SshProfileExportReport, String> {
    let store = store.inner().clone();
    worker(move || store.export_ssh_profiles(&project_id, expected, &destination)).await
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
async fn describe_object(
    store: State<'_, Store>,
    profile_id: String,
    name: String,
) -> Result<ObjectDetails, String> {
    let store = store.inner().clone();
    worker(move || store.describe_object(&profile_id, &name)).await
}

#[tauri::command]
fn prepare_query(store: State<'_, Store>) -> Result<String, String> {
    store.prepare_query()
}

#[tauri::command]
async fn cancel_query(store: State<'_, Store>, token: String) -> Result<bool, String> {
    let store = store.inner().clone();
    worker(move || store.cancel_query(&token)).await
}

#[tauri::command]
async fn run_query(
    store: State<'_, Store>,
    token: String,
    profile_id: String,
    sql: String,
    page: u32,
    parameters: Option<Vec<SqlParameterValue>>,
    explain: Option<bool>,
) -> Result<QueryOutcome, String> {
    let store = store.inner().clone();
    worker(move || {
        let parameters = parameters.as_deref();
        if explain.unwrap_or(false) {
            store.explain_prepared(&token, &profile_id, &sql, parameters)
        } else {
            store.query_prepared_with_parameters(&token, &profile_id, &sql, page, parameters)
        }
    })
    .await
}

#[tauri::command]
async fn run_object_query(
    store: State<'_, Store>,
    token: String,
    profile_id: String,
    request: TableQuery,
    page: u32,
) -> Result<QueryOutcome, String> {
    let store = store.inner().clone();
    worker(move || store.query_object_prepared(&token, &profile_id, &request, page)).await
}

#[tauri::command]
async fn export_sqlite_csv(
    store: State<'_, Store>,
    token: String,
    profile_id: String,
    query: ExportQuery,
    options: CsvOptions,
) -> Result<QueryOutcome, String> {
    let store = store.inner().clone();
    worker(move || store.export_csv_prepared(&token, &profile_id, &query, &options)).await
}

#[tauri::command]
async fn export_sqlite_json(
    store: State<'_, Store>,
    token: String,
    profile_id: String,
    query: ExportQuery,
    destination: String,
) -> Result<QueryOutcome, String> {
    let store = store.inner().clone();
    worker(move || store.export_json_prepared(&token, &profile_id, &query, &destination)).await
}

#[tauri::command]
fn result_export_progress(store: State<'_, Store>, token: String) -> Result<Option<u64>, String> {
    store.result_export_progress(&token)
}

#[tauri::command]
async fn begin_cell_edit(
    store: State<'_, Store>,
    profile_id: String,
    table: String,
    keys: Vec<EditKey>,
) -> Result<EditSession, String> {
    let store = store.inner().clone();
    worker(move || store.begin_cell_edit(&profile_id, &table, keys)).await
}

#[tauri::command]
async fn preview_cell_edit(
    store: State<'_, Store>,
    token: String,
    column: String,
    input: EditInput,
) -> Result<EditPreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_cell_edit(&token, &column, input)).await
}

#[tauri::command]
async fn apply_cell_edit(
    store: State<'_, Store>,
    token: String,
    production_confirmation: String,
) -> Result<EditResult, String> {
    let store = store.inner().clone();
    worker(move || store.apply_cell_edit(&token, &production_confirmation)).await
}

#[tauri::command]
async fn cancel_cell_edit(store: State<'_, Store>, token: String) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.cancel_cell_edit(&token)).await
}

#[tauri::command]
async fn open_terminal(
    terminals: State<'_, Arc<TerminalManager>>,
    shell: String,
    rows: u16,
    cols: u16,
) -> Result<TerminalInfo, String> {
    let terminals = Arc::clone(terminals.inner());
    worker(move || terminals.open(&shell, rows, cols)).await
}

#[tauri::command]
async fn read_terminal(
    terminals: State<'_, Arc<TerminalManager>>,
    id: String,
) -> Result<TerminalRead, String> {
    let terminals = Arc::clone(terminals.inner());
    worker(move || terminals.read(&id)).await
}

#[tauri::command]
async fn write_terminal(
    terminals: State<'_, Arc<TerminalManager>>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let terminals = Arc::clone(terminals.inner());
    worker(move || terminals.write(&id, &data)).await
}

#[tauri::command]
async fn resize_terminal(
    terminals: State<'_, Arc<TerminalManager>>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let terminals = Arc::clone(terminals.inner());
    worker(move || terminals.resize(&id, rows, cols)).await
}

#[tauri::command]
async fn close_terminal(
    terminals: State<'_, Arc<TerminalManager>>,
    id: String,
) -> Result<(), String> {
    let terminals = Arc::clone(terminals.inner());
    worker(move || terminals.close(&id)).await
}

#[tauri::command]
async fn inspect_ssh_host(
    ssh: State<'_, Arc<SshManager>>,
    host: String,
    port: u16,
) -> Result<SshHostInfo, String> {
    let ssh = Arc::clone(ssh.inner());
    worker(move || ssh.inspect(&host, port)).await
}

#[tauri::command]
async fn diagnose_ssh_network(
    network: State<'_, Arc<NetworkManager>>,
    host: String,
    port: u16,
) -> Result<NetworkDiagnostics, String> {
    let network = Arc::clone(network.inner());
    worker(move || network.diagnose(&host, port)).await
}

#[tauri::command]
async fn trust_ssh_host(
    ssh: State<'_, Arc<SshManager>>,
    token: String,
    fingerprint: String,
    confirmation: String,
) -> Result<SshHostInfo, String> {
    let ssh = Arc::clone(ssh.inner());
    worker(move || ssh.trust(&token, &fingerprint, &confirmation)).await
}

#[tauri::command]
async fn reinspect_ssh_host(
    ssh: State<'_, Arc<SshManager>>,
    host: String,
    port: u16,
) -> Result<SshHostInfo, String> {
    let ssh = Arc::clone(ssh.inner());
    worker(move || ssh.reinspect(&host, port)).await
}

#[tauri::command]
async fn list_ssh_trust_events(
    ssh: State<'_, Arc<SshManager>>,
    before: Option<i64>,
) -> Result<SshTrustPage, String> {
    let ssh = Arc::clone(ssh.inner());
    worker(move || ssh.history(before)).await
}

fn select_ssh_authentication(
    authentication: Option<SshAuthentication>,
    identity_path: Option<String>,
) -> Result<SshAuthentication, String> {
    match (authentication, identity_path) {
        (Some(_), Some(_)) => Err("SSH 인증 방식을 하나만 선택하세요.".into()),
        (Some(authentication), None) => Ok(authentication),
        (None, Some(path)) => Ok(SshAuthentication::KeyFile { path }),
        (None, None) => Ok(SshAuthentication::Automatic),
    }
}

#[tauri::command]
async fn open_ssh_terminal(
    ssh: State<'_, Arc<SshManager>>,
    terminals: State<'_, Arc<TerminalManager>>,
    host: String,
    port: u16,
    username: String,
    rows: u16,
    cols: u16,
    identity_path: Option<String>,
    authentication: Option<SshAuthentication>,
) -> Result<TerminalInfo, String> {
    let ssh = Arc::clone(ssh.inner());
    let terminals = Arc::clone(terminals.inner());
    worker(move || {
        let authentication = select_ssh_authentication(authentication, identity_path)?;
        ssh.open_with_authentication(&terminals, &host, port, &username, rows, cols, authentication)
    })
    .await
}

#[tauri::command]
async fn open_saved_ssh_terminal(
    store: State<'_, Store>,
    ssh: State<'_, Arc<SshManager>>,
    terminals: State<'_, Arc<TerminalManager>>,
    profile: SshProfile,
    confirmation: String,
    rows: u16,
    cols: u16,
    identity_path: Option<String>,
    authentication: Option<SshAuthentication>,
) -> Result<TerminalInfo, String> {
    let store = store.inner().clone();
    let ssh = Arc::clone(ssh.inner());
    let terminals = Arc::clone(terminals.inner());
    worker(move || {
        let current = confirmed_ssh_profile(&store, &profile, &confirmation)?;
        let authentication = select_ssh_authentication(authentication, identity_path)?;
        let mut terminal = ssh.open_with_authentication(
            &terminals,
            &current.host,
            current.port,
            &current.username,
            rows,
            cols,
            authentication,
        )?;
        terminal.environment = Some(current.environment);
        Ok(terminal)
    })
    .await
}

fn confirmed_ssh_profile(
    store: &Store,
    profile: &SshProfile,
    confirmation: &str,
) -> Result<SshProfile, String> {
    let current = store.ssh_profile(&profile.id)?;
    if &current != profile {
        return Err("SSH 연결이 변경되었습니다. 새로고침하고 대상을 다시 확인하세요.".into());
    }
    if current.environment == "PROD" && confirmation != "PROD" {
        return Err("운영 환경을 확인하려면 PROD를 입력하세요.".into());
    }
    Ok(current)
}

#[tauri::command]
async fn open_sftp(
    store: State<'_, Store>,
    ssh: State<'_, Arc<SshManager>>,
    sftp: State<'_, SftpManager>,
    profile: SshProfile,
    confirmation: String,
    authentication: SftpAuthentication,
) -> Result<SftpOpened, String> {
    let store = store.inner().clone();
    let ssh = Arc::clone(ssh.inner());
    let current = worker(move || confirmed_ssh_profile(&store, &profile, &confirmation)).await?;
    sftp.open(ssh, current, authentication).await
}

#[tauri::command]
async fn list_sftp_directory(
    sftp: State<'_, SftpManager>,
    id: String,
    path: RemotePath,
) -> Result<BrowseDirectory, String> {
    sftp.list(&id, path).await
}

#[tauri::command]
async fn download_sftp_file(
    sftp: State<'_, SftpManager>,
    id: String,
    source: RemotePath,
    destination: String,
    progress: Channel<SftpTransferProgress>,
) -> Result<SftpTransferOutcome, String> {
    sftp.download(&id, source, destination, |update| {
            let _ = progress.send(update);
        })
        .await
}

#[tauri::command]
async fn upload_sftp_file(
    sftp: State<'_, SftpManager>,
    id: String,
    source: String,
    directory: RemotePath,
    filename: String,
    progress: Channel<SftpTransferProgress>,
) -> Result<SftpTransferOutcome, String> {
    sftp.upload(&id, source, directory, filename, |update| {
            let _ = progress.send(update);
        })
        .await
}

#[tauri::command]
fn cancel_sftp_transfer(sftp: State<'_, SftpManager>, id: String, transfer_id: String) -> bool {
    sftp.cancel_transfer(&id, &transfer_id)
}

#[tauri::command]
async fn close_sftp(sftp: State<'_, SftpManager>, id: String) -> Result<(), String> {
    sftp.close(&id).await
}

#[tauri::command]
async fn browse_local_directory(path: String) -> Result<BrowseDirectory, String> {
    worker(move || list_local_directory(&path)).await
}

#[tauri::command]
async fn choose_local_browse_directory() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("탐색할 로컬 폴더 선택")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
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
async fn choose_ssh_profile_import_file() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("SSH 연결 파일 선택")
            .add_filter("JSON", &["json"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn choose_ssh_identity_file() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("SSH 키 파일 선택")
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn choose_ssh_profile_export_directory() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("SSH 연결 파일을 저장할 폴더 선택")
            .pick_folder()
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
async fn choose_result_export_directory() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("결과 파일을 저장할 폴더 선택")
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

#[tauri::command]
async fn preview_sqlite_restore(
    store: State<'_, Store>,
    project_id: String,
    source: String,
    destination: String,
) -> Result<RestorePreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_sqlite_restore(&project_id, &source, &destination)).await
}

#[tauri::command]
async fn restore_sqlite(
    store: State<'_, Store>,
    token: String,
    confirmed: bool,
) -> Result<RestoreReport, String> {
    let store = store.inner().clone();
    worker(move || store.restore_sqlite(&token, confirmed)).await
}

#[tauri::command]
async fn choose_sqlite_restore_destination() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("새 SQLite 복원 파일 선택")
            .set_file_name("stackport-restored.sqlite")
            .add_filter("SQLite", &["sqlite", "sqlite3", "db", "db3"])
            .save_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
}

fn main() {
    let run = tauri::Builder::default()
        .setup(|app| {
            let location = DataLocation::resolve(|| app.path().app_data_dir().map_err(std::io::Error::other))?;
            let config = app.config().app.windows.first()
                .ok_or_else(|| std::io::Error::other("StackPort 창 설정이 없습니다."))?;
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
            if location.mode == DataMode::Portable {
                let webview = location.directory.join("webview");
                std::fs::create_dir_all(&webview)?;
                window = window.data_directory(webview);
            }
            let path = location.directory.join("workspace.sqlite");
            let store = Store::open(path).map_err(std::io::Error::other)?;
            app.manage(store);
            app.manage(Arc::new(TerminalManager::default()));
            app.manage(Arc::new(SshManager::new(location.directory.clone())));
            app.manage(SftpManager::default());
            app.manage(Arc::new(NetworkManager::default()));
            app.manage(Arc::new(RdpManager::new(location.directory.clone())));
            app.manage(location);
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            get_runtime_info,
            preview_workspace_copy,
            copy_workspace,
            list_local_ports,
            rdp_availability,
            open_rdp,
            list_rdp_clients,
            disconnect_rdp,
            run_route_diagnostic,
            run_web_diagnostic,
            export_terminal_output,
            list_archived_projects,
            archive_project,
            unarchive_project,
            list_audit_events,
            create_project,
            duplicate_project,
            rename_project,
            delete_project,
            list_profiles,
            list_ssh_profiles,
            create_ssh_profile,
            update_ssh_profile,
            delete_ssh_profile,
            preview_ssh_profile_import,
            import_ssh_profiles,
            export_ssh_profiles,
            create_sqlite_profile,
            delete_profile,
            list_objects,
            describe_object,
            prepare_query,
            cancel_query,
            run_query,
            run_object_query,
            export_sqlite_csv,
            export_sqlite_json,
            result_export_progress,
            begin_cell_edit,
            preview_cell_edit,
            apply_cell_edit,
            cancel_cell_edit,
            open_terminal,
            read_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            inspect_ssh_host,
            diagnose_ssh_network,
            trust_ssh_host,
            reinspect_ssh_host,
            list_ssh_trust_events,
            open_ssh_terminal,
            open_saved_ssh_terminal,
            open_sftp,
            list_sftp_directory,
            download_sftp_file,
            upload_sftp_file,
            cancel_sftp_transfer,
            close_sftp,
            browse_local_directory,
            choose_local_browse_directory,
            choose_sqlite_file,
            choose_ssh_profile_import_file,
            choose_ssh_identity_file,
            choose_ssh_profile_export_directory,
            choose_backup_directory,
            choose_result_export_directory,
            backup_sqlite,
            preview_sqlite_restore,
            choose_sqlite_restore_destination,
            restore_sqlite
        ])
        .build(tauri::generate_context!());
    match run {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, RunEvent::Exit) {
                handle.state::<Arc<RdpManager>>().shutdown();
            }
        }),
        Err(error) => {
            eprintln!("StackPort 실행 실패: {error}");
            let _ = rfd::MessageDialog::new().set_title("StackPort 실행 실패")
                .set_description(error.to_string())
                .set_level(rfd::MessageLevel::Error)
                .show();
            std::process::exit(1);
        }
    }
}
