import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft, ArrowRight, Archive, Boxes, ChevronDown, ChevronRight,
  Database, FileCode2, FileDown, FileUp, Focus, FolderOpen, HardDrive, History, Layers3, PanelLeftClose, PanelLeftOpen, PanelsTopLeft,
  Pencil, Plus, RefreshCw, RotateCcw, Search, Settings, ShieldCheck, Table2, TerminalSquare, Trash2, Workflow, X, Play,
} from "lucide-react";
import type { SshOpenRequest, SshProfile } from "./ssh-profile-types";
import { SshProfileExchange } from "./SshProfileExchange";
import { TableQueryControls, defaultTableQuery, type TableQuery } from "./TableQueryControls";
import { SqliteRestoreDialog, restoreCounts, type RestoreReport } from "./SqliteRestoreDialog";
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
import { RdpWorkspace } from "./RdpWorkspace";
import { SftpWorkspace } from "./SftpWorkspace";
import type { TerminalDirectory } from "./terminalDirectory";
import { WorkspaceCopyDialog } from "./WorkspaceCopyDialog";
import { WorkspaceExitDialog } from "./WorkspaceExitDialog";
import { WorkspaceNavigation, workspaceTools, type WorkspacePage } from "./WorkspaceNavigation";
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
type EditKey = { name: string; kind: string; value: string };
type EditField = { name: string; declared_type: string; current: Cell; editable: boolean; reason: string | null };
type EditSession = { token: string; table: string; environment: string; keys: EditKey[]; fields: EditField[]; expires_seconds: number };
type EditPreview = { column: string; before: Cell; after: Cell };
type EditResult = { actual: Cell; audit_warning: string | null };
type EditRequest = { profile: Profile; object: DatabaseObject; keys: EditKey[] };
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

