import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, Archive, Boxes, ChevronDown, ChevronRight,
  Database, FileCode2, FileDown, Focus, FolderOpen, HardDrive, History, Layers3, PanelLeftClose, PanelLeftOpen, PanelsTopLeft,
  Plug, Plus, RefreshCw, Search, Settings, ShieldCheck, Table2, TerminalSquare, Trash2, Workflow, Play,
} from "lucide-react";
import type { SshOpenRequest, SshProfile } from "./ssh-profile-types";
import { SshProfileExchange } from "./SshProfileExchange";
import { Dialog, type GridEditExitGuard } from "./Dialog";
import { GridColumnLayoutDialog } from "./GridColumnLayoutDialog";
import { gridGeometry, useGridLayout, visibleColumns } from "./GridColumnLayout";
import { gridDisplay, gridTypeLabels, rawCellFormat, sqliteGridValueType } from "./gridValuePresentation";
import { TableQueryControls, defaultTableQuery, type TableQuery } from "./TableQueryControls";
import { SqliteRestoreDialog, restoreCounts, type RestoreReport } from "./SqliteRestoreDialog";
import { SqliteEditDialog, sqliteEditValue, type EditKey, type SqliteEditRequest, type SqliteEditResult } from "./SqliteEditDialog";
import { GridPasteDialog, type GridPasteRequest, type GridPasteResult } from "./GridPasteDialog";
import { GridCopyControls, GridSelectionButton, GridSelectPage, GridSelectRow, sqliteCopyCell, useGridRowSelection } from "./GridRowSelection";
import { RowChangeDialog, RowChangeFields, type RowChangeRequest, type RowChangeResult } from "./RowChangeDialog";
import { SqlParameterFields, type SqlParameter, type SqlParameterValue } from "./SqlParameterFields";
import { SqliteQueryPlan, type QueryPlan } from "./SqliteQueryPlan";
import { SqlFileDialog } from "./SqlFileDialog";
import {
  addSqlTab, CloseSqlTabDialog, emptySqlDocument, emptySqlTabs, isSqlDraftDirty, SqlTabStrip,
  sqlTabButtonId, sqlTabPanelId, sqlTabTitle, type SqlDocument, type SqlDraft, type SqlTabSet, type SqlTarget,
} from "./SqlTabs";
import { ResultExportDialog, type ExportReport, type ExportSource } from "./ResultExportDialog";
import { ArchivedProjectsDialog } from "./ArchivedProjectsDialog";
import { CommandPalette, type WorkspaceCommand } from "./CommandPalette";
import { QuickConnectDialog } from "./QuickConnectDialog";
import { matchesNetworkAddress, type NetworkAddress, type QuickTarget } from "./quickConnect";
import { CodeTextarea } from "./CodeTextarea";
import { sqlAliasRenameTarget, sqlCompletionContext, sqlCompletionSuggestions, sqlDefinitionReference, sqliteNameKey, type SqlAliasRenameTarget, type SqlCompletionCatalog, type SqlDefinitionReference, type SqlReferenceRange } from "./sqlCompletion";
import { SqlDiagnostics } from "./SqlDiagnostics";
import { SqlDefinitionDialog, type SqlDefinitionResult } from "./SqlDefinitionDialog";
import { SqlFormatDialog } from "./SqlFormatDialog";
import { SqlAliasRenameDialog } from "./SqlAliasRenameDialog";
import { SchemaDetails, type DatabaseObject, type ObjectDetails } from "./SqlSchemaDetails";
import { revealEditorRange } from "./editorSearch";
import type { EditorHoverInfo } from "./editorHover";
import { addSqlHistoryEntry, createSqlHistoryEntry, type SqlHistoryEntry, type SqlHistoryOutcome, type SqlHistoryScope } from "./sqlHistory";
import type { ResultComparisonSource } from "./SqlResultComparison";
import { SqlQueryMetrics } from "./SqlQueryMetrics";
import { resultPageBytes, type QueryPage, type Cell } from "./sqlResults";
import { NetworkWorkspace } from "./NetworkWorkspace";
import { PostgresWorkspace, type PostgresProfile, type PostgresProfileAction } from "./PostgresWorkspace";
import { PostgresProfileDialog } from "./PostgresProfileDialog";
import { RdpWorkspace } from "./RdpWorkspace";
import { SftpWorkspace } from "./SftpWorkspace";
import type { TerminalDirectory } from "./terminalDirectory";
import { WorkspaceCopyDialog } from "./WorkspaceCopyDialog";
import { WorkspaceExitDialog } from "./WorkspaceExitDialog";
import { WorkspaceNavigation, workspaceTools, type WorkspacePage } from "./WorkspaceNavigation";
import { WorkspaceExplorer, type ExplorerProjectAction, type ExplorerSshAction } from "./WorkspaceExplorer";
import { WorkspacePanes, WorkspaceSplitControls } from "./WorkspaceSplit";
import {
  editTool, paneTools, removePaneTool, replacePaneTool, resizePane, splitPane, toolPane,
  type SplitDirection, type WorkspaceLayout,
} from "./WorkspaceLayout";
import { restoreLayout, saveLayout, useWorkspaceResume, type ResumeRecord } from "./WorkspaceResume";
import {
  applyColorScheme, readDensityPreference, readThemePreference, saveDensityPreference, saveThemePreference,
  subscribeSystemTheme, systemTheme, type ThemePreference, type WorkspaceDensity,
} from "./appearance";
import "./theme.css";
import "./styles.css";

type Project = { id: string; name: string };
type RuntimeInfo = { version: string; data_mode: "standard" | "custom" | "portable"; data_directory: string };
type Profile = { id: string; project_id: string; name: string; path: string; environment: "DEV" | "STAGING" | "PROD" };
type BatchStop = SqlReferenceRange & { status: "error" | "cancelled" | "timed_out" | "parameters_required"; message: string };
type SqlBatchOutcome = { status: "batch"; total: number; items: (SqlReferenceRange & { result: QueryPage })[]; stopped: BatchStop | null };
type QueryOutcome = SqlBatchOutcome | { status: "completed"; result: QueryPage } | { status: "plan"; plan: QueryPlan } | { status: "parameters_required"; parameters: SqlParameter[] } | { status: "cancelled" | "timed_out" };
type SqlDocumentRange = { source: string; offset: number };
type SqlQueryTarget = { kind: "sql"; tabId: string; sql: string; parameters?: SqlParameterValue[]; planSource?: string; document?: SqlDocumentRange; batchIndex?: number; replayedFrom?: number };
type QueryTarget = SqlQueryTarget | { kind: "table"; request: TableQuery };
type QueryResult = { profileId: string; page: QueryPage; target: QueryTarget };
type SqlBatchView = {
  profileId: string;
  document: SqlDocumentRange;
  total: number;
  items: QueryResult[];
  stopped: BatchStop | null;
  active: number;
};
type PinnedSqlResult = { id: number; profileId: string; page: QueryPage; target: SqlQueryTarget; bytes: number };
type SqlQueryView = {
  result: QueryResult | null;
  plan: { sql: string; data: QueryPlan } | null;
  batch: SqlBatchView | null;
  pins: PinnedSqlResult[];
  pinId: number | null;
};
type ActiveQuery = { kind: QueryTarget["kind"]; token: string | null; cancelRequested: boolean; cancellation: Promise<void> | null };
type SqlFileAction = { mode: "open"; target: SqlTarget } | { mode: "save"; draft: SqlDraft; closeAfter?: boolean };
type SqlDefinitionRequest = { profileId: string; tabId: string; source: string; result: Promise<SqlDefinitionResult> };
type SqlDraftSnapshot = { profileId: string; tabId: string; source: string };
type SqlFormatSelection = SqlDraftSnapshot & SqlReferenceRange;
type SqlAliasRenameRequest = SqlDraftSnapshot & { target: SqlAliasRenameTarget | null };
type BackupReport = { path: string; size_bytes: number; integrity: "ok"; audit_warning: string | null };
type AuditEvent = { sequence: number; id: string; correlation_id: string; occurred_at: string; actor: string; operation: string; project_id: string | null; profile_id: string | null; environment: string | null; object_name: string | null; outcome: string; policy: string; affected_count: number | null };
type AuditPage = { events: AuditEvent[]; next_cursor: number | null };
type SshTrustEvent = { sequence: number; id: string; host: string; port: number; action: "accepted" | "replaced"; previous_fingerprint: string | null; fingerprint: string; occurred_at: string };
type SshTrustPage = { events: SshTrustEvent[]; next_cursor: number | null };
type Modal = "project" | "profile" | "rename" | "duplicateProject" | "archiveProject" | "deleteProject" | "deleteProfile" | "backup" | null;

const desktop = isTauri();
const initialTheme = readThemePreference();
applyColorScheme(initialTheme === "system" ? systemTheme() : initialTheme);
const TerminalWorkspace = React.lazy(() => import("./TerminalWorkspace").then(module => ({ default: module.TerminalWorkspace })));
const SqlResultComparison = React.lazy(() => import("./SqlResultComparison").then(module => ({ default: module.SqlResultComparison })));
const SqlTemplateLibrary = React.lazy(() => import("./SqlTemplateLibrary").then(module => ({ default: module.SqlTemplateLibrary })));
const SqlHistoryDialog = React.lazy(() => import("./SqlHistoryDialog").then(module => ({ default: module.SqlHistoryDialog })));
const SqlQueryBuilderDialog = React.lazy(() => import("./SqlQueryBuilderDialog").then(module => ({ default: module.SqlQueryBuilderDialog })));
const SqlSchemaDiagramDialog = React.lazy(() => import("./SqlSchemaDiagramDialog").then(module => ({ default: module.SqlSchemaDiagramDialog })));
const SchemaDocumentDialog = React.lazy(() => import("./SchemaDocumentDialog").then(module => ({ default: module.SchemaDocumentDialog })));
const SchemaComparisonDialog = React.lazy(() => import("./SchemaComparisonDialog").then(module => ({ default: module.SchemaComparisonDialog })));
const call = <T,>(command: string, args?: Record<string, unknown>): Promise<T> => invoke<T>(command, args);
const errorText = (error: unknown) => typeof error === "string" ? error : String(error);
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const objectSelectSql = (name: string) => `SELECT *\nFROM ${quoteIdentifier(name)};`;
const displayPath = (path: string) => path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.startsWith("\\\\?\\") ? path.slice(4) : path;
const initialSqlTabs = (target: SqlTarget) => addSqlTab(emptySqlTabs, target);
const hasDirtySqlTabs = (groups: Record<string, SqlTabSet>) => Object.values(groups).some(group => group.tabs.some(isSqlDraftDirty));
const emptySqlQueryView: SqlQueryView = { result: null, plan: null, batch: null, pins: [], pinId: null };
const maxResultPins = 8;
const maxPinnedResultBytes = 8 * 1024 * 1024;

