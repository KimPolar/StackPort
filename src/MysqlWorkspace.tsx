import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, Code2, Database, Download, Plug, RefreshCw, ShieldCheck, Table2 } from "lucide-react";
import { Dialog } from "./Dialog";
import { MysqlDataGrid, type MysqlValue } from "./MysqlDataGrid";
import { MysqlObjectStructure, mysqlStructureLabels, type MysqlObjectInfo, type MysqlStructure, type MysqlStructureSection } from "./MysqlObjectStructure";
import type { MysqlProfile } from "./MysqlProfileDialog";
import { MysqlResultExport, type MysqlExportTarget } from "./MysqlResultExport";
import { MysqlServerMonitor } from "./MysqlServerMonitor";
import { MysqlSqlWorkspace } from "./MysqlSqlWorkspace";
import { networkAddressText } from "./quickConnect";
import type { ExportReport } from "./ResultExportDialog";
import { emptyTableQueryClauses, TableQueryControls } from "./TableQueryControls";
import { useNativeRead } from "./usePostgresRead";
import "./mysqlWorkspace.css";

type Route = { id: string; name: string; port: number };
type Session = { id: string; version: string; engine: "MySQL" | "MariaDB"; database: string | null; tunnel: Route | null };
type Page<T> = { items: T[]; has_next: boolean };
type ObjectView = "columns" | "rows" | MysqlStructureSection;
const objectViewLabels: Record<ObjectView, string> = {
  columns: "열 구조", ...mysqlStructureLabels, rows: "데이터 미리보기",
};
const tableViews: ObjectView[] = ["columns", "indexes", "constraints", "references", "definition", "rows"];
const viewViews: ObjectView[] = ["columns", "definition", "rows"];
type Column = { name: string; data_type: string; column_type: string; nullable: boolean; key: string };
type Sample = {
  columns: Column[];
  rows: (MysqlValue | null)[][];
  more_columns: boolean;
  more_rows: boolean;
  stable_order: boolean;
  filter_columns?: string[];
  query_sql?: string;
};

