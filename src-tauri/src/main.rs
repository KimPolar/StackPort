#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod data_location;
use data_location::{DataLocation, DataMode, RuntimeInfo};

use stackport_core::{database_exchange, oracle, snowflake, sql_server, RelationalObjectSearch};
use stackport_core::{SqlParameterPlan, SqlParameterSet, SqlParameterSetScope, SqlParameterSetSummary, SqlParameterSetWrite};
use stackport_core::{
    ArchivedProject, AuditPage, BackupReport, CsvOptions, DatabaseObject, DiagramTable, EditInput, EditKey, EditPreview, EditResult, ExportQuery,
    EditCellChange, EditRowPreview, EditRowResult,
    EditGridChange, EditGridPreview, EditGridResult, EditGridSession,
    parse_json_import, JsonImportTable,
    list_local_directory, list_local_tree, local_ports, preview_local_file, save_merged_text, BrowseDirectory, ComparedFile, EditSession, FileContentComparison, FilePreview, FolderTree, NetworkDiagnostics, NetworkManager,
    ObjectDetails, PortSnapshot, Profile, Project, QueryOutcome, RemotePath, SchemaComparison, SchemaComparisonConnection, SchemaDocumentFormat, SchemaDocumentReport, SchemaSyncPreview, SchemaSyncReport,
    RdpAvailability, RdpManager, RdpRequest, RdpSession,
    RestorePreview, RestoreReport, RouteDiagnostic, RouteFamily, RouteTool, SqlCompletionCatalog, SqlDiagnostics, SqlParameterValue, SshAuthentication,
    RowChange, RowChangePreview, RowChangeResult, RowChangeSession, RowInsertField, RowPastePreview, RowPasteResult,
    SshHostInfo, SshManager, SshProfile, SshProfileExportReport, SshProfileImportPreview,
    save_terminal_output, save_text_draft, SftpAuthentication, SftpDeletePreview, SftpEditDocument, SftpEditSave, SftpEntrySource, SftpMutationReport, SftpTransferReport, SftpTransferProgress, SftpManager,
    open_sql_file_with_encoding, save_sql_definition, save_sql_file, sqlite_statement_at, SftpPermissionChange, SqlDocument, SqlFileEncoding, SqlTemplate, SqlTemplateSummary, SqlTemplateWrite,
    RoutedSftpOpened, SftpOpened, SshCredentials, SshProfileInput, SshRouteHop, SshRouteResult, SshTrustPage, Store, TableQuery, TableQueryClauses, TableQueryPreset, TableQueryPresetWrite, TableQueryTarget, TerminalInfo, MAX_SSH_HOPS,
    SavedSshTunnel, SshTunnelInput, SshTunnelManager, SshTunnelStatus,
    LocalTunnelEndpoint, PostgresExportOptions, PostgresManager, PostgresObjectPage, PostgresPage, PostgresPassword, PostgresProfile, PostgresProfileInput, PostgresSchemaPage, PostgresSessionInfo, PostgresSqlBindings, PostgresSqlInput, PostgresSqlMode, PostgresSqlOutcome, PostgresSqlScope, PostgresStructure, PostgresStructureSection,
    PostgresCellChange, PostgresDisconnect, PostgresEditField, PostgresEditInput, PostgresEditOutcome, PostgresEditPreview, PostgresEditSession, PostgresRowEditPreview, PostgresRowStamp,
    PostgresGridEditChange, PostgresGridEditOutcome, PostgresGridEditPreview, PostgresGridEditSession,
    PostgresRowChange, PostgresRowChangeOutcome,
    PostgresActivityInput, PostgresActivitySnapshot, PostgresSearchInput, PostgresSearchPage, PostgresStatementStats, PostgresStatementStatsInput,
    PostgresValuePage, PostgresValueRepresentation, PostgresValueSave, PostgresValueTarget,
    PostgresGridLayout,
    SavedSyncProfile, SyncPlan, SyncProfileInput, SyncProgress, SyncReport,
    SyncDeleteInput, SyncDeletePreview,
    TerminalManager, TerminalOutputFormat, TerminalRead, TextLineEnding,
    WebDiagnostic, WebMethod, WorkspaceCopyPreview, WorkspaceCopyReport, WorkspaceResume,
    WorkspaceResumeRecord, WorkspaceResumeWrite,
    FavoriteScope, FavoriteTarget, WorkspaceFavorite, PostgresCatalogObject,
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
async fn get_workspace_resume(store: State<'_, Store>) -> Result<WorkspaceResumeRecord, String> {
    let store = store.inner().clone();
    worker(move || store.workspace_resume()).await
}

#[tauri::command]
async fn list_workspace_favorites(store: State<'_, Store>, project_id: String) -> Result<Vec<WorkspaceFavorite>, String> {
    let store = store.inner().clone();
    worker(move || store.list_workspace_favorites(&project_id)).await
}

#[tauri::command]
async fn set_workspace_favorite(
    store: State<'_, Store>, postgres: State<'_, PostgresManager>, project_id: String,
    scope: FavoriteScope, target: FavoriteTarget, present: bool, session_id: Option<String>,
) -> Result<(), String> {
    if present {
        if let FavoriteTarget::PostgresObject { profile_id, schema_name, object_name } = &target {
            let session = session_id.as_deref().ok_or("PostgreSQL에 연결한 뒤 객체를 고정하세요.")?;
            postgres.resolve_catalog_object(session, profile_id, schema_name, object_name).await?;
        }
    }
    let store = store.inner().clone();
    worker(move || store.set_workspace_favorite(&project_id, scope, &target, present)).await
}

#[tauri::command]
async fn save_workspace_resume(
    store: State<'_, Store>,
    expected_revision: i64,
    state: WorkspaceResume,
) -> Result<WorkspaceResumeWrite, String> {
    let store = store.inner().clone();
    worker(move || store.save_workspace_resume(expected_revision, state)).await
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
async fn sqlite_schema_diagram(store: State<'_, Store>, profile_id: String) -> Result<Vec<DiagramTable>, String> {
    let store = store.inner().clone();
    worker(move || store.schema_diagram(&profile_id)).await
}

#[tauri::command]
async fn compare_sqlite_schema(store: State<'_, Store>, source_id: String, target_id: String) -> Result<SchemaComparison, String> {
    let store = store.inner().clone();
    worker(move || store.compare_sqlite_schema(&source_id, &target_id)).await
}

#[tauri::command]
async fn schema_comparison_connections(store: State<'_, Store>) -> Result<Vec<SchemaComparisonConnection>, String> {
    let store = store.inner().clone();
    worker(move || store.schema_comparison_connections()).await
}

#[tauri::command]
async fn preview_schema_sync(store: State<'_, Store>, source_id: String, target_id: String, objects: Vec<String>) -> Result<SchemaSyncPreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_schema_sync(&source_id, &target_id, &objects)).await
}

#[tauri::command]
async fn cancel_schema_sync(store: State<'_, Store>, token: String) -> Result<(), String> {
    store.cancel_schema_sync(&token)
}

#[tauri::command]
async fn apply_schema_sync(
    store: State<'_, Store>, token: String, destination: String, confirmed: bool, production: String,
) -> Result<SchemaSyncReport, String> {
    let store = store.inner().clone();
    worker(move || store.apply_schema_sync(&token, &destination, confirmed, &production)).await
}

#[tauri::command]
async fn choose_sqlite_schema_document_path(format: SchemaDocumentFormat) -> Result<Option<String>, String> {
    worker(move || {
        let extension = format.extension();
        let label = match format { SchemaDocumentFormat::Markdown => "Markdown", SchemaDocumentFormat::Html => "HTML" };
        Ok(rfd::FileDialog::new()
            .set_title("SQLite 데이터 사전을 새 파일로 저장")
            .set_file_name(format!("StackPort-schema.{extension}"))
            .add_filter(label, &[extension])
            .save_file()
            .map(|path| path.to_string_lossy().into_owned()))
    }).await
}

#[tauri::command]
async fn export_sqlite_schema_document(
    store: State<'_, Store>, profile_id: String, object: Option<String>, format: SchemaDocumentFormat, destination: String,
) -> Result<SchemaDocumentReport, String> {
    let store = store.inner().clone();
    worker(move || store.export_schema_document(&profile_id, object.as_deref(), format, &destination)).await
}

#[tauri::command]
async fn sql_completion_catalog(
    store: State<'_, Store>, profile_id: String, prefix: String, sources: Vec<String>,
) -> Result<SqlCompletionCatalog, String> {
    let store = store.inner().clone();
    worker(move || store.sql_completion_catalog(&profile_id, &prefix, sources)).await
}

#[tauri::command]
async fn diagnose_sql(store: State<'_, Store>, profile_id: String, sql: String) -> Result<SqlDiagnostics, String> {
    let store = store.inner().clone();
    worker(move || store.diagnose_sql(&profile_id, &sql)).await
}

#[tauri::command]
async fn validate_sql_alias_rename(
    store: State<'_, Store>, profile_id: String, original: String, changed: String,
) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.validate_sql_alias_rename(&profile_id, &original, &changed)).await
}

#[tauri::command]
fn prepare_query(store: State<'_, Store>) -> Result<String, String> {
    store.prepare_query()
}

#[tauri::command]
async fn current_sql_statement(sql: String, caret: usize) -> Result<Option<String>, String> {
    worker(move || sqlite_statement_at(&sql, caret).map(|statement| statement.map(str::to_owned))).await
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
    document: Option<bool>,
) -> Result<QueryOutcome, String> {
    let store = store.inner().clone();
    worker(move || {
        let parameters = parameters.as_deref();
        if explain.unwrap_or(false) {
            store.explain_prepared(&token, &profile_id, &sql, parameters)
        } else if document.unwrap_or(false) {
            store.query_document_prepared(&token, &profile_id, &sql, parameters)
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
async fn preview_sqlite_row_edit(store: State<'_, Store>, token: String, changes: Vec<EditCellChange>) -> Result<EditRowPreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_row_edit(&token, changes)).await
}

#[tauri::command]
async fn apply_sqlite_row_edit(store: State<'_, Store>, token: String, approval: String, production_confirmation: String) -> Result<EditRowResult, String> {
    let store = store.inner().clone();
    worker(move || store.apply_row_edit(&token, &approval, &production_confirmation)).await
}

#[tauri::command]
async fn begin_sqlite_grid_edit(
    store: State<'_, Store>,
    profile_id: String,
    table: String,
    rows: Vec<Vec<EditKey>>,
) -> Result<EditGridSession, String> {
    let store = store.inner().clone();
    worker(move || store.begin_grid_edit(&profile_id, &table, rows)).await
}

#[tauri::command]
async fn preview_sqlite_grid_edit(
    store: State<'_, Store>,
    token: String,
    changes: Vec<EditGridChange>,
) -> Result<EditGridPreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_grid_edit(&token, changes)).await
}

#[tauri::command]
async fn apply_sqlite_grid_edit(
    store: State<'_, Store>,
    token: String,
    approval: String,
    production_confirmation: String,
) -> Result<EditGridResult, String> {
    let store = store.inner().clone();
    worker(move || store.apply_grid_edit(&token, &approval, &production_confirmation)).await
}

#[tauri::command]
async fn begin_row_change(store: State<'_, Store>, profile_id: String, table: String, change: RowChange) -> Result<RowChangeSession, String> {
    let store = store.inner().clone();
    worker(move || store.begin_row_change(&profile_id, &table, change)).await
}

#[tauri::command]
async fn inspect_json_import(source: String) -> Result<JsonImportTable, String> {
    worker(move || parse_json_import(&source)).await
}

#[tauri::command]
async fn preview_sqlite_json_import(
    store: State<'_, Store>,
    token: String,
    columns: Vec<String>,
    rows: Vec<Vec<RowInsertField>>,
) -> Result<RowPastePreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_json_import(&token, columns, rows)).await
}