function App() {
  const [theme, setTheme] = useState(initialTheme);
  const [density, setDensity] = useState(readDensityPreference);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [themeSaveError, setThemeSaveError] = useState(false);
  const [densitySaveError, setDensitySaveError] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const focusToggle = useRef<HTMLButtonElement>(null);
  const osTheme = useSyncExternalStore(subscribeSystemTheme, systemTheme);
  const colorScheme = theme === "system" ? osTheme : theme;
  useLayoutEffect(() => applyColorScheme(colorScheme), [colorScheme]);
  useEffect(() => {
    if (desktop) void getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(error => {
      console.warn("창 테마를 적용하지 못했습니다.", error);
    });
  }, [theme]);

  const [layout, setLayout] = useState<WorkspaceLayout>(() => toolPane("workspace"));
  const toolsInLayout = paneTools(layout);
  const page = toolsInLayout[0];
  const lastPair = useRef<{ direction: SplitDirection; size: number }>({ direction: "side", size: 50 });
  const nextSplit = useRef(0);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const [rdpTarget, setRdpTarget] = useState<NetworkAddress | null>(null);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const [terminalTabCount, setTerminalTabCount] = useState(0);
  const [rdpClientCount, setRdpClientCount] = useState(0);
  const [sshTunnelCount, setSshTunnelCount] = useState(0);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [workspaceCopyOpen, setWorkspaceCopyOpen] = useState(false);
  const [loadedPages, setLoadedPages] = useState<ReadonlySet<WorkspacePage>>(() => new Set(["workspace"]));
  const [tunnelViewRequest, setTunnelViewRequest] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [startupLoaded, setStartupLoaded] = useState(!desktop);
  const [resumeReadError, setResumeReadError] = useState(false);
  const [archivedProjectsOpen, setArchivedProjectsOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [postgresProfiles, setPostgresProfiles] = useState<PostgresProfile[]>([]);
  const [postgresId, setPostgresId] = useState("");
  const [postgresAction, setPostgresAction] = useState<PostgresProfileAction | null>(null);
  const postgresProfile = postgresProfiles.find(item => item.id === postgresId && item.project_id === projectId);
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([]);
  const [sshProfileDialog, setSshProfileDialog] = useState<{ mode: "create" | "edit" | "delete"; profile?: SshProfile; initial?: NetworkAddress } | null>(null);
  const [sshExchange, setSshExchange] = useState<"import" | "export" | null>(null);
  const [sshOpenRequest, setSshOpenRequest] = useState<SshOpenRequest | null>(null);
  const [terminalDirectory, setTerminalDirectory] = useState<TerminalDirectory | null>(null);
  const [profileId, setProfileId] = useState("");
  const [catalog, setCatalog] = useState<{ profileId: string; objects: DatabaseObject[] } | null>(null);
  const objects = catalog?.profileId === profileId ? catalog.objects : [];
  const [selectedObject, setSelectedObject] = useState<DatabaseObject | null>(null);
  const [schemaDetailsOpen, setSchemaDetailsOpen] = useState(false);
  const [sqliteLayoutDialog, setSqliteLayoutDialog] = useState<string | null>(null);
  const sqliteLayoutButton = useRef<HTMLButtonElement>(null);
  const [objectDetails, setObjectDetails] = useState<ObjectDetails | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [sqlTabSets, setSqlTabSets] = useState<Record<string, SqlTabSet>>({});
  const [sqlFileAction, setSqlFileAction] = useState<SqlFileAction | null>(null);
  const [templateLibrary, setTemplateLibrary] = useState<{ projectId: string; source: string; selection: boolean } | null>(null);
  const [sqlHistory, setSqlHistory] = useState<SqlHistoryEntry[]>([]);
  const [sqlHistoryProfile, setSqlHistoryProfile] = useState<string | null>(null);
  const [sqlBuilderProfile, setSqlBuilderProfile] = useState<string | null>(null);
  const [diagramProfile, setDiagramProfile] = useState<string | null>(null);
  const [schemaDocumentRequest, setSchemaDocumentRequest] = useState<{ profileId: string; object: string | null } | null>(null);
  const [schemaComparisonSource, setSchemaComparisonSource] = useState<string | null>(null);
  const nextSqlHistoryId = useRef(0);
  const pendingSqlHistory = useRef(new Map<number, string>());
  const [definition, setDefinition] = useState<SqlDefinitionRequest | null>(null);
  const [formatSelection, setFormatSelection] = useState<SqlFormatSelection | null>(null);
  const [aliasRename, setAliasRename] = useState<SqlAliasRenameRequest | null>(null);
  const [closingSqlTab, setClosingSqlTab] = useState<SqlDraft | null>(null);
  const [exitPrompt, setExitPrompt] = useState(false);
  const [exitClosing, setExitClosing] = useState(false);
  const [exitError, setExitError] = useState("");
  const [sqlEditorOpen, setSqlEditorOpen] = useState(true);
  const [sqlSelection, setSqlSelection] = useState<{ start: number; end: number } | null>(null);
  const sqlEditor = useRef<HTMLTextAreaElement>(null);
  const statementRequest = useRef(0);
  const [sqlQueryViews, setSqlQueryViews] = useState<Record<string, SqlQueryView>>({});
  const nextResultPin = useRef(0);
  const [resultComparison, setResultComparison] = useState<{ tabId: string; sources: ResultComparisonSource[]; initial: number } | null>(null);
  const [tableQueryResult, setTableQueryResult] = useState<QueryResult | null>(null);
  const [resultMode, setResultMode] = useState<QueryTarget["kind"]>("sql");
  const [exportRequest, setExportRequest] = useState<{ profile: Profile; query: ExportSource } | null>(null);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [parameterRequest, setParameterRequest] = useState<{ target: SqlQueryTarget; parameters: SqlParameter[]; scope?: SqlHistoryScope } | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [environment, setEnvironment] = useState<Profile["environment"]>("DEV");
  const [loading, setLoading] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [queryNotice, setQueryNotice] = useState("");
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [backupReport, setBackupReport] = useState<BackupReport | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreReport, setRestoreReport] = useState<RestoreReport | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editRequest, setEditRequest] = useState<SqliteEditRequest | null>(null);
  const [editReport, setEditReport] = useState<SqliteEditResult | null>(null);
  const [rowChange, setRowChange] = useState<Extract<RowChangeRequest, { engine: "sqlite" }> | null>(null);
  const [pasteRequest, setPasteRequest] = useState<Extract<GridPasteRequest, { engine: "sqlite" }> | null>(null);
  const [pasteReport, setPasteReport] = useState<{ profile: string; table: string; result: GridPasteResult } | null>(null);
  const [rowReport, setRowReport] = useState<{ profile: string; table: string; result: RowChangeResult } | null>(null);
  const rowChangeTrigger = useRef<HTMLButtonElement | null>(null);
  const rowAddButton = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const queryGeneration = useRef(0);
  const activeQuery = useRef<ActiveQuery | null>(null);
  const objectGeneration = useRef(0);
  const detailsGeneration = useRef(0);
  const terminalCount = useRef(0);
  const rdpCount = useRef(0);
  const tunnelCount = useRef(0);
  const sshRequestSequence = useRef(0);
  const selectedProject = useRef(projectId);
  selectedProject.current = projectId;
  const closeApproved = useRef(false);
  const closePending = useRef(false);
  const exitPromptOpen = useRef(exitPrompt);
  exitPromptOpen.current = exitPrompt;
  const sftpExitGuard = useRef<(() => void) | null>(null);
  const gridEditExitGuard = useRef<GridEditExitGuard | null>(null);
  const localFileBusy = useRef(false);
  const startupProfile = useRef<{ projectId: string; profileId: string } | null>(null);
  const updateTerminalCount = useCallback((count: number) => {
    terminalCount.current = count;
    setTerminalTabCount(count);
  }, []);
  const updateRdpCount = useCallback((count: number) => {
    rdpCount.current = count;
    setRdpClientCount(count);
  }, []);
  const updateTunnelCount = useCallback((count: number) => {
    tunnelCount.current = count;
    setSshTunnelCount(count);
  }, []);
  const consumeSshRequest = useCallback(() => { setSshOpenRequest(null); }, []);
  const consumeRdpTarget = useCallback(() => { setRdpTarget(null); }, []);
  const setSftpExitGuard = useCallback((guard: (() => void) | null) => { sftpExitGuard.current = guard; }, []);
  const setGridEditExitGuard = useCallback((guard: GridEditExitGuard | null) => { gridEditExitGuard.current = guard; }, []);
  // Drafts stay in memory: SQL can contain sensitive literals, so the editor
  // must not silently write them to browser storage or workspace metadata.
  const drafts = useRef(sqlTabSets);
  drafts.current = sqlTabSets;
  const project = projects.find(item => item.id === projectId);
  const profile = profiles.find(item => item.id === profileId && item.project_id === projectId);
  const sqlTarget = profile && project ? {
    profileId: profile.id, projectId: project.id, projectName: project.name, profileName: profile.name,
  } : null;
  const postgresTarget = postgresProfile && project ? {
    profileId: postgresProfile.id, projectId: project.id, projectName: project.name, profileName: postgresProfile.settings.name,
  } : null;
  const sqlTabs = sqlTarget ? sqlTabSets[sqlTarget.profileId] ?? initialSqlTabs(sqlTarget) : emptySqlTabs;
  const sqlDraft = sqlTabs.tabs.find(draft => draft.id === sqlTabs.activeId);
  const sqlView = sqlQueryViews[sqlTabs.activeId] ?? emptySqlQueryView;
  const batch = resultMode === "sql" && sqlView.batch?.profileId === profileId ? sqlView.batch : null;
  const pinned = resultMode === "sql" ? sqlView.pins.find(pin => pin.id === sqlView.pinId && pin.profileId === profileId) : undefined;
  const visibleQueryResult = resultMode === "table" ? tableQueryResult : batch ? batch.items[batch.active] : sqlView.result;
  const liveQueryResult = visibleQueryResult?.profileId === profileId ? visibleQueryResult : null;
  const queryResult = pinned ?? liveQueryResult;
  const result = queryResult?.page ?? null;
  const executedQuery = queryResult?.target ?? null;
  const alreadyPinned = !!liveQueryResult && sqlView.pins.some(pin => pin.page === liveQueryResult.page);
  const queryPlan = sqlView.plan;
  const sql = sqlDraft?.document.text ?? "";
  const fileTarget = sqlFileAction && (sqlFileAction.mode === "save" ? sqlFileAction.draft : sqlFileAction.target);
  const sqlToRun = sqlSelection ? sql.slice(sqlSelection.start, sqlSelection.end) : sql;
  const restoringProfile = startupProfile.current?.projectId === projectId ? startupProfile.current.profileId : null;
  const { initialize: initializeResume, flush: flushResume, notice: resumeNotice, retry: retryResume } = useWorkspaceResume(
    desktop && startupLoaded ? {
      project_id: project?.id ?? null,
      profile_id: profile?.id ?? restoringProfile,
      explorer_open: explorerOpen,
      layout: saveLayout(layout),
    } : null,
  );

  const reloadProjects = useCallback(async (select?: string) => {
    const next = await call<Project[]>("list_projects");
    setProjects(next);
    setProjectId(current => select ?? (next.some(item => item.id === current) ? current : next[0]?.id ?? ""));
  }, []);

  const reloadProfiles = useCallback(async (id: string, select?: string) => {
    const next = await call<Profile[]>("list_profiles", { projectId: id });
    setProfiles(next);
    setProfileId(current => select ?? (next.some(item => item.id === current) ? current : ""));
  }, []);

  const reloadSshProfiles = useCallback(async (id: string) => {
    const next = await call<SshProfile[]>("list_ssh_profiles", { projectId: id });
    if (selectedProject.current === id) setSshProfiles(next);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void Promise.allSettled([call<Project[]>("list_projects"), call<ResumeRecord>("get_workspace_resume")]).then(([projectResult, resume]) => {
      if (!live) return;
      const saved = resume.status === "fulfilled" ? resume.value.state : null;
      if (projectResult.status === "fulfilled") {
        const next = projectResult.value;
        const restoredProject = next.find(item => item.id === saved?.project_id);
        const initialProject = restoredProject?.id ?? next[0]?.id ?? "";
        const initialProfile = restoredProject ? saved?.profile_id ?? null : null;
        if (initialProfile) startupProfile.current = { projectId: initialProject, profileId: initialProfile };
        setProjects(next);
        setProjectId(initialProject);
        if (resume.status === "fulfilled") initializeResume(resume.value, {
          project_id: initialProject || null,
          profile_id: initialProfile,
          explorer_open: saved?.explorer_open ?? true,
          layout: saved?.layout ?? toolPane("workspace"),
        });
      } else {
        setError(errorText(projectResult.reason));
      }
      if (resume.status === "rejected") setResumeReadError(true);
      if (saved) {
        const restored = restoreLayout(saved.layout, () => ++nextSplit.current);
        setExplorerOpen(saved.explorer_open);
        setLoadedPages(new Set(["workspace", ...paneTools(restored)]));
        setLayout(restored);
      }
      setStartupLoaded(true);
    });
    return () => { live = false; };
  }, [initializeResume]);

  useEffect(() => {
    function openWorkspaceDialog(event: globalThis.KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.isComposing
        || document.querySelector("dialog[open]")) return;
      const key = event.key.toLowerCase();
      if (key !== "p" && !(desktop && key === "q")) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "q") setQuickConnectOpen(true);
      else setPaletteOpen(true);
    }
    window.addEventListener("keydown", openWorkspaceDialog, true);
    return () => window.removeEventListener("keydown", openWorkspaceDialog, true);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    call<RuntimeInfo>("get_runtime_info").then(info => { if (live) setRuntime(info); }).catch(e => {
      if (live) setError(errorText(e));
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    resetActiveQuery();
    objectGeneration.current++;
    setProfiles([]); setSshProfiles([]); setPostgresProfiles([]); setPostgresId(""); setPostgresAction(null);
    setProfileId(""); setCatalog(null); setTableQueryResult(null);
    setRestoreReport(null);
    if (projectId) {
      call<Profile[]>("list_profiles", { projectId }).then(items => {
        if (!live) return;
        if (startupProfile.current?.projectId === projectId) {
          const restoredProfile = startupProfile.current.profileId;
          startupProfile.current = null;
          if (items.some(item => item.id === restoredProfile)) setProfileId(restoredProfile);
        }
        setProfiles(items);
      }).catch(e => { if (live) setError(errorText(e)); });
      call<SshProfile[]>("list_ssh_profiles", { projectId }).then(items => { if (live) setSshProfiles(items); }).catch(e => { if (live) setError(errorText(e)); });
      call<PostgresProfile[]>("list_postgres_profiles", { projectId }).then(items => { if (live) setPostgresProfiles(items); }).catch(e => { if (live) setError(errorText(e)); });
    }
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    let live = true;
    resetActiveQuery();
    const generation = ++objectGeneration.current;
    setCatalog(null); setTableQueryResult(null); setResultMode("sql"); setError("");
    setSqlEditorOpen(true);
    setSqlSelection(null);
    setParameterRequest(null);
    setSqlHistoryProfile(null);
    setSqlBuilderProfile(null);
    setExportReport(null);
    detailsGeneration.current++; setSelectedObject(null); setObjectDetails(null); setDetailsError(""); setDetailsLoading(false);
    setBackupReport(null);
    setEditReport(null);
    setRowReport(null);
    if (profileId) {
      setLoading(true);
      call<DatabaseObject[]>("list_objects", { profileId })
        .then(items => { if (live && objectGeneration.current === generation) setCatalog({ profileId, objects: items }); })
        .catch(e => { if (live && objectGeneration.current === generation) setError(errorText(e)); })
        .finally(() => { if (live && objectGeneration.current === generation) setLoading(false); });
    } else setLoading(false);
    return () => { live = false; };
  }, [profileId]);

  useEffect(() => {
    function warnBeforeClose(event: BeforeUnloadEvent) {
      if (!closeApproved.current && (localFileBusy.current || gridEditExitGuard.current || sftpExitGuard.current || terminalCount.current > 0 || rdpCount.current > 0 || tunnelCount.current > 0 || hasDirtySqlTabs(drafts.current))) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, []);

  const finishAppClose = useCallback(() => {
    if (closeApproved.current || closePending.current || localFileBusy.current) return;
    closePending.current = true;
    setExitClosing(true);
    setExitError("");
    void flushResume().then(() => {
      closeApproved.current = true;
      return getCurrentWindow().destroy();
    }).catch(e => {
      closeApproved.current = false;
      const message = `창을 닫을 수 없습니다. ${errorText(e)}`;
      if (exitPromptOpen.current) setExitError(message);
      else setError(message);
    }).finally(() => {
      closePending.current = false;
      setExitClosing(false);
    });
  }, [flushResume]);

  const requestAppClose: () => void = useCallback(() => {
    if (closeApproved.current || closePending.current || localFileBusy.current || exitPromptOpen.current) return;
    if (gridEditExitGuard.current) {
      gridEditExitGuard.current(requestAppClose);
      return;
    }
    if (sftpExitGuard.current) {
      sftpExitGuard.current();
      return;
    }
    if (hasDirtySqlTabs(drafts.current)) {
      setSqlFileAction(null);
      setClosingSqlTab(null);
      setExitError("");
      setExitPrompt(true);
      return;
    }
    const notes: string[] = [];
    if (terminalCount.current) notes.push(`열린 터미널 ${terminalCount.current}개와 연결된 작업이 종료됩니다.`);
    if (rdpCount.current) notes.push(`열린 RDP 클라이언트 ${rdpCount.current}개가 종료됩니다.`);
    if (tunnelCount.current) notes.push(`실행 중이거나 준비 중인 SSH 터널 ${tunnelCount.current}개가 종료됩니다.`);
    if (notes.length && !globalThis.confirm(`${notes.join("\n")}\n앱을 종료하시겠습니까?`)) return;
    finishAppClose();
  }, [finishAppClose]);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    const window = getCurrentWindow();
    window.onCloseRequested(event => {
      if (closeApproved.current) return;
      event.preventDefault();
      requestAppClose();
    }).then(remove => { if (live) unlisten = remove; else remove(); }).catch(e => { if (live) setError(`창 종료 확인을 설정할 수 없습니다: ${errorText(e)}`); });
    return () => { live = false; unlisten?.(); };
  }, [requestAppClose]);

  function changeSql(value: string) {
    if (!sqlDraft || !sqlTarget) return;
    statementRequest.current++;
    editSqlTabs(sqlTarget, group => ({
      ...group, tabs: group.tabs.map(draft => draft.id === sqlDraft.id
        ? { ...draft, document: { ...draft.document, text: value } } : draft),
    }));
    setSqlSelection(null);
    if (queryPlan) editSqlQueryView(sqlDraft.id, { plan: null });
  }

  async function completeSql(value: string, position: number) {
    const context = sqlCompletionContext(value, position);
    if (!context || !profileId) return null;
    const generation = objectGeneration.current;
    const sources = [...new Set(context.sources.map(source => source.name))].slice(0, 12);
    const catalog = await call<SqlCompletionCatalog>("sql_completion_catalog", { profileId, prefix: context.prefix, sources });
    if (objectGeneration.current !== generation) return null;
    return { start: context.start, end: context.end, items: sqlCompletionSuggestions(context, catalog) };
  }

  async function readSqlDefinition(reference: SqlDefinitionReference, targetProfile: string): Promise<SqlDefinitionResult> {
    const { column } = reference;
    let candidates = reference.sources;
    if (column && candidates.length > 1) {
      const sources = [...new Set(candidates.map(source => source.name))];
      if (sources.length > 12) return { error: "테이블 이름이나 별칭을 붙여 확인할 열을 지정하세요." };
      const catalog = await call<SqlCompletionCatalog>("sql_completion_catalog", { profileId: targetProfile, prefix: column, sources });
      const owners = new Set(catalog.columns.filter(item => item.names.some(name => sqliteNameKey(name) === sqliteNameKey(column)))
        .map(item => sqliteNameKey(item.relation)));
      candidates = candidates.filter(candidate => owners.has(sqliteNameKey(candidate.name)));
    }
    if (candidates.length > 1) return { error: "여러 테이블이 이 이름을 사용합니다. 테이블 이름이나 별칭을 붙여 확인할 열을 지정하세요." };
    const target = candidates[0];
    if (!target) return { error: "현재 문장에서 이 열의 테이블을 찾을 수 없습니다." };
    const details = await call<ObjectDetails>("describe_object", { profileId: targetProfile, name: target.name });
    const matching = column && details.columns.find(item => item.hidden !== 1 && sqliteNameKey(item.name) === sqliteNameKey(column));
    if (column && !matching) return { error: "현재 테이블 또는 뷰에서 이 열을 찾을 수 없습니다." };
    return { details, column: matching ? matching.name : null, uses: target.uses };
  }

  function openSqlDefinition() {
    const editor = sqlEditor.current;
    if (!editor || !sqlDraft || !profile) return;
    const source = editor.value;
    const caret = editor.selectionDirection === "backward" ? editor.selectionStart : editor.selectionEnd;
    const reference = sqlDefinitionReference(source, caret);
    const result = reference ? readSqlDefinition(reference, profile.id).catch(error => ({ error: errorText(error) }))
      : Promise.resolve({ error: "현재 문장의 테이블, 별칭 또는 열 이름에 커서를 두세요." });
    setDefinition({ profileId: profile.id, tabId: sqlDraft.id, source, result });
  }

  async function inspectSql(source: string, position: number): Promise<EditorHoverInfo | null> {
    if (!profile || !sqlDraft) return null;
    const reference = sqlDefinitionReference(source, position);
    if (!reference) return null;
    const generation = objectGeneration.current;
    const snapshot = { profileId: profile.id, tabId: sqlDraft.id, source };
    const answer = await readSqlDefinition(reference, profile.id);
    if ("error" in answer || objectGeneration.current !== generation) return null;
    const { details, column } = answer;
    const field = column && details.columns.find(item => item.name === column);
    const kind = details.object.kind === "view" ? "뷰" : "테이블";
    const detail = field ? [
      field.declared_type || "형식 지정 없음", field.not_null && "NOT NULL",
      !!field.primary_key_position && `PK ${field.primary_key_position}`,
      field.hidden === 2 ? "가상 생성 열" : field.hidden === 3 ? "저장 생성 열" : null,
    ].filter(Boolean).join(" · ") : `main · ${kind} · 열 ${details.columns.length}개`;
    return {
      heading: column ? `${details.object.name} · ${column}` : details.object.name,
      detail,
      openDefinition: () => {
        if (objectGeneration.current === generation && sqlEditor.current?.value === source) {
          setDefinition({ ...snapshot, result: Promise.resolve(answer) });
        }
      },
    };
  }

  function openSqlFormat() {
    const editor = sqlEditor.current;
    if (!editor || !sqlDraft || !profile || !editor.value.trim()) return;
    const source = editor.value;
    const selected = editor.selectionStart !== editor.selectionEnd;
    setFormatSelection({ profileId: profile.id, tabId: sqlDraft.id, source,
      start: selected ? editor.selectionStart : 0, end: selected ? editor.selectionEnd : source.length });
  }

  function openSqlAliasRename() {
    const editor = sqlEditor.current;
    if (!editor || !sqlDraft || !profile || !editor.value.trim()) return;
    const source = editor.value;
    const caret = editor.selectionDirection === "backward" ? editor.selectionStart : editor.selectionEnd;
    setAliasRename({ profileId: profile.id, tabId: sqlDraft.id, source, target: sqlAliasRenameTarget(source, caret) });
  }

  function replaceSqlDraftRange(snapshot: SqlDraftSnapshot, range: SqlReferenceRange, text: string, reveal?: SqlReferenceRange) {
    const editor = sqlEditor.current;
    if (!editor || profile?.id !== snapshot.profileId || sqlDraft?.id !== snapshot.tabId || editor.value !== snapshot.source) {
      setError("SQL 탭이나 내용이 바뀌었습니다. 편집 내용을 다시 확인하세요.");
      return;
    }
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(range.start, range.end);
    if (!document.execCommand("insertText", false, text)) {
      setError("SQL 편집기에 변경을 적용할 수 없습니다.");
    } else if (reveal) {
      revealEditorRange(editor, reveal.start, reveal.end);
    }
  }

  function editSqlTabs(target: SqlTarget, edit: (group: SqlTabSet) => SqlTabSet) {
    setSqlTabSets(current => ({
      ...current, [target.profileId]: edit(current[target.profileId] ?? initialSqlTabs(target)),
    }));
  }

  function editSqlQueryView(id: string, changes: Partial<SqlQueryView>) {
    setSqlQueryViews(current => ({ ...current, [id]: { ...(current[id] ?? emptySqlQueryView), ...changes } }));
  }

  function forgetSqlQueryViews(ids: Set<string>) {
    setSqlQueryViews(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.has(id))));
  }

  function pinResult() {
    if (!sqlDraft || !liveQueryResult || liveQueryResult.target.kind !== "sql" || alreadyPinned ||
      querying || sqlView.pins.length >= maxResultPins) return;
    const { page, profileId, target: { sql, parameters } } = liveQueryResult;
    const bytes = resultPageBytes(page) + sql.length * 2 + (parameters ?? []).reduce(
      (size, parameter) => size + ("value" in parameter ? parameter.value.length * 2 : 0), 0);
    if (bytes + sqlView.pins.reduce((total, pin) => total + pin.bytes, 0) > maxPinnedResultBytes) {
      setError("이 SQL 탭에 고정할 수 있는 결과 크기를 초과했습니다. 고정 결과를 해제하거나 조회 열을 줄이세요.");
      return;
    }
    const pin: PinnedSqlResult = { id: ++nextResultPin.current, page, profileId, bytes,
      target: { kind: "sql", tabId: sqlDraft.id, sql, parameters } };
    editSqlQueryView(sqlDraft.id, { pins: [...sqlView.pins, pin] });
    setError("");
  }

  function showResultComparison() {
    const sources: ResultComparisonSource[] = sqlView.pins.map(pin => ({ id: pin.id, label: `고정 ${pin.id}`, page: pin.page }));
    if (liveQueryResult) sources.unshift({ id: 0, label: "현재 결과", page: liveQueryResult.page });
    const initial = pinned?.id ?? sqlView.pins.at(-1)?.id;
    if (sqlDraft && sources.length > 1 && initial !== undefined) setResultComparison({ tabId: sqlDraft.id, sources, initial });
  }

  function selectResultPin(id: number | null) {
    if (sqlDraft) editSqlQueryView(sqlDraft.id, { pinId: id });
    setExportReport(null);
  }

  function removeSqlConnections(ids: Set<string>) {
    if (ids.has(profileId)) {
      resetActiveQuery();
      setParameterRequest(null);
    }
    const tabs = [...ids].flatMap(id => sqlTabSets[id]?.tabs ?? []);
    setSqlTabSets(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.has(id))));
    forgetSqlQueryViews(new Set(tabs.map(draft => draft.id)));
    clearSqlHistory(ids);
  }

  function clearSqlHistory(ids: Set<string>) {
    for (const [id, profileId] of pendingSqlHistory.current) {
      if (ids.has(profileId)) pendingSqlHistory.current.delete(id);
    }
    setSqlHistory(current => current.filter(entry => !ids.has(entry.profileId)));
  }

  function activateSqlView() {
    if (resultMode !== "sql") setExportReport(null);
    setResultMode("sql");
  }

  function resetSqlView() {
    statementRequest.current++;
    activateSqlView();
    setSqlSelection(null);
    setParameterRequest(null);
    setResultComparison(null);
    setExportReport(null);
    if (activeQuery.current?.kind === "sql") resetActiveQuery();
    else if (!activeQuery.current) setQueryNotice("");
  }

  function selectSqlTab(id: string) {
    if (!sqlTarget) return;
    if (id === sqlTabs.activeId) {
      activateSqlView();
      return;
    }
    resetSqlView();
    editSqlTabs(sqlTarget, group => ({ ...group, activeId: id }));
  }

  function newSqlTab() {
    if (!sqlTarget) return;
    resetSqlView();
    editSqlTabs(sqlTarget, group => addSqlTab(group, sqlTarget));
    requestAnimationFrame(() => document.getElementById("sql-editor")?.focus());
  }

  function removeSqlTab(draft: SqlDraft) {
    const group = sqlTabSets[draft.profileId] ?? initialSqlTabs(draft);
    const index = group.tabs.findIndex(item => item.id === draft.id);
    if (index < 0) return;
    const remaining = group.tabs.filter(item => item.id !== draft.id);
    const wasActive = group.activeId === draft.id;
    const activeId = wasActive ? (remaining[index] ?? remaining[index - 1])?.id ?? "" : group.activeId;
    if (wasActive && draft.profileId === profileId) resetSqlView();
    editSqlTabs(draft, previous => ({ ...previous, tabs: previous.tabs.filter(item => item.id !== draft.id), activeId }));
    forgetSqlQueryViews(new Set([draft.id]));
    setClosingSqlTab(null);
    requestAnimationFrame(() => document.getElementById(activeId ? sqlTabButtonId(activeId) : "new-sql-tab")?.focus());
  }

  function requestCloseSqlTab(draft: SqlDraft) {
    if (isSqlDraftDirty(draft)) setClosingSqlTab(draft);
    else removeSqlTab(draft);
  }

  function openSqlFileDialog(mode: "open" | "save") {
    if (!sqlTarget) return;
    if (mode === "open") setSqlFileAction({ mode, target: sqlTarget });
    else if (sqlDraft) setSqlFileAction({ mode, draft: { ...sqlDraft, ...sqlTarget } });
  }

  function openSqlTemplates() {
    if (!desktop || !project) return;
    const editor = sqlEditor.current;
    const selection = !!editor && sqlEditorOpen && editor.selectionStart !== editor.selectionEnd;
    const source = selection ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : sql;
    setTemplateLibrary({ projectId: project.id, source, selection });
  }

  function openSqlTemplate(template: { name: string; sql: string }, owner: string) {
    if (sqlTarget?.projectId !== owner) return;
    openSqlDraft(template.sql, template.name);
    setTemplateLibrary(null);
  }

  function openSqlDraft(text: string, templateName?: string) {
    if (!sqlTarget) return;
    showTool("workspace");
    setSqlEditorOpen(true);
    resetSqlView();
    editSqlTabs(sqlTarget, group => addSqlTab(group, sqlTarget, {
      ...emptySqlDocument, text: text.replace(/\r\n?/g, "\n"),
    }, { templateName }));
    requestAnimationFrame(() => document.getElementById("sql-editor")?.focus());
  }

  function openSqlHistory() {
    if (desktop && profile) setSqlHistoryProfile(profile.id);
  }

  function openSqlBuilder() {
    if (desktop && profile) setSqlBuilderProfile(profile.id);
  }

  function finishSqlFile(action: SqlFileAction, contents: SqlDocument, path: string) {
    if (action.mode === "open") {
      if (action.target.profileId === profileId) {
        resetSqlView();
        requestAnimationFrame(() => document.getElementById("sql-editor")?.focus());
      } else if (action.target.profileId === postgresId) {
        requestAnimationFrame(() => document.getElementById("postgres-sql-editor")?.focus());
      }
      editSqlTabs(action.target, group => addSqlTab(group, action.target, contents, { path }));
    } else if (action.closeAfter) {
      removeSqlTab(action.draft);
    } else {
      editSqlTabs(action.draft, group => ({
        ...group, tabs: group.tabs.map(draft => draft.id === action.draft.id
          ? { ...draft, savedText: contents.text, savedPath: path } : draft),
      }));
    }
    setSqlFileAction(null);
  }

  function openObject(object: DatabaseObject, revealSchema = false) {
    setPostgresId("");
    setEditReport(null);
    showTool("workspace");
    setSqlEditorOpen(false);
    if (revealSchema || selectedObject?.name !== object.name) setSchemaDetailsOpen(revealSchema);
    const generation = ++detailsGeneration.current;
    setSelectedObject(object); setObjectDetails(null); setDetailsError(""); setDetailsLoading(true);
    call<ObjectDetails>("describe_object", { profileId, name: object.name })
      .then(details => { if (detailsGeneration.current === generation) setObjectDetails(details); })
      .catch(e => { if (detailsGeneration.current === generation) setDetailsError(errorText(e)); })
      .finally(() => { if (detailsGeneration.current === generation) setDetailsLoading(false); });
    void executeQuery({ kind: "table", request: defaultTableQuery(object.name) });
  }

  async function refreshObjects() {
    if (!profileId) return;
    const generation = ++objectGeneration.current;
    detailsGeneration.current++; setSelectedObject(null); setObjectDetails(null); setDetailsError(""); setDetailsLoading(false);
    setLoading(true); setError("");
    try {
      const items = await call<DatabaseObject[]>("list_objects", { profileId });
      if (objectGeneration.current === generation) setCatalog({ profileId, objects: items });
    } catch (e) { if (objectGeneration.current === generation) setError(errorText(e)); }
    finally { if (objectGeneration.current === generation) setLoading(false); }
  }

  function requestCancellation(task: ActiveQuery): Promise<void> {
    task.cancelRequested = true;
    if (!task.token) return Promise.resolve();
    if (!task.cancellation) {
      task.cancellation = call<boolean>("cancel_query", { token: task.token }).then(() => {}).catch(e => {
        task.cancelRequested = false;
        task.cancellation = null;
        if (activeQuery.current === task) { setCancelling(false); setQueryNotice(""); setError(`중단 요청에 실패했습니다: ${errorText(e)}`); }
      });
    }
    return task.cancellation;
  }

  function abandonQuery() {
    const task = activeQuery.current;
    if (task) { activeQuery.current = null; void requestCancellation(task); }
  }

  function resetActiveQuery() {
    statementRequest.current++;
    abandonQuery();
    queryGeneration.current++;
    setQuerying(false);
    setCancelling(false);
    setQueryNotice("");
    setResultComparison(null);
  }

  function cancelCurrentQuery() {
    const task = activeQuery.current;
    if (!task || task.cancelRequested) return;
    setCancelling(true); setQueryNotice("중단 요청 중입니다. 실행 결과를 확인하고 있습니다.");
    void requestCancellation(task);
  }

  function runQuery(query: string, scope: SqlHistoryScope, document?: SqlDocumentRange) {
    if (!sqlDraft || !query.trim()) return;
    if (queryPlan) editSqlQueryView(sqlDraft.id, { plan: null });
    void executeQuery({ kind: "sql", tabId: sqlDraft.id, sql: query, planSource: scope === "plan" ? sql : undefined, document }, 0, scope);
  }

  function runDocument(start: number, end: number) {
    runQuery(sql.slice(start, end), start === 0 && end === sql.length ? "document" : "selection", { source: sql, offset: start });
  }

  async function runCurrentStatement() {
    const editor = sqlEditor.current;
    if (!editor || !sqlDraft || querying) return;
    const request = ++statementRequest.current;
    const caret = editor.selectionDirection === "backward" ? editor.selectionStart : editor.selectionEnd;
    try {
      const statement = await call<string | null>("current_sql_statement", { sql, caret });
      if (request !== statementRequest.current) return;
      if (statement) runQuery(statement, "statement");
      else setError("커서를 실행할 SQL 문장 안에 두세요.");
    } catch (error) {
      if (request === statementRequest.current) setError(errorText(error));
    }
  }

  async function executeQuery(target: QueryTarget, page = 0, scope?: SqlHistoryScope) {
    if (!profileId || (target.kind === "sql" && target.tabId !== sqlDraft?.id)) return;
    statementRequest.current++;
    abandonQuery();
    const generation = ++queryGeneration.current;
    const task: ActiveQuery = { kind: target.kind, token: null, cancelRequested: false, cancellation: null };
    const started = performance.now();
    const history = scope && target.kind === "sql" ? { id: ++nextSqlHistoryId.current, scope, sql: target.sql, startedAt: Date.now() } : null;
    if (history) pendingSqlHistory.current.set(history.id, profileId);
    function finishHistory(outcome: SqlHistoryOutcome | null) {
      if (!history || !pendingSqlHistory.current.delete(history.id) || !outcome) return;
      const elapsedMs = Math.round(performance.now() - started);
      const entry = createSqlHistoryEntry(history.id, profileId, history.scope, history.sql, history.startedAt, { ...outcome, elapsedMs });
      setSqlHistory(current => addSqlHistoryEntry(current, entry));
    }
    activeQuery.current = task;
    setQuerying(true); setCancelling(false); setQueryNotice(""); setError("");
    const planning = target.kind === "sql" && target.planSource !== undefined;
    if (!planning) {
      if (resultMode !== target.kind) setExportReport(null);
      setResultMode(target.kind);
      if (target.kind === "table" && target !== tableQueryResult?.target) setTableQueryResult(null);
    }
    try {
      task.token = await call<string>("prepare_query");
      if (task.cancelRequested || queryGeneration.current !== generation) await requestCancellation(task);
      const args = { token: task.token, profileId, page };
      const response = target.kind === "sql"
        ? await call<QueryOutcome>("run_query", { ...args, sql: target.sql, parameters: target.parameters, explain: planning, document: !!target.document })
        : await call<QueryOutcome>("run_object_query", { ...args, request: target.request });
      if (response.status === "parameters_required") finishHistory(null);
      else if (response.status === "completed") finishHistory({ status: "completed", displayedRows: response.result.rows.length });
      else if (response.status === "plan") finishHistory({ status: "planned" });
      else if (response.status === "batch") finishHistory({ status: response.stopped?.status ?? "completed",
        batch: { finished: response.items.length, total: response.total } });
      else finishHistory({ status: response.status });
      if (queryGeneration.current === generation) {
        if (response.status === "completed") {
          if (target.kind === "sql") {
            const result = { profileId, page: response.result, target: { ...target, document: undefined } };
            const batch = sqlView.batch;
            if (target.batchIndex !== undefined && batch) {
              const items = batch.items.map((item, index) => index === target.batchIndex ? result : item);
              editSqlQueryView(target.tabId, { batch: { ...batch, items } });
            } else editSqlQueryView(target.tabId, { result, batch: null, pinId: null });
          } else setTableQueryResult({ profileId, page: response.result, target });
          setQueryNotice(task.cancelRequested ? "중단 요청 전에 쿼리가 완료되었습니다." : "");
        } else if (response.status === "batch" && target.kind === "sql" && target.document) {
          const items = response.items.map((item, batchIndex) => ({
            profileId, page: item.result, target: {
              kind: "sql" as const, tabId: target.tabId, sql: target.sql.slice(item.start, item.end), batchIndex,
            },
          }));
          editSqlQueryView(target.tabId, { result: null, pinId: null, batch: {
            profileId, document: target.document, total: response.total, stopped: response.stopped, items, active: 0,
          } });
          if (task.cancelRequested && !response.stopped) setQueryNotice("중단 요청 전에 일괄 실행이 완료되었습니다.");
        } else if (response.status === "plan" && target.kind === "sql" && target.planSource !== undefined) {
          editSqlQueryView(target.tabId, { plan: { sql: target.planSource, data: response.plan } });
        } else if (response.status === "parameters_required" && target.kind === "sql") {
          if (!task.cancelRequested) setParameterRequest({ target, parameters: response.parameters, scope });
          else setQueryNotice("쿼리 실행을 중단했습니다.");
        } else if (response.status === "cancelled") {
          setQueryNotice("쿼리가 중단되었습니다. 읽기 전용 연결이 닫혔습니다.");
        } else {
          setQueryNotice("쿼리 실행 시간 10초를 초과해 중단되었습니다. 조건을 줄여 다시 실행하세요.");
        }
      }
    } catch (e) {
      finishHistory({ status: "error" });
      if (queryGeneration.current === generation) { setQueryNotice(""); setError(errorText(e)); }
    }
    finally {
      if (activeQuery.current === task) activeQuery.current = null;
      if (queryGeneration.current === generation) { setQuerying(false); setCancelling(false); }
    }
  }

  function openModal(next: Modal) {
    setFormError("");
    setName(next === "rename" ? project?.name ?? "" : next === "duplicateProject" && project ? `${project.name} 복사본` : "");
    setPath(""); setEnvironment("DEV"); setModal(next);
  }

  function applyLayout(next: WorkspaceLayout) {
    const tools = paneTools(next);
    setLoadedPages(current => tools.every(tool => current.has(tool)) ? current : new Set([...current, ...tools]));
    setLayout(next);
  }

  function openPage(next: WorkspacePage) {
    if (next === "workspace") setHistoryOpen(false);
    if (next !== page) applyLayout(replacePaneTool(layout, page, next));
  }

  function showTool(next: WorkspacePage) {
    if (!toolVisible(next)) openPage(next);
    else if (next === "workspace") setHistoryOpen(false);
  }

  function changePaneTool(previous: WorkspacePage, next: WorkspacePage) {
    if (previous === next) return;
    if (next === "workspace" && !toolVisible(next)) setHistoryOpen(false);
    applyLayout(replacePaneTool(layout, previous, next));
  }

  function toggleFocusMode() {
    if (!focusMode && document.activeElement?.closest("#workspace-toolbar, #workspace-explorer, #workspace-status")) {
      focusToggle.current?.focus();
    }
    setFocusMode(current => !current);
  }

  function toggleSplit() {
    if (layout.kind === "split") {
      if (toolsInLayout.length === 2) lastPair.current = { direction: layout.direction, size: layout.size };
      applyLayout(toolPane(page));
      return;
    }
    const second = page === "workspace" ? "terminal" : "workspace";
    if (second === "workspace") setHistoryOpen(false);
    const pair = splitPane(++nextSplit.current, lastPair.current.direction, layout, toolPane(second));
    applyLayout({ ...pair, size: lastPair.current.size });
  }

  function addPane(target: WorkspacePage, direction: SplitDirection) {
    if (toolsInLayout.length >= 4) return;
    const next = workspaceTools.find(tool => !toolVisible(tool.id))?.id;
    if (!next) return;
    if (next === "workspace") setHistoryOpen(false);
    const divider = splitPane(++nextSplit.current, direction, toolPane(target), toolPane(next));
    applyLayout(editTool(layout, tool => tool === target ? divider : toolPane(tool)));
  }

  function closePane(target: WorkspacePage) {
    const next = removePaneTool(layout, target);
    if (next) applyLayout(next);
  }

  function openGrid() {
    if (!toolVisible("workspace")) setHistoryOpen(false);
    const available = workspaceTools.map(tool => tool.id).filter(tool => !toolVisible(tool));
    const [first, second, third, fourth] = [...toolsInLayout, ...available].slice(0, 4).map(toolPane);
    const top = splitPane(++nextSplit.current, "side", first, second);
    const bottom = splitPane(++nextSplit.current, "side", third, fourth);
    applyLayout(splitPane(++nextSplit.current, "stack", top, bottom));
  }

  function toolVisible(tool: WorkspacePage) {
    return toolsInLayout.includes(tool);
  }

  function selectSqliteProfile(id: string) {
    setPostgresId("");
    setProfileId(id);
    showTool("workspace");
  }

  function selectPostgresProfile(id: string) {
    setPostgresId(id);
    setHistoryOpen(false);
    showTool("workspace");
  }

  function savePostgresProfile(saved: PostgresProfile | null) {
    if (!postgresAction) return;
    const previous = postgresAction.kind === "create" ? null : postgresAction.profile.id;
    setPostgresProfiles(current => [...current.filter(item => item.id !== previous), ...(saved ? [saved] : [])]
      .sort((left, right) => left.settings.name.localeCompare(right.settings.name)));
    if (postgresAction.kind === "create" && saved) selectPostgresProfile(saved.id);
    if (!saved && previous) {
      removeSqlConnections(new Set([previous]));
      if (previous === postgresId) setPostgresId("");
    }
    setPostgresAction(null);
  }

  function openSavedSsh(item: SshProfile) {
    setSshOpenRequest({ profile: item, sequence: ++sshRequestSequence.current });
    showTool("terminal");
  }

  function runExplorerProjectAction(action: ExplorerProjectAction) {
    if (action === "archived") setArchivedProjectsOpen(true);
    else if (action === "copy") setWorkspaceCopyOpen(true);
    else {
      const modals = { create: "project", rename: "rename", duplicate: "duplicateProject", archive: "archiveProject", delete: "deleteProject" } as const;
      openModal(modals[action]);
    }
  }

  function runExplorerSshAction(action: ExplorerSshAction, item?: SshProfile) {
    if (action === "import" || action === "export") setSshExchange(action);
    else if (action === "refresh") {
      if (projectId) void reloadSshProfiles(projectId).catch(error => setError(errorText(error)));
    } else setSshProfileDialog({ mode: action, profile: item });
  }

  function quickConnectMatches(target: QuickTarget) {
    function match(id: string, name: string, environment: string, open: () => void) {
      return { id, name, environment, open: () => { setQuickConnectOpen(false); open(); } };
    }
    switch (target.kind) {
      case "ssh":
        return sshProfiles.filter(item => item.project_id === projectId && matchesNetworkAddress(target, item))
          .map(item => match(item.id, item.name, item.environment, () => openSavedSsh(item)));
      case "postgres":
        return postgresProfiles.filter(item => item.project_id === projectId && matchesNetworkAddress(target, item.settings)
          && (!target.database || target.database === item.settings.database))
          .map(item => match(item.id, item.settings.name, item.settings.environment, () => selectPostgresProfile(item.id)));
      case "sqlite":
        return profiles.filter(item => item.project_id === projectId && displayPath(item.path) === target.path)
          .map(item => match(item.id, item.name, item.environment, () => selectSqliteProfile(item.id)));
      case "rdp":
        return [];
    }
  }

  function openQuickTarget(target: QuickTarget, saveSsh: boolean) {
    setQuickConnectOpen(false);
    if (target.kind === "ssh") {
      if (saveSsh) setSshProfileDialog({ mode: "create", initial: target });
      else {
        setSshOpenRequest({ target, sequence: ++sshRequestSequence.current });
        showTool("terminal");
      }
    } else if (target.kind === "rdp") {
      setRdpTarget(target);
      showTool("rdp");
    } else if (target.kind === "postgres") {
      const { host, port, username, database } = target;
      setPostgresAction({ kind: "create", initial: { host, port, username, database, name: (database || host).slice(0, 80) } });
    } else {
      openModal("profile");
      setName(target.name);
      setPath(target.path);
    }
  }

  function showHistory() {
    showTool("workspace");
    setHistoryOpen(true);
  }

  function workspaceCommands(): WorkspaceCommand[] {
    const commands: WorkspaceCommand[] = workspaceTools.filter(tool => desktop || !("native" in tool)).map(tool => ({
      id: `tool:${tool.id}`, title: tool.label, group: "도구", keywords: tool.keywords, Icon: tool.Icon, run: () => openPage(tool.id),
    }));
    if (!focusMode) commands.push({
      id: "toggle:explorer", title: explorerOpen ? "탐색기 접기" : "탐색기 펼치기", group: "작업",
      keywords: "explorer sidebar", Icon: explorerOpen ? PanelLeftClose : PanelLeftOpen, run: () => setExplorerOpen(open => !open),
    });
    commands.push({
      id: "toggle:focus", title: focusMode ? "집중 모드 끄기" : "집중 모드 켜기", group: "작업",
      keywords: "focus mode", Icon: Focus, run: toggleFocusMode,
    });
    commands.push({
      id: "open:appearance", title: "화면 설정", group: "작업", keywords: "테마 라이트 다크 밀도 컴팩트 theme density appearance",
      Icon: Settings, run: () => setAppearanceOpen(true),
    });
    if (desktop) {
      commands.push(
        { id: "open:quick-connect", title: "빠른 연결", group: "작업", keywords: "quick connect 주소 ssh rdp postgres sqlite", Icon: Plug, run: () => setQuickConnectOpen(true) },
        { id: "open:history", title: "작업 기록", group: "작업", keywords: "audit history", Icon: History, run: showHistory },
        { id: "toggle:split", title: layout.kind === "split" ? "화면 분할 해제" : "화면 분할", group: "작업", keywords: "split pane", Icon: PanelsTopLeft, run: toggleSplit },
        { id: "create:project", title: "새 프로젝트", group: "작업", Icon: Plus, run: () => openModal("project") },
        { id: "open:archived", title: "보관된 프로젝트", group: "작업", Icon: Archive, run: () => setArchivedProjectsOpen(true) },
      );
    }
    if (project) {
      commands.push(
        { id: "create:sqlite", title: "SQLite 연결 추가", group: "작업", Icon: Database, run: () => openModal("profile") },
        { id: "create:postgres", title: "PostgreSQL 연결 추가", group: "작업", Icon: Database, run: () => setPostgresAction({ kind: "create" }) },
        { id: "create:ssh", title: "SSH 연결 추가", group: "작업", Icon: TerminalSquare, run: () => setSshProfileDialog({ mode: "create" }) },
      );
      if (desktop && !postgresProfile) commands.push({ id: "open:sql-templates", title: "SQL 템플릿", group: "작업",
        keywords: "query templates snippets favorites", Icon: FileCode2, run: openSqlTemplates });
    }
    for (const item of projects) commands.push({
      id: `project:${item.id}`, title: item.name, group: "프로젝트",
      Icon: FolderOpen, run: () => setProjectId(item.id),
    });
    for (const item of profiles.filter(item => item.project_id === projectId)) commands.push({
      id: `sqlite:${item.id}`, title: item.name, group: "SQLite 연결", detail: item.environment,
      Icon: Database, run: () => selectSqliteProfile(item.id),
    });
    for (const item of postgresProfiles.filter(item => item.project_id === projectId)) commands.push({
      id: `postgres:${item.id}`, title: item.settings.name, group: "PostgreSQL 연결", detail: item.settings.environment,
      Icon: Database, run: () => selectPostgresProfile(item.id),
    });
    for (const item of sshProfiles.filter(item => item.project_id === projectId)) commands.push({
      id: `ssh:${item.id}`, title: item.name, group: "SSH 연결", detail: item.environment,
      Icon: TerminalSquare, run: () => openSavedSsh(item),
    });
    if (desktop && profile && !postgresProfile) commands.push({ id: "open:sql-history", title: "최근 SQL", group: "작업",
      keywords: "query history recent sql", Icon: History, run: openSqlHistory });
    if (desktop && profile && !postgresProfile) commands.push({ id: "open:sql-builder", title: "쿼리 빌더", group: "작업",
      keywords: "query builder join group select sql", Icon: Table2, run: openSqlBuilder });
    if (desktop && profile && !postgresProfile) commands.push({ id: "open:schema-diagram", title: "SQLite 관계도", group: "작업",
      keywords: "erd schema diagram foreign key 외래 키", Icon: Workflow, run: () => setDiagramProfile(profile.id) });
    if (desktop && profile && !postgresProfile) commands.push({ id: "open:schema-document", title: "SQLite 데이터 사전", group: "작업",
      keywords: "schema data dictionary markdown html 구조 문서", Icon: FileDown,
      run: () => setSchemaDocumentRequest({ profileId: profile.id, object: selectedObject?.name ?? null }) });
    if (desktop && profile && !postgresProfile) commands.push({ id: "open:schema-comparison", title: "SQLite 스키마 비교", group: "작업",
      keywords: "schema compare diff 구조 차이", Icon: ArrowLeftRight, run: () => setSchemaComparisonSource(profile.id) });
    if (profile?.project_id === projectId && !loading) {
      for (const item of objects) commands.push({
        id: `object:${profile.id}:${item.name}`, title: item.name, group: item.kind === "view" ? "뷰" : "테이블",
        detail: profile.name, keywords: `sqlite ${item.kind}`, Icon: Table2, run: () => openObject(item),
      });
    }
    return commands;
  }

  function runWorkspaceCommand(command: WorkspaceCommand) {
    setPaletteOpen(false);
    setRecentCommands(current => [command.id, ...current.filter(id => id !== command.id)].slice(0, 12));
    command.run();
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setFormError("");
    try {
      if (modal === "project") {
        const created = await call<Project>("create_project", { name });
        await reloadProjects(created.id);
      } else if (modal === "duplicateProject" && project) {
        const duplicate = await call<Project>("duplicate_project", { source: project.id, name });
        await reloadProjects(duplicate.id);
      } else if (modal === "archiveProject" && project) {
        await call("archive_project", { id: project.id });
        await reloadProjects();
      } else if (modal === "rename" && project) {
        await call("rename_project", { id: project.id, name });
        await reloadProjects(project.id);
      } else if (modal === "profile" && project) {
        const created = await call<Profile>("create_sqlite_profile", { projectId: project.id, name, path, environment });
        setPostgresId("");
        await reloadProfiles(project.id, created.id);
      } else if (modal === "deleteProject" && project) {
        await call("delete_project", { id: project.id });
        const removedProfiles = Object.entries(sqlTabSets).filter(([, group]) => group.tabs[0]?.projectId === project.id).map(([id]) => id);
        removeSqlConnections(new Set([...removedProfiles, ...profiles.map(item => item.id)]));
        await reloadProjects();
      } else if (modal === "deleteProfile" && project && profile) {
        await call("delete_profile", { id: profile.id });
        removeSqlConnections(new Set([profile.id]));
        await reloadProfiles(project.id, "");
      } else if (modal === "backup" && profile) {
        const report = await call<BackupReport>("backup_sqlite", { profileId: profile.id, destination: path });
        setBackupReport(report);
      }
      setModal(null);
    } catch (e) { setFormError(errorText(e)); }
    finally { setSaving(false); }
  }

  const primaryKeys = objectDetails?.columns.filter(column => column.primary_key_position > 0).sort((a, b) => a.primary_key_position - b.primary_key_position) ?? [];
  const resultForObject = selectedObject && (
    executedQuery?.kind === "table" ? executedQuery.request.object === selectedObject.name
      : executedQuery?.kind === "sql" && executedQuery.sql === objectSelectSql(selectedObject.name) && sql === executedQuery.sql
  );
  const canEditRows = Boolean(!pinned && profile && selectedObject?.kind === "table" && objectDetails && primaryKeys.length && result && resultForObject);
  const tableLayoutTarget = profile && resultForObject && result && !pinned && executedQuery?.kind === "table"
    ? { engine: "sqlite" as const, profile: profile.id, object: executedQuery.request.object } : null;
  const rowChangeTable = canEditRows && tableLayoutTarget && !objectDetails?.columns.some(column => column.hidden !== 0)
    ? tableLayoutTarget.object : null;
  const currentRowReport = rowReport && tableLayoutTarget?.profile === rowReport.profile && tableLayoutTarget.object === rowReport.table
    ? rowReport.result : null;
  const currentPasteReport = pasteReport && tableLayoutTarget?.profile === pasteReport.profile && tableLayoutTarget.object === pasteReport.table
    ? pasteReport.result : null;
  const tableLayoutKey = tableLayoutTarget ? JSON.stringify([tableLayoutTarget.profile, tableLayoutTarget.object]) : null;
  const sqliteGrid = useGridLayout(tableLayoutTarget);
  const sourceColumns = new Map(result?.columns.map((name, index) => [name, index]));
  const displayColumns = tableLayoutTarget && result ? visibleColumns(result.columns, sqliteGrid.layout.active)
    .map(column => ({ name: column.name, index: sourceColumns.get(column.name)!, pinned: column.pinned, format: column.format }))
    : result?.columns.map((name, index) => ({ name, index, pinned: false, format: rawCellFormat })) ?? [];
  const declaredTypes = new Map(tableLayoutTarget && sqliteGrid.layout.typeColors
    ? objectDetails?.columns.map(column => [column.name, column.declared_type]) : undefined);
  const rowSelection = useGridRowSelection(result, result?.rows.length ?? 0);
  const rowNumberWidth = rowSelection.active ? 76 : 50;
  const actionWidth = 96;
  const sqliteGeometry = tableLayoutTarget && gridGeometry(displayColumns.map(column => column.name), sqliteGrid.layout.active,
    displayColumns.filter(column => column.pinned).length, rowNumberWidth + (canEditRows ? actionWidth : 0));
  function closeSqliteLayout() {
    setSqliteLayoutDialog(null);
    requestAnimationFrame(() => sqliteLayoutButton.current?.focus());
  }
  function openRowChange(change: Extract<RowChangeRequest, { engine: "sqlite" }>["change"], trigger: HTMLButtonElement) {
    if (!profile || !rowChangeTable) return;
    rowChangeTrigger.current = trigger;
    setRowReport(null);
    setPasteReport(null);
    setRowChange({ engine: "sqlite", profileId: profile.id, profileName: profile.name, location: displayPath(profile.path),
      environment: profile.environment, table: rowChangeTable, change });
  }
  function closeRowChange(applied = false) {
    const trigger = rowChangeTrigger.current;
    setRowChange(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected && !applied) trigger.focus();
      else rowAddButton.current?.focus();
    });
  }
  function openRowBatch(trigger: HTMLButtonElement, source: GridPasteRequest["source"]) {
    if (!profile || !rowChangeTable) return;
    rowChangeTrigger.current = trigger;
    setRowReport(null);
    setPasteReport(null);
    setEditReport(null);
    setPasteRequest({ engine: "sqlite", source, profileId: profile.id, profileName: profile.name, location: displayPath(profile.path),
      environment: profile.environment, table: rowChangeTable });
  }
  function closeRowPaste() {
    const trigger = rowChangeTrigger.current;
    setPasteRequest(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected && !trigger.disabled) trigger.focus();
      else sqliteLayoutButton.current?.focus();
    });
  }
  const editUnavailableReason = !pinned && selectedObject && objectDetails && result && !canEditRows
    ? selectedObject.kind !== "table" ? "뷰는 편집할 수 없습니다."
      : !primaryKeys.length ? "기본 키가 없는 테이블은 편집할 수 없습니다."
      : "행 편집은 선택한 테이블의 조회 결과에서 사용할 수 있습니다."
    : null;
  function keysForRow(row: Cell[]): EditKey[] | null {
    if (!result || !canEditRows) return null;
    const keys: EditKey[] = [];
    for (const column of primaryKeys) {
      const index = result.columns.indexOf(column.name);
      const cell = row[index];
      if (index < 0 || !cell || cell.truncated || cell.lossy_text || !["integer", "real", "text"].includes(cell.kind)) return null;
      keys.push({ name: column.name, kind: cell.kind, value: cell.display });
    }
    return keys;
  }
  const selectedRowsForEdit = result && rowSelection.active && rowChangeTable
    ? [...rowSelection.rows].sort((first, second) => first - second).flatMap(index => {
      const keys = keysForRow(result.rows[index]);
      return keys ? [{ keys, number: result.page * 100 + index + 1 }] : [];
    })
    : [];
  const canEditSelection = selectedRowsForEdit.length >= 2 && selectedRowsForEdit.length === rowSelection.rows.size;
  const editedCellCount = editReport?.rows.reduce((count, row) => count + row.cells.length, 0) ?? 0;

  if (!startupLoaded) return <main className="empty-state" role="status">작업 공간을 불러오는 중…</main>;

  const sqlEditorFooter = <>
    <div className="sql-file-actions">
      <button type="button" className="secondary small" onClick={() => openSqlFileDialog("open")}><FolderOpen size={14} aria-hidden /> SQL 파일 열기</button>
      <button type="button" className="secondary small" disabled={!sqlDraft} onClick={() => openSqlFileDialog("save")}><FileDown size={14} aria-hidden /> SQL 파일로 저장</button>
      <button type="button" className="secondary small" onClick={openSqlTemplates}><FileCode2 size={14} aria-hidden /> SQL 템플릿</button>
      <button type="button" className="secondary small" onClick={openSqlHistory}><History size={14} aria-hidden /> 최근 SQL</button>
      <button type="button" className="secondary small" onClick={openSqlBuilder}><Table2 size={14} aria-hidden /> 쿼리 빌더</button>
      {sqlDraft && <button type="button" className="secondary small" title="F12" disabled={!sql.trim()} onClick={openSqlDefinition}>정의 보기</button>}
      {sqlDraft && <button type="button" className="secondary small" title="F2" disabled={!sql.trim()} onClick={openSqlAliasRename}>별칭 변경</button>}
      {sqlDraft && <button type="button" className="secondary small" title="Ctrl+Alt+F" disabled={!sql.trim()} onClick={openSqlFormat}>SQL 서식</button>}
    </div>
    {sqlDraft && <span className="sql-file-state" role="status" title={sqlDraft.savedPath || undefined}>
      {isSqlDraftDirty(sqlDraft) ? "저장하지 않은 변경" : sqlDraft.savedPath ? "파일과 동일" : "Ctrl + Enter 실행"}
    </span>}
  </>;

  const databasePane = <div id="workspace-pane-workspace" className="main-content">
    {restoreReport && !historyOpen && !postgresProfile && <div className="success-banner restore-result" role="status">
      <strong>SQLite 복원 완료 · 검증 통과</strong>
      <span>{displayPath(restoreReport.path)}</span>
      <span>{restoreCounts(restoreReport)} · 무결성 및 SHA-256 일치</span>
      <code>{restoreReport.sha256}</code>
      {restoreReport.audit_warning && <strong className="audit-warning">{restoreReport.audit_warning}</strong>}
    </div>}
    {postgresProfile && postgresTarget && <div hidden={historyOpen}>
      <PostgresWorkspace key={`${postgresProfile.id}:${postgresProfile.revision}`} profile={postgresProfile} onEditExitGuard={setGridEditExitGuard}
        visible={!historyOpen && toolVisible("workspace")}
        onOpenTunnels={() => { setTunnelViewRequest(value => value + 1); showTool("network"); }}
        onFileBusy={busy => { localFileBusy.current = busy; }} editor={{
        tabs: sqlTabSets[postgresTarget.profileId] ?? initialSqlTabs(postgresTarget),
        select: id => editSqlTabs(postgresTarget, group => ({ ...group, activeId: id })),
        add: (text = "") => {
          editSqlTabs(postgresTarget, group => addSqlTab(group, postgresTarget, { ...emptySqlDocument, text }));
          requestAnimationFrame(() => document.getElementById("postgres-sql-editor")?.focus());
        },
        close: requestCloseSqlTab,
        edit: (id, text) => editSqlTabs(postgresTarget, group => ({
          ...group, tabs: group.tabs.map(draft => draft.id === id ? { ...draft, document: { ...draft.document, text } } : draft),
        })),
        openFile: () => setSqlFileAction({ mode: "open", target: postgresTarget }),
        saveFile: draft => setSqlFileAction({ mode: "save", draft: { ...draft, ...postgresTarget } }),
      }} />
    </div>}
    {historyOpen ? <AuditPanel onBack={() => setHistoryOpen(false)} /> : !desktop ? <EmptyState title="데스크톱 앱에서 시작하세요" text="브라우저에서 로컬 파일에 직접 연결할 수 없습니다. 브라우저용 게이트웨이는 아직 제공되지 않습니다." /> :
    !project ? <EmptyState title="첫 프로젝트를 만드세요" text="프로젝트에서 SQLite, PostgreSQL과 SSH 연결을 함께 관리할 수 있습니다." action="프로젝트 만들기" onAction={() => openModal("project")} /> :
    postgresProfile ? null :
    !profile ? <EmptyState title="데이터베이스를 연결하세요" text="기존 SQLite 파일을 연결해 테이블을 조회하고 지원되는 셀을 미리보기 후 편집할 수 있습니다." action="SQLite 연결 추가" onAction={() => openModal("profile")} /> : <>
      <div className="content-header"><div className="database-target"><h1><Database size={21} aria-hidden /><span title={profile.name}>{profile.name}</span><span className={`environment ${profile.environment.toLowerCase()}`}>{profile.environment}</span></h1><p className="path"><HardDrive size={13} aria-hidden /><span title={displayPath(profile.path)}>{displayPath(profile.path)}</span></p></div>
        <div className="header-actions"><span className="readonly"><ShieldCheck size={15} /> SQL 조회 전용</span>
          <button type="button" className="secondary" aria-haspopup="dialog" onClick={() => setDiagramProfile(profile.id)}><Workflow size={14} aria-hidden /> 관계도</button>
          <button className="secondary" onClick={() => openModal("backup")}><Archive size={14} /> 백업</button><button className="icon-button" aria-label="연결 삭제" onClick={() => openModal("deleteProfile")}><Trash2 size={16} /></button></div>
      </div>
      {backupReport && <div className="success-banner" role="status"><strong>백업 생성 완료 · 무결성 검사 통과</strong><span>{displayPath(backupReport.path)} · {new Intl.NumberFormat("ko-KR").format(backupReport.size_bytes)} bytes</span><span>별도 파일에 복원해 검증할 수 있습니다.</span>{backupReport.audit_warning && <strong className="audit-warning">{backupReport.audit_warning}</strong>}</div>}
      {exportReport && <div className="success-banner" role="status">
        <strong>{exportReport.format} 내보내기 완료</strong>
        <span>{displayPath(exportReport.path)} · {exportReport.rows.toLocaleString("ko-KR")}행 · {exportReport.size_bytes.toLocaleString("ko-KR")} bytes</span>
        {exportReport.protected_fields > 0 && <span>수식처럼 보이는 텍스트 {exportReport.protected_fields.toLocaleString("ko-KR")}개를 보호했습니다.</span>}
        {exportReport.audit_warning && <strong className="audit-warning">{exportReport.audit_warning}</strong>}
      </div>}
      {editReport && <div className="sqlite-edit-report">
        <div className="success-banner" role="status">
          <strong>{editReport.rows[0]?.number !== undefined && `행 ${editReport.rows.length}개 · `}
            {editedCellCount === 1 ? "셀 변경 완료" : `${editedCellCount}개 셀 변경 완료`} · 저장 값 검증됨</strong>
          {editReport.audit_warning && <strong className="audit-warning">{editReport.audit_warning}</strong>}
        </div>
        <details><summary>저장된 값 보기</summary>
          {editReport.rows.map(row => <div key={row.number ?? 0}>
            {row.number !== undefined && <p className="form-note">편집 당시 {row.number}행</p>}
            <dl className="row-change-values">
              {row.cells.map(({ column, actual }) => <div key={column}><dt>{column}</dt><dd>{sqliteEditValue(actual)}</dd></div>)}
            </dl>
          </div>)}
        </details>
      </div>}
      <div className="editor-card">
        <div className="panel-heading">
          <button type="button" className="sql-editor-toggle" aria-expanded={sqlEditorOpen} aria-controls="sql-editor-panel"
            onClick={() => setSqlEditorOpen(open => !open)}>
            <FileCode2 size={16} aria-hidden /> SQL 편집기
            {sqlEditorOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </button>
          {querying ? <button className="secondary small" disabled={cancelling} onClick={cancelCurrentQuery}>{cancelling ? "중단 요청 중…" : "쿼리 중단"}</button>
          : sqlEditorOpen && <div className="sql-editor-actions">
          <button className="secondary small" disabled={!sqlToRun.trim()} onClick={() => runQuery(sqlToRun, "plan")}>실행 계획</button>
          <button type="button" className="secondary small" disabled={!sql.trim()} title="Ctrl+Shift+Enter"
            onClick={() => void runCurrentStatement()} aria-label="현재 문장 실행">현재 문장</button>
          {sqlSelection && <button type="button" className="secondary small" disabled={!sql.trim()} title="Ctrl+Alt+Enter"
            onClick={() => runDocument(0, sql.length)}>문서 전체 실행</button>}
          <button className="primary small" disabled={!sqlToRun.trim()} title="Ctrl+Enter"
            onClick={() => runDocument(sqlSelection?.start ?? 0, sqlSelection?.end ?? sql.length)}>
            <Play size={14} fill="currentColor" /> {sqlSelection ? "선택 영역 실행" : "쿼리 실행"}
          </button>
          </div>}
        </div>
        <div id="sql-editor-panel" hidden={!sqlEditorOpen}>
          <SqlTabStrip group={sqlTabs} onSelect={selectSqlTab} onNew={newSqlTab} onClose={requestCloseSqlTab} />
          {sqlTabs.tabs.map(draft => <div key={draft.id} role="tabpanel" id={sqlTabPanelId(draft.id)}
            aria-labelledby={sqlTabButtonId(draft.id)} hidden={draft.id !== sqlTabs.activeId}>
            {draft.id === sqlTabs.activeId && <>
              <label className="sr-only" htmlFor="sql-editor">SQL 쿼리</label>
              <CodeTextarea id="sql-editor" editorRef={sqlEditor} spellCheck={false} value={sql} language="sqlite" complete={completeSql}
                inspect={inspectSql} inspectContext={`${profileId}:${draft.id}`}
                footer={sqlEditorFooter} onChange={event => changeSql(event.target.value)}
                onSelect={event => {
                  const { selectionStart: start, selectionEnd: end } = event.currentTarget;
                  setSqlSelection(start === end ? null : { start, end });
                }} onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "F2" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                    event.preventDefault();
                    openSqlAliasRename();
                    return;
                  }
                  if (event.key === "F12" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                    event.preventDefault();
                    if (sql.trim()) openSqlDefinition();
                    return;
                  }
                  if (!(event.ctrlKey || event.metaKey)) return;
                  if (event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
                    event.preventDefault();
                    openSqlFormat();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const { selectionStart, selectionEnd } = event.currentTarget;
                    if (event.shiftKey) void runCurrentStatement();
                    else if (!querying) {
                      const whole = event.altKey || selectionStart === selectionEnd;
                      runDocument(whole ? 0 : selectionStart, whole ? sql.length : selectionEnd);
                    }
                  } else if (event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    openSqlFileDialog("save");
                  }
                }} placeholder={'SELECT *\nFROM 테이블_이름;'} />
            </>}
          </div>)}
          {sqlDraft && <SqlDiagnostics profileId={profile.id} sql={sql} enabled={sqlEditorOpen && toolVisible("workspace")} editorRef={sqlEditor} />}
          {!sqlDraft && <>
            <p className="sql-tabs-empty">열린 SQL 탭이 없습니다.</p>
            <div className="editor-footer">{sqlEditorFooter}</div>
          </>}
        </div>
      </div>
      {queryNotice && <div className="query-notice" role="status">{queryNotice}</div>}
      {error && <div className="error-banner" role="alert"><strong>작업을 완료하지 못했습니다.</strong> {error}</div>}
      {selectedObject && <SchemaDetails key={selectedObject.name} object={selectedObject} details={objectDetails} loading={detailsLoading}
        error={detailsError} open={schemaDetailsOpen} onToggle={setSchemaDetailsOpen} />}
      {sqlEditorOpen && sqlDraft && queryPlan?.sql === sql && <SqliteQueryPlan plan={queryPlan.data}
        dismiss={() => editSqlQueryView(sqlDraft.id, { plan: null })} />}
      <section className="results-card database-results" aria-label={resultMode === "sql" && sqlDraft ? `${sqlTabTitle(sqlDraft)} 쿼리 결과` : "쿼리 결과"}
        aria-busy={querying && activeQuery.current?.kind === resultMode}><div className="panel-heading">
        <div className="result-identity">
          <Table2 size={16} aria-hidden />
          <strong title={executedQuery?.kind === "table" ? executedQuery.request.object : undefined}>
            {executedQuery?.kind === "table" ? executedQuery.request.object : "쿼리 결과"}
          </strong>
          {executedQuery?.kind === "sql" && sqlDraft && <span className="sql-result-source" title={sqlTabTitle(sqlDraft)}>{sqlTabTitle(sqlDraft)}</span>}
          {!pinned && executedQuery?.kind === "sql" && executedQuery.replayedFrom !== undefined &&
            <span className="sql-result-source">고정 {executedQuery.replayedFrom} 재실행</span>}
          {result && <span className="result-count">{result.rows.length}개 행</span>}
        </div>
        <div className="results-actions">
          {Boolean(result?.rows.length) && <GridSelectionButton selection={rowSelection} disabled={querying} />}
          {rowSelection.active && rowChangeTable && profile && <button type="button" className="secondary small"
            disabled={querying || !canEditSelection} onClick={() => {
              setEditReport(null);
              setEditRequest({ profileId: profile.id, profileName: profile.name, location: displayPath(profile.path),
                environment: profile.environment, table: rowChangeTable, rows: selectedRowsForEdit });
            }}>선택한 행 편집</button>}
          {rowChangeTable && <button type="button" ref={rowAddButton} className="secondary small" disabled={querying}
            onClick={event => openRowChange({ kind: "insert" }, event.currentTarget)}><Plus size={14} aria-hidden /> 행 추가</button>}
          {rowChangeTable && <button type="button" className="secondary small" disabled={querying}
            onClick={event => openRowBatch(event.currentTarget, "clipboard")}>행 붙여넣기</button>}
          {rowChangeTable && <button type="button" className="secondary small" disabled={querying}
            onClick={event => openRowBatch(event.currentTarget, "file")}>파일 가져오기</button>}
          {tableLayoutKey && !!result?.columns.length && <button ref={sqliteLayoutButton} type="button" className="secondary small"
            onClick={() => setSqliteLayoutDialog(tableLayoutKey)}>열 설정</button>}
          {!pinned && liveQueryResult?.target.kind === "sql" && <button type="button" className="secondary small"
            disabled={querying || alreadyPinned || sqlView.pins.length >= maxResultPins}
            title={sqlView.pins.length >= maxResultPins ? "SQL 탭마다 최대 8개 페이지를 고정할 수 있습니다." : "현재 조회 페이지를 메모리에 고정합니다."}
            onClick={pinResult}>{alreadyPinned ? "현재 페이지 고정됨" : "현재 페이지 고정"}</button>}
          {!pinned && result && executedQuery && <button className="secondary small" disabled={querying} onClick={() => {
            setExportReport(null);
            const query: ExportSource = executedQuery.kind === "table" ? executedQuery : {
              kind: "sql", sql: executedQuery.sql, parameters: executedQuery.parameters,
            };
            setExportRequest({ profile, query });
          }}><FileDown size={14} /> 결과 내보내기</button>}
        </div>
      </div>
        {resultMode === "sql" && sqlDraft && sqlView.pins.length > 0 && <div className="sql-pinned-results">
          <div className="sql-pinned-tabs" role="group" aria-label="고정 결과">
            <button type="button" className="secondary small" aria-pressed={!pinned} disabled={querying}
              onClick={() => selectResultPin(null)}>현재 결과</button>
            {sqlView.pins.map(pin => <button key={pin.id} type="button" className="secondary small" aria-pressed={pinned?.id === pin.id}
              title={`${pin.page.page + 1}페이지 · ${pin.page.rows.length}개 행`} disabled={querying}
              onClick={() => selectResultPin(pin.id)}>고정 {pin.id}</button>)}
          </div>
          <button type="button" className="secondary small" disabled={querying || sqlView.pins.length + Number(!!liveQueryResult) < 2}
            onClick={showResultComparison}>결과 비교</button>
        </div>}
        {pinned && sqlDraft && <div className="sql-pinned-detail">
          <div className="sql-pinned-actions">
            <span>고정된 {pinned.page.page + 1}페이지</span>
            <button type="button" className="secondary small" disabled={querying}
              onClick={() => void executeQuery({ ...pinned.target, replayedFrom: pinned.id }, pinned.page.page, "replay")}>고정 쿼리 재실행</button>
            <button type="button" className="secondary small" disabled={querying} onClick={() => {
              editSqlQueryView(sqlDraft.id, { pins: sqlView.pins.filter(pin => pin.id !== pinned.id), pinId: null });
              setExportReport(null);
            }}>고정 해제</button>
          </div>
          <details><summary>고정된 SQL</summary><pre aria-label="고정된 SQL">{pinned.target.sql}</pre></details>
        </div>}
        {!pinned && batch && sqlDraft && <div className="sql-batch-results" aria-label="일괄 실행 결과" role="group">
          <p>{batch.total}개 문장 중 {batch.items.length}개 완료</p>
          {!!batch.items.length && <div className="sql-batch-statements" aria-label="문장별 결과" role="group">
            {batch.items.map((item, index) => <button key={index} type="button" className="secondary small"
              aria-pressed={batch.active === index} disabled={querying} title={item.page.columns.join(", ")}
              onClick={() => { editSqlQueryView(sqlDraft.id, { batch: { ...batch, active: index } }); setExportReport(null); }}>
              문장 {index + 1}
            </button>)}
          </div>}
          {batch.stopped && <div className="sql-batch-stop">
            <span role={batch.stopped.status === "cancelled" ? "status" : "alert"}>
              문장 {batch.items.length + 1} · {batch.stopped.message}
            </span>
            {sql === batch.document.source && <button type="button" className="secondary small" onClick={() => {
              const editor = sqlEditor.current;
              const { stopped, document: { offset, source } } = batch;
              if (editor?.value === source && stopped) {
                setSqlEditorOpen(true);
                requestAnimationFrame(() => {
                  if (sqlEditor.current === editor && editor.value === source) {
                    revealEditorRange(editor, offset + stopped.start, offset + stopped.end);
                  }
                });
              }
            }}>중단 위치로 이동</button>}
          </div>}
        </div>}
        {profile && selectedObject && objectDetails && <TableQueryControls key={detailsGeneration.current}
          target={{ engine: "sqlite", profile_id: profile.id, object: selectedObject.name }}
          columns={objectDetails.columns.filter(column => column.hidden !== 1).map(column => column.name)} busy={querying}
          apply={clauses => void executeQuery({ kind: "table", request: { object: selectedObject.name, ...clauses } })} />}
        {result?.generated_sql && executedQuery?.kind === "table" && <details className="table-query-sql">
          <summary>{executedQuery.request.object} · 조회 SQL{executedQuery.request.filters.length > 0 && ` · 필터 ${executedQuery.request.filters.length}개`}{executedQuery.request.sort.length > 0 && ` · 정렬 ${executedQuery.request.sort.length}개`}</summary>
          <pre>{result.generated_sql}</pre>
          {executedQuery.request.filters.length > 0 && <p>물음표에는 필터 값을 매개변수로 전달합니다.</p>}
        </details>}
        {result?.metrics && <SqlQueryMetrics metrics={result.metrics} />}
        {editUnavailableReason && <p className="edit-unavailable">{editUnavailableReason}</p>}
        {currentPasteReport && <p className="success-banner" role="status">행 {currentPasteReport.rows}개 {currentPasteReport.source === "file" ? "가져오기" : "붙여넣기"} 완료
          {currentPasteReport.audit_warning && <strong className="audit-warning">{currentPasteReport.audit_warning}</strong>}</p>}
        {currentRowReport && <div className="sqlite-row-report">
          <p className="success-banner" role="status">{currentRowReport.fields.length ? "행 1개 추가 완료" : "행 1개 삭제 완료"}
            {currentRowReport.audit_warning && <strong className="audit-warning">{currentRowReport.audit_warning}</strong>}</p>
          {!!currentRowReport.fields.length && <details><summary>저장된 행 보기</summary><RowChangeFields fields={currentRowReport.fields} /></details>}
        </div>}
        {sqliteGrid.error && <p className="form-note" role="status">{sqliteGrid.error}</p>}
        {rowSelection.active && rowChangeTable && rowSelection.rows.size > selectedRowsForEdit.length &&
          <p className="form-note">편집할 행마다 전체 기본 키 값이 필요합니다.</p>}
        {result && rowSelection.active && Boolean(result.rows.length) && <GridCopyControls selection={rowSelection} disabled={querying}
          columns={displayColumns.map(column => column.name)} startRow={result.page * 100 + 1}
          readCell={(row, column) => sqliteCopyCell(result.rows[row][displayColumns[column].index])} />}
        {result ? <><div className="table-wrap"><table className={rowSelection.active ? "with-row-selection" : undefined}
          style={sqliteGeometry ? { tableLayout: "fixed", width: sqliteGeometry.total } : undefined}>
          {sqliteGeometry && <colgroup><col style={{ width: rowNumberWidth }} />
            {sqliteGeometry.widths.map((width, index) => <col key={index} style={{ width }} />)}
            {canEditRows && <col style={{ width: actionWidth }} />}</colgroup>}
          <thead><tr><th scope="col" className="row-number">{rowSelection.active && <GridSelectPage selection={rowSelection} disabled={querying} />}#</th>
            {displayColumns.map((column, position) => <th scope="col" key={column.index} title={column.name}
              className={column.pinned ? "grid-sticky-column" : undefined} style={{ insetInlineStart: sqliteGeometry?.pins[position] }}>{column.name}</th>)}
            {canEditRows && <th scope="col">작업</th>}</tr></thead>
          <tbody>{result.rows.map((row, rowIndex) => {
            const keys = keysForRow(row);
            const rowNumber = result.page * 100 + rowIndex + 1;
            return <tr key={rowIndex} data-grid-selected={rowSelection.rows.has(rowIndex) || undefined}><td className="row-number">
              {rowSelection.active && <GridSelectRow selection={rowSelection} index={rowIndex} rowNumber={rowNumber} disabled={querying} />}{rowNumber}</td>
              {displayColumns.map((column, position) => {
                const cell = row[column.index];
                const display = gridDisplay(cell.display, cell.truncated, column.format);
                const type = tableLayoutTarget && sqliteGrid.layout.typeColors
                  ? sqliteGridValueType(cell.kind, declaredTypes.get(column.name) ?? "", cell.display) : undefined;
                const classes = [cell.kind === "null" && "null-cell", column.pinned && "grid-sticky-column"].filter(Boolean).join(" ");
                return <td key={column.index} className={classes} style={{ insetInlineStart: sqliteGeometry?.pins[position] }}
                  data-grid-value-type={type} title={cell.truncated ? "표시 길이를 초과하여 일부만 표시됩니다."
                    : display !== cell.display ? `원본 ${cell.display}` : type ? gridTypeLabels[type] : undefined}>{display}{cell.truncated ? "…" : ""}</td>;
              })}
              {canEditRows && <td>{keys && profile && selectedObject ? <span className="sqlite-row-actions">
                <button className="row-edit" disabled={querying}
                  aria-label={`${rowNumber}행 편집`} onClick={() => {
                    setEditReport(null);
                    setEditRequest({ profileId: profile.id, profileName: profile.name, table: selectedObject.name,
                      location: displayPath(profile.path), environment: profile.environment, keys });
                  }}>편집</button>
                {rowChangeTable &&
                  <button type="button" className="icon-button" disabled={querying} aria-label={`${rowNumber}행 삭제`} title="행 삭제"
                    onClick={event => openRowChange({ kind: "delete", keys }, event.currentTarget)}><Trash2 size={14} aria-hidden /></button>}
                </span>
                : <span className="subtle" title="편집할 행을 식별하려면 원본 기본 키가 필요합니다.">지원 안 됨</span>}</td>}
            </tr>;
          })}</tbody></table>{result.rows.length === 0 && <p className="result-empty">조회된 행이 없습니다.</p>}</div>
          {!pinned && <div className="pagination"><span>페이지 {result.page + 1}{result.has_more ? " · 다음 페이지 있음" : " · 마지막 페이지"}</span><div><button className="icon-button" disabled={!result.page || querying} onClick={() => { if (executedQuery) void executeQuery(executedQuery, result.page - 1); }} aria-label="이전 페이지"><ArrowLeft size={16} /></button><button className="icon-button" disabled={!result.has_more || querying} onClick={() => { if (executedQuery) void executeQuery(executedQuery, result.page + 1); }} aria-label="다음 페이지"><ArrowRight size={16} /></button></div></div>}</> : <div className="result-placeholder"><Table2 size={24} /><strong>아직 조회 결과가 없습니다</strong><span>테이블을 선택하거나 SQL을 실행해 보세요.</span></div>}
      </section>
      {sqliteLayoutDialog && sqliteLayoutDialog === tableLayoutKey && tableLayoutTarget && result &&
        <GridColumnLayoutDialog title={tableLayoutTarget.object} columns={result.columns} layout={sqliteGrid.layout}
          onProfiles={profiles => sqliteGrid.apply({ ...sqliteGrid.layout, profiles })}
          onClose={closeSqliteLayout} onApply={next => { sqliteGrid.apply(next); closeSqliteLayout(); }} />}
    </>}
    {!profile && error && <div className="error-banner" role="alert">{error}</div>}
  </div>;

  const toolPanes: Record<WorkspacePage, React.ReactNode> = {
    workspace: databasePane,
    terminal: loadedPages.has("terminal") && <div id="workspace-pane-terminal" className="tool-body terminal-body">
      <React.Suspense fallback={<p className="terminal-loading" role="status">터미널을 불러오는 중…</p>}>
        <TerminalWorkspace visible={toolVisible("terminal")} colorScheme={colorScheme} onCountChange={updateTerminalCount} request={sshOpenRequest} sshProfiles={sshProfiles}
          onRequestHandled={consumeSshRequest} onDirectoryChange={setTerminalDirectory} />
      </React.Suspense>
    </div>,
    network: loadedPages.has("network") && <div id="workspace-pane-network" className="tool-body network-body">
      <NetworkWorkspace projectId={projectId} profiles={sshProfiles} visible={toolVisible("network")}
        tunnelViewRequest={tunnelViewRequest} onTunnelCountChange={updateTunnelCount} />
    </div>,
    rdp: loadedPages.has("rdp") && <div id="workspace-pane-rdp" className="tool-body network-body">
      <RdpWorkspace desktop={desktop} onCountChange={updateRdpCount} target={rdpTarget} onTargetHandled={consumeRdpTarget} />
    </div>,
    files: loadedPages.has("files") && <div id="workspace-pane-files" className="tool-body network-body">
      <SftpWorkspace projectName={project?.name ?? ""} profiles={sshProfiles} onExitGuard={setSftpExitGuard}
        onRequestExit={requestAppClose} terminalDirectory={terminalDirectory} />
    </div>,
  };

  return <div className="app-shell" data-density={density}>
    <div className="workspace">
      <header className="topbar">
        <div className="workspace-heading">
          <span className="brand-mark" aria-hidden><Layers3 size={17} strokeWidth={2.2} /></span>
          <span className="brand-name">StackPort</span>
          <span className="workspace-context" title={project?.name}><FolderOpen size={14} aria-hidden /><span>{project?.name ?? "프로젝트 없음"}</span></span>
        </div>
        <div className="top-right">
          {desktop && <button className="history-button quick-connect-trigger" type="button" aria-haspopup="dialog" aria-keyshortcuts="Control+Shift+Q Meta+Shift+Q"
            title="빠른 연결 (Ctrl+Shift+Q)" onClick={() => setQuickConnectOpen(true)}><Plug size={15} aria-hidden /> 빠른 연결</button>}
          <button className="history-button palette-trigger" type="button" aria-haspopup="dialog" aria-keyshortcuts="Control+Shift+P Meta+Shift+P"
            title="명령 팔레트 (Ctrl+Shift+P)" onClick={() => setPaletteOpen(true)}><Search size={15} aria-hidden /> 명령 팔레트 <kbd aria-hidden>Ctrl+Shift+P</kbd></button>
          <button className="history-button" disabled={!desktop} onClick={() => { if (toolVisible("workspace") && historyOpen) setHistoryOpen(false); else showHistory(); }} aria-pressed={toolVisible("workspace") && historyOpen}><History size={15} /> 작업 기록</button>
          <button ref={focusToggle} className="history-button" type="button" aria-pressed={focusMode}
            aria-controls="workspace-toolbar workspace-explorer workspace-status" onClick={toggleFocusMode}>
            <Focus size={15} aria-hidden /> 집중 모드
          </button>
          <button className="history-button" type="button" aria-haspopup="dialog" onClick={() => setAppearanceOpen(true)}><Settings size={15} aria-hidden /> 화면 설정</button>
        </div>
      </header>
      <div className="workspace-toolbar" id="workspace-toolbar" hidden={focusMode}>
        <button className="icon-button explorer-toggle" type="button" aria-controls="workspace-explorer" aria-expanded={explorerOpen}
          aria-label={explorerOpen ? "탐색기 접기" : "탐색기 펼치기"} title={explorerOpen ? "탐색기 접기" : "탐색기 펼치기"}
          onClick={() => setExplorerOpen(open => !open)}>{explorerOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
        <WorkspaceNavigation page={page} desktop={desktop} historyOpen={page === "workspace" && historyOpen}
          terminalCount={terminalTabCount} rdpCount={rdpClientCount} onSelect={openPage} />
        {desktop && <WorkspaceSplitControls layout={layout} tools={toolsInLayout} onToggle={toggleSplit} onSelect={changePaneTool}
          onDirectionChange={direction => setLayout(current => current.kind === "split" ? { ...current, direction } : current)}
          onAdd={addPane} onRemove={closePane} onGrid={openGrid} />}
      </div>
      {(resumeReadError || resumeNotice) && <div className="workspace-resume-notice" role="status">
        <span>{resumeReadError ? "작업 공간 배치를 읽을 수 없습니다." : resumeNotice?.message}</span>
        {resumeNotice?.retry && <button type="button" className="secondary small" onClick={retryResume}>이 창의 배치 저장</button>}
      </div>}
      <div className="body-layout">
        <WorkspaceExplorer desktop={desktop} hidden={focusMode || !explorerOpen} projectId={projectId} projects={projects}
          onProjectSelect={setProjectId} onProjectAction={runExplorerProjectAction}
          sqlite={{ profiles, loadedId: profileId, active: !postgresProfile, objects, selected: postgresProfile ? undefined : selectedObject?.name,
            loading, displayPath, open: selectSqliteProfile, openObject, refresh: refreshObjects,
            add: () => openModal("profile"), restore: () => { setRestoreOpen(true); showTool("workspace"); } }}
          postgres={{ profiles: postgresProfiles, activeId: postgresId, open: selectPostgresProfile, action: setPostgresAction }}
          ssh={{ profiles: sshProfiles, open: openSavedSsh, action: runExplorerSshAction }} />
        <WorkspacePanes layout={layout} panels={toolPanes} onResize={(id, size) => setLayout(current => resizePane(current, id, size))} />
      </div>
      <footer className="statusbar" id="workspace-status" hidden={focusMode}>
        <span className="offline-indicator" title={runtime ? displayPath(runtime.data_directory) : undefined}><span />
          {desktop ? runtime?.data_mode === "portable" ? "휴대형 작업 공간" : runtime?.data_mode === "custom" ? "지정 작업 공간" : "로컬 작업 공간" : "브라우저 · 게이트웨이 미연결"}</span>
        {runtime && <span className="version" aria-label="StackPort 버전">v{runtime.version}</span>}
      </footer>
    </div>
    {paletteOpen && <CommandPalette commands={workspaceCommands()} recent={recentCommands}
      onClose={() => setPaletteOpen(false)} onRun={runWorkspaceCommand} />}
    {quickConnectOpen && <QuickConnectDialog project={project?.name} findSaved={quickConnectMatches} onProceed={openQuickTarget}
      onCreateProject={() => { setQuickConnectOpen(false); openModal("project"); }} onClose={() => setQuickConnectOpen(false)} />}
    {appearanceOpen && <Dialog title="화면 설정" onClose={() => setAppearanceOpen(false)} busy={false}>
      <div className="appearance-settings">
        <label className="field">테마<select value={theme} onChange={event => {
          const preference = event.target.value as ThemePreference;
          setTheme(preference);
          setThemeSaveError(!saveThemePreference(preference));
        }}>
          <option value="system">시스템 설정 따르기</option>
          <option value="light">라이트</option>
          <option value="dark">다크</option>
        </select></label>
        {themeSaveError && <p className="form-error" role="alert">테마를 저장할 수 없어 현재 창에만 적용됩니다.</p>}
        <label className="field">화면 밀도<select value={density} onChange={event => {
          const preference = event.target.value as WorkspaceDensity;
          setDensity(preference);
          setDensitySaveError(!saveDensityPreference(preference));
        }}>
          <option value="default">기본</option>
          <option value="compact">컴팩트</option>
        </select></label>
        {densitySaveError && <p className="form-error" role="alert">화면 밀도를 저장할 수 없어 현재 창에만 적용됩니다.</p>}
      </div>
    </Dialog>}
    {modal && <Dialog title={{ project: "새 프로젝트", profile: "SQLite 연결 추가", rename: "프로젝트 이름 변경", duplicateProject: "프로젝트 복제", archiveProject: "프로젝트 보관", deleteProject: "프로젝트 삭제", deleteProfile: "연결 삭제", backup: "SQLite 백업" }[modal]} onClose={() => setModal(null)} busy={saving}><form onSubmit={submitForm} aria-busy={saving}>
      {(modal === "project" || modal === "rename" || modal === "profile" || modal === "duplicateProject") && <label className="field">이름<input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder={modal === "profile" ? "예: 로컬 데이터베이스" : "프로젝트 이름"} /></label>}
      {modal === "duplicateProject" && <p className="form-note"><strong>{project?.name}</strong>의 SQLite·SSH 연결 정의와 SQL 템플릿을 복제합니다. 두 프로젝트에서 같은 SQLite 파일과 SSH 대상에 접속합니다.</p>}
      {modal === "archiveProject" && <p className="confirm-copy"><strong>{project?.name}</strong>을 활성 목록에서 숨깁니다. 연결 정의와 파일은 보존되며 보관된 프로젝트 목록에서 다시 활성화할 수 있습니다.</p>}
      {modal === "profile" && <><label className="field">SQLite 파일 경로<span className="file-input"><input required value={path} onChange={e => setPath(e.target.value)} placeholder="기존 데이터베이스 파일 선택" /><button type="button" className="secondary" onClick={async () => { try { const chosen = await call<string | null>("choose_sqlite_file"); if (chosen) setPath(chosen); } catch (e) { setFormError(errorText(e)); } }}>찾아보기</button></span></label><label className="field">환경<select value={environment} onChange={e => setEnvironment(e.target.value as Profile["environment"])}><option>DEV</option><option>STAGING</option><option>PROD</option></select></label><p className="form-note">기존 파일만 열 수 있습니다. SQL은 읽기 전용이며 지원되는 셀은 별도 미리보기와 승인 후 수정할 수 있습니다.</p></>}
      {modal === "backup" && <><p className="confirm-copy">원본: <strong>{profile?.name}</strong><br />{profile && displayPath(profile.path)}</p><label className="field">새 백업 파일 경로<span className="file-input"><input required disabled={saving} value={path} onChange={e => setPath(e.target.value)} placeholder="절대 경로를 입력하세요" /><button type="button" className="secondary" disabled={saving} onClick={async () => { try { const folder = await call<string | null>("choose_backup_directory"); if (folder) setPath(`${folder}${folder.endsWith("\\") || folder.endsWith("/") ? "" : folder.includes("\\") ? "\\" : "/"}stackport-backup.sqlite`); } catch (e) { setFormError(errorText(e)); } }}>폴더 선택</button></span></label><p className="form-note">전체 데이터베이스를 백업하고 무결성을 검사합니다. 기존 파일은 덮어쓰지 않습니다. 백업은 암호화되지 않으므로 저장 폴더의 접근 권한을 확인하세요.</p></>}
      {modal === "deleteProject" && <p className="confirm-copy"><strong>{project?.name}</strong> 프로젝트와 SQLite 연결 {profiles.length}개, SSH 연결 {sshProfiles.length}개, SQL 초안 및 템플릿을 삭제합니다. 원본 데이터베이스 파일과 SSH 호스트 키 신뢰 기록, 열린 SSH 세션은 유지됩니다.</p>}
      {modal === "deleteProfile" && <p className="confirm-copy"><strong>{profile?.name}</strong> 연결 정의와 SQL 초안을 삭제합니다. 원본 데이터베이스 파일은 삭제되지 않습니다.</p>}
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={saving} onClick={() => setModal(null)}>취소</button><button type="submit" disabled={saving} className={modal.startsWith("delete") ? "danger" : "primary"}>{saving ? "처리 중…" : modal.startsWith("delete") ? "삭제" : modal === "backup" ? "백업 만들기" : modal === "duplicateProject" ? "프로젝트 복제" : modal === "archiveProject" ? "프로젝트 보관" : "저장"}</button></div>
    </form></Dialog>}
    {archivedProjectsOpen && <ArchivedProjectsDialog onClose={() => setArchivedProjectsOpen(false)} onRestored={id => {
      setArchivedProjectsOpen(false);
      void reloadProjects(id).catch(error => setError(errorText(error)));
    }} />}
    {workspaceCopyOpen && <WorkspaceCopyDialog displayPath={displayPath} onClose={() => setWorkspaceCopyOpen(false)} />}
    {exitPrompt && <WorkspaceExitDialog drafts={Object.values(sqlTabSets).flatMap(group => group.tabs).filter(isSqlDraftDirty).map(draft => ({
      ...draft, projectName: projects.find(item => item.id === draft.projectId)?.name ?? draft.projectName,
    }))} terminals={terminalTabCount} rdpClients={rdpClientCount} sshTunnels={sshTunnelCount}
      busy={exitClosing} error={exitError} onClose={() => setExitPrompt(false)}
      onSave={draft => setSqlFileAction({ mode: "save", draft })} onExit={finishAppClose} />}
    {closingSqlTab && <CloseSqlTabDialog draft={closingSqlTab} onCancel={() => setClosingSqlTab(null)}
      onDiscard={() => removeSqlTab(closingSqlTab)}
      onSave={() => setSqlFileAction({ mode: "save", draft: closingSqlTab, closeAfter: true })} />}
    {sqlFileAction && fileTarget && <SqlFileDialog mode={sqlFileAction.mode}
      target={`${fileTarget.projectName} · ${fileTarget.profileName}${sqlFileAction.mode === "save" ? ` · ${sqlTabTitle(sqlFileAction.draft)}` : ""}`}
      document={sqlFileAction.mode === "save" ? sqlFileAction.draft.document : emptySqlDocument}
      onClose={() => setSqlFileAction(null)} onBusy={busy => { localFileBusy.current = busy; }}
      onDone={(document, path) => finishSqlFile(sqlFileAction, document, path)} />}
    {definition && definition.profileId === profile?.id && definition.tabId === sqlDraft?.id && <SqlDefinitionDialog
      source={definition.source} result={definition.result} onClose={() => setDefinition(null)} onReveal={range => {
        const editor = sqlEditor.current;
        if (editor?.value === definition.source) revealEditorRange(editor, range.start, range.end);
      }} />}
    {formatSelection && formatSelection.profileId === profile?.id && formatSelection.tabId === sqlDraft?.id && <SqlFormatDialog
      source={formatSelection.source} start={formatSelection.start} end={formatSelection.end}
      onClose={() => setFormatSelection(null)} onApply={text => replaceSqlDraftRange(formatSelection, formatSelection, text,
        formatSelection.start > 0 || formatSelection.end < formatSelection.source.length
          ? { start: formatSelection.start, end: formatSelection.start + text.length } : undefined)} />}
    {aliasRename && aliasRename.profileId === profile?.id && aliasRename.tabId === sqlDraft?.id && <SqlAliasRenameDialog
      source={aliasRename.source} target={aliasRename.target} onClose={() => setAliasRename(null)}
      onValidate={(range, text) => call<void>("validate_sql_alias_rename", {
        profileId: aliasRename.profileId, original: aliasRename.source.slice(range.start, range.end), changed: text,
      })}
      onApply={(range, update) => replaceSqlDraftRange(aliasRename, range, update.text,
        { start: update.first, end: update.first + update.spelling.length })} />}
    {editRequest && <SqliteEditDialog request={editRequest} onClose={() => setEditRequest(null)} onExitGuard={setGridEditExitGuard}
      onBusy={busy => { localFileBusy.current = busy; }} onApplied={report => {
        setEditRequest(null); setEditReport(report); if (result && executedQuery) void executeQuery(executedQuery, result.page);
      }} />}
    {rowChange && <RowChangeDialog request={rowChange} onClose={() => closeRowChange()} onExitGuard={setGridEditExitGuard}
      onBusy={busy => { localFileBusy.current = busy; }} onApplied={report => {
      setRowReport({ profile: rowChange.profileId, table: rowChange.table, result: report });
      closeRowChange(true);
      if (result && executedQuery) {
        const previous = rowChange.change.kind === "delete" && result.rows.length === 1 && result.page > 0;
        void executeQuery(executedQuery, previous ? result.page - 1 : result.page);
      }
    }} />}
    {pasteRequest && <GridPasteDialog request={pasteRequest} onClose={closeRowPaste} onExitGuard={setGridEditExitGuard}
      onBusy={busy => { localFileBusy.current = busy; }} onApplied={report => {
        setPasteReport({ profile: pasteRequest.profileId, table: pasteRequest.table, result: report });
        closeRowPaste();
        if (result && executedQuery) void executeQuery(executedQuery, result.page);
      }} />}
    {restoreOpen && project && <SqliteRestoreDialog project={project} displayPath={displayPath} onClose={() => setRestoreOpen(false)} onRestored={report => { setRestoreReport(report); setRestoreOpen(false); }} />}
    {exportRequest && <ResultExportDialog profile={exportRequest.profile} query={exportRequest.query} onClose={() => setExportRequest(null)} onExported={report => { setExportReport(report); setExportRequest(null); }} />}
    {resultComparison && resultComparison.tabId === sqlDraft?.id && <React.Suspense fallback={null}>
      <SqlResultComparison sources={resultComparison.sources} initial={resultComparison.initial} onClose={() => setResultComparison(null)} />
    </React.Suspense>}
    {templateLibrary && project && templateLibrary.projectId === project.id && <React.Suspense fallback={null}>
      <SqlTemplateLibrary key={project.id} projectId={project.id} projectName={project.name}
        source={templateLibrary.source} selection={templateLibrary.selection} canOpen={sqlTarget?.projectId === project.id}
        onOpen={template => openSqlTemplate(template, project.id)} onClose={() => setTemplateLibrary(null)} />
    </React.Suspense>}
    {profile && sqlHistoryProfile === profile.id && <React.Suspense fallback={null}>
      <SqlHistoryDialog key={profile.id} connection={`${profile.name} · ${profile.environment}`}
        entries={sqlHistory.filter(entry => entry.profileId === profile.id)}
        onClear={() => clearSqlHistory(new Set([profile.id]))}
        onOpen={text => { setSqlHistoryProfile(null); openSqlDraft(text); }}
        onClose={() => setSqlHistoryProfile(null)} />
    </React.Suspense>}
    {profile && sqlBuilderProfile === profile.id && <React.Suspense fallback={null}>
      <SqlQueryBuilderDialog key={profile.id} profileId={profile.id} objects={objects}
        connection={`${profile.name} · ${profile.environment}`}
        onOpen={text => { setSqlBuilderProfile(null); openSqlDraft(text); }}
        onClose={() => setSqlBuilderProfile(null)} />
    </React.Suspense>}
    {profile && diagramProfile === profile.id && <React.Suspense fallback={null}>
      <SqlSchemaDiagramDialog key={profile.id} profileId={profile.id} connection={`${profile.name} · ${profile.environment}`}
        initialTable={selectedObject?.kind === "table" ? selectedObject.name : null}
        onOpen={name => {
          setDiagramProfile(null);
          openObject({ name, kind: "table", ddl: null }, true);
        }} onExport={object => setSchemaDocumentRequest({ profileId: profile.id, object })}
        onCompare={() => setSchemaComparisonSource(profile.id)}
        onClose={() => setDiagramProfile(null)} />
    </React.Suspense>}
    {profile && schemaComparisonSource === profile.id && <React.Suspense fallback={null}>
      <SchemaComparisonDialog initial={schemaComparisonSource} onClose={() => setSchemaComparisonSource(null)}
        onBusy={busy => { localFileBusy.current = busy; }}
        onApplied={id => { if (id === profileId) void refreshObjects(); }} />
    </React.Suspense>}
    {profile && schemaDocumentRequest?.profileId === profile.id && <React.Suspense fallback={null}>
      <SchemaDocumentDialog profile={profile} object={schemaDocumentRequest.object}
        onClose={() => setSchemaDocumentRequest(null)} onBusy={busy => { localFileBusy.current = busy; }} />
    </React.Suspense>}
    {parameterRequest && <Dialog title="SQL 매개변수" busy={false} onClose={() => setParameterRequest(null)}>
      <SqlParameterFields parameters={parameterRequest.parameters} dismiss={() => setParameterRequest(null)} submit={parameters => {
        setParameterRequest(null);
        void executeQuery({ ...parameterRequest.target, parameters }, 0, parameterRequest.scope);
      }} />
    </Dialog>}
    {sshProfileDialog && project && <SshProfileDialog mode={sshProfileDialog.mode} profile={sshProfileDialog.profile} initial={sshProfileDialog.initial}
      projectId={project.id} onClose={() => setSshProfileDialog(null)} onChanged={() => { setSshProfileDialog(null); void reloadSshProfiles(project.id).catch(e => setError(errorText(e))); }} />}
    {postgresAction && project && <PostgresProfileDialog action={postgresAction} projectId={project.id} onClose={() => setPostgresAction(null)} onSaved={savePostgresProfile} />}
    {sshExchange && project && <SshProfileExchange mode={sshExchange} projectId={project.id} profiles={sshProfiles} onClose={() => setSshExchange(null)} onImported={() => { void reloadSshProfiles(project.id).catch(e => setError(errorText(e))); }} />}
  </div>;
}

