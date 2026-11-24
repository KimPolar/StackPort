import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Database, FileCode2, Plug, ShieldCheck, X } from "lucide-react";
import { PostgresObjectStructure, type PostgresObjectKind, type PostgresRelationLink } from "./PostgresObjectStructure";
import { PostgresPager as Pager } from "./PostgresPager";
import type { PostgresBindings } from "./PostgresParameterDialog";
import { PostgresSqlWorkspace, PostgresValue, type PostgresCell, type PostgresEditorState } from "./PostgresSqlWorkspace";
import { PostgresResultExport, type PostgresExportTarget } from "./PostgresResultExport";
import type { ExportReport } from "./ResultExportDialog";
import { emptyTableQueryClauses, TableQueryControls, type TableQueryClauses } from "./TableQueryControls";
import { usePostgresRead as useRead } from "./usePostgresRead";
import "./postgresWorkspace.css";

export type PostgresSettings = { name: string; host: string; port: number; database: string; username: string; environment: "DEV" | "STAGING" | "PROD"; ca_path: string | null };
export type PostgresProfile = { id: string; project_id: string; revision: number; settings: PostgresSettings };
export type PostgresProfileAction = { kind: "create" } | { kind: "edit" | "delete"; profile: PostgresProfile };
type Session = { id: string; version: string; database: string; username: string; encoding: string; timezone: string; tunnel: string | null };
type Schema = { id: number; name: string; accessible: boolean };
type SchemaPage = { schemas: Schema[]; has_next: boolean };
type ObjectKind = PostgresObjectKind;
type DatabaseObject = { id: number; name: string; kind: ObjectKind; readable: boolean };
type ObjectPage = { objects: DatabaseObject[]; has_next: boolean };
type Page = { schema: string; name: string; kind: ObjectKind; columns: { name: string; data_type: string; not_null: boolean; primary_key_position: number | null }[];
  rows: PostgresCell[][]; total_columns: number; has_next: boolean; primary_key_order: boolean;
  column_names: string[]; source: string; parameter_types: number[] };
type Route = { id: string; name: string; port: number };
const kindLabels: Record<ObjectKind, string> = { table: "테이블", partitioned: "파티션 테이블", view: "뷰", materialized: "구체화 뷰" };
const endpoint = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const number = new Intl.NumberFormat("ko-KR");

function filterBindings(query: TableQueryClauses, types: number[]): PostgresBindings | undefined {
  if (!types.length) return undefined;
  const values = query.filters.flatMap(({ condition }) => {
    if (condition.kind === "between") return [condition.from.value, condition.to.value];
    if (condition.kind === "contains") return [condition.value];
    return "value" in condition ? [condition.value.value] : [];
  });
  return { types, values: values.map(value => ({ kind: "text", value })) };
}