#[tauri::command]
async fn preview_row_insert(store: State<'_, Store>, token: String, fields: Vec<RowInsertField>) -> Result<RowChangePreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_row_insert(&token, fields)).await
}

#[tauri::command]
async fn apply_row_change(store: State<'_, Store>, token: String, approval: String, confirmation: String) -> Result<RowChangeResult, String> {
    let store = store.inner().clone();
    worker(move || store.apply_row_change(&token, &approval, &confirmation)).await
}

#[tauri::command]
async fn preview_row_paste(store: State<'_, Store>, token: String, columns: Vec<String>, rows: Vec<Vec<RowInsertField>>) -> Result<RowPastePreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_row_paste(&token, columns, rows)).await
}

#[tauri::command]
async fn apply_row_paste(store: State<'_, Store>, token: String, approval: String, confirmation: String) -> Result<RowPasteResult, String> {
    let store = store.inner().clone();
    worker(move || store.apply_row_paste(&token, &approval, &confirmation)).await
}

#[tauri::command]
async fn cancel_row_change(store: State<'_, Store>, token: String) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.cancel_row_change(&token)).await
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
async fn open_routed_sftp(
    store: State<'_, Store>,
    ssh: State<'_, Arc<SshManager>>,
    sftp: State<'_, SftpManager>,
    profile: SshProfile,
    confirmation: String,
    authentication: SshCredentials,
    hops: Vec<SshRouteHop>,
) -> Result<RoutedSftpOpened, String> {
    let (destination, hops) = confirmed_ssh_route(store.inner().clone(), profile, confirmation, authentication, hops).await?;
    sftp.open_routed(Arc::clone(ssh.inner()), destination, hops).await
}

#[tauri::command]
async fn open_routed_ssh_terminal(
    store: State<'_, Store>,
    ssh: State<'_, Arc<SshManager>>,
    terminals: State<'_, Arc<TerminalManager>>,
    profile: SshProfile,
    confirmation: String,
    authentication: SshCredentials,
    hops: Vec<SshRouteHop>,
    rows: u16,
    cols: u16,
) -> Result<SshRouteResult<TerminalInfo>, String> {
    let (destination, hops) = confirmed_ssh_route(store.inner().clone(), profile, confirmation, authentication, hops).await?;
    terminals.open_routed_ssh(Arc::clone(ssh.inner()), destination, hops, rows, cols).await
}

async fn confirmed_ssh_route(
    store: Store,
    profile: SshProfile,
    confirmation: String,
    authentication: SshCredentials,
    mut hops: Vec<SshRouteHop>,
) -> Result<(SshRouteHop, Vec<SshRouteHop>), String> {
    worker(move || {
        if !(1..=MAX_SSH_HOPS).contains(&hops.len()) {
            return Err(format!("경유 서버를 1~{MAX_SSH_HOPS}개 선택하세요."));
        }
        let profile = confirmed_ssh_profile(&store, &profile, &confirmation)
            .map_err(|error| format!("대상 · {} — {error}", profile.name))?;
        for (index, hop) in hops.iter_mut().enumerate() {
            hop.profile = confirmed_ssh_profile(&store, &hop.profile, &confirmation)
                .map_err(|error| format!("경유 {} · {} — {error}", index + 1, hop.profile.name))?;
        }
        Ok((SshRouteHop { profile, authentication }, hops))
    }).await
}

#[tauri::command]
async fn list_ssh_tunnels(store: State<'_, Store>, project_id: String) -> Result<Vec<SavedSshTunnel>, String> {
    let store = store.inner().clone();
    worker(move || store.list_ssh_tunnels(&project_id)).await
}

#[tauri::command]
async fn list_postgres_profiles(store: State<'_, Store>, project_id: String) -> Result<Vec<PostgresProfile>, String> {
    let store = store.inner().clone();
    worker(move || store.list_postgres_profiles(&project_id)).await
}

#[tauri::command]
async fn list_redis_profiles(store: State<'_, Store>, project_id: String) -> Result<Vec<stackport_core::RedisProfile>, String> {
    let store = store.inner().clone();
    worker(move || store.list_redis_profiles(&project_id)).await
}

#[tauri::command]
async fn list_mongo_profiles(store: State<'_, Store>, project_id: String) -> Result<Vec<stackport_core::MongoProfile>, String> {
    let store = store.inner().clone();
    worker(move || store.list_mongo_profiles(&project_id)).await
}

#[tauri::command]
async fn create_mongo_profile(store: State<'_, Store>, project_id: String, input: stackport_core::MongoSettings) -> Result<stackport_core::MongoProfile, String> {
    let store = store.inner().clone();
    worker(move || store.create_mongo_profile(&project_id, input)).await
}

#[tauri::command]
async fn update_mongo_profile(store: State<'_, Store>, id: String, revision: i64, input: stackport_core::MongoSettings) -> Result<stackport_core::MongoProfile, String> {
    let store = store.inner().clone();
    worker(move || store.update_mongo_profile(&id, revision, input)).await
}

#[tauri::command]
async fn delete_mongo_profile(store: State<'_, Store>, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_mongo_profile(&id, revision)).await
}

#[tauri::command]
async fn open_mongo(mongo: State<'_, stackport_core::MongoManager>, profile_id: String, revision: i64,
    password: stackport_core::MongoPassword, confirmation: String, allow_edits: Option<bool>) -> Result<stackport_core::MongoSessionInfo, String> {
    mongo.open(profile_id, revision, password, &confirmation, allow_edits.unwrap_or_default()).await
}

#[tauri::command]
async fn close_mongo(mongo: State<'_, stackport_core::MongoManager>, id: String) -> Result<(), String> {
    mongo.close(&id).await
}

#[tauri::command]
async fn mongo_databases(mongo: State<'_, stackport_core::MongoManager>, id: String, search: String, page: u32)
    -> Result<stackport_core::MongoCatalogPage<String>, String> { mongo.databases(&id, &search, page).await }

#[tauri::command]
async fn mongo_collections(mongo: State<'_, stackport_core::MongoManager>, id: String, database: String, search: String, page: u32)
    -> Result<stackport_core::MongoCatalogPage<stackport_core::MongoCollection>, String> { mongo.collections(&id, &database, &search, page).await }

#[tauri::command]
async fn mongo_indexes(mongo: State<'_, stackport_core::MongoManager>, id: String, database: String, collection: String)
    -> Result<stackport_core::MongoCatalogPage<stackport_core::MongoIndex>, String> { mongo.indexes(&id, &database, &collection).await }

#[tauri::command]
async fn mongo_documents(mongo: State<'_, stackport_core::MongoManager>, id: String, database: String, collection: String, query: stackport_core::MongoQuery)
    -> Result<stackport_core::MongoDocumentPage, String> { mongo.documents(&id, &database, &collection, query).await }

#[tauri::command]
async fn begin_mongo_document_edit(mongo: State<'_, stackport_core::MongoManager>, id: String, database: String, collection: String, change: stackport_core::MongoDocumentChange)
    -> Result<stackport_core::MongoEditDraft, String> { mongo.begin_document_edit(&id, database, collection, change).await }

#[tauri::command]
async fn review_mongo_document_edit(mongo: State<'_, stackport_core::MongoManager>, id: String, token: String, input: String)
    -> Result<stackport_core::MongoEditReview, String> { mongo.review_document_edit(&id, &token, &input).await }

#[tauri::command]
async fn apply_mongo_document_edit(mongo: State<'_, stackport_core::MongoManager>, id: String, token: String, approval: String, confirmation: String)
    -> Result<stackport_core::MongoEditReport, String> { mongo.apply_document_edit(&id, &token, &approval, &confirmation).await }

#[tauri::command]
async fn discard_mongo_document_edit(mongo: State<'_, stackport_core::MongoManager>, id: String, token: String)
    -> Result<(), String> { mongo.discard_document_edit(&id, &token).await }

#[tauri::command]
async fn mongo_schema_sample(mongo: State<'_, stackport_core::MongoManager>, id: String, database: String, collection: String, sample_size: u32)
    -> Result<stackport_core::MongoSchemaSample, String> { mongo.schema_sample(&id, &database, &collection, sample_size).await }

#[tauri::command]
async fn mongo_pipeline_preview(mongo: State<'_, stackport_core::MongoManager>, id: String, database: String, collection: String, request: stackport_core::MongoPipelinePreview)
    -> Result<stackport_core::MongoDocumentPage, String> { mongo.preview_pipeline(&id, &database, &collection, request).await }

#[tauri::command]
async fn list_mongo_pipelines(store: State<'_, Store>, project_id: String) -> Result<Vec<stackport_core::MongoPipelineSummary>, String> {
    let store = store.inner().clone();
    worker(move || store.list_mongo_pipelines(&project_id)).await
}

#[tauri::command]
async fn read_mongo_pipeline(store: State<'_, Store>, project_id: String, id: String) -> Result<stackport_core::SavedMongoPipeline, String> {
    let store = store.inner().clone();
    worker(move || store.read_mongo_pipeline(&project_id, &id)).await
}

#[tauri::command]
async fn save_mongo_pipeline(store: State<'_, Store>, project_id: String, write: stackport_core::MongoPipelineWrite) -> Result<stackport_core::SavedMongoPipeline, String> {
    let store = store.inner().clone();
    worker(move || store.save_mongo_pipeline(&project_id, write)).await
}

#[tauri::command]
async fn delete_mongo_pipeline(store: State<'_, Store>, project_id: String, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_mongo_pipeline(&project_id, &id, revision)).await
}

#[tauri::command]
async fn list_sql_server_profiles(store: State<'_, Store>, project_id: String) -> Result<Vec<sql_server::Profile>, String> {
    let store = store.inner().clone();
    worker(move || store.list_sql_server_profiles(&project_id)).await
}

#[tauri::command]
async fn create_sql_server_profile(store: State<'_, Store>, project_id: String, input: sql_server::ProfileSettings) -> Result<sql_server::Profile, String> {
    let store = store.inner().clone();
    worker(move || store.create_sql_server_profile(&project_id, input)).await
}

#[tauri::command]
async fn update_sql_server_profile(store: State<'_, Store>, id: String, revision: i64, input: sql_server::ProfileSettings) -> Result<sql_server::Profile, String> {
    let store = store.inner().clone();
    worker(move || store.update_sql_server_profile(&id, revision, input)).await
}

#[tauri::command]
async fn delete_sql_server_profile(store: State<'_, Store>, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_sql_server_profile(&id, revision)).await
}

#[tauri::command]
async fn open_sql_server(manager: State<'_, sql_server::Manager>, profile_id: String, revision: i64,
    password: sql_server::Password, confirmation: String) -> Result<sql_server::SessionInfo, String> {
    manager.open(profile_id, revision, password, &confirmation).await
}

#[tauri::command]
fn close_sql_server(manager: State<'_, sql_server::Manager>, id: String) -> Result<(), String> {
    manager.close(&id)
}

#[tauri::command]
async fn sql_server_schemas(manager: State<'_, sql_server::Manager>, id: String, search: String, page: u32)
    -> Result<sql_server::CatalogPage<String>, String> { manager.schemas(&id, &search, page).await }

#[tauri::command]
async fn sql_server_objects(manager: State<'_, sql_server::Manager>, id: String, schema: String, search: String, page: u32)
    -> Result<sql_server::CatalogPage<sql_server::Object>, String> { manager.objects(&id, &schema, &search, page).await }

#[tauri::command]
async fn sql_server_search_objects(manager: State<'_, sql_server::Manager>, id: String, input: RelationalObjectSearch)
    -> Result<sql_server::CatalogPage<sql_server::Object>, String> { manager.search_objects(&id, input).await }

#[tauri::command]
async fn sql_server_columns(manager: State<'_, sql_server::Manager>, id: String, object: i32)
    -> Result<sql_server::CatalogPage<sql_server::Column>, String> { manager.columns(&id, object).await }

#[tauri::command]
async fn sql_server_structure(manager: State<'_, sql_server::Manager>, id: String, object: i32,
    section: sql_server::StructureSection, page: u32) -> Result<sql_server::Structure, String> {
    manager.structure(&id, object, section, page).await
}

#[tauri::command]
async fn sql_server_definition(manager: State<'_, sql_server::Manager>, id: String, object: i32) -> Result<String, String> {
    manager.definition(&id, object).await
}

#[tauri::command]
async fn sql_server_data(manager: State<'_, sql_server::Manager>, id: String, object: i32, page: u32, clauses: Option<TableQueryClauses>)
    -> Result<sql_server::DataPage, String> { manager.data(&id, object, page, clauses.unwrap_or_default()).await }

#[derive(serde::Serialize)]
#[serde(untagged)]
enum ParameterDiscovery<T> {
    Plain(T),
    Scoped(SqlParameterPlan<T>),
}

#[tauri::command]
fn sql_server_query_parameters(input: sql_server::QueryInput, with_scope: Option<bool>) -> Result<ParameterDiscovery<Vec<u16>>, String> {
    if with_scope.unwrap_or(false) {
        input.parameter_plan().map(ParameterDiscovery::Scoped)
    } else {
        input.parameter_indexes().map(ParameterDiscovery::Plain)
    }
}

#[tauri::command]
fn sql_server_query_review(input: sql_server::QueryInput) -> Result<stackport_core::SqlExecutionReview, String> {
    input.review()
}

#[tauri::command]
async fn run_sql_server_query(manager: State<'_, sql_server::Manager>, id: String, request_id: String,
    input: sql_server::QueryInput) -> Result<sql_server::QueryOutcome, String> {
    manager.run_query(&id, &request_id, input).await
}

#[tauri::command]
fn cancel_sql_server_query(manager: State<'_, sql_server::Manager>, id: String, request_id: String) -> Result<bool, String> {
    manager.cancel_query(&id, &request_id)
}

#[tauri::command]
async fn export_sql_server(manager: State<'_, sql_server::Manager>, id: String, request_id: String,
    object: i32, clauses: TableQueryClauses, options: sql_server::ExportOptions) -> Result<sql_server::ExportOutcome, String> {
    manager.export(&id, request_id, object, clauses, options).await
}

#[tauri::command]
fn sql_server_export_progress(manager: State<'_, sql_server::Manager>, id: String, request_id: String) -> Result<Option<u64>, String> {
    manager.export_progress(&id, &request_id)
}

#[tauri::command]
fn cancel_sql_server_export(manager: State<'_, sql_server::Manager>, id: String, request_id: String) -> Result<bool, String> {
    manager.cancel_export(&id, &request_id)
}

#[tauri::command]
async fn list_oracle_profiles(store: State<'_, Store>, project_id: String) -> Result<Vec<oracle::Profile>, String> {
    let store = store.inner().clone();
    worker(move || store.list_oracle_profiles(&project_id)).await
}

#[tauri::command]
async fn create_oracle_profile(store: State<'_, Store>, project_id: String, input: oracle::ProfileSettings) -> Result<oracle::Profile, String> {
    let store = store.inner().clone();
    worker(move || store.create_oracle_profile(&project_id, input)).await
}

#[tauri::command]
async fn update_oracle_profile(store: State<'_, Store>, id: String, revision: i64, input: oracle::ProfileSettings) -> Result<oracle::Profile, String> {
    let store = store.inner().clone();
    worker(move || store.update_oracle_profile(&id, revision, input)).await
}

#[tauri::command]
async fn delete_oracle_profile(store: State<'_, Store>, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_oracle_profile(&id, revision)).await
}

#[tauri::command]
async fn open_oracle(manager: State<'_, oracle::Manager>, profile_id: String, revision: i64,
    password: oracle::Password, confirmation: String) -> Result<oracle::SessionInfo, String> {
    manager.open(profile_id, revision, password, confirmation).await
}

#[tauri::command]
async fn close_oracle(manager: State<'_, oracle::Manager>, id: String) -> Result<(), String> {
    manager.close(&id)
}

#[tauri::command]
async fn oracle_schemas(manager: State<'_, oracle::Manager>, id: String, search: String, page: u32)
    -> Result<oracle::CatalogPage<String>, String> { manager.schemas(&id, search, page).await }

#[tauri::command]
async fn oracle_objects(manager: State<'_, oracle::Manager>, id: String, schema: String, search: String, page: u32)
    -> Result<oracle::CatalogPage<oracle::Object>, String> { manager.objects(&id, schema, search, page).await }

#[tauri::command]
async fn oracle_search_objects(manager: State<'_, oracle::Manager>, id: String, input: RelationalObjectSearch)
    -> Result<oracle::CatalogPage<oracle::Object>, String> { manager.search_objects(&id, input).await }

#[tauri::command]
async fn oracle_columns(manager: State<'_, oracle::Manager>, id: String, object: i64)
    -> Result<oracle::CatalogPage<oracle::Column>, String> { manager.columns(&id, object).await }

#[tauri::command]
async fn oracle_definition(manager: State<'_, oracle::Manager>, id: String, object: i64) -> Result<String, String> {
    manager.definition(&id, object).await
}

#[tauri::command]
async fn oracle_data(manager: State<'_, oracle::Manager>, id: String, object: i64, page: u32, clauses: Option<TableQueryClauses>)
    -> Result<oracle::DataPage, String> { manager.data(&id, object, page, clauses.unwrap_or_default()).await }

#[tauri::command]
fn oracle_query_review(input: oracle::QuerySource) -> Result<stackport_core::SqlExecutionReview, String> {
    input.review()
}

#[tauri::command]
async fn run_oracle_query(manager: State<'_, oracle::Manager>, id: String, request_id: String,
    input: oracle::QueryInput) -> Result<oracle::QueryOutcome, String> {
    manager.run_query(&id, &request_id, input).await
}

#[tauri::command]
async fn oracle_query_parameters(manager: State<'_, oracle::Manager>, id: String,
    input: oracle::QuerySource, with_scope: Option<bool>) -> Result<ParameterDiscovery<Vec<String>>, String> {
    if with_scope.unwrap_or(false) {
        manager.query_parameter_plan(&id, input).await.map(ParameterDiscovery::Scoped)
    } else {
        manager.query_parameters(&id, input).await.map(ParameterDiscovery::Plain)
    }
}

#[tauri::command]
fn cancel_oracle_query(manager: State<'_, oracle::Manager>, id: String, request_id: String) -> Result<bool, String> {
    manager.cancel_query(&id, &request_id)
}

#[tauri::command]
async fn export_oracle(manager: State<'_, oracle::Manager>, id: String, request_id: String, object: i64,
    clauses: TableQueryClauses, options: oracle::ExportOptions) -> Result<oracle::ExportOutcome, String> {
    manager.export(&id, request_id, object, clauses, options).await
}

#[tauri::command]
fn oracle_export_progress(manager: State<'_, oracle::Manager>, id: String, request_id: String) -> Result<Option<u64>, String> {
    manager.export_progress(&id, &request_id)
}

#[tauri::command]
fn cancel_oracle_export(manager: State<'_, oracle::Manager>, id: String, request_id: String) -> Result<bool, String> {
    manager.cancel_export(&id, &request_id)
}

#[tauri::command]
async fn list_snowflake_profiles(store: State<'_, Store>, project_id: String) -> Result<Vec<snowflake::Profile>, String> {
    let store = store.inner().clone();
    worker(move || store.list_snowflake_profiles(&project_id)).await
}

#[tauri::command]
async fn create_snowflake_profile(store: State<'_, Store>, project_id: String, input: snowflake::ProfileSettings) -> Result<snowflake::Profile, String> {
    let store = store.inner().clone();
    worker(move || store.create_snowflake_profile(&project_id, input)).await
}

#[tauri::command]
async fn update_snowflake_profile(store: State<'_, Store>, id: String, revision: i64, input: snowflake::ProfileSettings) -> Result<snowflake::Profile, String> {
    let store = store.inner().clone();
    worker(move || store.update_snowflake_profile(&id, revision, input)).await
}

#[tauri::command]
async fn delete_snowflake_profile(store: State<'_, Store>, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_snowflake_profile(&id, revision)).await
}

#[tauri::command]
async fn open_snowflake(manager: State<'_, snowflake::Manager>, profile_id: String, revision: i64,
    token: snowflake::AccessToken, confirmation: String) -> Result<snowflake::SessionInfo, String> {
    manager.open(profile_id, revision, token, confirmation).await
}

#[tauri::command]
async fn close_snowflake(manager: State<'_, snowflake::Manager>, id: String) -> Result<(), String> {
    manager.close(&id)
}

#[tauri::command]
async fn snowflake_schemas(manager: State<'_, snowflake::Manager>, id: String, search: String, page: u32)
    -> Result<snowflake::CatalogPage<String>, String> { manager.schemas(&id, search, page).await }

#[tauri::command]
async fn snowflake_objects(manager: State<'_, snowflake::Manager>, id: String, schema: String, search: String, page: u32)
    -> Result<snowflake::CatalogPage<snowflake::Object>, String> { manager.objects(&id, schema, search, page).await }

#[tauri::command]
async fn snowflake_search_objects(manager: State<'_, snowflake::Manager>, id: String, input: RelationalObjectSearch)
    -> Result<snowflake::CatalogPage<snowflake::Object>, String> { manager.search_objects(&id, input).await }

#[tauri::command]
async fn snowflake_columns(manager: State<'_, snowflake::Manager>, id: String, object: String)
    -> Result<snowflake::CatalogPage<snowflake::Column>, String> { manager.columns(&id, object).await }

#[tauri::command]
async fn snowflake_definition(manager: State<'_, snowflake::Manager>, id: String, object: String) -> Result<String, String> {
    manager.definition(&id, object).await
}

#[tauri::command]
async fn snowflake_data(manager: State<'_, snowflake::Manager>, id: String, object: String, page: u32, clauses: Option<TableQueryClauses>)
    -> Result<snowflake::DataPage, String> { manager.data(&id, object, page, clauses.unwrap_or_default()).await }

#[tauri::command]
fn snowflake_query_review(input: snowflake::QuerySource) -> Result<stackport_core::SqlExecutionReview, String> {
    input.review()
}

#[tauri::command]
async fn run_snowflake_query(manager: State<'_, snowflake::Manager>, id: String, request_id: String,
    input: snowflake::QueryInput) -> Result<snowflake::QueryOutcome, String> {
    manager.run_query(&id, &request_id, input).await
}

#[tauri::command]
fn snowflake_query_parameters(input: snowflake::QuerySource, with_scope: Option<bool>) -> Result<ParameterDiscovery<usize>, String> {
    if with_scope.unwrap_or(false) {
        input.parameter_plan().map(ParameterDiscovery::Scoped)
    } else {
        input.parameter_count().map(ParameterDiscovery::Plain)
    }
}

#[tauri::command]
fn cancel_snowflake_query(manager: State<'_, snowflake::Manager>, id: String, request_id: String) -> Result<bool, String> {
    manager.cancel_query(&id, &request_id)
}

#[tauri::command]
async fn export_snowflake(manager: State<'_, snowflake::Manager>, id: String, request_id: String, object: String,
    clauses: TableQueryClauses, options: snowflake::ExportOptions) -> Result<snowflake::ExportOutcome, String> {
    manager.export(&id, request_id, object, clauses, options).await
}

#[tauri::command]
fn snowflake_export_progress(manager: State<'_, snowflake::Manager>, id: String, request_id: String) -> Result<Option<u64>, String> {
    manager.export_progress(&id, &request_id)
}

#[tauri::command]
fn cancel_snowflake_export(manager: State<'_, snowflake::Manager>, id: String, request_id: String) -> Result<bool, String> {
    manager.cancel_export(&id, &request_id)
}

#[tauri::command]
async fn list_mysql_profiles(store: State<'_, Store>, project_id: String) -> Result<Vec<stackport_core::MysqlProfile>, String> {
    let store = store.inner().clone();
    worker(move || store.list_mysql_profiles(&project_id)).await
}

#[tauri::command]
async fn create_mysql_profile(store: State<'_, Store>, project_id: String, input: stackport_core::MysqlSettings)
    -> Result<stackport_core::MysqlProfile, String> {
    let store = store.inner().clone();
    worker(move || store.create_mysql_profile(&project_id, input)).await
}

#[tauri::command]
async fn update_mysql_profile(store: State<'_, Store>, id: String, revision: i64, input: stackport_core::MysqlSettings)
    -> Result<stackport_core::MysqlProfile, String> {
    let store = store.inner().clone();
    worker(move || store.update_mysql_profile(&id, revision, input)).await
}

#[tauri::command]
async fn delete_mysql_profile(store: State<'_, Store>, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_mysql_profile(&id, revision)).await
}

#[tauri::command]
async fn mysql_tunnel_options(store: State<'_, Store>, tunnels: State<'_, SshTunnelManager>, profile_id: String,
    revision: i64) -> Result<Vec<LocalTunnelEndpoint>, String> {
    let store = store.inner().clone();
    let profile = worker(move || store.mysql_profile(&profile_id, revision)).await?;
    tunnels.local_database_routes(&profile.project_id, &profile.settings.host, profile.settings.port)
}

#[tauri::command]
async fn open_mysql(mysql: State<'_, stackport_core::MysqlManager>, tunnels: State<'_, SshTunnelManager>, profile_id: String,
    revision: i64, password: stackport_core::MysqlPassword, confirmation: String, tunnel_id: Option<String>, grid_edit: Option<bool>,
) -> Result<stackport_core::MysqlSessionInfo, String> {
    let route = tunnel_id.as_deref().map(|id| (tunnels.inner(), id));
    mysql.open(profile_id, revision, password, &confirmation, route, grid_edit.unwrap_or_default()).await
}

#[tauri::command]
fn close_mysql(mysql: State<'_, stackport_core::MysqlManager>, id: String) -> Result<(), String> { mysql.close(&id) }

#[tauri::command]
async fn wait_mysql_tunnel_end(mysql: State<'_, stackport_core::MysqlManager>, id: String) -> Result<bool, String> {
    mysql.wait_tunnel_end(&id).await
}

#[tauri::command]
async fn mysql_databases(mysql: State<'_, stackport_core::MysqlManager>, id: String, search: String, page: u32)
    -> Result<stackport_core::MysqlCatalogPage<String>, String> { mysql.databases(&id, search, page).await }

#[tauri::command]
async fn mysql_objects(mysql: State<'_, stackport_core::MysqlManager>, id: String, database: String, search: String, page: u32)
    -> Result<stackport_core::MysqlCatalogPage<stackport_core::MysqlObject>, String> { mysql.objects(&id, database, search, page).await }

#[tauri::command]
async fn mysql_table(mysql: State<'_, stackport_core::MysqlManager>, id: String, database: String, table: String, include_rows: bool, grid: Option<stackport_core::MysqlGridQuery>)
    -> Result<stackport_core::MysqlTable, String> { mysql.table(&id, database, table, include_rows, grid).await }

#[tauri::command]
async fn preview_mysql_grid_edit(mysql: State<'_, stackport_core::MysqlManager>, id: String, database: String, table: String,
    stamp: stackport_core::MysqlRowStamp, changes: Vec<stackport_core::MysqlEditChange>) -> Result<stackport_core::MysqlEditPreview, String> {
    mysql.preview_grid_edit(&id, database, table, stamp, changes).await
}

#[tauri::command]
async fn apply_mysql_grid_edit(mysql: State<'_, stackport_core::MysqlManager>, id: String, token: String, confirmation: String,
) -> Result<stackport_core::MysqlEditOutcome, String> {
    mysql.apply_grid_edit(&id, &token, &confirmation).await
}

#[tauri::command]
async fn discard_mysql_grid_edit(mysql: State<'_, stackport_core::MysqlManager>, id: String, token: String) -> Result<(), String> {
    mysql.discard_grid_edit(&id, &token).await
}

#[tauri::command]
async fn mysql_structure(mysql: State<'_, stackport_core::MysqlManager>, id: String, database: String, table: String,
    section: stackport_core::MysqlStructureSection, page: u32)
    -> Result<stackport_core::MysqlStructure, String> { mysql.structure(&id, database, table, section, page).await }

#[tauri::command]
async fn open_mysql_monitor(mysql: State<'_, stackport_core::MysqlManager>, id: String) -> Result<String, String> {
    mysql.open_server_monitor(&id).await
}

#[tauri::command]
async fn close_mysql_monitor(mysql: State<'_, stackport_core::MysqlManager>, id: String, monitor_id: String) -> Result<(), String> {
    mysql.close_server_monitor(&id, &monitor_id).await
}

#[tauri::command]
async fn mysql_server_activity(mysql: State<'_, stackport_core::MysqlManager>, id: String, monitor_id: String,
    input: stackport_core::MysqlActivityInput) -> Result<stackport_core::MysqlActivitySnapshot, String> {
    mysql.server_activity(&id, &monitor_id, input).await
}

#[tauri::command]
async fn export_mysql(mysql: State<'_, stackport_core::MysqlManager>, id: String, request_id: String,
    source: stackport_core::MysqlExportSource, options: stackport_core::MysqlExportOptions)
    -> Result<stackport_core::MysqlExportOutcome, String> { mysql.export(&id, request_id, source, options).await }

#[tauri::command]
fn mysql_export_progress(mysql: State<'_, stackport_core::MysqlManager>, id: String, request_id: String)
    -> Result<Option<u64>, String> { mysql.export_progress(&id, &request_id) }

#[tauri::command]
fn mysql_sql_parameters(mysql: State<'_, stackport_core::MysqlManager>, id: String, sql: String, select_only: Option<bool>,
    with_scope: Option<bool>) -> Result<ParameterDiscovery<usize>, String> {
    let select_only = select_only.unwrap_or_default();
    if with_scope.unwrap_or(false) {
        mysql.sql_parameter_plan(&id, &sql, select_only).map(ParameterDiscovery::Scoped)
    } else {
        mysql.sql_parameters(&id, &sql, select_only).map(ParameterDiscovery::Plain)
    }
}

#[tauri::command]
fn mysql_script_parameters(mysql: State<'_, stackport_core::MysqlManager>, id: String, sql: String,
    scope: stackport_core::MysqlScriptScope, with_scope: Option<bool>) -> Result<ParameterDiscovery<usize>, String> {
    if with_scope.unwrap_or(false) {
        mysql.script_parameter_plan(&id, &sql, &scope).map(ParameterDiscovery::Scoped)
    } else {
        mysql.script_parameters(&id, &sql, &scope).map(ParameterDiscovery::Plain)
    }
}

#[tauri::command]
fn mysql_script_review(mysql: State<'_, stackport_core::MysqlManager>, id: String, sql: String,
    scope: stackport_core::MysqlScriptScope) -> Result<stackport_core::SqlExecutionReview, String> {
    mysql.script_review(&id, &sql, &scope)
}

#[tauri::command]
async fn run_mysql_script(mysql: State<'_, stackport_core::MysqlManager>, id: String, request_id: String,
    input: stackport_core::MysqlScriptInput) -> Result<stackport_core::MysqlScriptOutcome, String> {
    mysql.run_script(&id, &request_id, input).await
}

#[tauri::command]
async fn run_mysql_sql(mysql: State<'_, stackport_core::MysqlManager>, id: String, request_id: String,
    database: Option<String>, sql: String, parameters: Vec<stackport_core::MysqlSqlParameter>) -> Result<stackport_core::MysqlSqlResult, String> {
    mysql.run_sql(&id, request_id, database, sql, parameters).await
}

#[tauri::command]
async fn mysql_sql_plan(mysql: State<'_, stackport_core::MysqlManager>, id: String, request_id: String,
    database: Option<String>, sql: String, parameters: Vec<stackport_core::MysqlSqlParameter>, analyzed: bool,
) -> Result<stackport_core::MysqlPlan, String> {
    mysql.sql_plan(&id, request_id, database, sql, parameters, analyzed).await
}

#[tauri::command]
fn cancel_mysql_sql(mysql: State<'_, stackport_core::MysqlManager>, id: String, request_id: String) -> Result<bool, String> {
    mysql.cancel_sql(&id, &request_id)
}

#[tauri::command]
async fn create_redis_profile(store: State<'_, Store>, project_id: String, input: stackport_core::RedisSettings)
    -> Result<stackport_core::RedisProfile, String> {
    let store = store.inner().clone();
    worker(move || store.create_redis_profile(&project_id, input)).await
}

#[tauri::command]
async fn update_redis_profile(store: State<'_, Store>, id: String, revision: i64, input: stackport_core::RedisSettings)
    -> Result<stackport_core::RedisProfile, String> {
    let store = store.inner().clone();
    worker(move || store.update_redis_profile(&id, revision, input)).await
}

#[tauri::command]
async fn delete_redis_profile(store: State<'_, Store>, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_redis_profile(&id, revision)).await
}

#[tauri::command]
async fn open_redis(redis: State<'_, stackport_core::RedisManager>, profile_id: String, revision: i64,
    password: stackport_core::RedisPassword, confirmation: String, allow_edits: Option<bool>,
    allow_publish: Option<bool>,
) -> Result<stackport_core::RedisSessionInfo, String> {
    redis.open(profile_id, revision, password, &confirmation, allow_edits.unwrap_or(false), allow_publish.unwrap_or(false)).await
}

#[tauri::command]
fn close_redis(redis: State<'_, stackport_core::RedisManager>, id: String) -> Result<(), String> { redis.close(&id) }

#[tauri::command]
async fn redis_keys(redis: State<'_, stackport_core::RedisManager>, id: String, input: stackport_core::RedisScanInput)
    -> Result<stackport_core::RedisKeyPage, String> { redis.keys(&id, input).await }

#[tauri::command]
async fn redis_value(redis: State<'_, stackport_core::RedisManager>, id: String, input: stackport_core::RedisValueInput)
    -> Result<stackport_core::RedisValuePage, String> { redis.value(&id, input).await }

#[tauri::command]
async fn redis_server_snapshot(
    redis: State<'_, stackport_core::RedisManager>,
    id: String,
) -> Result<stackport_core::RedisServerSnapshot, String> {
    redis.server_snapshot(&id).await
}

#[tauri::command]
fn redis_console_commands() -> Vec<stackport_core::RedisConsoleCommand> {
    stackport_core::redis_console_commands()
}

#[tauri::command]
async fn redis_run_console(
    redis: State<'_, stackport_core::RedisManager>, id: String, line: String,
) -> Result<stackport_core::RedisConsoleResult, String> {
    redis.run_console(&id, line).await
}

#[tauri::command]
async fn redis_start_subscription(
    redis: State<'_, stackport_core::RedisManager>,
    id: String, name: String, pattern: bool, password: stackport_core::RedisPassword, confirmation: String,
) -> Result<String, String> {
    redis.start_subscription(&id, name, pattern, password, &confirmation).await
}

#[tauri::command]
async fn redis_subscription_snapshot(
    redis: State<'_, stackport_core::RedisManager>, id: String, subscription: String,
) -> Result<stackport_core::RedisSubscriptionSnapshot, String> {
    redis.subscription_snapshot(&id, &subscription).await
}

#[tauri::command]
async fn redis_clear_subscription_history(
    redis: State<'_, stackport_core::RedisManager>, id: String, subscription: String,
) -> Result<(), String> {
    redis.clear_subscription_history(&id, &subscription).await
}

#[tauri::command]
async fn redis_stop_subscription(
    redis: State<'_, stackport_core::RedisManager>, id: String, subscription: String,
) -> Result<(), String> {
    redis.stop_subscription(&id, &subscription).await
}

#[tauri::command]
async fn redis_publish_message(
    redis: State<'_, stackport_core::RedisManager>, id: String, channel: String, message: String, confirmed: bool, confirmation: String,
) -> Result<stackport_core::RedisPublishReport, String> {
    redis.publish_message(&id, channel, message, confirmed, &confirmation).await
}

#[tauri::command]
async fn preview_redis_edit(redis: State<'_, stackport_core::RedisManager>, id: String, key: String, input: stackport_core::RedisEditInput)
    -> Result<stackport_core::RedisEditPreview, String> { redis.preview_edit(&id, key, input).await }

#[tauri::command]
async fn discard_redis_edit(redis: State<'_, stackport_core::RedisManager>, id: String, token: String) -> Result<(), String> {
    redis.discard_edit(&id, &token).await
}

#[tauri::command]
async fn apply_redis_edit(redis: State<'_, stackport_core::RedisManager>, id: String, token: String, confirmation: String)
    -> Result<stackport_core::RedisEditReport, String> { redis.apply_edit(&id, &token, &confirmation).await }

#[tauri::command]
async fn preview_redis_key_delete(redis: State<'_, stackport_core::RedisManager>, id: String, keys: Vec<String>)
    -> Result<stackport_core::RedisKeyDeletePreview, String> { redis.preview_delete(&id, keys).await }

#[tauri::command]
async fn apply_redis_key_delete(redis: State<'_, stackport_core::RedisManager>, id: String, token: String, confirmation: String, approval: String)
    -> Result<stackport_core::RedisEditReport, String> { redis.apply_delete(&id, &token, &confirmation, &approval).await }

#[tauri::command]
async fn create_postgres_profile(store: State<'_, Store>, project_id: String, input: PostgresProfileInput) -> Result<PostgresProfile, String> {
    let store = store.inner().clone();
    worker(move || store.create_postgres_profile(&project_id, input)).await
}

#[tauri::command]
async fn update_postgres_profile(store: State<'_, Store>, id: String, revision: i64, input: PostgresProfileInput) -> Result<PostgresProfile, String> {
    let store = store.inner().clone();
    worker(move || store.update_postgres_profile(&id, revision, input)).await
}

#[tauri::command]
async fn delete_postgres_profile(store: State<'_, Store>, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_postgres_profile(&id, revision)).await
}

#[tauri::command]
fn postgres_tunnel_options(tunnels: State<'_, SshTunnelManager>, profile: PostgresProfile) -> Result<Vec<LocalTunnelEndpoint>, String> {
    tunnels.local_database_routes(&profile.project_id, &profile.settings.host, profile.settings.port)
}

#[tauri::command]
async fn open_postgres(
    postgres: State<'_, PostgresManager>, tunnels: State<'_, SshTunnelManager>, profile: PostgresProfile,
    password: PostgresPassword, confirmation: String, tunnel_id: Option<String>, grid_edit: Option<bool>,
) -> Result<PostgresSessionInfo, String> {
    postgres.open(tunnels.inner(), profile, password, &confirmation, tunnel_id.as_deref(), grid_edit.unwrap_or(false)).await
}

#[tauri::command]
fn close_postgres(postgres: State<'_, PostgresManager>, id: String) -> Result<(), String> {
    postgres.close(&id)
}

#[tauri::command]
async fn wait_postgres_disconnect(postgres: State<'_, PostgresManager>, id: String) -> Result<PostgresDisconnect, String> {
    postgres.wait_disconnect(&id).await
}

#[tauri::command]
async fn open_postgres_monitor(postgres: State<'_, PostgresManager>, id: String, password: PostgresPassword, confirmation: String) -> Result<PostgresSessionInfo, String> {
    postgres.open_monitor(&id, password, &confirmation).await
}

#[tauri::command]
async fn postgres_server_activity(postgres: State<'_, PostgresManager>, id: String, input: PostgresActivityInput) -> Result<PostgresActivitySnapshot, String> {
    postgres.server_activity(&id, input).await
}

#[tauri::command]
async fn postgres_statement_stats(postgres: State<'_, PostgresManager>, id: String, input: PostgresStatementStatsInput) -> Result<PostgresStatementStats, String> {
    postgres.statement_stats(&id, input).await
}

#[tauri::command]
async fn postgres_schemas(postgres: State<'_, PostgresManager>, id: String, page: u32) -> Result<PostgresSchemaPage, String> {
    postgres.schemas(&id, page).await
}

#[tauri::command]
async fn postgres_objects(postgres: State<'_, PostgresManager>, id: String, schema: i64, search: String, page: u32) -> Result<PostgresObjectPage, String> {
    postgres.objects(&id, schema, &search, page).await
}

#[tauri::command]
async fn search_postgres_objects(postgres: State<'_, PostgresManager>, id: String, input: PostgresSearchInput) -> Result<PostgresSearchPage, String> {
    postgres.search_objects(&id, input).await
}

#[tauri::command]
async fn resolve_postgres_catalog_object(
    postgres: State<'_, PostgresManager>, id: String, profile_id: String, schema: String, name: String,
) -> Result<PostgresCatalogObject, String> {
    postgres.resolve_catalog_object(&id, &profile_id, &schema, &name).await
}

#[tauri::command]
async fn postgres_page(
    postgres: State<'_, PostgresManager>, id: String, object: i64, row_page: u32, column_page: u32,
    query: Option<TableQueryClauses>,
    layout: Option<PostgresGridLayout>,
) -> Result<PostgresPage, String> {
    postgres.page(&id, object, row_page, column_page, query, layout).await
}

#[tauri::command]
async fn postgres_value_page(postgres: State<'_, PostgresManager>, id: String, target: PostgresValueTarget, page: u32) -> Result<PostgresValuePage, String> {
    postgres.value_page(&id, target, page).await
}

#[tauri::command]
async fn postgres_value_representation(postgres: State<'_, PostgresManager>, id: String, target: PostgresValueTarget) -> Result<PostgresValueRepresentation, String> {
    postgres.value_representation(&id, target).await
}

#[tauri::command]
async fn save_postgres_value(postgres: State<'_, PostgresManager>, id: String, target: PostgresValueTarget, destination: String) -> Result<PostgresValueSave, String> {
    postgres.save_value(&id, target, destination).await
}

#[tauri::command]
async fn postgres_structure(
    postgres: State<'_, PostgresManager>, id: String, object: i64, section: PostgresStructureSection, page: u32,
) -> Result<PostgresStructure, String> {
    postgres.structure(&id, object, section, page).await
}

#[tauri::command]
async fn postgres_schema_diagram(
    postgres: State<'_, PostgresManager>, id: String, schema: i64,
) -> Result<stackport_core::PostgresSchemaDiagram, String> {
    postgres.schema_diagram(&id, schema).await
}

#[tauri::command]
async fn create_postgres_backup(
    postgres: State<'_, PostgresManager>, id: String, request: String,
    target: stackport_core::PostgresBackupTarget, contents: stackport_core::PostgresBackupContents,
    password: PostgresPassword, confirmation: String, destination: String,
) -> Result<stackport_core::PostgresBackupReport, String> {
    postgres.create_backup(&id, &request, target, contents, password, &confirmation, destination).await
}

#[tauri::command]
fn cancel_postgres_backup(postgres: State<'_, PostgresManager>, id: String, request: String) -> Result<bool, String> {
    postgres.cancel_archive_job(&id, &request)
}

#[tauri::command]
async fn preview_postgres_restore(postgres: State<'_, PostgresManager>, id: String, request: String, source: String, database: String)
    -> Result<stackport_core::PostgresRestorePreview, String> {
    postgres.preview_restore(&id, &request, source, database).await
}

#[tauri::command]
fn discard_postgres_restore(postgres: State<'_, PostgresManager>, id: String, token: String) -> Result<(), String> {
    postgres.discard_restore(&id, &token)
}

#[tauri::command]
fn cancel_postgres_restore(postgres: State<'_, PostgresManager>, id: String, request: String) -> Result<bool, String> {
    postgres.cancel_archive_job(&id, &request)
}

#[tauri::command]
async fn apply_postgres_restore(postgres: State<'_, PostgresManager>, id: String, request: String, token: String,
    database_confirmation: String, trusted: bool, password: PostgresPassword, confirmation: String,
) -> Result<stackport_core::PostgresRestoreReport, String> {
    postgres.apply_restore(&id, &request, &token, &database_confirmation, trusted, password, &confirmation).await
}

#[tauri::command]
async fn choose_postgres_restore_archive() -> Result<Option<String>, String> {
    worker(|| Ok(rfd::FileDialog::new().set_title("PostgreSQL 백업 파일 선택")
        .add_filter("PostgreSQL 아카이브", &["backup", "dump"]).pick_file()
        .map(|path| path.to_string_lossy().into_owned()))).await
}

#[tauri::command]
async fn begin_postgres_edit(
    postgres: State<'_, PostgresManager>, id: String, object: i64, stamp: PostgresRowStamp, column: String,
) -> Result<PostgresEditSession, String> {
    postgres.begin_edit(&id, object, stamp, &column).await
}

#[tauri::command]
async fn preview_postgres_edit(
    postgres: State<'_, PostgresManager>, id: String, token: String, input: PostgresEditInput,
) -> Result<PostgresEditPreview, String> {
    postgres.preview_edit(&id, &token, input).await
}

#[tauri::command]
async fn open_postgres_edit_field(
    postgres: State<'_, PostgresManager>, id: String, token: String, column: String,
) -> Result<PostgresEditField, String> {
    postgres.open_edit_field(&id, &token, &column).await
}

#[tauri::command]
async fn preview_postgres_row_edit(
    postgres: State<'_, PostgresManager>, id: String, token: String, changes: Vec<PostgresCellChange>,
) -> Result<PostgresRowEditPreview, String> {
    postgres.preview_row_edit(&id, &token, changes).await
}

#[tauri::command]
async fn apply_postgres_edit(
    postgres: State<'_, PostgresManager>, id: String, token: String, approval: String, confirmation: String,
) -> Result<PostgresEditOutcome, String> {
    postgres.apply_edit(&id, &token, &approval, &confirmation).await
}

#[tauri::command]
async fn cancel_postgres_edit(postgres: State<'_, PostgresManager>, id: String, token: String) -> Result<(), String> {
    postgres.cancel_edit(&id, &token).await
}

#[tauri::command]
async fn begin_postgres_grid_edit(
    postgres: State<'_, PostgresManager>,
    id: String,
    object: i64,
    stamps: Vec<PostgresRowStamp>,
) -> Result<PostgresGridEditSession, String> {
    postgres.begin_grid_edit(&id, object, stamps).await
}

#[tauri::command]
async fn open_postgres_grid_edit_column(
    postgres: State<'_, PostgresManager>,
    id: String,
    token: String,
    column: String,
) -> Result<Vec<Option<PostgresEditField>>, String> {
    postgres.open_grid_edit_column(&id, &token, &column).await
}

#[tauri::command]
async fn preview_postgres_grid_edit(
    postgres: State<'_, PostgresManager>,
    id: String,
    token: String,
    changes: Vec<PostgresGridEditChange>,
) -> Result<PostgresGridEditPreview, String> {
    postgres.preview_grid_edit(&id, &token, changes).await
}

#[tauri::command]
async fn apply_postgres_grid_edit(
    postgres: State<'_, PostgresManager>,
    id: String,
    token: String,
    approval: String,
    confirmation: String,
) -> Result<PostgresGridEditOutcome, String> {
    postgres.apply_grid_edit(&id, &token, &approval, &confirmation).await
}

#[tauri::command]
async fn cancel_postgres_grid_edit(
    postgres: State<'_, PostgresManager>,
    id: String,
    token: String,
) -> Result<(), String> {
    postgres.cancel_grid_edit(&id, &token).await
}

#[tauri::command]
async fn begin_postgres_row_change(postgres: State<'_, PostgresManager>, id: String, object: i64, change: PostgresRowChange) -> Result<RowChangeSession, String> {
    postgres.begin_row_change(&id, object, change).await
}

#[tauri::command]
async fn preview_postgres_row_insert(postgres: State<'_, PostgresManager>, id: String, token: String, fields: Vec<PostgresCellChange>) -> Result<RowChangePreview, String> {
    postgres.preview_row_insert(&id, &token, fields).await
}

#[tauri::command]
async fn apply_postgres_row_change(postgres: State<'_, PostgresManager>, id: String, token: String, approval: String, confirmation: String) -> Result<PostgresRowChangeOutcome, String> {
    postgres.apply_row_change(&id, &token, &approval, &confirmation).await
}

#[tauri::command]
async fn cancel_postgres_row_change(postgres: State<'_, PostgresManager>, id: String, token: String) -> Result<(), String> {
    postgres.cancel_row_change(&id, &token).await
}

#[tauri::command]
async fn preview_postgres_row_paste(postgres: State<'_, PostgresManager>, id: String, token: String, columns: Vec<String>, rows: Vec<Vec<PostgresCellChange>>) -> Result<RowPastePreview, String> {
    postgres.preview_row_paste(&id, &token, columns, rows).await
}

#[tauri::command]
async fn apply_postgres_row_paste(postgres: State<'_, PostgresManager>, id: String, token: String, approval: String, confirmation: String) -> Result<PostgresRowChangeOutcome, String> {
    postgres.apply_row_paste(&id, &token, &approval, &confirmation).await
}

#[tauri::command]
async fn execute_postgres_sql(
    postgres: State<'_, PostgresManager>, id: String, request: String, source: String, scope: PostgresSqlScope,
    bindings: Option<PostgresSqlBindings>,
    mode: Option<PostgresSqlMode>,
    export: Option<PostgresExportOptions>,
) -> Result<PostgresSqlOutcome, String> {
    postgres.execute_sql(&id, &request, PostgresSqlInput { source, scope, bindings, mode: mode.unwrap_or_default(), export }).await
}

#[tauri::command]
fn postgres_script_review(postgres: State<'_, PostgresManager>, id: String, source: String,
    scope: PostgresSqlScope) -> Result<stackport_core::SqlExecutionReview, String> {
    postgres.script_review(&id, &source, scope)
}

#[tauri::command]
async fn execute_postgres_script(
    postgres: State<'_, PostgresManager>, id: String, request: String,
    input: stackport_core::PostgresScriptInput,
) -> Result<stackport_core::PostgresScriptOutcome, String> {
    postgres.execute_script(&id, &request, input).await
}

#[tauri::command]
fn postgres_export_progress(postgres: State<'_, PostgresManager>, id: String, request: String) -> Result<Option<u64>, String> {
    postgres.export_progress(&id, &request)
}

#[tauri::command]
fn cancel_postgres_sql(postgres: State<'_, PostgresManager>, id: String, request: String) -> Result<bool, String> {
    postgres.cancel_sql(&id, &request)
}

#[tauri::command]
async fn create_ssh_tunnel(store: State<'_, Store>, project_id: String, input: SshTunnelInput) -> Result<SavedSshTunnel, String> {
    let store = store.inner().clone();
    worker(move || store.create_ssh_tunnel(&project_id, input)).await
}

#[tauri::command]
async fn update_ssh_tunnel(store: State<'_, Store>, id: String, revision: i64, input: SshTunnelInput) -> Result<SavedSshTunnel, String> {
    let store = store.inner().clone();
    worker(move || store.update_ssh_tunnel(&id, revision, input)).await
}

#[tauri::command]
async fn delete_ssh_tunnel(store: State<'_, Store>, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_ssh_tunnel(&id, revision)).await
}

#[tauri::command]
fn ssh_tunnel_status(tunnels: State<'_, SshTunnelManager>) -> Result<Vec<SshTunnelStatus>, String> {
    tunnels.status()
}

#[tauri::command]
async fn start_ssh_tunnel(
    tunnels: State<'_, SshTunnelManager>,
    ssh: State<'_, Arc<SshManager>>,
    tunnel: SavedSshTunnel,
    profile: SshProfile,
    authentication: SshCredentials,
    hops: Vec<SshRouteHop>,
    confirmation: String,
    scope_confirmed: Option<bool>,
) -> Result<SshRouteResult<SshTunnelStatus>, String> {
    let gateway = SshRouteHop { profile, authentication };
    tunnels.start(Arc::clone(ssh.inner()), tunnel, gateway, hops, &confirmation, scope_confirmed.unwrap_or_default()).await
}

#[tauri::command]
async fn stop_ssh_tunnel(tunnels: State<'_, SshTunnelManager>, id: String) -> Result<SshTunnelStatus, String> {
    tunnels.stop(&id).await
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
async fn preview_sftp_file(
    sftp: State<'_, SftpManager>,
    id: String,
    location: String,
) -> Result<FilePreview, String> {
    sftp.preview(&id, location).await
}

#[tauri::command]
async fn open_sftp_editor(
    sftp: State<'_, SftpManager>,
    id: String,
    parent: String,
    source: SftpEntrySource,
) -> Result<SftpEditDocument, String> {
    sftp.open_editor(&id, parent, source).await
}

#[tauri::command]
fn discard_sftp_editor(sftp: State<'_, SftpManager>, id: String, token: String) {
    sftp.discard_editor(&id, &token);
}

#[tauri::command]
async fn start_sftp_external_editor(
    sftp: State<'_, SftpManager>, id: String, token: String, executable: String, text: String,
) -> Result<(), String> {
    sftp.start_external_editor(&id, token, executable, text).await
}

#[tauri::command]
async fn sftp_external_editor_changed(
    sftp: State<'_, SftpManager>, id: String, token: String,
) -> Result<bool, String> {
    sftp.external_editor_changed(&id, token).await
}

#[tauri::command]
async fn finish_sftp_external_editor(
    sftp: State<'_, SftpManager>, id: String, token: String, discard: bool,
) -> Result<Option<String>, String> {
    sftp.finish_external_editor(&id, token, discard).await
}

#[tauri::command]
async fn save_sftp_editor(
    sftp: State<'_, SftpManager>,
    id: String,
    input: SftpEditSave,
    progress: Channel<SftpTransferProgress>,
) -> Result<SftpTransferReport, String> {
    sftp.save_editor(&id, input, |update| {
        let _ = progress.send(update);
    }).await
}

#[tauri::command]
async fn save_local_text_draft(
    destination: String,
    text: String,
    line_ending: TextLineEnding,
    bom: bool,
) -> Result<usize, String> {
    worker(move || save_text_draft(&destination, &text, line_ending, bom)).await
}

#[tauri::command]
async fn create_sftp_folder(
    sftp: State<'_, SftpManager>,
    id: String,
    parent: String,
    name: String,
) -> Result<SftpMutationReport, String> {
    sftp.create_folder(&id, parent, name).await
}

#[tauri::command]
async fn rename_sftp_entry(
    sftp: State<'_, SftpManager>,
    id: String,
    parent: String,
    source: SftpEntrySource,
    name: String,
) -> Result<SftpMutationReport, String> {
    sftp.rename(&id, parent, source, name).await
}

#[tauri::command]
async fn change_sftp_permissions(
    sftp: State<'_, SftpManager>,
    id: String,
    input: SftpPermissionChange,
) -> Result<SftpMutationReport, String> {
    sftp.change_permissions(&id, input).await
}

#[tauri::command]
async fn move_sftp_entry(
    sftp: State<'_, SftpManager>,
    id: String,
    parent: String,
    source: SftpEntrySource,
    destination: String,
) -> Result<SftpMutationReport, String> {
    sftp.move_entry(&id, parent, source, destination).await
}

#[tauri::command]
async fn preview_sftp_delete(
    sftp: State<'_, SftpManager>,
    id: String,
    parent: String,
    source: SftpEntrySource,
) -> Result<SftpDeletePreview, String> {
    sftp.preview_delete(&id, parent, source).await
}

#[tauri::command]
fn discard_sftp_delete(sftp: State<'_, SftpManager>, id: String, token: String) {
    sftp.discard_delete_preview(&id, &token);
}

#[tauri::command]
async fn delete_sftp_entry(
    sftp: State<'_, SftpManager>,
    id: String,
    token: String,
    confirmation: String,
) -> Result<SftpMutationReport, String> {
    sftp.delete_entry(&id, token, confirmation).await
}

#[tauri::command]
async fn copy_sftp_file(
    sftp: State<'_, SftpManager>,
    id: String,
    parent: String,
    source: SftpEntrySource,
    directory: String,
    name: Option<String>,
    progress: Channel<SftpTransferProgress>,
) -> Result<SftpTransferReport, String> {
    sftp.copy_file(&id, parent, source, directory, name, |update| {
        let _ = progress.send(update);
    }).await
}

#[tauri::command]
async fn preview_local_browse_file(path: String) -> Result<FilePreview, String> {
    worker(move || preview_local_file(&path)).await
}

#[tauri::command]
async fn download_sftp_file(
    sftp: State<'_, SftpManager>,
    id: String,
    source: RemotePath,
    destination: String,
    progress: Channel<SftpTransferProgress>,
) -> Result<SftpTransferReport, String> {
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
) -> Result<SftpTransferReport, String> {
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
async fn browse_local_folder_tree(path: String) -> Result<FolderTree, String> {
    worker(move || list_local_tree(&path)).await
}

#[tauri::command]
async fn browse_sftp_folder_tree(
    sftp: State<'_, SftpManager>,
    id: String,
    location: String,
) -> Result<FolderTree, String> {
    sftp.list_tree(&id, location).await
}

#[tauri::command]
async fn list_sftp_sync_profiles(sftp: State<'_, SftpManager>, id: String) -> Result<Vec<SavedSyncProfile>, String> {
    sftp.saved_sync_profiles(&id).await
}

#[tauri::command]
async fn save_sftp_sync_profile(sftp: State<'_, SftpManager>, id: String, input: SyncProfileInput) -> Result<(), String> {
    sftp.save_sync_profile(&id, input).await
}

#[tauri::command]
async fn remove_sftp_sync_profile(sftp: State<'_, SftpManager>, id: String, profile_id: String) -> Result<(), String> {
    sftp.remove_sync_profile(&id, profile_id).await
}

#[tauri::command]
async fn apply_sftp_sync_plan(
    sftp: State<'_, SftpManager>,
    id: String,
    run_id: String,
    input: SyncPlan,
    progress: Channel<SyncProgress>,
) -> Result<SyncReport, String> {
    let run_id = run_id.parse().map_err(|_| "동기화 실행 ID를 확인하세요.")?;
    sftp.apply_sync_plan(&id, run_id, input, |update| { let _ = progress.send(update); }).await
}

#[tauri::command]
fn stop_sftp_sync(sftp: State<'_, SftpManager>, id: String, run_id: String) -> bool {
    run_id.parse().is_ok_and(|run_id| sftp.stop_sync(&id, run_id))
}

#[tauri::command]
async fn prepare_sftp_sync_deletions(
    sftp: State<'_, SftpManager>,
    id: String,
    input: SyncDeleteInput,
    progress: Channel<SyncProgress>,
) -> Result<SyncDeletePreview, String> {
    sftp.prepare_sync_deletions(&id, input, |update| { let _ = progress.send(update); }).await
}

#[tauri::command]
async fn compare_sftp_file_contents(
    sftp: State<'_, SftpManager>,
    id: String,
    local: ComparedFile,
    remote: ComparedFile,
) -> Result<FileContentComparison, String> {
    sftp.compare_contents(&id, local, remote).await
}

#[tauri::command]
async fn save_merged_file(destination: String, text: String) -> Result<usize, String> {
    worker(move || save_merged_text(&destination, &text)).await
}

#[tauri::command]
async fn choose_merged_file_path(name: String) -> Result<Option<String>, String> {
    worker(move || {
        Ok(rfd::FileDialog::new()
            .set_title("병합 결과를 새 파일로 저장")
            .set_file_name(&name)
            .save_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
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
async fn choose_local_text_draft_path() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("로컬 초안 파일 저장")
            .set_file_name("StackPort-remote-draft.txt")
            .add_filter("텍스트", &["txt"])
            .save_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn choose_sftp_external_editor() -> Result<Option<String>, String> {
    worker(|| {
        Ok(rfd::FileDialog::new()
            .set_title("외부 편집기 실행 파일 선택")
            .add_filter("실행 파일", &["exe"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned()))
    }).await
}

#[tauri::command]
async fn choose_sql_document_path(save: bool) -> Result<Option<String>, String> {
    worker(move || {
        let dialog = rfd::FileDialog::new().add_filter("SQL", &["sql"]);
        let path = if save {
            dialog.set_title("SQL 파일로 저장").set_file_name("StackPort-query.sql").save_file()
        } else {
            dialog.set_title("SQL 파일 열기").pick_file()
        };
        Ok(path.map(|path| path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn read_sql_document(source: String, encoding: Option<SqlFileEncoding>) -> Result<SqlDocument, String> {
    worker(move || open_sql_file_with_encoding(&source, encoding)).await
}

#[tauri::command]
async fn write_sql_document(destination: String, document: SqlDocument) -> Result<usize, String> {
    worker(move || save_sql_file(&destination, &document)).await
}

#[tauri::command]
async fn write_sql_definition(destination: String, definition: String) -> Result<usize, String> {
    worker(move || save_sql_definition(&destination, &definition)).await
}

#[tauri::command]
async fn list_sql_templates(store: State<'_, Store>, project_id: String) -> Result<Vec<SqlTemplateSummary>, String> {
    let store = store.inner().clone();
    worker(move || store.list_sql_templates(&project_id)).await
}

#[tauri::command]
async fn read_sql_template(store: State<'_, Store>, project_id: String, id: String) -> Result<SqlTemplate, String> {
    let store = store.inner().clone();
    worker(move || store.read_sql_template(&project_id, &id)).await
}

#[tauri::command]
async fn save_sql_template(store: State<'_, Store>, project_id: String, write: SqlTemplateWrite) -> Result<SqlTemplate, String> {
    let store = store.inner().clone();
    worker(move || store.save_sql_template(&project_id, write)).await
}

#[tauri::command]
async fn delete_sql_template(store: State<'_, Store>, project_id: String, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_sql_template(&project_id, &id, revision)).await
}

#[tauri::command]
async fn list_sql_parameter_sets(store: State<'_, Store>, scope: SqlParameterSetScope) -> Result<Vec<SqlParameterSetSummary>, String> {
    let store = store.inner().clone();
    worker(move || store.list_sql_parameter_sets(&scope)).await
}

#[tauri::command]
async fn read_sql_parameter_set(store: State<'_, Store>, scope: SqlParameterSetScope, id: String, revision: i64) -> Result<SqlParameterSet, String> {
    let store = store.inner().clone();
    worker(move || store.read_sql_parameter_set(&scope, &id, revision)).await
}

#[tauri::command]
async fn save_sql_parameter_set(store: State<'_, Store>, scope: SqlParameterSetScope, write: SqlParameterSetWrite) -> Result<SqlParameterSetSummary, String> {
    let store = store.inner().clone();
    worker(move || store.save_sql_parameter_set(&scope, write)).await
}

#[tauri::command]
async fn delete_sql_parameter_set(store: State<'_, Store>, scope: SqlParameterSetScope, id: String, revision: i64) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.delete_sql_parameter_set(&scope, &id, revision)).await
}

#[tauri::command]
async fn list_table_query_presets(store: State<'_, Store>, target: TableQueryTarget) -> Result<Vec<TableQueryPreset>, String> {
    let store = store.inner().clone();
    worker(move || store.list_table_query_presets(&target)).await
}

#[tauri::command]
async fn read_table_query_preset(store: State<'_, Store>, target: TableQueryTarget, id: String, revision: i64) -> Result<TableQueryClauses, String> {
    let store = store.inner().clone();
    worker(move || store.read_table_query_preset(&target, &id, revision)).await
}

#[tauri::command]
async fn write_table_query_preset(store: State<'_, Store>, target: TableQueryTarget, write: TableQueryPresetWrite) -> Result<(), String> {
    let store = store.inner().clone();
    worker(move || store.write_table_query_preset(&target, write)).await
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
async fn list_database_exchange_candidates(store: State<'_, Store>, project_id: String)
    -> Result<Vec<database_exchange::Candidate>, String> {
    let store = store.inner().clone();
    worker(move || store.list_database_exchange_candidates(&project_id)).await
}

#[tauri::command]
async fn export_database_profiles(store: State<'_, Store>, project_id: String, selected: Vec<database_exchange::Source>, destination: String)
    -> Result<database_exchange::ProfileExportReport, String> {
    let store = store.inner().clone();
    worker(move || store.export_database_profiles(&project_id, selected, &destination)).await
}

#[tauri::command]
async fn preview_database_profile_import(store: State<'_, Store>, path: String)
    -> Result<database_exchange::ProfileImportPreview, String> {
    let store = store.inner().clone();
    worker(move || store.preview_database_profile_import(&path)).await
}

#[tauri::command]
async fn import_database_profiles(store: State<'_, Store>, project_id: String, path: String, digest: String,
    selected: Vec<database_exchange::ImportSelection>) -> Result<usize, String> {
    let store = store.inner().clone();
    worker(move || store.import_database_profiles(&project_id, &path, &digest, selected)).await
}

#[tauri::command]
async fn choose_database_profile_path(import: bool) -> Result<Option<String>, String> {
    worker(move || {
        let dialog = rfd::FileDialog::new().add_filter("JSON", &["json"]);
        let path = if import {
            dialog.set_title("데이터베이스 연결 파일 선택").pick_file()
        } else {
            dialog.set_title("데이터베이스 연결 파일 저장")
                .set_file_name("stackport-database-profiles.json").save_file()
        };
        Ok(path.map(|path| path.to_string_lossy().into_owned()))
    }).await
}

#[tauri::command]
async fn choose_postgres_ca() -> Result<Option<String>, String> {
    worker(|| Ok(rfd::FileDialog::new().set_title("TLS CA 인증서 선택")
        .add_filter("PEM 인증서", &["pem", "crt", "cer"]).pick_file()
        .map(|path| path.to_string_lossy().into_owned()))).await
}

#[tauri::command]
async fn choose_mysql_client_tls_file(key: bool) -> Result<Option<String>, String> {
    worker(move || {
        let dialog = if key {
            rfd::FileDialog::new().set_title("MySQL 클라이언트 개인 키 선택").add_filter("PEM 개인 키", &["pem", "key"])
        } else {
            rfd::FileDialog::new().set_title("MySQL 클라이언트 인증서 선택").add_filter("PEM 인증서", &["pem", "crt", "cer"])
        };
        Ok(dialog.pick_file().map(|path| path.to_string_lossy().into_owned()))
    }).await
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
            app.manage(SftpManager::new(store.clone()));
            app.manage(SshTunnelManager::new(store.clone()));
            app.manage(PostgresManager::new(store.clone()));
            app.manage(stackport_core::RedisManager::new(store.clone()));
            app.manage(stackport_core::MysqlManager::new(store.clone()));
            app.manage(stackport_core::MongoManager::new(store.clone()));
            app.manage(sql_server::Manager::new(store.clone()));
            app.manage(oracle::Manager::new(store.clone()));
            app.manage(snowflake::Manager::new(store.clone()));
            app.manage(store);
            app.manage(Arc::new(TerminalManager::default()));
            app.manage(Arc::new(SshManager::new(location.directory.clone())));
            app.manage(Arc::new(NetworkManager::default()));
            app.manage(Arc::new(RdpManager::new(location.directory.clone())));
            app.manage(location);
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            get_runtime_info,
            get_workspace_resume,
            list_workspace_favorites,
            set_workspace_favorite,
            save_workspace_resume,
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
            sqlite_schema_diagram,
            compare_sqlite_schema,
            schema_comparison_connections,
            preview_schema_sync,
            cancel_schema_sync,
            apply_schema_sync,
            choose_sqlite_schema_document_path,
            export_sqlite_schema_document,
            sql_completion_catalog,
            diagnose_sql,
            validate_sql_alias_rename,
            prepare_query,
            current_sql_statement,
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
            preview_sqlite_row_edit,
            apply_sqlite_row_edit,
            begin_sqlite_grid_edit,
            preview_sqlite_grid_edit,
            apply_sqlite_grid_edit,
            begin_row_change,
            inspect_json_import,
            preview_sqlite_json_import,
            preview_row_insert,
            apply_row_change,
            preview_row_paste,
            apply_row_paste,
            cancel_row_change,
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
            open_routed_ssh_terminal,
            list_ssh_tunnels,
            list_postgres_profiles,
            list_redis_profiles,
            list_mysql_profiles,
            list_mongo_profiles,
            create_mongo_profile,
            update_mongo_profile,
            delete_mongo_profile,
            open_mongo,
            close_mongo,
            mongo_databases,
            mongo_collections,
            mongo_indexes,
            mongo_documents,
            begin_mongo_document_edit,
            review_mongo_document_edit,
            apply_mongo_document_edit,
            discard_mongo_document_edit,
            mongo_schema_sample,
            mongo_pipeline_preview,
            list_mongo_pipelines,
            read_mongo_pipeline,
            save_mongo_pipeline,
            delete_mongo_pipeline,
            list_sql_server_profiles,
            create_sql_server_profile,
            update_sql_server_profile,
            delete_sql_server_profile,
            open_sql_server,
            close_sql_server,
            sql_server_schemas,
            sql_server_objects,
            sql_server_search_objects,
            sql_server_columns,
            sql_server_structure,
            sql_server_definition,
            sql_server_data,
            sql_server_query_parameters,
            sql_server_query_review,
            run_sql_server_query,
            cancel_sql_server_query,
            export_sql_server,
            sql_server_export_progress,
            cancel_sql_server_export,
            list_oracle_profiles,
            create_oracle_profile,
            update_oracle_profile,
            delete_oracle_profile,
            open_oracle,
            close_oracle,
            oracle_schemas,
            oracle_objects,
            oracle_search_objects,
            oracle_columns,
            oracle_definition,
            oracle_data,
            oracle_query_review,
            run_oracle_query,
            oracle_query_parameters,
            cancel_oracle_query,
            export_oracle,
            oracle_export_progress,
            cancel_oracle_export,
            list_snowflake_profiles,
            create_snowflake_profile,
            update_snowflake_profile,
            delete_snowflake_profile,
            open_snowflake,
            close_snowflake,
            snowflake_schemas,
            snowflake_objects,
            snowflake_search_objects,
            snowflake_columns,
            snowflake_definition,
            snowflake_data,
            snowflake_query_review,
            run_snowflake_query,
            snowflake_query_parameters,
            cancel_snowflake_query,
            export_snowflake,
            snowflake_export_progress,
            cancel_snowflake_export,
            create_mysql_profile,
            update_mysql_profile,
            delete_mysql_profile,
            mysql_tunnel_options,
            open_mysql,
            close_mysql,
            wait_mysql_tunnel_end,
            mysql_databases,
            mysql_objects,
            mysql_table,
            preview_mysql_grid_edit,
            apply_mysql_grid_edit,
            discard_mysql_grid_edit,
            mysql_structure,
            open_mysql_monitor,
            close_mysql_monitor,
            mysql_server_activity,
            export_mysql,
            mysql_export_progress,
            mysql_sql_parameters,
            mysql_script_parameters,
            mysql_script_review,
            run_mysql_script,
            run_mysql_sql,
            mysql_sql_plan,
            cancel_mysql_sql,
            create_redis_profile,
            update_redis_profile,
            delete_redis_profile,
            open_redis,
            close_redis,
            redis_keys,
            redis_value,
            redis_server_snapshot,
            redis_console_commands,
            redis_run_console,
            redis_start_subscription,
            redis_subscription_snapshot,
            redis_clear_subscription_history,
            redis_stop_subscription,
            redis_publish_message,
            preview_redis_edit,
            discard_redis_edit,
            apply_redis_edit,
            preview_redis_key_delete,
            apply_redis_key_delete,
            create_postgres_profile,
            update_postgres_profile,
            delete_postgres_profile,
            postgres_tunnel_options,
            open_postgres,
            close_postgres,
            wait_postgres_disconnect,
            open_postgres_monitor,
            postgres_server_activity,
            postgres_statement_stats,
            postgres_schemas,
            postgres_objects,
            search_postgres_objects,
            resolve_postgres_catalog_object,
            postgres_page,
            postgres_value_page,
            postgres_value_representation,
            save_postgres_value,
            postgres_structure,
            postgres_schema_diagram,
            create_postgres_backup,
            cancel_postgres_backup,
            preview_postgres_restore,
            discard_postgres_restore,
            cancel_postgres_restore,
            apply_postgres_restore,
            choose_postgres_restore_archive,
            begin_postgres_edit,
            preview_postgres_edit,
            open_postgres_edit_field,
            preview_postgres_row_edit,
            apply_postgres_edit,
            cancel_postgres_edit,
            begin_postgres_grid_edit,
            open_postgres_grid_edit_column,
            preview_postgres_grid_edit,
            apply_postgres_grid_edit,
            cancel_postgres_grid_edit,
            begin_postgres_row_change,
            preview_postgres_row_insert,
            apply_postgres_row_change,
            cancel_postgres_row_change,
            preview_postgres_row_paste,
            apply_postgres_row_paste,
            execute_postgres_sql,
            postgres_script_review,
            execute_postgres_script,
            postgres_export_progress,
            cancel_postgres_sql,
            create_ssh_tunnel,
            update_ssh_tunnel,
            delete_ssh_tunnel,
            ssh_tunnel_status,
            start_ssh_tunnel,
            stop_ssh_tunnel,
            open_sftp,
            open_routed_sftp,
            list_sftp_directory,
            preview_sftp_file,
            open_sftp_editor,
            discard_sftp_editor,
            choose_sftp_external_editor,
            start_sftp_external_editor,
            sftp_external_editor_changed,
            finish_sftp_external_editor,
            save_sftp_editor,
            save_local_text_draft,
            create_sftp_folder,
            rename_sftp_entry,
            change_sftp_permissions,
            move_sftp_entry,
            preview_sftp_delete,
            discard_sftp_delete,
            delete_sftp_entry,
            copy_sftp_file,
            preview_local_browse_file,
            download_sftp_file,
            upload_sftp_file,
            cancel_sftp_transfer,
            close_sftp,
            browse_local_directory,
            browse_local_folder_tree,
            browse_sftp_folder_tree,
            list_sftp_sync_profiles,
            save_sftp_sync_profile,
            remove_sftp_sync_profile,
            apply_sftp_sync_plan,
            stop_sftp_sync,
            prepare_sftp_sync_deletions,
            compare_sftp_file_contents,
            save_merged_file,
            choose_merged_file_path,
            choose_local_browse_directory,
            choose_local_text_draft_path,
            choose_sql_document_path,
            read_sql_document,
            write_sql_document,
            write_sql_definition,
            list_sql_templates,
            list_table_query_presets,
            read_table_query_preset,
            write_table_query_preset,
            read_sql_template,
            save_sql_template,
            delete_sql_template,
            list_sql_parameter_sets,
            read_sql_parameter_set,
            save_sql_parameter_set,
            delete_sql_parameter_set,
            choose_sqlite_file,
            list_database_exchange_candidates,
            export_database_profiles,
            preview_database_profile_import,
            import_database_profiles,
            choose_database_profile_path,
            choose_postgres_ca,
            choose_mysql_client_tls_file,
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
                handle.state::<SshTunnelManager>().shutdown();
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