function Dialog({ title, children, onClose, busy }: { title: string; children: React.ReactNode; onClose: () => void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="dialog" aria-labelledby={titleId} onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    {children}
  </dialog>;
}

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
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const [terminalTabCount, setTerminalTabCount] = useState(0);
  const [rdpClientCount, setRdpClientCount] = useState(0);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [workspaceCopyOpen, setWorkspaceCopyOpen] = useState(false);
  const [loadedPages, setLoadedPages] = useState<ReadonlySet<WorkspacePage>>(() => new Set(["workspace"]));
  const [projects, setProjects] = useState<Project[]>([]);
  const [startupLoaded, setStartupLoaded] = useState(!desktop);
  const [resumeReadError, setResumeReadError] = useState(false);
  const [archivedProjectsOpen, setArchivedProjectsOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([]);
  const [sshProfileDialog, setSshProfileDialog] = useState<{ mode: "create" | "edit" | "delete"; profile?: SshProfile } | null>(null);
  const [sshExchange, setSshExchange] = useState<"import" | "export" | null>(null);
  const [sshOpenRequest, setSshOpenRequest] = useState<SshOpenRequest | null>(null);
  const [terminalDirectory, setTerminalDirectory] = useState<TerminalDirectory | null>(null);
  const [profileId, setProfileId] = useState("");
  const [objects, setObjects] = useState<DatabaseObject[]>([]);
  const [selectedObject, setSelectedObject] = useState<DatabaseObject | null>(null);
  const [schemaDetailsOpen, setSchemaDetailsOpen] = useState(false);
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
  const [filter, setFilter] = useState("");
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
  const [editRequest, setEditRequest] = useState<EditRequest | null>(null);
  const [editReport, setEditReport] = useState<EditResult | null>(null);
  const [saving, setSaving] = useState(false);
  const queryGeneration = useRef(0);
  const activeQuery = useRef<ActiveQuery | null>(null);
  const objectGeneration = useRef(0);
  const detailsGeneration = useRef(0);
  const terminalCount = useRef(0);
  const rdpCount = useRef(0);
  const sshRequestSequence = useRef(0);
  const selectedProject = useRef(projectId);
  selectedProject.current = projectId;
  const closeApproved = useRef(false);
  const closePending = useRef(false);
  const exitPromptOpen = useRef(exitPrompt);
  exitPromptOpen.current = exitPrompt;
  const sftpExitGuard = useRef<(() => void) | null>(null);
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
  const consumeSshRequest = useCallback(() => { setSshOpenRequest(null); }, []);
  const setSftpExitGuard = useCallback((guard: (() => void) | null) => { sftpExitGuard.current = guard; }, []);
  // Drafts stay in memory: SQL can contain sensitive literals, so the editor
  // must not silently write them to browser storage or workspace metadata.
  const drafts = useRef(sqlTabSets);
  drafts.current = sqlTabSets;
  const project = projects.find(item => item.id === projectId);
  const profile = profiles.find(item => item.id === profileId && item.project_id === projectId);
  const sqlTarget = profile && project ? {
    profileId: profile.id, projectId: project.id, projectName: project.name, profileName: profile.name,
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
    function openCommandPalette(event: globalThis.KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.isComposing
        || event.key.toLowerCase() !== "p" || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      event.stopPropagation();
      setPaletteOpen(true);
    }
    window.addEventListener("keydown", openCommandPalette, true);
    return () => window.removeEventListener("keydown", openCommandPalette, true);
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
    setProfiles([]); setSshProfiles([]); setProfileId(""); setObjects([]); setTableQueryResult(null);
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
    }
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    let live = true;
    resetActiveQuery();
    const generation = ++objectGeneration.current;
    setObjects([]); setTableQueryResult(null); setResultMode("sql"); setError("");
    setSqlEditorOpen(true);
    setSqlSelection(null);
    setParameterRequest(null);
    setSqlHistoryProfile(null);
    setSqlBuilderProfile(null);
    setExportReport(null);
    detailsGeneration.current++; setSelectedObject(null); setObjectDetails(null); setDetailsError(""); setDetailsLoading(false);
    setBackupReport(null);
    setEditReport(null);
    if (profileId) {
      setLoading(true);
      call<DatabaseObject[]>("list_objects", { profileId })
        .then(items => { if (live && objectGeneration.current === generation) setObjects(items); })
        .catch(e => { if (live && objectGeneration.current === generation) setError(errorText(e)); })
        .finally(() => { if (live && objectGeneration.current === generation) setLoading(false); });
    } else setLoading(false);
    return () => { live = false; };
  }, [profileId]);

  useEffect(() => {
    function warnBeforeClose(event: BeforeUnloadEvent) {
      if (!closeApproved.current && (localFileBusy.current || sftpExitGuard.current || terminalCount.current > 0 || rdpCount.current > 0 || hasDirtySqlTabs(drafts.current))) {
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

  const requestAppClose = useCallback(() => {
    if (closeApproved.current || closePending.current || localFileBusy.current || exitPromptOpen.current) return;
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
      if (objectGeneration.current === generation) setObjects(items);
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
    setProfileId(id);
    showTool("workspace");
  }

  function openSavedSsh(item: SshProfile) {
    setSshOpenRequest({ profile: item, sequence: ++sshRequestSequence.current });
    showTool("terminal");
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
        { id: "open:history", title: "작업 기록", group: "작업", keywords: "audit history", Icon: History, run: showHistory },
        { id: "toggle:split", title: layout.kind === "split" ? "화면 분할 해제" : "화면 분할", group: "작업", keywords: "split pane", Icon: PanelsTopLeft, run: toggleSplit },
        { id: "create:project", title: "새 프로젝트", group: "작업", Icon: Plus, run: () => openModal("project") },
        { id: "open:archived", title: "보관된 프로젝트", group: "작업", Icon: Archive, run: () => setArchivedProjectsOpen(true) },
      );
    }
    if (project) {
      commands.push(
        { id: "create:sqlite", title: "SQLite 연결 추가", group: "작업", Icon: Database, run: () => openModal("profile") },
        { id: "create:ssh", title: "SSH 연결 추가", group: "작업", Icon: TerminalSquare, run: () => setSshProfileDialog({ mode: "create" }) },
      );
      if (desktop) commands.push({ id: "open:sql-templates", title: "SQL 템플릿", group: "작업",
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
    for (const item of sshProfiles.filter(item => item.project_id === projectId)) commands.push({
      id: `ssh:${item.id}`, title: item.name, group: "SSH 연결", detail: item.environment,
      Icon: TerminalSquare, run: () => openSavedSsh(item),
    });
    if (desktop && profile) commands.push({ id: "open:sql-history", title: "최근 SQL", group: "작업",
      keywords: "query history recent sql", Icon: History, run: openSqlHistory });
    if (desktop && profile) commands.push({ id: "open:sql-builder", title: "쿼리 빌더", group: "작업",
      keywords: "query builder join group select sql", Icon: Table2, run: openSqlBuilder });
    if (desktop && profile) commands.push({ id: "open:schema-diagram", title: "SQLite 관계도", group: "작업",
      keywords: "erd schema diagram foreign key 외래 키", Icon: Workflow, run: () => setDiagramProfile(profile.id) });
    if (desktop && profile) commands.push({ id: "open:schema-document", title: "SQLite 데이터 사전", group: "작업",
      keywords: "schema data dictionary markdown html 구조 문서", Icon: FileDown,
      run: () => setSchemaDocumentRequest({ profileId: profile.id, object: selectedObject?.name ?? null }) });
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

  const filtered = objects.filter(item => item.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const tables = filtered.filter(item => item.kind === "table");
  const views = filtered.filter(item => item.kind === "view");
  const primaryKeys = objectDetails?.columns.filter(column => column.primary_key_position > 0).sort((a, b) => a.primary_key_position - b.primary_key_position) ?? [];
  const resultForObject = selectedObject && (
    executedQuery?.kind === "table" ? executedQuery.request.object === selectedObject.name
      : executedQuery?.kind === "sql" && executedQuery.sql === objectSelectSql(selectedObject.name) && sql === executedQuery.sql
  );
  const canEditRows = Boolean(!pinned && profile && selectedObject?.kind === "table" && objectDetails && primaryKeys.length && result && resultForObject);
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
      if (index < 0 || !cell || cell.truncated || !["integer", "real", "text"].includes(cell.kind)) return null;
      keys.push({ name: column.name, kind: cell.kind, value: cell.display });
    }
    return keys;
  }

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
    {restoreReport && !historyOpen && <div className="success-banner restore-result" role="status">
      <strong>SQLite 복원 완료 · 검증 통과</strong>
      <span>{displayPath(restoreReport.path)}</span>
      <span>{restoreCounts(restoreReport)} · 무결성 및 SHA-256 일치</span>
      <code>{restoreReport.sha256}</code>
      {restoreReport.audit_warning && <strong className="audit-warning">{restoreReport.audit_warning}</strong>}
    </div>}
    {historyOpen ? <AuditPanel onBack={() => setHistoryOpen(false)} /> : !desktop ? <EmptyState title="데스크톱 앱에서 시작하세요" text="브라우저에서 로컬 파일에 직접 연결할 수 없습니다. 브라우저용 게이트웨이는 아직 제공되지 않습니다." /> :
    !project ? <EmptyState title="첫 프로젝트를 만드세요" text="프로젝트에서 SQLite와 SSH 연결을 함께 관리할 수 있습니다." action="프로젝트 만들기" onAction={() => openModal("project")} /> :
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
      {editReport && <div className="success-banner" role="status"><strong>셀 변경 완료 · 저장 값 검증됨</strong><span>저장된 값: {editReport.actual.kind === "null" ? "NULL" : editReport.actual.display || "(빈 문자열)"}</span>{editReport.audit_warning && <strong className="audit-warning">{editReport.audit_warning}</strong>}</div>}
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
        {selectedObject && objectDetails && <TableQueryControls key={detailsGeneration.current} object={selectedObject.name} columns={objectDetails.columns.filter(column => column.hidden !== 1).map(column => column.name)} busy={querying} apply={request => void executeQuery({ kind: "table", request })} />}
        {result?.generated_sql && executedQuery?.kind === "table" && <details className="table-query-sql">
          <summary>{executedQuery.request.object} · 조회 SQL{executedQuery.request.filters.length > 0 && ` · 필터 ${executedQuery.request.filters.length}개`}{executedQuery.request.sort.length > 0 && ` · 정렬 ${executedQuery.request.sort.length}개`}</summary>
          <pre>{result.generated_sql}</pre>
          {executedQuery.request.filters.length > 0 && <p>물음표에는 필터 값을 매개변수로 전달합니다.</p>}
        </details>}
        {result?.metrics && <SqlQueryMetrics metrics={result.metrics} />}
        {editUnavailableReason && <p className="edit-unavailable">{editUnavailableReason}</p>}
        {result ? <><div className="table-wrap"><table><thead><tr><th scope="col" className="row-number">#</th>{result.columns.map((column, i) => <th scope="col" key={i}>{column}</th>)}{canEditRows && <th scope="col">작업</th>}</tr></thead><tbody>{result.rows.map((row, rowIndex) => { const keys = keysForRow(row); return <tr key={rowIndex}><td className="row-number">{result.page * 100 + rowIndex + 1}</td>{row.map((cell, index) => <td key={index} className={cell.kind === "null" ? "null-cell" : ""} title={cell.truncated ? "표시 길이를 초과하여 일부만 표시됩니다." : undefined}>{cell.display}{cell.truncated ? "…" : ""}</td>)}{canEditRows && <td>{keys && profile && selectedObject ? <button className="row-edit" disabled={querying} aria-label={`${result.page * 100 + rowIndex + 1}행 편집`} onClick={() => { setEditReport(null); setEditRequest({ profile, object: selectedObject, keys }); }}>편집</button> : <span className="subtle" title="NULL·BLOB 또는 긴 기본 키는 편집할 수 없습니다.">지원 안 됨</span>}</td>}</tr>; })}</tbody></table>{result.rows.length === 0 && <p className="result-empty">조회된 행이 없습니다.</p>}</div>
          {!pinned && <div className="pagination"><span>페이지 {result.page + 1}{result.has_more ? " · 다음 페이지 있음" : " · 마지막 페이지"}</span><div><button className="icon-button" disabled={!result.page || querying} onClick={() => { if (executedQuery) void executeQuery(executedQuery, result.page - 1); }} aria-label="이전 페이지"><ArrowLeft size={16} /></button><button className="icon-button" disabled={!result.has_more || querying} onClick={() => { if (executedQuery) void executeQuery(executedQuery, result.page + 1); }} aria-label="다음 페이지"><ArrowRight size={16} /></button></div></div>}</> : <div className="result-placeholder"><Table2 size={24} /><strong>아직 조회 결과가 없습니다</strong><span>테이블을 선택하거나 SQL을 실행해 보세요.</span></div>}
      </section>
    </>}
    {!profile && error && <div className="error-banner" role="alert">{error}</div>}
  </div>;

  const toolPanes: Record<WorkspacePage, React.ReactNode> = {
    workspace: databasePane,
    terminal: loadedPages.has("terminal") && <div id="workspace-pane-terminal" className="tool-body terminal-body">
      <React.Suspense fallback={<p className="terminal-loading" role="status">터미널을 불러오는 중…</p>}>
        <TerminalWorkspace visible={toolVisible("terminal")} colorScheme={colorScheme} onCountChange={updateTerminalCount} request={sshOpenRequest}
          onRequestHandled={consumeSshRequest} onDirectoryChange={setTerminalDirectory} />
      </React.Suspense>
    </div>,
    network: loadedPages.has("network") && <div id="workspace-pane-network" className="tool-body network-body"><NetworkWorkspace /></div>,
    rdp: loadedPages.has("rdp") && <div id="workspace-pane-rdp" className="tool-body network-body"><RdpWorkspace desktop={desktop} onCountChange={updateRdpCount} /></div>,
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
        <aside className="explorer" id="workspace-explorer" aria-label="작업 공간 탐색기" hidden={focusMode || !explorerOpen}>
          <div className="explorer-top"><span>탐색기</span><button className="icon-button" onClick={() => openModal("project")} disabled={!desktop} aria-label="새 프로젝트"><Plus size={17} /></button></div>
          <label className="select-label" htmlFor="project-select">프로젝트</label>
          <div className="project-selector"><FolderOpen size={16} /><select id="project-select" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={!projects.length}>
            {!projects.length && <option value="">프로젝트 없음</option>}
            {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select><ChevronDown size={15} /></div>
          {project && <div className="project-actions"><button onClick={() => openModal("rename")}>이름 변경</button><button onClick={() => openModal("duplicateProject")}>복제</button><button onClick={() => openModal("archiveProject")}>보관</button><button onClick={() => openModal("deleteProject")}>삭제</button></div>}
          <div className="project-actions">
            <button disabled={!desktop} onClick={() => setArchivedProjectsOpen(true)}><Archive size={13} /> 보관된 프로젝트</button>
            <button disabled={!desktop} onClick={() => setWorkspaceCopyOpen(true)}><FileDown size={13} /> 데이터 복사</button>
          </div>
          <div className="section-heading"><span>데이터베이스</span><div>
            <button className="icon-button" onClick={() => { setRestoreOpen(true); showTool("workspace"); }} disabled={!project} aria-label="SQLite 백업 복원" title="SQLite 백업 복원"><RotateCcw size={15} /></button>
            <button className="icon-button" onClick={() => openModal("profile")} disabled={!project} aria-label="SQLite 연결 추가"><Plus size={16} /></button>
          </div></div>
          {!profiles.length && <p className="sidebar-empty">{project ? "저장된 연결이 없습니다." : "프로젝트를 먼저 만드세요."}</p>}
          <div className="profile-list">{profiles.map(item => <button key={item.id} className={`profile-row ${item.id === profileId ? "selected" : ""}`} onClick={() => selectSqliteProfile(item.id)}>
            {item.id === profileId ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Database size={15} /><span>{item.name}</span><small>{item.environment}</small>
          </button>)}</div>
          {profile && <div className="object-list">
            <div className="object-toolbar"><span>객체</span><button className="icon-button" onClick={refreshObjects} disabled={loading} aria-label="객체 새로고침"><RefreshCw size={14} /></button></div>
            <div className="object-search"><Search size={14} /><input aria-label="객체 검색" value={filter} onChange={e => setFilter(e.target.value)} placeholder="이름으로 찾기" /></div>
            {loading ? <p className="sidebar-empty">불러오는 중…</p> : <>
              <ObjectGroup name="테이블" items={tables} selected={selectedObject?.name} onSelect={openObject} />
              <ObjectGroup name="뷰" items={views} selected={selectedObject?.name} onSelect={openObject} />
            </>}
          </div>}
          <div className="section-heading"><span>SSH 연결</span><div><button className="icon-button" onClick={() => setSshExchange("import")} disabled={!project} aria-label="SSH 연결 가져오기" title="SSH 연결 가져오기"><FileUp size={14} /></button><button className="icon-button" onClick={() => setSshExchange("export")} disabled={!project || !sshProfiles.length} aria-label="SSH 연결 내보내기" title="SSH 연결 내보내기"><FileDown size={14} /></button><button className="icon-button" onClick={() => { if (projectId) void reloadSshProfiles(projectId).catch(e => setError(errorText(e))); }} disabled={!project} aria-label="SSH 연결 새로고침"><RefreshCw size={14} /></button><button className="icon-button" onClick={() => setSshProfileDialog({ mode: "create" })} disabled={!project} aria-label="SSH 연결 추가"><Plus size={16} /></button></div></div>
          {!sshProfiles.length && <p className="sidebar-empty">{project ? "저장된 SSH 연결이 없습니다." : "프로젝트를 먼저 만드세요."}</p>}
          <div className="profile-list">{sshProfiles.map(item => <div className="ssh-profile-row" key={item.id}>
            <button className="profile-row" aria-label={`SSH ${item.name} 연결`} aria-description={`${item.username}@${item.host}:${item.port} · ${item.environment}`} title={`${item.username}@${item.host}:${item.port}`} onClick={() => openSavedSsh(item)}><TerminalSquare size={15} /><span className="ssh-profile-detail"><span>{item.name}</span><small>{item.host.includes(":") ? `[${item.host}]` : item.host}:{item.port}</small></span><small className={item.environment.toLowerCase()}>{item.environment}</small></button>
            <button className="icon-button" aria-label={`${item.name} SSH 연결 수정`} aria-description={`${item.username}@${item.host}:${item.port} · ${item.environment}`} onClick={() => setSshProfileDialog({ mode: "edit", profile: item })}><Pencil size={14} /></button>
            <button className="icon-button" aria-label={`${item.name} SSH 연결 삭제`} aria-description={`${item.username}@${item.host}:${item.port} · ${item.environment}`} onClick={() => setSshProfileDialog({ mode: "delete", profile: item })}><Trash2 size={14} /></button>
          </div>)}</div>
        </aside>
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
    }))} terminals={terminalTabCount} rdpClients={rdpClientCount}
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
    {editRequest && <EditDialog request={editRequest} onClose={() => setEditRequest(null)} onApplied={report => { setEditRequest(null); setEditReport(report); if (result && executedQuery) void executeQuery(executedQuery, result.page); }} />}
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
        onClose={() => setDiagramProfile(null)} />
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
    {sshProfileDialog && project && <SshProfileDialog mode={sshProfileDialog.mode} profile={sshProfileDialog.profile} projectId={project.id} onClose={() => setSshProfileDialog(null)} onChanged={() => { setSshProfileDialog(null); void reloadSshProfiles(project.id).catch(e => setError(errorText(e))); }} />}
    {sshExchange && project && <SshProfileExchange mode={sshExchange} projectId={project.id} profiles={sshProfiles} onClose={() => setSshExchange(null)} onImported={() => { void reloadSshProfiles(project.id).catch(e => setError(errorText(e))); }} />}
  </div>;
}

function SshProfileDialog({ mode, profile, projectId, onClose, onChanged }: { mode: "create" | "edit" | "delete"; profile?: SshProfile; projectId: string; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [host, setHost] = useState(profile?.host ?? "");
  const [port, setPort] = useState(String(profile?.port ?? 22));
  const [username, setUsername] = useState(profile?.username ?? "");
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
  "sql_template.delete": "SQL 템플릿 삭제",
  "workspace.copy": "작업 공간 데이터 복사",
  "sqlite_profile.create": "SQLite 연결 추가", "sqlite_profile.delete": "SQLite 연결 삭제", "sqlite.backup": "SQLite 백업", "sqlite.cell.update": "SQLite 셀 변경",
  "sqlite.schema.export": "SQLite 데이터 사전 저장",
  "sqlite.restore": "SQLite 복원",
  "sqlite.export.csv": "SQLite CSV 내보내기",
  "sqlite.export.json": "SQLite JSON 내보내기",
  "ssh_profile.create": "SSH 연결 추가", "ssh_profile.update": "SSH 연결 수정", "ssh_profile.delete": "SSH 연결 삭제",
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

function EditDialog({ request, onClose, onApplied }: { request: EditRequest; onClose: () => void; onApplied: (result: EditResult) => void }) {
  const [session, setSession] = useState<EditSession | null>(null);
  const [column, setColumn] = useState("");
  const [kind, setKind] = useState("text");
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [needsRestart, setNeedsRestart] = useState(false);
  const current = session?.fields.find(field => field.name === column);

  useEffect(() => {
    let live = true;
    let token: string | null = null;
    call<EditSession>("begin_cell_edit", { profileId: request.profile.id, table: request.object.name, keys: request.keys })
      .then(result => {
        token = result.token;
        if (!live) { void call("cancel_cell_edit", { token }).catch(() => {}); return; }
        setSession(result);
        const first = result.fields.find(field => field.editable);
        if (first) { setColumn(first.name); setKind(first.current.kind === "null" ? "text" : first.current.kind); setValue(first.current.kind === "null" ? "" : first.current.display); }
      })
      .catch(e => { if (live) setError(errorText(e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; if (token) void call("cancel_cell_edit", { token }).catch(() => {}); };
  }, [request]);

  function chooseColumn(name: string) {
    const field = session?.fields.find(item => item.name === name);
    setColumn(name); setPreview(null); setError("");
    if (field) { setKind(field.current.kind === "null" ? "text" : field.current.kind); setValue(field.current.kind === "null" ? "" : field.current.display); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!session || busy || needsRestart) return;
    if (preview && session.environment === "PROD" && confirmation !== "PROD") { setError("운영 환경을 확인하려면 PROD를 입력하세요."); return; }
    setBusy(true); setError("");
    try {
      if (!preview) {
        const next = await call<EditPreview>("preview_cell_edit", { token: session.token, column, input: { kind, value } });
        setPreview(next);
      } else {
        const result = await call<EditResult>("apply_cell_edit", { token: session.token, productionConfirmation: confirmation });
        onApplied(result);
      }
    } catch (e) {
      setError(errorText(e));
      if (preview) { setNeedsRestart(true); setPreview(null); }
    } finally { setBusy(false); }
  }

  return <Dialog title="SQLite 셀 편집" onClose={onClose} busy={busy}><form onSubmit={submit} aria-busy={busy}>
    <p className="confirm-copy">대상: <strong>{request.profile.name} · {request.object.name}</strong> <span className={`environment ${request.profile.environment.toLowerCase()}`}>{request.profile.environment}</span><br />{displayPath(request.profile.path)}</p>
    {busy && !session && <p className="form-note" role="status">현재 행을 읽는 중…</p>}
    {session && <><p className="form-note">기본 키: {session.keys.map(key => `${key.name} = ${key.value}`).join(", ")}</p><p className="form-note">현재 DB에서 다시 읽은 행입니다. 전체 행이 바뀌면 적용을 중단합니다. 한 번에 한 셀만 변경할 수 있으며 편집 세션은 {session.expires_seconds / 60}분 후 만료됩니다.</p>
      {!needsRestart && <><label className="field">변경할 열<select value={column} disabled={busy || Boolean(preview)} onChange={event => chooseColumn(event.target.value)}>{session.fields.map(field => <option key={field.name} value={field.name} disabled={!field.editable}>{field.name}{field.editable ? "" : ` — ${field.reason}`}</option>)}</select></label>
        {current && <div className="edit-current"><span>현재 값 · {current.current.kind}</span><pre>{current.current.kind === "null" ? "NULL" : current.current.display || "(빈 문자열)"}</pre></div>}
        <label className="field">새 값의 형식<select value={kind} disabled={busy || Boolean(preview)} onChange={event => { setKind(event.target.value); setPreview(null); }}><option value="text">문자열</option><option value="integer">정수</option><option value="real">실수</option><option value="null">NULL</option></select></label>
        {kind !== "null" && <label className="field">변경할 값<textarea className="edit-value" value={value} disabled={busy || Boolean(preview)} onChange={event => { setValue(event.target.value); setPreview(null); }} /></label>}
      </>}
      {preview && <div className="edit-preview"><strong>변경 미리보기 · 1행 / 1열</strong><div><span>이전 · {preview.before.kind}</span><pre>{preview.before.kind === "null" ? "NULL" : preview.before.display || "(빈 문자열)"}</pre></div><div><span>변경 · {preview.after.kind}</span><pre>{preview.after.kind === "null" ? "NULL" : preview.after.display || "(빈 문자열)"}</pre></div><p>제약 조건 위반이나 값 형식 변환이 발생하면 롤백합니다. 적용 후 자동 되돌리기는 제공되지 않으므로 필요하면 먼저 백업하세요.</p></div>}
      {preview && session.environment === "PROD" && <label className="field">운영 환경 확인: PROD 입력<input value={confirmation} disabled={busy} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></label>}
    </>}
    {error && <p className="form-error" role="alert">{error}{needsRestart && " 닫은 뒤 행을 다시 조회하고 선택하세요."}</p>}
    <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>닫기</button>{preview && !needsRestart && <button type="button" className="secondary" disabled={busy} onClick={() => { setPreview(null); setConfirmation(""); }}>다시 편집</button>}{session && !needsRestart && <button type="submit" className={preview ? "danger" : "primary"} disabled={busy}>{busy ? "처리 중…" : preview ? "변경 적용" : "변경 미리보기"}</button>}</div>
  </form></Dialog>;
}

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

function ObjectGroup({ name, items, selected, onSelect }: { name: string; items: DatabaseObject[]; selected?: string; onSelect: (object: DatabaseObject) => void }) {
  return <section className="object-group"><div className="group-title"><ChevronDown size={13} /> {name} <span>{items.length}</span></div>{items.map(object => <button key={object.name} className="object-row"
    aria-current={object.name === selected ? "true" : undefined} onClick={() => onSelect(object)}><Table2 size={14} /><span>{object.name}</span></button>)}</section>;
}

function EmptyState({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><div className="empty-icon" aria-hidden><Layers3 size={27} /></div><h1>{title}</h1><p>{text}</p>{action && <button className="primary" onClick={onAction}><Plus size={16} /> {action}</button>}</div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
