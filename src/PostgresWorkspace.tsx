import { lazy, Suspense, useEffect, useEffectEvent, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, Archive, Database, FileCode2, Maximize2, Pencil, Plug, Plus, Search, ShieldCheck, Star, Trash2, X } from "lucide-react";
import { PostgresBackupDialog, type PostgresBackupReport, type PostgresBackupTarget } from "./PostgresBackupDialog";
import { PostgresRestoreDialog, type PostgresRestoreReport } from "./PostgresRestoreDialog";
import { PostgresEditDialog, PostgresGridEditDialog, type PostgresGridEditRow, type PostgresRowStamp } from "./PostgresEditDialog";
import type { GridEditExitGuard } from "./Dialog";
import { PostgresObjectStructure, postgresObjectLabels as kindLabels, type PostgresObjectKind, type PostgresRelationLink,
  type PostgresStructureSection } from "./PostgresObjectStructure";
import { PostgresSearchDialog, type PostgresSearchHit } from "./PostgresSearchDialog";
import type { PostgresDiagramTable } from "./PostgresSchemaDiagramDialog";
import { PostgresServerMonitor } from "./PostgresServerMonitor";
import { PostgresValueDialog, type PostgresValueFormat, type PostgresValueRow, type PostgresValueTarget } from "./PostgresValueDialog";
import { gridGeometry, postgresPinLimit, postgresProjection, useGridLayout } from "./GridColumnLayout";
import { GridColumnLayoutDialog } from "./GridColumnLayoutDialog";
import { RowChangeDialog, RowChangeFields, type RowChangeRequest, type RowChangeResult } from "./RowChangeDialog";
import { GridPasteDialog, type GridPasteRequest, type GridPasteResult } from "./GridPasteDialog";
import { GridCopyControls, GridSelectionButton, GridSelectPage, GridSelectRow, postgresCopyCell, selectionColumnWidth, useGridRowSelection } from "./GridRowSelection";
import { gridDisplay, gridTypeLabels, postgresGridValueType } from "./gridValuePresentation";
import { PostgresPager as Pager } from "./PostgresPager";
import type { PostgresBindings } from "./PostgresParameterDialog";
import { PostgresSqlWorkspace, PostgresValue, type PostgresCell, type PostgresEditorState } from "./PostgresSqlWorkspace";
import { PostgresResultExport, type PostgresExportTarget } from "./PostgresResultExport";
import type { ExportReport } from "./ResultExportDialog";
import { emptyTableQueryClauses, TableQueryControls, type TableQueryClauses } from "./TableQueryControls";
import { usePostgresRead as useRead } from "./usePostgresRead";
import type { QueryActivity } from "./WorkspaceStatus";
import { favoriteKey, favoriteScopeNames, type FavoriteScope, type PostgresFavorite, type WorkspaceFavorites } from "./workspaceFavorites";
import "./postgresWorkspace.css";

export type PostgresSettings = { name: string; host: string; port: number; database: string; username: string; environment: "DEV" | "STAGING" | "PROD"; ca_path: string | null };
export type PostgresProfile = { id: string; project_id: string; revision: number; settings: PostgresSettings };
export type PostgresConnection = { id: string; profileId: string; revision: number };
export type PostgresProfileAction = { kind: "create"; initial?: Partial<PostgresSettings> } | { kind: "edit" | "delete"; profile: PostgresProfile };
type Session = { id: string; version: string; database: string; username: string; encoding: string; timezone: string;
  tunnel: string | null; tunnel_id: string | null; grid_edit: boolean };
type Disconnect = "closed" | "tunnel_stopped" | "tunneled_connection_closed";
type Schema = { id: number; name: string; accessible: boolean };
type SchemaPage = { schemas: Schema[]; has_next: boolean };
type ObjectKind = PostgresObjectKind;
type DatabaseObject = { id: number; name: string; kind: ObjectKind; readable: boolean };
type ObjectPage = { objects: DatabaseObject[]; has_next: boolean };
type Page = { schema: string; name: string; kind: ObjectKind; columns: { name: string; data_type: string; not_null: boolean; primary_key_position: number | null; editable: boolean; value_kind: "binary" | "text" | "json" | "xml" | null }[];
  rows: PostgresCell[][]; total_columns: number; visible_columns: number; pinned_columns: number;
  has_next: boolean; has_next_columns: boolean; primary_key_order: boolean;
  column_names: string[]; source: string; parameter_types: number[]; row_stamps: (PostgresRowStamp | null)[] | null;
  value_rows: PostgresValueRow[] | null; edit_reason: string | null;
  row_update: boolean; row_insert: boolean; row_paste: boolean; row_delete: boolean; row_delete_reason: string | null };
type GridEditTarget = { object: number; trigger: HTMLButtonElement } &
  ({ stamp: PostgresRowStamp; column: string; rows?: never } | { rows: PostgresGridEditRow[] });
type PostgresRowChangeRequest = Extract<RowChangeRequest, { engine: "postgres" }>;
const rowActionWidth = 56;
type Route = { id: string; name: string; port: number };
type RouteChoice = Pick<Route, "id" | "name">;
const endpoint = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const number = new Intl.NumberFormat("ko-KR");
const PostgresSchemaDiagramDialog = lazy(async () => ({ default: (await import("./PostgresSchemaDiagramDialog")).PostgresSchemaDiagramDialog }));

function filterBindings(query: TableQueryClauses, types: number[]): PostgresBindings | undefined {
  if (!types.length) return undefined;
  const values = query.filters.flatMap(({ condition }) => {
    if (condition.kind === "between") return [condition.from.value, condition.to.value];
    if (condition.kind === "contains") return [condition.value];
    return "value" in condition ? [condition.value.value] : [];
  });
  return { types, values: values.map(value => ({ kind: "text", value })) };
}