export function MysqlWorkspace({ profile, onOpenTunnels }: { profile: MysqlProfile; onOpenTunnels: () => void }) {
  const settings = profile.settings;
  const [session, setSession] = useState<Session | null>(null);
  const [login, setLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [route, setRoute] = useState<Route | null>(null);
  const [routeRevision, setRouteRevision] = useState(0);
  const [database, setDatabase] = useState<string | null>(null);
  const [object, setObject] = useState<MysqlObjectInfo | null>(null);
  const [view, setView] = useState<ObjectView>("columns");
  const [structurePage, setStructurePage] = useState(0);
  const [mode, setMode] = useState<"objects" | "sql" | "monitor">("objects");
  const [sqlText, setSqlText] = useState("");
  const [schemaSearch, setSchemaSearch] = useState("");
  const [objectSearch, setObjectSearch] = useState("");
  const [schemaPage, setSchemaPage] = useState(0);
  const [objectPage, setObjectPage] = useState(0);
  const [rowPage, setRowPage] = useState(0);
  const [tableQuery, setTableQuery] = useState(emptyTableQueryClauses);
  const [exportTarget, setExportTarget] = useState<MysqlExportTarget | null>(null);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [revision, setRevision] = useState(0);
  const active = useRef<string | null>(null);
  const preferredRoute = useRef<Route | null>(null);
  const mounted = useRef(false);
  const connecting = useRef(false);
  const production = settings.environment === "PROD";
  const sqlOpen = mode === "sql";
  const monitorOpen = mode === "monitor";

  const routeArgs = useMemo(() => login ? { profileId: profile.id, revision: profile.revision } : null,
    [login, profile.id, profile.revision]);
  const routes = useNativeRead<Route[]>("mysql_tunnel_options", routeArgs, routeRevision);
  const routeUnavailable = route !== null && !routes.data?.some(item => item.id === route.id);

  const schemaArgs = useMemo(() => session ? { id: session.id, search: schemaSearch, page: schemaPage } : null, [session, schemaSearch, schemaPage]);
  const objectArgs = useMemo(() => session && database ? { id: session.id, database, search: objectSearch, page: objectPage } : null,
    [session, database, objectSearch, objectPage]);
  const structureArgs = useMemo(() => session && database && object ? { id: session.id, database, table: object.name, includeRows: false } : null,
    [session, database, object]);
  const rowArgs = useMemo(() => structureArgs && view === "rows" ? {
    ...structureArgs, includeRows: true, grid: { page: rowPage, clauses: tableQuery },
  } : null, [structureArgs, view, rowPage, tableQuery]);
  const inspectionArgs = useMemo(() => session && database && object && view !== "columns" && view !== "rows" ? {
    id: session.id, database, table: object.name, section: view, page: structurePage,
  } : null, [session, database, object, view, structurePage]);
  const schemas = useNativeRead<Page<string>>("mysql_databases", schemaArgs, revision);
  const objects = useNativeRead<Page<MysqlObjectInfo>>("mysql_objects", objectArgs, revision);
  const structure = useNativeRead<Sample>("mysql_table", structureArgs, revision, true);
  const inspection = useNativeRead<MysqlStructure>("mysql_structure", inspectionArgs, revision);
  const rows = useNativeRead<Sample>("mysql_table", rowArgs, revision);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void invoke("close_mysql", { id: active.current }).catch(() => {});
    };
  }, []);

  const loseConnection = useCallback((id: string, message: string) => {
    if (active.current !== id) return;
    active.current = null; setSession(null); setExportTarget(null); setError(message);
    void invoke("close_mysql", { id }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!session?.tunnel) return;
    const { id, tunnel } = session;
    let live = true;
    void invoke<boolean>("wait_mysql_tunnel_end", { id }).then(stopped => {
      if (live && stopped) loseConnection(id, `SSH 터널 ‘${tunnel.name}’이 중단되어 MySQL 연결이 닫혔습니다. 터널을 시작한 뒤 다시 연결하세요.`);
    }).catch(cause => { if (live) loseConnection(id, String(cause)); });
    return () => { live = false; };
  }, [session, loseConnection]);

  useEffect(() => {
    const lost = [schemas.error, objects.error, structure.error, inspection.error, rows.error].find(message => message.includes("MySQL 연결이 닫혔습니다"));
    if (lost && session) loseConnection(session.id, lost);
  }, [session, schemas.error, objects.error, structure.error, inspection.error, rows.error, loseConnection]);

  function chooseDatabase(name: string | null) {
    setDatabase(name);
    chooseObject(null);
    setObjectSearch("");
    setObjectPage(0);
  }

  function chooseObject(next: MysqlObjectInfo | null) {
    setObject(next);
    showView("columns");
    setTableQuery(emptyTableQueryClauses);
    setRowPage(0);
  }

  function showView(next: ObjectView) {
    if (next !== view) {
      setView(next);
      setStructurePage(0);
    }
  }

  function followRelation(targetDatabase: string, target: MysqlObjectInfo) {
    if (targetDatabase !== database) chooseDatabase(targetDatabase);
    chooseObject(target);
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (connecting.current || routeUnavailable) return;
    connecting.current = true; setBusy(true); setError(""); setPassword("");
    try {
      const next = await invoke<Session>("open_mysql", {
        profileId: profile.id, revision: profile.revision, password, confirmation, tunnelId: route?.id ?? null,
      });
      if (!mounted.current) { await invoke("close_mysql", { id: next.id }); return; }
      active.current = next.id; chooseDatabase(next.database); setSchemaSearch(""); setSchemaPage(0);
      preferredRoute.current = next.tunnel;
      setSession(next); setLogin(false); setExportReport(null);
    } catch (cause) {
      if (mounted.current) {
        setError(String(cause));
        if (route) setRouteRevision(value => value + 1);
      }
    }
    finally { connecting.current = false; if (mounted.current) setBusy(false); }
  }

  async function disconnect() {
    const id = active.current;
    if (!id) return;
    active.current = null; setSession(null); setExportTarget(null); chooseDatabase(null); setError("");
    setMode("objects"); setSqlText("");
    try { await invoke("close_mysql", { id }); }
    catch (cause) { if (mounted.current) setError(String(cause)); }
  }

  function beginExport(target: MysqlExportTarget) {
    setExportReport(null);
    setExportTarget(target);
  }

  function openLogin() {
    setError(""); setConfirmation(""); setRoute(preferredRoute.current); setLogin(true);
  }

  function closeLogin() {
    setLogin(false); setPassword(""); setError("");
  }

  return <section className="mysql-workspace" aria-label="MySQL 작업 공간">
    <div className="content-header">
      <div className="database-target">
        <h1><Database size={21} aria-hidden /><span>{settings.name}</span><span className={`environment ${settings.environment.toLowerCase()}`}>{settings.environment}</span></h1>
        <p className="path">{session ? `${session.engine} · ${session.version}` : "MySQL · MariaDB"} · {networkAddressText(settings)}
          {session?.tunnel && ` · SSH 터널 ${session.tunnel.name}`}</p>
      </div>
      <div className="header-actions">
        <span className="readonly"><ShieldCheck size={14} aria-hidden /> 읽기 전용</span>
        {session ? <><button type="button" className="secondary" aria-pressed={sqlOpen} onClick={() => setMode(sqlOpen ? "objects" : "sql")}><Code2 size={15} aria-hidden /> SQL 편집기</button>
          <button type="button" className="secondary" aria-pressed={monitorOpen} onClick={() => setMode(monitorOpen ? "objects" : "monitor")}><Activity size={15} aria-hidden /> 서버 모니터</button>
          {!monitorOpen && <button type="button" className="secondary" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} aria-hidden /> 새로 고침</button>}
          <button type="button" className="secondary" onClick={() => void disconnect()}>MySQL 연결 끊기</button></> :
          <button type="button" className="primary" onClick={openLogin}><Plug size={15} aria-hidden /> MySQL 연결</button>}
      </div>
    </div>
    {error && !login && <p className="error-banner" role="alert">{error}</p>}
    {exportReport && <div className="mysql-export-report" role="status">
      <div>{exportReport.format} 저장 완료 · {exportReport.rows.toLocaleString("ko-KR")}행 · {exportReport.size_bytes.toLocaleString("ko-KR")} B
        {exportReport.protected_fields > 0 && ` · 수식 보호 ${exportReport.protected_fields.toLocaleString("ko-KR")}개`}
        <code>{exportReport.path}</code>
        {exportReport.audit_warning && <span>{exportReport.audit_warning}</span>}
      </div>
      <button type="button" className="secondary small" onClick={() => setExportReport(null)}>확인</button>
    </div>}
    {session && <div hidden={monitorOpen}><div className="mysql-layout">
      <div className="mysql-catalog">
        <section className="results-card" aria-label="MySQL 데이터베이스 목록">
          <div className="panel-heading"><h2>데이터베이스</h2></div>
          <Search label="데이터베이스 검색" onSearch={value => { setSchemaSearch(value); setSchemaPage(0); }} />
          <ReadNotice loading={schemas.loading} error={schemas.error} empty={schemas.data?.items.length === 0} />
          <ul className="mysql-catalog-items">{schemas.data?.items.map(name => <li key={name}>
            <button type="button" aria-current={name === database || undefined} onClick={() => chooseDatabase(name)}><Database size={14} aria-hidden /><span>{name}</span></button>
          </li>)}</ul>
          <Pager page={schemaPage} loading={schemas.loading} hasNext={schemas.data?.has_next === true} onPage={setSchemaPage} />
        </section>
        {database && <section className="results-card" aria-label="MySQL 테이블과 뷰">
          <div className="panel-heading"><h2 title={database}>{database}</h2></div>
          <Search key={database} label="테이블 및 뷰 검색" onSearch={value => { setObjectSearch(value); setObjectPage(0); }} />
          <ReadNotice loading={objects.loading} error={objects.error} empty={objects.data?.items.length === 0} />
          <ul className="mysql-catalog-items">{objects.data?.items.map(item => <li key={item.name}>
            <button type="button" aria-current={object?.name === item.name || undefined} onClick={() => {
              if (object?.name !== item.name) chooseObject(item);
              else showView("columns");
              setMode("objects");
            }}>
              <Table2 size={14} aria-hidden /><span>{item.name}</span><small>{item.kind.endsWith("VIEW") ? "뷰" : "테이블"}</small>
            </button>
          </li>)}</ul>
          <Pager page={objectPage} loading={objects.loading} hasNext={objects.data?.has_next === true} onPage={setObjectPage} />
        </section>}
      </div>
      <div className="mysql-detail">
      <section className="results-card" aria-label="MySQL 객체 상세" hidden={sqlOpen}>
        <div className="panel-heading"><h2>{object?.name ?? "객체 상세"}</h2>{object?.engine && <span>{object.engine}</span>}</div>
        {!object && <p className="result-empty">데이터베이스에서 테이블이나 뷰를 선택하세요.</p>}
        {object && <>
          <div className="mysql-views" aria-label="객체 보기" role="group">
            {(object.kind.endsWith("VIEW") ? viewViews : tableViews).map(item =>
              <button key={item} type="button" className="secondary small" aria-pressed={view === item}
                onClick={() => showView(item)}>{objectViewLabels[item]}</button>)}
            {view === "rows" && database && <button type="button" className="secondary small" disabled={!rows.data}
              onClick={() => beginExport({ kind: "table", database, table: object.name, clauses: tableQuery })}>
              <Download size={14} aria-hidden /> 결과 내보내기</button>}
          </div>
          {view === "columns" && <>
            <ReadNotice loading={structure.loading} error={structure.error} />
            {structure.data && <TableStructure data={structure.data} />}
          </>}
          {inspectionArgs && <section aria-label={objectViewLabels[view]} aria-busy={inspection.loading}>
            <ReadNotice loading={inspection.loading} error={inspection.error} />
            {inspection.data && <MysqlObjectStructure data={inspection.data} target={`${database}.${object.name}`} onFollow={followRelation} />}
            {view !== "definition" && <Pager page={structurePage} loading={inspection.loading}
              hasNext={inspection.data != null && inspection.data.section !== "definition" && inspection.data.has_next} onPage={setStructurePage} />}
          </section>}
          <div hidden={view !== "rows"}>
            {database && structure.data?.filter_columns && <TableQueryControls
              key={JSON.stringify([session.id, database, object.name])} columns={structure.data.filter_columns} busy={rows.loading}
              target={{ engine: "mysql", profile_id: profile.id, revision: profile.revision, schema: database, object: object.name }}
              apply={clauses => { setTableQuery(clauses); setRowPage(0); }} />}
            <ReadNotice loading={rows.loading} error={rows.error} />
            {rows.data && <RowPage data={rows.data} page={rowPage} />}
            <Pager page={rowPage} loading={rows.loading} hasNext={rows.data?.more_rows === true} onPage={setRowPage} rowNavigation />
          </div>
        </>}
      </section>
      <div hidden={!sqlOpen}><MysqlSqlWorkspace key={session.id} id={session.id} database={database}
        text={sqlText} onTextChange={setSqlText} onExport={beginExport} /></div>
      </div>
    </div></div>}
    {session && monitorOpen && <MysqlServerMonitor key={session.id} id={session.id} />}
    {session && exportTarget && <MysqlResultExport id={session.id} profile={settings} target={exportTarget}
      onClose={() => setExportTarget(null)} onExported={report => { setExportTarget(null); setExportReport(report); }} />}
    {login && <Dialog title="MySQL 계열 연결" busy={busy} onClose={closeLogin}>
      <form aria-busy={busy} onSubmit={event => void connect(event)}>
        <p className="confirm-copy"><strong>{settings.name} · {settings.environment}</strong><br />{networkAddressText(settings)} · {settings.username}</p>
        {settings.client_certificate_path && <p className="form-note">TLS 클라이언트 인증서 사용</p>}
        <label className="field">연결 경로<select value={route?.id ?? ""} disabled={busy} onChange={event =>
          setRoute(routes.data?.find(item => item.id === event.target.value) ?? null)}>
          <option value="">직접 연결</option>
          {route && routeUnavailable && <option value={route.id} disabled>{route.name} · {routes.loading ? "확인 중" : "사용할 수 없음"}</option>}
          {routes.data?.map(item => <option value={item.id} key={item.id}>{item.name} · 127.0.0.1:{item.port}</option>)}
        </select></label>
        {routeUnavailable && !routes.loading && <p className="form-note">선택한 터널을 시작한 뒤 목록을 새로 고침하세요.</p>}
        {!routes.loading && (routeUnavailable || !routes.data?.length) && <div className="dialog-actions">
          <button type="button" className="secondary small" disabled={busy} onClick={() => setRouteRevision(value => value + 1)}>터널 목록 새로 고침</button>
          <button type="button" className="secondary small" disabled={busy} onClick={() => { closeLogin(); onOpenTunnels(); }}>SSH 터널 열기</button>
        </div>}
        {routes.error && <p className="form-error" role="alert">{routes.error}</p>}
        <label className="field">MySQL 암호<input type="password" autoComplete="off" maxLength={4096} value={password}
          disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        {production && <label className="field">운영 환경 확인<input required placeholder="PROD" value={confirmation}
          autoComplete="off" disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
        {!settings.tls && <p className="form-note">{route ? "SSH 게이트웨이와 데이터베이스 사이에는 TLS가 적용되지 않습니다." : "일반 TCP 연결에는 TLS 전송 보호가 적용되지 않습니다."}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="submit" className="primary" disabled={busy || routeUnavailable || (production && confirmation !== "PROD")}>{busy ? "연결 중…" : "연결"}</button></div>
      </form>
    </Dialog>}
  </section>;
}

function Search({ label, onSearch }: { label: string; onSearch: (value: string) => void }) {
  const [text, setText] = useState("");
  return <form className="mysql-search" onSubmit={event => { event.preventDefault(); onSearch(text); }}>
    <input type="search" aria-label={label} placeholder={label} value={text} maxLength={256} onChange={event => setText(event.target.value)} />
    <button type="submit" className="secondary small">검색</button>
  </form>;
}

function ReadNotice({ loading, error, empty = false }: { loading: boolean; error: string; empty?: boolean }) {
  if (error) return <p className="error-banner" role="alert">{error}</p>;
  if (loading) return <p className="result-empty" role="status">조회 중…</p>;
  return empty ? <p className="result-empty">조회할 항목이 없습니다.</p> : null;
}

function Pager({ page, loading, hasNext, onPage, rowNavigation = false }: {
  page: number; loading: boolean; hasNext: boolean; onPage: (page: number) => void; rowNavigation?: boolean;
}) {
  if (!page && !hasNext) return null;
  return <div className="mysql-pager" role={rowNavigation ? "group" : undefined} aria-label={rowNavigation ? "데이터 페이지" : undefined}>
    {rowNavigation && <button type="button" className="secondary small" disabled={loading || !page} onClick={() => onPage(0)}>처음</button>}
    <button type="button" className="secondary small" disabled={loading || !page} onClick={() => onPage(page - 1)}>이전</button>
    <span>{page + 1} 페이지</span>
    <button type="button" className="secondary small" disabled={loading || !hasNext} onClick={() => onPage(page + 1)}>다음</button>
  </div>;
}

function TableStructure({ data }: { data: Sample }) {
  return <>
    {data.more_columns && <p className="form-note mysql-table-note">앞 128개 열을 표시합니다.</p>}
    <div className="mysql-table" tabIndex={0} role="region" aria-label="MySQL 열 구조 스크롤">
      <table aria-label="MySQL 열 구조"><thead><tr><th scope="col">열</th><th scope="col">타입</th><th scope="col">NULL 허용</th><th scope="col">키</th></tr></thead>
        <tbody>{data.columns.map(column => <tr key={column.name}><th scope="row">{column.name}</th><td><code>{column.column_type}</code></td>
          <td>{column.nullable ? "예" : "아니요"}</td><td>{column.key || "—"}</td></tr>)}</tbody>
      </table>
    </div>
  </>;
}

function RowPage({ data, page }: { data: Sample; page: number }) {
  const offset = page * 50;
  return <>
    <p className="form-note mysql-table-note" role="status">
      {data.rows.length ? `${offset + 1}–${offset + data.rows.length}행` : "조건에 맞는 행이 없습니다."}
      {data.more_columns && " · 앞 128개 열"}
    </p>
    {!data.stable_order && <p className="form-note mysql-table-note">기본 키가 없는 결과는 페이지를 이동할 때 행 순서가 달라질 수 있습니다.</p>}
    {data.rows.length > 0 && <MysqlDataGrid columns={data.columns} rows={data.rows} label="MySQL 데이터 미리보기" />}
    {data.query_sql && <details className="table-query-sql">
      <summary>조회 SQL</summary>
      <p className="form-note">조건 값과 행 위치는 매개변수(?)로 전달합니다.</p>
      <pre><code>{data.query_sql}</code></pre>
    </details>}
  </>;
}