export function PostgresWorkspace({ profile, editor, onFileBusy }: {
  profile: PostgresProfile; editor: PostgresEditorState; onFileBusy: (busy: boolean) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<"catalog" | "sql">("catalog");
  const [dialog, setDialog] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const [exportTarget, setExportTarget] = useState<PostgresExportTarget | null>(null);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const active = useRef<string | null>(null);
  const { name, host, port, database, environment } = profile.settings;

  useEffect(() => () => { if (active.current) void invoke("close_postgres", { id: active.current }).catch(() => {}); }, []);

  function closedByQuery(id: string) {
    if (active.current !== id) return;
    active.current = null;
    setSession(null);
    setError("PostgreSQL 연결이 닫혔습니다. 다시 연결하세요.");
    void invoke("close_postgres", { id }).catch(() => {});
  }

  async function disconnect() {
    if (!active.current || closing) return;
    setClosing(true); setError("");
    try {
      await invoke("close_postgres", { id: active.current });
      active.current = null;
      setSession(null);
    } catch (reason) { setError(String(reason)); }
    finally { setClosing(false); }
  }

  function requestExport(target: PostgresExportTarget) {
    setExportReport(null);
    setExportTarget(target);
  }

  return <section className="postgres-workspace" aria-label="PostgreSQL 작업 공간">
    <div className="content-header">
      <div className="database-target"><h1><Database size={21} aria-hidden /><span title={name}>{name}</span>
        <span className={`environment ${environment.toLowerCase()}`}>{environment}</span></h1>
        <p className="path"><span>PostgreSQL · {endpoint(host, port)} / {database}</span></p></div>
      <div className="header-actions"><span className="readonly"><ShieldCheck size={15} aria-hidden /> 읽기 전용</span>
        {session ? <button type="button" className="secondary" disabled={closing} onClick={() => void disconnect()}>PostgreSQL 연결 끊기</button> :
          <button type="button" className="primary" onClick={() => setDialog(true)}><Plug size={15} aria-hidden /> PostgreSQL 연결</button>}
      </div>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {exportReport && <div className="success-banner" role="status">
      <strong>{exportReport.format} 저장 완료 · {number.format(exportReport.rows)}행</strong>
      <span>{exportReport.path} · {number.format(exportReport.size_bytes)} B</span>
      {exportReport.protected_fields > 0 && <span>수식으로 해석될 수 있는 필드 {number.format(exportReport.protected_fields)}개 보호</span>}
      {exportReport.audit_warning && <strong className="audit-warning">{exportReport.audit_warning}</strong>}
    </div>}
    <nav className="postgres-views" aria-label="PostgreSQL 보기">
      <button type="button" className="secondary small" aria-pressed={view === "catalog"} onClick={() => setView("catalog")}>객체 탐색</button>
      <button type="button" className="secondary small" aria-pressed={view === "sql"} onClick={() => setView("sql")}><FileCode2 size={14} aria-hidden /> SQL 편집기</button>
    </nav>
    {session && <>
      <div className="postgres-server" role="status">TLS 연결됨 · PostgreSQL {session.version} · {session.username}@{session.database} · {session.encoding} · {session.timezone}{session.tunnel && ` · SSH 터널 ${session.tunnel}`}</div>
      <div hidden={view !== "catalog"}>
        <PostgresBrowse key={session.id} id={session.id} onFileBusy={onFileBusy} onOpenSql={source => {
          editor.add(source + ";");
          setView("sql");
        }} onExport={requestExport} />
      </div>
    </>}
    <div hidden={view !== "sql"}><PostgresSqlWorkspace session={session?.id ?? null} editor={editor} onClosed={closedByQuery} onExport={requestExport} /></div>
    {exportTarget && <PostgresResultExport profile={profile.settings} target={exportTarget} onClosed={closedByQuery}
      onClose={() => setExportTarget(null)} onExported={report => { setExportTarget(null); setExportReport(report); }} />}
    {dialog && <ConnectDialog profile={profile} onClose={() => setDialog(false)} onOpened={connected => {
      active.current = connected.id; setSession(connected); setDialog(false); setError("");
    }} />}
  </section>;
}

function ConnectDialog({ profile, onClose, onOpened }: { profile: PostgresProfile; onClose: () => void; onOpened: (session: Session) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const live = useRef(false);
  const pending = useRef(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [tunnelId, setTunnelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const routeArgs = useMemo(() => ({ profile }), [profile]);
  const routes = useRead<Route[]>("postgres_tunnel_options", routeArgs);
  const { host, port, database, username, environment, ca_path } = profile.settings;
  useEffect(() => { live.current = true; dialog.current?.showModal(); return () => { live.current = false; }; }, []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const session = await invoke<Session>("open_postgres", { profile, password, confirmation, tunnelId: tunnelId || null });
      if (live.current) onOpened(session);
      else await invoke("close_postgres", { id: session.id });
    } catch (reason) { if (live.current) setError(String(reason)); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby={title} onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2 id={title}>PostgreSQL 연결</h2>
      <button type="button" className="icon-button" aria-label="PostgreSQL 연결 닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={17} aria-hidden /></button></div>
    <form onSubmit={event => void connect(event)} aria-busy={busy}>
      <p className="form-note">{username}@{endpoint(host, port)} / {database} · {environment}</p>
      <p className="form-note">TLS에서 {host}의 인증서를 검증합니다. {ca_path ? "시스템 신뢰 저장소와 선택한 CA를 사용합니다." : "시스템 신뢰 저장소를 사용합니다."}</p>
      <label className="field">연결 경로<select value={tunnelId} disabled={busy} onChange={event => setTunnelId(event.target.value)}>
        <option value="">직접 연결</option>{routes.data?.map(route => <option value={route.id} key={route.id}>{route.name} · 127.0.0.1:{route.port}</option>)}</select></label>
      {routes.error && <p className="form-error" role="alert">{routes.error}</p>}
      <label className="field">PostgreSQL 암호<input type="password" autoFocus autoComplete="off" maxLength={4096} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
      {environment === "PROD" && <label className="field">운영 환경 확인<input required pattern="PROD" placeholder="PROD" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      {busy && <p className="form-note" role="status">PostgreSQL에 연결하는 중…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary" type="button" disabled={busy} onClick={() => dialog.current?.close()}>취소</button>
        <button className="primary" type="submit" disabled={busy}>연결</button></div>
    </form>
  </dialog>;
}

function PostgresBrowse({ id, onOpenSql, onExport, onFileBusy }: {
  id: string; onOpenSql: (source: string) => void; onExport: (target: PostgresExportTarget) => void; onFileBusy: (busy: boolean) => void;
}) {
  const [schemaPage, setSchemaPage] = useState(0);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [objectPage, setObjectPage] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [object, setObject] = useState<DatabaseObject | null>(null);
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [structureOpen, setStructureOpen] = useState(false);
  const [structureRevision, setStructureRevision] = useState(0);
  const [tableQuery, setTableQuery] = useState(emptyTableQueryClauses);
  const [filterColumns, setFilterColumns] = useState<string[] | null>(null);
  const errorId = useId();
  const schemaArgs = useMemo(() => ({ id, page: schemaPage }), [id, schemaPage]);
  const objectArgs = useMemo(() => schema ? { id, schema: schema.id, search: query, page: objectPage } : null, [id, schema, query, objectPage]);
  const pageArgs = useMemo(() => object ? { id, object: object.id, rowPage, columnPage, query: tableQuery } : null,
    [id, object, rowPage, columnPage, tableQuery]);
  const schemas = useRead<SchemaPage>("postgres_schemas", schemaArgs);
  const objects = useRead<ObjectPage>("postgres_objects", objectArgs);
  const page = useRead<Page>("postgres_page", pageArgs, refresh);
  const hasQuery = tableQuery.filters.length > 0 || tableQuery.sort.length > 0;
  const source = page.data?.source ?? (object && schema && !hasQuery
    ? `SELECT *\nFROM ${quoteIdentifier(schema.name)}.${quoteIdentifier(object.name)}` : null);

  useEffect(() => { if (page.data) setFilterColumns(page.data.column_names); }, [page.data]);

  function selectObject(next: DatabaseObject | null, structure = false) {
    setObject(next); setRowPage(0); setColumnPage(0); setStructureOpen(structure);
    setTableQuery(emptyTableQueryClauses); setFilterColumns(null);
  }

  function chooseSchema(next: Schema | null) {
    setSchema(next); setSearch(""); setQuery(""); setObjectPage(0); selectObject(null);
  }

  function searchObjects(event: FormEvent) {
    event.preventDefault(); setQuery(search.trim()); setObjectPage(0); selectObject(null);
  }

  function follow(link: PostgresRelationLink) {
    if (!link.target) return;
    chooseSchema({ id: link.target.schema_id, name: link.schema, accessible: true });
    selectObject({ id: link.target.id, name: link.name, kind: link.target.kind, readable: true }, true);
  }

  function exportPage(data: Page) {
    onExport({ session: id, source: data.source, scope: { kind: "document" }, title: `${data.schema}.${data.name} 조회`,
      bindings: filterBindings(tableQuery, data.parameter_types) });
  }

  return <div className="postgres-layout">
    <aside className="postgres-catalog results-card" aria-label="PostgreSQL 객체 탐색">
      <div className="panel-heading"><strong>스키마</strong></div>
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
        <div className="panel-heading"><strong>{schema.name}의 객체</strong></div>
        <form className="postgres-search" onSubmit={searchObjects}><input type="search" aria-label="PostgreSQL 객체 검색" value={search} maxLength={256} onChange={event => setSearch(event.target.value)} />
          <button type="submit" className="secondary small">검색</button></form>
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
    <section className="postgres-data results-card" aria-label="PostgreSQL 조회 결과" aria-busy={!structureOpen && page.loading}>
      {object && schema ? <div className="panel-heading"><strong>{schema.name}.{object.name}</strong>
        <div className="sql-editor-actions">
          <button type="button" className="secondary small" disabled={!source} onClick={() => source && onOpenSql(source)}>SQL로 열기</button>
          {page.data && !structureOpen && <button type="button" className="secondary small" onClick={() => page.data && exportPage(page.data)}>결과 내보내기</button>}
          <button type="button" className="secondary small" disabled={!structureOpen && page.loading}
            onClick={() => structureOpen ? setStructureRevision(value => value + 1) : setRefresh(value => value + 1)}>다시 조회</button>
        </div></div> :
        <p className="result-empty">스키마와 조회할 테이블 또는 뷰를 선택하세요.</p>}
      {object && schema && <>
        <div className="postgres-result-views postgres-object-views" role="group" aria-label="객체 보기">
          <button type="button" className="secondary small" aria-pressed={!structureOpen} onClick={() => setStructureOpen(false)}>데이터</button>
          <button type="button" className="secondary small" aria-pressed={structureOpen} onClick={() => setStructureOpen(true)}>구조</button>
        </div>
        <PostgresObjectStructure key={object.id} id={id} object={object.id} relation={schema.name + "." + object.name} kind={object.kind}
          visible={structureOpen} revision={structureRevision} onFollow={follow} onFileBusy={onFileBusy} />
      </>}
      <div hidden={structureOpen}>
        {object && filterColumns && filterColumns.length > 0 && <TableQueryControls key={object.id} columns={filterColumns} engine="postgres"
          busy={page.loading} errorId={page.error ? errorId : undefined} apply={next => {
            if (next === tableQuery) setRefresh(value => value + 1);
            setTableQuery(next); setRowPage(0);
          }} />}
        {page.error && <p id={errorId} className="error-banner" role="alert">{page.error}</p>}
        {page.loading && <p className="result-empty" role="status">데이터를 읽는 중…</p>}
        {page.data && <>
          <p className="form-note postgres-page-note">{kindLabels[page.data.kind]} · {page.data.rows.length}행 · 전체 {page.data.total_columns}열
            {tableQuery.filters.length > 0 && ` · 필터 ${tableQuery.filters.length}개`}
            {tableQuery.sort.length > 0 ? ` · 정렬 ${tableQuery.sort.length}개` : page.data.primary_key_order ? " · 기본 키 순서" : " · 고정 정렬 없음"}
          </p>
          {hasQuery && <details className="table-query-sql">
            <summary>조회 SQL</summary>
            <pre tabIndex={0} aria-label="PostgreSQL 그리드 조회 SQL">{page.data.source}</pre>
            {page.data.parameter_types.length > 0 && <p>필터 값은 $1부터 순서대로 바인딩됩니다.</p>}
          </details>}
          {page.data.columns.length > 0 && <div className="table-wrap" tabIndex={0} role="region" aria-label="PostgreSQL 데이터 스크롤">
            <table aria-label="PostgreSQL 데이터"><thead><tr>{page.data.columns.map(column => <th key={column.name} scope="col">
              {column.name}<small>{column.data_type}{column.primary_key_position !== null && ` · PK ${column.primary_key_position}`}{column.not_null && " · NOT NULL"}</small>
            </th>)}</tr></thead>
              <tbody>{page.data.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>
                <PostgresValue cell={cell} />
              </td>)}</tr>)}</tbody></table></div>}
          {page.data.rows.length === 0 && <p className="result-empty">조회된 행이 없습니다.</p>}
          <div className="postgres-paging">
            <Pager label="데이터" page={rowPage} next={page.data.has_next} change={setRowPage} />
            {page.data.total_columns > 24 && <Pager label="열" page={columnPage} next={(columnPage + 1) * 24 < page.data.total_columns} change={setColumnPage} />}
          </div>
        </>}
      </div>
    </section>
  </div>;
}