function SshProfileDialog({ mode, profile, initial, projectId, onClose, onChanged }: {
  mode: "create" | "edit" | "delete"; profile?: SshProfile; initial?: NetworkAddress; projectId: string; onClose: () => void; onChanged: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? initial?.host.slice(0, 80) ?? "");
  const [host, setHost] = useState(profile?.host ?? initial?.host ?? "");
  const [port, setPort] = useState(String(profile?.port ?? initial?.port ?? 22));
  const [username, setUsername] = useState(profile?.username ?? initial?.username ?? "");
  const [environment, setEnvironment] = useState<SshProfile["environment"]>(profile?.environment ?? "DEV");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const input = { name, host, port: Number(port), username, environment };
      if (mode === "create") await call("create_ssh_profile", { projectId, input });
      else if (mode === "edit" && profile) await call("update_ssh_profile", { id: profile.id, revision: profile.revision, input });
      else if (mode === "delete" && profile) await call("delete_ssh_profile", { id: profile.id, revision: profile.revision });
      else throw new Error("변경할 SSH 연결을 찾을 수 없습니다.");
      onChanged();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  const title = mode === "create" ? "SSH 연결 추가" : mode === "edit" ? "SSH 연결 수정" : "SSH 연결 삭제";
  return <Dialog title={title} onClose={onClose} busy={busy}><form onSubmit={submit} aria-busy={busy}>
    {mode === "delete" ? <p className="confirm-copy"><strong>{profile?.name}</strong> 연결 정의를 삭제합니다. 열린 SSH 세션과 저장된 호스트 키 신뢰 기록은 유지됩니다.</p> : <>
      <label className="field">연결 이름<input autoFocus required disabled={busy} value={name} onChange={event => setName(event.target.value)} placeholder="예: 운영 서버" /></label>
      <label className="field">호스트 또는 IP<input required disabled={busy} value={host} onChange={event => setHost(event.target.value)} placeholder="예: server.example.com" /></label>
      <label className="field">포트<input required type="number" min="1" max="65535" step="1" disabled={busy} value={port} onChange={event => setPort(event.target.value)} /></label>
      <label className="field">사용자 이름<input required pattern="[A-Za-z0-9_.][A-Za-z0-9._-]*" disabled={busy} value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label className="field">환경<select disabled={busy} value={environment} onChange={event => setEnvironment(event.target.value as SshProfile["environment"])}><option>DEV</option><option>STAGING</option><option>PROD</option></select></label>
      <p className="form-note">연결 정보만 저장합니다. 암호나 개인 키는 입력하지 않습니다. 운영 환경 연결은 열기 전 추가 확인합니다.</p>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button><button type="submit" className={mode === "delete" ? "danger" : "primary"} disabled={busy}>{busy ? "처리 중…" : mode === "delete" ? "삭제" : "저장"}</button></div>
  </form></Dialog>;
}

const auditOperationNames: Record<string, string> = {
  "project.create": "프로젝트 생성", "project.rename": "프로젝트 이름 변경", "project.duplicate": "프로젝트 복제", "project.delete": "프로젝트 삭제",
  "project.archive": "프로젝트 보관", "project.unarchive": "프로젝트 활성화",
  "sql_template.create": "SQL 템플릿 생성", "sql_template.update": "SQL 템플릿 편집", "sql_template.favorite": "SQL 템플릿 즐겨찾기 변경",
  "table_query_preset.create": "조회 조건 저장", "table_query_preset.replace": "조회 조건 갱신", "table_query_preset.delete": "조회 조건 삭제",
  "sql_template.delete": "SQL 템플릿 삭제",
  "workspace.copy": "작업 공간 데이터 복사",
  "sqlite_profile.create": "SQLite 연결 추가", "sqlite_profile.delete": "SQLite 연결 삭제", "sqlite.backup": "SQLite 백업", "sqlite.cell.update": "SQLite 셀 변경",
  "sqlite.row.insert": "SQLite 행 추가", "sqlite.row.delete": "SQLite 행 삭제",
  "sqlite.row.paste": "SQLite 행 붙여넣기",
  "sqlite.row.import": "SQLite 파일 가져오기",
  "sqlite.row.update": "SQLite 행 변경",
  "sqlite.grid.update": "SQLite 여러 행 변경",
  "postgres.row.insert": "PostgreSQL 행 추가", "postgres.row.delete": "PostgreSQL 행 삭제",
  "postgres.row.paste": "PostgreSQL 행 붙여넣기",
  "postgres.row.import": "PostgreSQL 파일 가져오기",
  "sqlite.schema.export": "SQLite 데이터 사전 저장",
  "sqlite.schema.sync": "SQLite 스키마 변경 적용",
  "sqlite.restore": "SQLite 복원",
  "sqlite.export.csv": "SQLite CSV 내보내기",
  "sqlite.export.json": "SQLite JSON 내보내기",
  "ssh_profile.create": "SSH 연결 추가", "ssh_profile.update": "SSH 연결 수정", "ssh_profile.delete": "SSH 연결 삭제",
  "ssh_tunnel.create": "SSH 터널 등록", "ssh_tunnel.update": "SSH 터널 수정", "ssh_tunnel.delete": "SSH 터널 삭제",
  "postgres_profile.create": "PostgreSQL 연결 추가", "postgres_profile.update": "PostgreSQL 연결 수정", "postgres_profile.delete": "PostgreSQL 연결 삭제",
  "postgres.edit.cell": "PostgreSQL 셀 변경",
  "postgres.edit.row": "PostgreSQL 행 변경",
  "postgres.edit.grid": "PostgreSQL 여러 행 변경",
  "postgres.export.csv": "PostgreSQL CSV 내보내기", "postgres.export.json": "PostgreSQL JSON 내보내기",
  "ssh_profile.import": "SSH 연결 가져오기", "ssh_profile.export": "SSH 연결 내보내기",
  "sftp.download": "SFTP 다운로드", "sftp.download.cancel": "SFTP 다운로드",
  "sftp.upload": "SFTP 업로드", "sftp.upload.cancel": "SFTP 업로드",
  "sftp.mkdir": "SFTP 폴더 생성",
  "sftp.sync": "SFTP 폴더 동기화",
  "sftp.sync.cancel": "SFTP 폴더 동기화",
  "sftp.sync.delete": "SFTP 폴더 동기화 · 삭제 포함",
  "sftp.sync.delete.cancel": "SFTP 폴더 동기화 · 삭제 포함",
  "sftp.rename": "SFTP 이름 변경",
  "sftp.chmod": "SFTP 권한 변경",
  "sftp.chown": "SFTP 소유자·그룹 변경",
  "sftp.move": "SFTP 이동",
  "sftp.copy": "SFTP 복사", "sftp.copy.cancel": "SFTP 복사",
  "sftp.delete": "SFTP 삭제",
  "sftp.edit": "SFTP 편집 저장", "sftp.edit.cancel": "SFTP 편집 저장",
  "sftp.edit.copy": "SFTP 편집본 새 이름 저장", "sftp.edit.copy.cancel": "SFTP 편집본 새 이름 저장",
};
const auditOutcomeNames: Record<string, string> = { started: "시작", succeeded: "완료", failed: "실패", cancelled: "중단" };

function AuditPanel({ onBack }: { onBack: () => void }) {
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [sshOpen, setSshOpen] = useState(false);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    call<AuditPage>("list_audit_events", { before: cursor })
      .then(result => { if (live) setPage(result); })
      .catch(e => { if (live) setError(errorText(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [cursor, refresh]);

  return <section className="audit-panel" aria-labelledby="audit-title">
    <div className="audit-header"><div><button className="back-button" onClick={onBack}><ArrowLeft size={15} /> 작업 공간으로</button><h1 id="audit-title">작업 기록</h1><p>이 장치의 프로젝트·연결 변경, SQLite·SFTP 작업과 SSH 호스트 키 신뢰 기록을 확인합니다.</p></div><button className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /> 새로고침</button></div>
    <p className="audit-note">SQL, 행 데이터, 암호와 파일 경로는 기록하지 않습니다. 실행자는 로컬 사용자로만 표시되며 개인 계정 식별과 변조 방지는 아직 제공되지 않습니다.</p>
    {error && <div className="error-banner" role="alert">기록을 불러오지 못했습니다: {error}</div>}
    <div className="audit-card" aria-busy={loading}>
      {loading ? <p className="audit-empty">기록을 불러오는 중…</p> : page?.events.length ? <ul className="audit-list">{page.events.map(event => {
        const outcome = event.operation.startsWith("sftp.") && event.operation.endsWith(".cancel") ? "cancelled" : event.outcome;
        return <li key={event.id}>
          <div className="audit-row"><div><strong>{auditOperationNames[event.operation] ?? event.operation}</strong> <span className={`audit-outcome ${outcome}`}>{auditOutcomeNames[outcome] ?? outcome}</span><p>{new Date(event.occurred_at).toLocaleString("ko-KR")} · 로컬 사용자{event.environment ? ` · ${event.environment}` : ""}{event.affected_count !== null ? ` · ${event.affected_count}개 항목` : ""}</p></div><details><summary>상세</summary><dl><dt>이벤트 ID</dt><dd>{event.id}</dd><dt>작업 ID</dt><dd>{event.correlation_id}</dd>{event.project_id && <><dt>프로젝트 ID</dt><dd>{event.project_id}</dd></>}{event.profile_id && <><dt>연결 ID</dt><dd>{event.profile_id}</dd></>}{event.object_name && <><dt>객체</dt><dd>{event.object_name}</dd></>}<dt>정책</dt><dd>{event.policy}</dd></dl></details></div>
        </li>;
      })}</ul> : <p className="audit-empty">아직 기록된 작업이 없습니다.</p>}
      <div className="pagination"><span>최대 100개씩 표시</span><div><button className="secondary" disabled={loading || cursors.length === 1} onClick={() => setCursors(items => items.slice(0, -1))}>이전</button><button className="secondary" disabled={loading || !page?.next_cursor} onClick={() => { if (page?.next_cursor) setCursors(items => [...items, page.next_cursor]); }}>이전 기록 더 보기</button></div></div>
    </div>
    <details className="ssh-history" onToggle={event => setSshOpen(event.currentTarget.open)}><summary>SSH 호스트 키 신뢰 기록</summary>{sshOpen && <SshTrustHistory />}</details>
  </section>;
}

function SshTrustHistory() {
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const [page, setPage] = useState<SshTrustPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    call<SshTrustPage>("list_ssh_trust_events", { before: cursor }).then(result => { if (live) setPage(result); })
      .catch(e => { if (live) setError(errorText(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [cursor, refresh]);
  return <div className="ssh-history-content" aria-busy={loading}>
    <div className="ssh-history-heading"><p>호스트 이름·포트와 확인한 공개 키 지문을 이 장치에 기록합니다.</p><button className="secondary small" disabled={loading} onClick={() => setRefresh(value => value + 1)}>새로고침</button></div>
    {error && <p className="form-error" role="alert">신뢰 기록을 불러오지 못했습니다: {error}</p>}
    {loading ? <p className="audit-empty">기록을 불러오는 중…</p> : page?.events.length ? <ul className="audit-list">{page.events.map(event => <li key={event.id}>
      <div className="audit-row"><div><strong>{event.action === "replaced" ? "호스트 키 교체" : "호스트 키 신뢰"}</strong><p>{event.host.includes(":") ? `[${event.host}]` : event.host}:{event.port} · {new Date(event.occurred_at).toLocaleString("ko-KR")} · 로컬 사용자</p></div><details><summary>지문과 이벤트 ID</summary><dl>{event.previous_fingerprint && <><dt>이전 지문</dt><dd>{event.previous_fingerprint}</dd></>}<dt>확인한 지문</dt><dd>{event.fingerprint}</dd><dt>이벤트 ID</dt><dd>{event.id}</dd></dl></details></div>
    </li>)}</ul> : <p className="audit-empty">아직 신뢰한 호스트 키가 없습니다.</p>}
    <div className="pagination"><span>최대 100개씩 표시</span><div><button className="secondary" disabled={loading || cursors.length === 1} onClick={() => setCursors(items => items.slice(0, -1))}>이전</button><button className="secondary" disabled={loading || !page?.next_cursor} onClick={() => { if (page?.next_cursor) setCursors(items => [...items, page.next_cursor]); }}>이전 기록 더 보기</button></div></div>
  </div>;
}

function EmptyState({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><div className="empty-icon" aria-hidden><Layers3 size={27} /></div><h1>{title}</h1><p>{text}</p>{action && <button className="primary" onClick={onAction}><Plus size={16} /> {action}</button>}</div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