export function PostgresWorkspace({ profile, editor, visible, onFileBusy, onEditExitGuard, onOpenTunnels, onConnectionChange, onQueryActivity,
  objectRequest, onObjectHandled, favorites, favoriteScope }: {
  profile: PostgresProfile; editor: PostgresEditorState; onFileBusy: (busy: boolean) => void;
  visible: boolean;
  onEditExitGuard: (guard: GridEditExitGuard | null) => void;
  onOpenTunnels: () => void;
  onConnectionChange: (connection: PostgresConnection | null) => void;
  onQueryActivity: (activity: QueryActivity) => void;
  objectRequest: PostgresFavorite | null; onObjectHandled: (request: PostgresFavorite) => void;
  favorites: WorkspaceFavorites; favoriteScope: FavoriteScope;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<"catalog" | "sql" | "monitor">("catalog");
  const [dialog, setDialog] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const [loss, setLoss] = useState("");
  const [preferredRoute, setPreferredRoute] = useState<RouteChoice | null>(null);
  const [exportTarget, setExportTarget] = useState<PostgresExportTarget | null>(null);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [backup, setBackup] = useState<{ id: string; target: PostgresBackupTarget } | null>(null);
  const [backupReport, setBackupReport] = useState<PostgresBackupReport | null>(null);
  const [restoreFor, setRestoreFor] = useState<string | null>(null);
  const [restoreReport, setRestoreReport] = useState<PostgresRestoreReport | null>(null);
  const active = useRef<string | null>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const { name, host, port, database, environment } = profile.settings;
  const online = session !== null && !loss;
  const activeId = online ? session.id : null;

  useEffect(() => () => { if (active.current) void invoke("close_postgres", { id: active.current }).catch(() => {}); }, []);
  useEffect(() => {
    onConnectionChange(activeId ? { id: activeId, profileId: profile.id, revision: profile.revision } : null);
    return () => onConnectionChange(null);
  }, [activeId, profile.id, profile.revision, onConnectionChange]);

  useEffect(() => {
    if (!objectRequest) return;
    setView("catalog");
    if (!activeId) setDialog(true);
  }, [objectRequest, activeId]);

  useEffect(() => {
    if (!session || loss) return;
    const { id, tunnel } = session;
    let live = true;
    void invoke<Disconnect>("wait_postgres_disconnect", { id }).then(reason => {
      if (!live || active.current !== id) return;
      active.current = null;
      const message = reason === "tunnel_stopped" ? `SSH 터널 ‘${tunnel}’이 중단되어 PostgreSQL 연결이 닫혔습니다.`
        : reason === "tunneled_connection_closed" ? `SSH 터널 ‘${tunnel}’을 통한 PostgreSQL 연결이 끊겼습니다.`
        : "PostgreSQL 연결이 닫혔습니다.";
      setLoss(message);
      void invoke("close_postgres", { id }).catch(() => {});
    }, reason => {
      if (live && active.current === id) setError(String(reason));
    });
    return () => { live = false; };
  }, [session, loss]);

  async function disconnect() {
    if (!active.current || closing) return;
    const id = active.current;
    active.current = null;
    setClosing(true); setError("");
    try {
      await invoke("close_postgres", { id });
      setSession(null);
    } catch (reason) {
      active.current = id;
      setError(String(reason));
    }
    finally { setClosing(false); }
  }

  function requestExport(target: PostgresExportTarget) {
    setExportReport(null);
    setExportTarget(target);
  }

  function requestBackup(target: PostgresBackupTarget) {
    if (!activeId) return;
    setBackupReport(null);
    setBackup({ id: activeId, target });
  }

  return <section className="postgres-workspace" aria-label="PostgreSQL 작업 공간">
    <div className="content-header">
      <div className="database-target"><h1><Database size={21} aria-hidden /><span title={name}>{name}</span>
        <span className={`environment ${environment.toLowerCase()}`}>{environment}</span></h1>
        <p className="path"><span>PostgreSQL · {endpoint(host, port)} / {database}</span></p></div>
      <div className="header-actions"><span className="readonly"><ShieldCheck size={15} aria-hidden /> {online && session.grid_edit ? "그리드 편집 허용" : "읽기 전용"}</span>
        {online && <button type="button" className="secondary" aria-haspopup="dialog" disabled={closing}
          onClick={() => requestBackup({ selection: { kind: "database" }, label: "전체 데이터베이스" })}><Archive size={14} aria-hidden /> DB 백업</button>}
        {activeId && <button type="button" className="secondary" aria-haspopup="dialog" disabled={closing}
          onClick={() => { setRestoreReport(null); setRestoreFor(activeId); }}>백업 복원</button>}
        {online ? <button type="button" className="secondary" disabled={closing} onClick={() => void disconnect()}>PostgreSQL 연결 끊기</button> :
          <button type="button" className="primary" ref={connectButton} onClick={() => setDialog(true)}>
            <Plug size={15} aria-hidden /> {loss ? "PostgreSQL 다시 연결" : "PostgreSQL 연결"}
          </button>}
      </div>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {loss && <div className="error-banner postgres-recovery">
      <p role="alert">{loss} {preferredRoute ? "터널 상태를 확인한 뒤 다시 연결하세요." : "다시 연결하세요."}</p>
      {preferredRoute && <button type="button" className="secondary small" onClick={onOpenTunnels}>SSH 터널 열기</button>}
    </div>}
    {exportReport && <div className="success-banner" role="status">
      <strong>{exportReport.format} 저장 완료 · {number.format(exportReport.rows)}행</strong>
      <span>{exportReport.path} · {number.format(exportReport.size_bytes)} B</span>
      {exportReport.protected_fields > 0 && <span>수식으로 해석될 수 있는 필드 {number.format(exportReport.protected_fields)}개 보호</span>}
      {exportReport.audit_warning && <strong className="audit-warning">{exportReport.audit_warning}</strong>}
    </div>}
    {backupReport && <div className="success-banner" role="status">
      <strong>백업 저장 완료 · 아카이브 검사 통과</strong>
      <span>{backupReport.path} · {number.format(backupReport.size_bytes)} B · pg_dump {backupReport.tool_version}</span>
      <span>SHA-256 <code>{backupReport.sha256}</code></span>
      {backupReport.audit_warning && <strong className="audit-warning">작업 기록을 저장할 수 없습니다.</strong>}
    </div>}
    {restoreReport && <div className="success-banner" role="status">
      <strong>새 DB 복원 완료 · {restoreReport.database}</strong>
      <span>{restoreReport.tables === null ? "대상 서버에서 확인이 필요합니다." : `다시 연결하여 테이블 ${number.format(restoreReport.tables)}개 확인`}</span>
      <span>백업 SHA-256 <code>{restoreReport.sha256}</code></span>
      {restoreReport.audit_warning && <strong className="audit-warning">작업 기록을 저장할 수 없습니다.</strong>}
    </div>}
    <nav className="postgres-views" aria-label="PostgreSQL 보기">
      <button type="button" className="secondary small" aria-pressed={view === "catalog"} onClick={() => setView("catalog")}>객체 탐색</button>
      <button type="button" className="secondary small" aria-pressed={view === "sql"} onClick={() => setView("sql")}><FileCode2 size={14} aria-hidden /> SQL 편집기</button>
      <button type="button" className="secondary small" aria-pressed={view === "monitor"} disabled={!online}
        onClick={() => setView("monitor")}><Activity size={14} aria-hidden /> 서버 모니터</button>
    </nav>
    {session && <>
      {online && <div className="postgres-server" role="status">TLS 연결됨 · PostgreSQL {session.version} · {session.username}@{session.database} · {session.encoding} · {session.timezone}{session.tunnel && ` · SSH 터널 ${session.tunnel}`}</div>}
      <div hidden={view !== "catalog"}>
        <PostgresBrowse key={session.id} id={session.id} profile={profile} onFileBusy={onFileBusy} onEditExitGuard={onEditExitGuard}
          objectRequest={objectRequest} onObjectHandled={onObjectHandled} favorites={favorites} favoriteScope={favoriteScope}
          unavailable={loss} onReconnectFocus={() => connectButton.current?.focus()}
          onEditUnknown={() => {
            if (active.current === session.id) {
              active.current = null;
              void invoke("close_postgres", { id: session.id }).catch(() => {});
            }
            setLoss("PostgreSQL 커밋 결과를 확인할 수 없습니다. 다시 연결해 현재 행을 확인하세요.");
          }}
          onOpenSql={source => {
            editor.add(source + ";");
            setView("sql");
          }} onExport={requestExport} onBackup={requestBackup} />
      </div>
    </>}
    <div hidden={view !== "sql"}><PostgresSqlWorkspace session={online ? session.id : null} editor={editor} onExport={requestExport}
      onQueryActivity={onQueryActivity} /></div>
    {online && <PostgresServerMonitor key={session.id} workspace={session} environment={environment} database={database} visible={visible && view === "monitor"} />}
    {exportTarget && <PostgresResultExport profile={profile.settings} target={exportTarget}
      unavailable={online && session.id === exportTarget.session ? "" : loss || "PostgreSQL에 다시 연결한 뒤 내보내세요."}
      onClose={() => setExportTarget(null)} onExported={report => { setExportTarget(null); setExportReport(report); }} />}
    {backup && <PostgresBackupDialog id={backup.id} target={backup.target} connection={name}
      source={`${endpoint(host, port)} / ${database}`} environment={environment} onBusy={onFileBusy}
      unavailable={activeId === backup.id ? "" : loss || "PostgreSQL에 다시 연결한 뒤 백업을 시작하세요."}
      onClose={() => setBackup(null)} onDone={report => { setBackup(null); setBackupReport(report); }} />}
    {restoreFor && <PostgresRestoreDialog id={restoreFor} server={endpoint(host, port)} environment={environment}
      unavailable={activeId === restoreFor ? "" : loss || "PostgreSQL에 다시 연결한 뒤 복원하세요."} onBusy={onFileBusy}
      onClose={() => setRestoreFor(null)} onRestored={report => { setRestoreFor(null); setRestoreReport(report); }} />}
    {dialog && <ConnectDialog profile={profile} preferredRoute={preferredRoute} onOpenTunnels={onOpenTunnels} onClose={() => {
      setDialog(false);
      if (objectRequest) onObjectHandled(objectRequest);
    }} onOpened={connected => {
      active.current = connected.id; setSession(connected); setDialog(false); setError(""); setLoss("");
      setPreferredRoute(connected.tunnel_id && connected.tunnel ? { id: connected.tunnel_id, name: connected.tunnel } : null);
    }} />}
  </section>;
}

function ConnectDialog({ profile, preferredRoute, onClose, onOpened, onOpenTunnels }: {
  profile: PostgresProfile; preferredRoute: RouteChoice | null; onClose: () => void;
  onOpened: (session: Session) => void; onOpenTunnels: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const live = useRef(false);
  const pending = useRef(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [route, setRoute] = useState(preferredRoute);
  const [routeRevision, setRouteRevision] = useState(0);
  const [gridEdit, setGridEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const routeArgs = useMemo(() => ({ profile }), [profile]);
  const routes = useRead<Route[]>("postgres_tunnel_options", routeArgs, routeRevision);
  const unavailable = route !== null && !routes.data?.some(item => item.id === route.id);
  const { host, port, database, username, environment, ca_path } = profile.settings;
  useEffect(() => { live.current = true; dialog.current?.showModal(); return () => { live.current = false; }; }, []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (pending.current || unavailable) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const session = await invoke<Session>("open_postgres", { profile, password, confirmation, tunnelId: route?.id ?? null, gridEdit });
      if (live.current) onOpened(session);
      else await invoke("close_postgres", { id: session.id });
    } catch (reason) {
      if (live.current) {
        setError(String(reason));
        if (route) setRouteRevision(value => value + 1);
      }
    }
    finally { pending.current = false; if (live.current) setBusy(false); }
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby={title} onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2 id={title}>PostgreSQL 연결</h2>
      <button type="button" className="icon-button" aria-label="PostgreSQL 연결 닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={17} aria-hidden /></button></div>
    <form onSubmit={event => void connect(event)} aria-busy={busy}>
      <p className="form-note">{username}@{endpoint(host, port)} / {database} · {environment}</p>
      <p className="form-note">TLS에서 {host}의 인증서를 검증합니다. {ca_path ? "시스템 신뢰 저장소와 선택한 CA를 사용합니다." : "시스템 신뢰 저장소를 사용합니다."}</p>
      <label className="field">연결 경로<select value={route?.id ?? ""} disabled={busy} onChange={event =>
        setRoute(routes.data?.find(item => item.id === event.target.value) ?? null)}>
        <option value="">직접 연결</option>
        {route && unavailable && <option value={route.id} disabled>{route.name} · {routes.loading ? "확인 중" : "사용할 수 없음"}</option>}
        {routes.data?.map(item => <option value={item.id} key={item.id}>{item.name} · 127.0.0.1:{item.port}</option>)}</select></label>
      {unavailable && !routes.loading && <div className="postgres-recovery">
        <p className="form-note">선택한 터널을 시작한 뒤 목록을 새로 고침하세요.</p>
        <button type="button" className="secondary small" onClick={() => setRouteRevision(value => value + 1)}>터널 목록 새로 고침</button>
        <button type="button" className="secondary small" onClick={() => { dialog.current?.close(); onOpenTunnels(); }}>SSH 터널 열기</button>
      </div>}
      {routes.error && <p className="form-error" role="alert">{routes.error}</p>}
      <label className="field">PostgreSQL 암호<input type="password" autoFocus autoComplete="off" maxLength={4096} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
      {environment === "PROD" && <label className="field">운영 환경 확인<input required pattern="PROD" placeholder="PROD" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      <label className="postgres-edit-opt-in"><input type="checkbox" checked={gridEdit} disabled={busy}
        onChange={event => setGridEdit(event.target.checked)} /> 이 연결에서 데이터 그리드 편집 허용</label>
      {busy && <p className="form-note" role="status">PostgreSQL에 연결하는 중…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary" type="button" disabled={busy} onClick={() => dialog.current?.close()}>취소</button>
        <button className="primary" type="submit" disabled={busy || unavailable}>연결</button></div>
    </form>
  </dialog>;
}

function PostgresBrowse({ id, profile, onOpenSql, onExport, onBackup, onFileBusy, onEditUnknown, onEditExitGuard, unavailable, onReconnectFocus,
  objectRequest, onObjectHandled, favorites, favoriteScope }: {
  id: string; profile: PostgresProfile; onOpenSql: (source: string) => void;
  onExport: (target: PostgresExportTarget) => void; onFileBusy: (busy: boolean) => void;
  onBackup: (target: PostgresBackupTarget) => void;
  onEditUnknown: () => void;
  onEditExitGuard: (guard: GridEditExitGuard | null) => void;
  unavailable: string;
  onReconnectFocus: () => void;
  objectRequest: PostgresFavorite | null; onObjectHandled: (request: PostgresFavorite) => void;
  favorites: WorkspaceFavorites; favoriteScope: FavoriteScope;
}) {
  const [schemaPage, setSchemaPage] = useState(0);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [objectPage, setObjectPage] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const [object, setObject] = useState<DatabaseObject | null>(null);
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [gridRequested, setGridRequested] = useState(false);
  const [structureOpen, setStructureOpen] = useState(false);
  const [structureStart, setStructureStart] = useState<{ section: PostgresStructureSection; version: number }>({ section: "overview", version: 0 });
  const [structureRevision, setStructureRevision] = useState(0);
  const [diagram, setDiagram] = useState<{ schema: Schema; initialObject: number | null } | null>(null);
  const [tableQuery, setTableQuery] = useState(emptyTableQueryClauses);
  const [filterColumns, setFilterColumns] = useState<string[] | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [edit, setEdit] = useState<GridEditTarget | null>(null);
  const [rowChange, setRowChange] = useState<{ request: PostgresRowChangeRequest; trigger: HTMLButtonElement } | null>(null);
  const [rowReport, setRowReport] = useState<RowChangeResult | null>(null);
  const [paste, setPaste] = useState<{ request: GridPasteRequest; trigger: HTMLButtonElement } | null>(null);
  const [pasteReport, setPasteReport] = useState<GridPasteResult | null>(null);
  const [value, setValue] = useState<{ target: PostgresValueTarget; title: string; format: PostgresValueFormat | null; trigger: HTMLButtonElement } | null>(null);
  const [editNotice, setEditNotice] = useState("");
  const dataPanel = useRef<HTMLElement>(null);
  const columnSettings = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const grid = useGridLayout(schema && object ? { engine: "postgres", profile: profile.id, schema: schema.name, object: object.name } : null);
  const projection = useMemo(() => postgresProjection(grid.layout.active), [grid.layout.active]);
  const schemaArgs = useMemo(() => unavailable ? null : { id, page: schemaPage }, [id, schemaPage, unavailable]);
  const objectArgs = useMemo(() => schema && !unavailable ? { id, schema: schema.id, search: query, page: objectPage } : null,
    [id, schema, query, objectPage, unavailable]);
  const pageArgs = useMemo(() => object && !unavailable && gridRequested ? { id, object: object.id, rowPage, columnPage, query: tableQuery, layout: projection } : null,
    [id, object, rowPage, columnPage, tableQuery, projection, unavailable, gridRequested]);
  const schemas = useRead<SchemaPage>("postgres_schemas", schemaArgs);
  const objects = useRead<ObjectPage>("postgres_objects", objectArgs);
  const page = useRead<Page>("postgres_page", pageArgs, refresh);
  const result = page.data;
  const rowSelection = useGridRowSelection(result, result?.rows.length ?? 0);
  const selectedRowsForEdit = result?.row_update && rowSelection.active
    ? [...rowSelection.rows].sort((first, second) => first - second).flatMap(index => {
      const stamp = result.row_stamps?.[index];
      return stamp ? [{ stamp, number: rowPage * 100 + index + 1 }] : [];
    })
    : [];
  const canEditSelection = selectedRowsForEdit.length >= 2 && selectedRowsForEdit.length === rowSelection.rows.size;
  const selectedWidth = rowSelection.active ? selectionColumnWidth : 0;
  const geometry = result && gridGeometry(result.columns.map(column => column.name), grid.layout.active, result.pinned_columns,
    (result.row_delete ? rowActionWidth : 0) + selectedWidth);
  const displayFormats = useMemo(() => new Map(grid.layout.active.map(column => [column.name, column.format])), [grid.layout.active]);
  const hasQuery = tableQuery.filters.length > 0 || tableQuery.sort.length > 0;
  const source = page.data?.source ?? (object && schema && !hasQuery
    ? `SELECT *\nFROM ${quoteIdentifier(schema.name)}.${quoteIdentifier(object.name)}` : null);
  const pinnedObject: PostgresFavorite | null = object?.readable && schema
    ? { kind: "postgres_object", profile_id: profile.id, schema_name: schema.name, object_name: object.name } : null;
  const isPinned = pinnedObject && favorites.items.some(item => item.scope === favoriteScope && favoriteKey(item.target) === favoriteKey(pinnedObject));

  useEffect(() => { if (page.data) setFilterColumns(page.data.column_names); }, [page.data]);

  function selectObject(next: DatabaseObject | null, section?: PostgresStructureSection) {
    if (objectRequest) onObjectHandled(objectRequest);
    setNavigationError("");
    setObject(next); setRowPage(0); setColumnPage(0); setStructureOpen(Boolean(section));
    setLayoutOpen(false);
    setGridRequested(next !== null && section === undefined);
    setStructureStart(current => ({ section: section ?? "overview", version: current.version + 1 }));
    setTableQuery(emptyTableQueryClauses); setFilterColumns(null);
    setEditNotice("");
    setRowReport(null);
    setPasteReport(null);
  }

  function chooseSchema(next: Schema | null) {
    setSchema(next); setSearch(""); setQuery(""); setObjectPage(0); selectObject(null);
  }

  function openObjectData(hit: PostgresDiagramTable) {
    chooseSchema({ id: hit.schema_id, name: hit.schema, accessible: true });
    selectObject({ id: hit.id, name: hit.name, kind: hit.kind, readable: true });
    requestAnimationFrame(() => dataPanel.current?.focus());
  }

  const openResolvedObject = useEffectEvent(openObjectData);

  useEffect(() => {
    if (!objectRequest || unavailable) return;
    let live = true;
    setNavigationError("");
    const { schema_name: schema, object_name: name } = objectRequest;
    void invoke<Pick<PostgresSearchHit, "id" | "schema_id" | "schema" | "name" | "kind">>("resolve_postgres_catalog_object", { id, profileId: profile.id, schema, name })
      .then(hit => { if (live) openResolvedObject(hit); })
      .catch(reason => { if (live) setNavigationError(String(reason)); })
      .finally(() => { if (live) onObjectHandled(objectRequest); });
    return () => { live = false; };
  }, [id, profile.id, objectRequest, unavailable, onObjectHandled]);

  function searchObjects(event: FormEvent) {
    event.preventDefault(); setQuery(search.trim()); setObjectPage(0); selectObject(null);
  }

  function follow(link: PostgresRelationLink) {
    if (!link.target) return;
    chooseSchema({ id: link.target.schema_id, name: link.schema, accessible: true });
    selectObject({ id: link.target.id, name: link.name, kind: link.target.kind, readable: true }, "overview");
  }

  function openSearchHit(hit: PostgresSearchHit) {
    chooseSchema({ id: hit.schema_id, name: hit.schema, accessible: true });
    selectObject({ id: hit.id, name: hit.name, kind: hit.kind, readable: true }, hit.section);
    setSearchOpen(false);
    requestAnimationFrame(() => dataPanel.current?.focus());
  }

  function exportPage(data: Page) {
    onExport({ session: id, source: data.source, scope: { kind: "document" }, title: `${data.schema}.${data.name} 조회`,
      bindings: filterBindings(tableQuery, data.parameter_types) });
  }

  function closeLayout() {
    setLayoutOpen(false);
    requestAnimationFrame(() => columnSettings.current?.focus());
  }

  function closeEdit(refreshGrid = false) {
    const trigger = edit?.trigger;
    setEdit(null);
    if (refreshGrid) setRefresh(value => value + 1);
    requestAnimationFrame(() => {
      if (unavailable) onReconnectFocus();
      else if (!refreshGrid && trigger?.isConnected) trigger.focus();
      else dataPanel.current?.focus();
    });
  }

  function openGridEdit(trigger: HTMLButtonElement) {
    if (!object || unavailable || page.loading || !canEditSelection) return;
    setEditNotice("");
    setRowReport(null);
    setPasteReport(null);
    setEdit({ object: object.id, trigger, rows: selectedRowsForEdit });
  }

  function editApplied(cells: number, warning: boolean, rows?: number) {
    const changes = cells === 1 ? "셀 변경 완료" : `${cells}개 셀 변경 완료`;
    const report = rows === undefined ? changes : `행 ${rows}개 · ${changes}`;
    setEditNotice(warning ? report + " · 작업 기록을 저장할 수 없습니다." : report);
    closeEdit(true);
  }

  function openRowChange(change: PostgresRowChangeRequest["change"], trigger: HTMLButtonElement) {
    if (!object || !result || unavailable) return;
    const settings = profile.settings;
    setRowReport(null);
    setPasteReport(null);
    setEditNotice("");
    setRowChange({ trigger, request: { engine: "postgres", id, object: object.id,
      table: `${result.schema}.${result.name}`, profileName: settings.name, environment: settings.environment,
      location: `${settings.username}@${endpoint(settings.host, settings.port)}/${settings.database}`, change } });
  }

  function closeRowChange(report?: RowChangeResult) {
    const trigger = rowChange?.trigger;
    setRowChange(null);
    if (report) {
      setRowReport(report);
      if (!report.fields.length && rowPage > 0 && result?.rows.length === 1) setRowPage(rowPage - 1);
      else setRefresh(value => value + 1);
    }
    requestAnimationFrame(() => {
      if (unavailable) onReconnectFocus();
      else if (!report && trigger?.isConnected) trigger.focus();
      else dataPanel.current?.focus();
    });
  }

  function openRowBatch(trigger: HTMLButtonElement, source: GridPasteRequest["source"]) {
    if (!object || !result || unavailable) return;
    const settings = profile.settings;
    setRowReport(null); setPasteReport(null); setEditNotice("");
    setPaste({ trigger, request: { engine: "postgres", source, id, object: object.id,
      table: `${result.schema}.${result.name}`, profileName: settings.name, environment: settings.environment,
      location: `${settings.username}@${endpoint(settings.host, settings.port)}/${settings.database}` } });
  }

  function closeRowPaste(report?: GridPasteResult) {
    const trigger = paste?.trigger;
    setPaste(null);
    if (report) { setPasteReport(report); setRefresh(value => value + 1); }
    requestAnimationFrame(() => {
      if (unavailable) onReconnectFocus();
      else if (!report && trigger?.isConnected) trigger.focus();
      else dataPanel.current?.focus();
    });
  }

  return <><div className="postgres-layout" hidden={Boolean(unavailable)}>
    <aside className="postgres-catalog results-card" aria-label="PostgreSQL 객체 탐색">
      <div className="panel-heading"><strong>스키마</strong>
        <button className="secondary small" type="button" onClick={() => setSearchOpen(true)}><Search size={14} aria-hidden /> 객체 검색</button>
      </div>
      {schemas.error && <p className="error-banner" role="alert">{schemas.error}</p>}
      {schemas.loading && <p className="result-empty" role="status">스키마를 읽는 중…</p>}
      {schemas.data && <>
        {schemas.data.schemas.length ? <ul>{schemas.data.schemas.map(item => <li key={item.id}>
          <button type="button" aria-pressed={schema?.id === item.id} disabled={!item.accessible} title={item.name} onClick={() => chooseSchema(item)}>
            <span>{item.name}</span>{!item.accessible && <small>접근 권한 없음</small>}
          </button></li>)}</ul> : <p className="result-empty">표시할 스키마가 없습니다.</p>}
        <Pager label="스키마" page={schemaPage} next={schemas.data.has_next} change={value => { setSchemaPage(value); chooseSchema(null); }} />
      </>}
      {schema && <>
        <div className="panel-heading"><strong>{schema.name}의 객체</strong>
          <button className="secondary small" type="button" aria-haspopup="dialog"
            onClick={() => setDiagram({ schema, initialObject: object?.id ?? null })}>관계도</button>
        </div>
        <form className="postgres-search" onSubmit={searchObjects}><input type="search" aria-label="PostgreSQL 객체 검색" value={search} maxLength={256} onChange={event => setSearch(event.target.value)} />
          <button type="submit" className="secondary small">검색</button></form>
        <button type="button" className="secondary small" aria-haspopup="dialog"
          onClick={() => onBackup({ selection: { kind: "schema", schema: schema.id }, label: `스키마 ${quoteIdentifier(schema.name)}` })}>스키마 백업</button>
        {objects.error && <p className="error-banner" role="alert">{objects.error}</p>}
        {objects.loading && <p className="result-empty" role="status">객체 목록을 읽는 중…</p>}
        {objects.data && <>
          {objects.data.objects.length ? <ul>{objects.data.objects.map(item => <li key={item.id}>
            <button type="button" aria-pressed={object?.id === item.id} disabled={!item.readable} title={item.name}
              onClick={() => { if (object?.id !== item.id) selectObject(item); }}><span>{item.name}</span><small>{item.readable ? kindLabels[item.kind] : "SELECT 권한 없음"}</small></button>
          </li>)}</ul> : <p className="result-empty">표시할 테이블과 뷰가 없습니다.</p>}
          <Pager label="객체" page={objectPage} next={objects.data.has_next} change={value => { setObjectPage(value); selectObject(null); }} />
        </>}
      </>}
    </aside>
    <section className="postgres-data results-card" aria-label="PostgreSQL 조회 결과" aria-busy={Boolean(objectRequest) || !structureOpen && page.loading}
      tabIndex={-1} ref={dataPanel}>
      {objectRequest && <p className="result-empty" role="status">PostgreSQL 객체를 확인하는 중…</p>}
      {navigationError && <p className="error-banner" role="alert">{navigationError}</p>}
      {object && schema ? <div className="panel-heading"><strong>{schema.name}.{object.name}</strong>
        <div className="sql-editor-actions">
          {!structureOpen && Boolean(result?.rows.length) && <GridSelectionButton selection={rowSelection} disabled={page.loading} />}
          {!structureOpen && result?.row_update && rowSelection.active && <button type="button" className="secondary small"
            disabled={page.loading || Boolean(unavailable) || !canEditSelection} onClick={event => openGridEdit(event.currentTarget)}>선택한 행 편집</button>}
          {result?.row_insert && !structureOpen && <button type="button" className="secondary small" disabled={page.loading || Boolean(unavailable)}
            onClick={event => openRowChange({ kind: "insert" }, event.currentTarget)}><Plus size={14} aria-hidden /> 행 추가</button>}
          {result?.row_paste && !structureOpen && <button type="button" className="secondary small" disabled={page.loading || Boolean(unavailable)}
            onClick={event => openRowBatch(event.currentTarget, "clipboard")}>행 붙여넣기</button>}
          {result?.row_paste && !structureOpen && <button type="button" className="secondary small" disabled={page.loading || Boolean(unavailable)}
            onClick={event => openRowBatch(event.currentTarget, "file")}>파일 가져오기</button>}
          <button type="button" className="secondary small" disabled={!source} onClick={() => source && onOpenSql(source)}>SQL로 열기</button>
          {page.data && !structureOpen && <button type="button" className="secondary small" onClick={() => page.data && exportPage(page.data)}>결과 내보내기</button>}
          {!structureOpen && !!filterColumns?.length && <button ref={columnSettings} type="button" className="secondary small"
            onClick={() => setLayoutOpen(true)}>열 설정</button>}
          <button type="button" className="secondary small" disabled={!structureOpen && page.loading}
            onClick={() => {
              if (structureOpen) setStructureRevision(value => value + 1);
              else {
                if (page.error === "열 페이지를 다시 선택하세요.") setColumnPage(0);
                setRefresh(value => value + 1);
              }
            }}>다시 조회</button>
        </div></div> :
        <p className="result-empty">스키마와 조회할 테이블 또는 뷰를 선택하세요.</p>}
      {object && schema && <>
        <div className="postgres-result-views postgres-object-views" role="group" aria-label="객체 보기">
          <button type="button" className="secondary small" aria-pressed={!structureOpen} onClick={() => { setStructureOpen(false); setGridRequested(true); }}>데이터</button>
          <button type="button" className="secondary small" aria-pressed={structureOpen} onClick={() => setStructureOpen(true)}>구조</button>
          {object.readable && object.kind === "table" && <button type="button" className="secondary small" aria-haspopup="dialog"
            onClick={() => onBackup({ selection: { kind: "table", object: object.id }, label: `${quoteIdentifier(schema.name)}.${quoteIdentifier(object.name)}` })}>테이블 백업</button>}
          {pinnedObject && <button type="button" className="icon-button postgres-pin-object" aria-pressed={Boolean(isPinned)}
            disabled={!favorites.ready} aria-disabled={favorites.busy || undefined}
            aria-label={`${schema.name}.${object.name} ${favoriteScopeNames[favoriteScope]} 즐겨찾기`}
            title={`${favoriteScopeNames[favoriteScope]} 즐겨찾기`}
            onClick={() => { if (!favorites.busy) void favorites.change(favoriteScope, pinnedObject, !isPinned, id); }}>
            <Star size={15} aria-hidden />
          </button>}
        </div>
        {!unavailable && <PostgresObjectStructure key={`${object.id}-${structureStart.version}`} id={id} object={object.id}
          relation={schema.name + "." + object.name} kind={object.kind} initialSection={structureStart.section}
          visible={structureOpen} revision={structureRevision} onFollow={follow} onFileBusy={onFileBusy} />}
      </>}
      {diagram && !unavailable && <Suspense fallback={null}><PostgresSchemaDiagramDialog id={id} schema={diagram.schema}
        initialObject={diagram.initialObject} connection={profile.settings.name}
        onOpen={table => { setDiagram(null); openObjectData(table); }} onClose={() => setDiagram(null)} /></Suspense>}
      <div hidden={structureOpen}>
        {grid.error && <p className="form-note" role="status">{grid.error}</p>}
        {editNotice && <p className="success-banner" role="status">{editNotice}</p>}
        {pasteReport && <p className="success-banner" role="status">행 {pasteReport.rows}개 {pasteReport.source === "file" ? "가져오기" : "붙여넣기"} 완료
          {pasteReport.audit_warning && <strong className="audit-warning">{pasteReport.audit_warning}</strong>}</p>}
        {rowReport && <div className="row-change-report">
          <p className="success-banner" role="status">{rowReport.fields.length ? "행 1개 추가 완료" : "행 1개 삭제 완료"}
            {rowReport.audit_warning && <strong className="audit-warning">{rowReport.audit_warning}</strong>}</p>
          {!!rowReport.fields.length && <details><summary>저장된 행 보기</summary><RowChangeFields fields={rowReport.fields} /></details>}
        </div>}
        {schema && object && filterColumns && filterColumns.length > 0 && <TableQueryControls key={object.id} columns={filterColumns}
          target={{ engine: "postgres", profile_id: profile.id, revision: profile.revision, schema: schema.name, object: object.name }}
          busy={page.loading} errorId={page.error ? errorId : undefined} apply={next => {
            if (next === tableQuery) setRefresh(value => value + 1);
            setTableQuery(next); setRowPage(0);
          }} />}
        {page.error && <p id={errorId} className="error-banner" role="alert">{page.error}</p>}
        {page.loading && <p className="result-empty" role="status">데이터를 읽는 중…</p>}
        {result && <>
          {result.edit_reason && <p className="form-note postgres-page-note">{result.edit_reason}</p>}
          {result.row_delete_reason && <p className="form-note postgres-page-note">{result.row_delete_reason}</p>}
          <p className="form-note postgres-page-note">{kindLabels[result.kind]} · {result.rows.length}행 · 전체 {result.total_columns}열
            {result.visible_columns < result.total_columns && ` · 표시 ${result.visible_columns}열`}
            {tableQuery.filters.length > 0 && ` · 필터 ${tableQuery.filters.length}개`}
            {tableQuery.sort.length > 0 ? ` · 정렬 ${tableQuery.sort.length}개` : result.primary_key_order ? " · 기본 키 순서" : " · 고정 정렬 없음"}
          </p>
          {hasQuery && <details className="table-query-sql">
            <summary>조회 SQL</summary>
            <pre tabIndex={0} aria-label="PostgreSQL 그리드 조회 SQL">{result.source}</pre>
            {result.parameter_types.length > 0 && <p>필터 값은 $1부터 순서대로 바인딩됩니다.</p>}
          </details>}
          {rowSelection.active && Boolean(result.rows.length) && <GridCopyControls selection={rowSelection}
            columns={result.columns.map(column => column.name)} startRow={rowPage * 100 + 1} disabled={page.loading}
            readCell={(row, column) => postgresCopyCell(result.rows[row][column], result.columns[column].data_type)} />}
          {rowSelection.active && result.row_update && rowSelection.rows.size > selectedRowsForEdit.length &&
            <p className="form-note">편집할 행마다 전체 기본 키 값이 필요합니다.</p>}
          {result.columns.length > 0 && <div className="table-wrap" tabIndex={0} role="region" aria-label="PostgreSQL 데이터 스크롤">
            <table aria-label="PostgreSQL 데이터" style={geometry ? { tableLayout: "fixed", width: geometry.total } : undefined}>
              {geometry && <colgroup>{rowSelection.active && <col style={{ width: selectionColumnWidth }} />}
                {geometry.widths.map((width, index) => <col key={index} style={{ width }} />)}
                {result.row_delete && <col style={{ width: rowActionWidth }} />}</colgroup>}
              <thead><tr>{rowSelection.active && <th scope="col" className="grid-row-select"><GridSelectPage selection={rowSelection} disabled={page.loading} /></th>}
                {result.columns.map((column, index) => <th key={column.name} scope="col"
                className={index < result.pinned_columns ? "grid-sticky-column" : undefined}
                style={{ insetInlineStart: index < result.pinned_columns && geometry ? geometry.pins[index] + selectedWidth : undefined }}>
              {column.name}<small>{column.data_type}{column.primary_key_position !== null && ` · PK ${column.primary_key_position}`}{column.not_null && " · NOT NULL"}</small>
            </th>)}{result.row_delete && <th scope="col" className="postgres-row-actions">작업</th>}</tr></thead>
              <tbody>{result.rows.map((row, index) => <tr key={index} data-grid-selected={rowSelection.rows.has(index) || undefined}>
                {rowSelection.active && <td className="grid-row-select"><GridSelectRow selection={rowSelection} index={index} rowNumber={rowPage * 100 + index + 1} disabled={page.loading} /></td>}
                {row.map((cell, column) => {
                const field = result.columns[column];
                const stamp = result.row_stamps?.[index];
                const valueRow = result.value_rows?.[index];
                const format = field.value_kind === "json" || field.value_kind === "xml" ? field.value_kind
                  : field.value_kind === "binary" && cell.value?.startsWith("\\x89504e470d0a1a0a") ? "png" : null;
                const canPreview = valueRow && object && cell.value !== null
                  && (format || field.value_kind === "binary" || (field.value_kind === "text" && cell.truncated));
                const canEdit = field.editable && stamp && object;
                const rowNumber = rowPage * 100 + index + 1;
                const display = cell.value === null ? undefined : gridDisplay(cell.value, cell.truncated, displayFormats.get(field.name));
                const type = grid.layout.typeColors ? postgresGridValueType(field.data_type, cell.value === null) : undefined;
                return <td key={column} className={column < result.pinned_columns ? "grid-sticky-column" : undefined}
                  style={{ insetInlineStart: column < result.pinned_columns && geometry ? geometry.pins[column] + selectedWidth : undefined }} data-grid-value-type={type}
                  title={display !== undefined && display !== cell.value ? `원본 ${cell.value}` : type ? gridTypeLabels[type] : undefined}>
                  {canPreview || canEdit ? <div className="postgres-editable-cell">
                  <PostgresValue cell={cell} display={display} />
                  {canPreview && <button type="button" className="icon-button" aria-label={`${rowNumber}행 ${field.name} 원본 열기`}
                    onClick={event => setValue({ target: { object: object.id, column: field.name, row: valueRow },
                      title: `${result.schema}.${result.name} · ${rowNumber}행 · ${field.name}`, format, trigger: event.currentTarget })}>
                    <Maximize2 size={14} aria-hidden /></button>}
                  {canEdit && <button type="button" className="icon-button" aria-label={`${rowNumber}행 ${field.name} 편집`}
                    onClick={event => {
                      setEditNotice("");
                      setRowReport(null);
                      setPasteReport(null);
                      setEdit({ object: object.id, stamp, column: field.name, trigger: event.currentTarget });
                    }}><Pencil size={14} aria-hidden /></button>}
                </div> : <PostgresValue cell={cell} display={display} />}</td>;
              })}{result.row_delete && <td className="postgres-row-actions">{result.row_stamps?.[index] &&
                <button type="button" className="icon-button" title="행 삭제" aria-label={`${rowPage * 100 + index + 1}행 삭제`}
                  disabled={page.loading || Boolean(unavailable)} onClick={event => {
                    const stamp = result.row_stamps?.[index];
                    if (stamp) openRowChange({ kind: "delete", stamp }, event.currentTarget);
                  }}><Trash2 size={14} aria-hidden /></button>}</td>}</tr>)}</tbody></table></div>}
          {result.rows.length === 0 && <p className="result-empty">조회된 행이 없습니다.</p>}
          <div className="postgres-paging">
            <Pager label="데이터" page={rowPage} next={result.has_next} change={setRowPage} />
            <Pager label="열" page={columnPage} next={result.has_next_columns} change={setColumnPage} />
          </div>
        </>}
      </div>
    </section>
  </div>
      {searchOpen && !unavailable && <PostgresSearchDialog id={id} database={profile.settings.database} schema={schema}
        onClose={() => setSearchOpen(false)} onOpen={openSearchHit} />}
      {layoutOpen && !unavailable && filterColumns && schema && object &&
        <GridColumnLayoutDialog title={`${schema.name}.${object.name}`} columns={filterColumns} layout={grid.layout} pinLimit={postgresPinLimit}
          onProfiles={profiles => grid.apply({ ...grid.layout, profiles })}
          onClose={closeLayout} onApply={next => { grid.apply(next); setColumnPage(0); closeLayout(); }} />}
      {value && <PostgresValueDialog id={id} target={value.target} title={value.title} format={value.format} unavailable={unavailable} onBusy={onFileBusy} onClose={() => {
        const trigger = value.trigger;
        setValue(null);
        requestAnimationFrame(() => {
          if (unavailable) onReconnectFocus();
          else if (trigger.isConnected) trigger.focus();
          else dataPanel.current?.focus();
        });
      }} />}
      {edit && (edit.rows
        ? <PostgresGridEditDialog id={id} object={edit.object} selected={edit.rows} profile={profile.settings}
          unavailable={unavailable} onBusy={onFileBusy} onClose={() => closeEdit()} onUnknown={onEditUnknown}
          onExitGuard={onEditExitGuard} onApplied={(rows, cells, warning) => editApplied(cells, warning, rows)} />
        : <PostgresEditDialog id={id} object={edit.object} stamp={edit.stamp} column={edit.column} profile={profile.settings}
          unavailable={unavailable} onBusy={onFileBusy} onClose={() => closeEdit()} onUnknown={onEditUnknown} onExitGuard={onEditExitGuard} onApplied={editApplied} />)}
      {rowChange && <RowChangeDialog request={rowChange.request} unavailable={unavailable} onClose={() => closeRowChange()}
        onApplied={closeRowChange} onUnknown={onEditUnknown} onBusy={onFileBusy} onExitGuard={onEditExitGuard} />}
      {paste && <GridPasteDialog request={paste.request} unavailable={unavailable} onClose={() => closeRowPaste()}
        onApplied={closeRowPaste} onUnknown={onEditUnknown} onBusy={onFileBusy} onExitGuard={onEditExitGuard} />}
  </>;
}
