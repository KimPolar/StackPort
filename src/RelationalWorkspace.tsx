import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Database, Plug, RefreshCw, ShieldCheck } from "lucide-react";
import { DatabasePreviewGrid, type DatabasePreviewValue } from "./DatabasePreviewGrid";
import { Dialog } from "./Dialog";
import { PostgresPager } from "./PostgresPager";
import { emptyTableQueryClauses, TableQueryControls, type TableQueryClauses } from "./TableQueryControls";
import { networkAddressText } from "./quickConnect";
import { useNativeRead } from "./usePostgresRead";
import "./mysqlWorkspace.css";

type Session = { id: string; database: string; version: string; context?: string };
type CatalogPage<T> = { items: T[]; has_next: boolean };
type ServerObject = { id: number | string; schema: string; name: string; kind: "table" | "view" | "materialized_view" };
const objectKind = { table: "테이블", view: "뷰", materialized_view: "구체화 뷰" };
type Column = { name: string; data_type: string; nullable: boolean; identity: boolean };
type DataPage = {
  columns: Column[]; rows: (DatabasePreviewValue | null)[][]; has_next: boolean;
  stable_order: boolean; more_columns: boolean;
  query_sql: string;
};

type Adapter = { engine: string; prefix: "sql_server" | "oracle" | "snowflake" };
type Profile = { id: string; revision: number; settings: { name: string; host: string; port?: number; environment: string } };

export function RelationalWorkspace({ profile, engine, prefix, database, passwordless = false, passwordLimit = 128, transportNote, tokenLabel }: Adapter & {
  profile: Profile; database: string; passwordless?: boolean; passwordLimit?: number; transportNote?: string; tokenLabel?: string;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const active = useRef<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const confirmationHint = useId();
  const { settings } = profile;
  const production = settings.environment === "PROD";
  const endpoint = settings.port === undefined ? settings.host : networkAddressText({ host: settings.host, port: settings.port });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void invoke("close_" + prefix, { id: active.current }).catch(() => {});
    };
  }, [prefix]);

  function closeLogin() {
    setLogin(false); setPassword(""); setConfirmation(""); setError("");
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setPassword("");
    try {
      const next = await invoke<Session>("open_" + prefix, {
        profileId: profile.id, revision: profile.revision, [tokenLabel ? "token" : "password"]: password, confirmation,
      });
      if (!mounted.current) { await invoke("close_" + prefix, { id: next.id }); return; }
      active.current = next.id; setSession(next); closeLogin();
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  function disconnect() {
    const id = active.current;
    if (!id) return;
    active.current = null; setSession(null); setError("");
    void invoke("close_" + prefix, { id }).catch(cause => { if (mounted.current) setError(String(cause)); });
  }

  return <section className="mysql-workspace" aria-label={engine + " 작업 공간"}>
    <header className="content-header">
      <div className="database-target">
        <h1><Database size={21} aria-hidden /><span>{settings.name}</span><span className={`environment ${settings.environment.toLowerCase()}`}>{settings.environment}</span></h1>
        <p className="path">{engine} · {endpoint} / {session?.database ?? database}{session && <> · {session.version}{session.context && <> · {session.context}</>}</>}</p>
      </div>
      <div className="header-actions">
        <span className="readonly"><ShieldCheck size={14} aria-hidden /> 읽기 전용</span>
        {session ? <button type="button" className="secondary" onClick={disconnect}>{engine} 연결 끊기</button>
          : <button type="button" className="primary" onClick={() => { setError(""); setLogin(true); }}><Plug size={15} aria-hidden /> {engine} 연결</button>}
      </div>
    </header>
    {error && !login && <p className="error-banner" role="alert">{error}</p>}
    {session && <Browse key={session.id} session={session} profile={profile} engine={engine} prefix={prefix} />}
    {login && <Dialog title={engine + " 연결"} busy={busy} onClose={closeLogin}>
      <form onSubmit={event => void connect(event)} aria-busy={busy}>
        <p className="confirm-copy"><strong>{settings.name} · {settings.environment}</strong><br />{endpoint} / {database}</p>
        {!passwordless
          ? <label className="field">{tokenLabel ?? engine + " 암호"}<input autoFocus type="password" autoComplete="off" value={password}
            required={Boolean(tokenLabel)} maxLength={tokenLabel ? 16_384 : passwordLimit}
            disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
          : <p className="form-note">현재 Windows 계정으로 연결합니다.</p>}
        {transportNote && <p className="form-note">{transportNote}</p>}
        {production && <label className="field">운영 환경 확인<input required placeholder="PROD" autoComplete="off"
          aria-describedby={confirmationHint} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} />
          <span id={confirmationHint}>연결하려면 PROD를 입력하세요.</span></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={closeLogin}>취소</button>
          <button type="submit" className="primary" disabled={busy || (production && confirmation !== "PROD")}>{busy ? "연결 중…" : "연결"}</button>
        </div>
      </form>
    </Dialog>}
  </section>;
}

function Browse({ session, profile, engine, prefix }: { session: Session; profile: Profile } & Adapter) {
  const [schema, setSchema] = useState("");
  const [object, setObject] = useState<ServerObject | null>(null);
  const [revision, setRevision] = useState(0);
  const schemaArgs = useMemo(() => ({ id: session.id }), [session.id]);
  const objectArgs = useMemo(() => ({ id: session.id, schema }), [session.id, schema]);
  const refresh = () => setRevision(current => current + 1);

  return <div className="mysql-layout">
    <div className="mysql-catalog">
      <Catalog<string> title="스키마" engine={engine} command={prefix + "_schemas"} args={schemaArgs} revision={revision} id={name => name}
        name={name => name} selected={schema} onSelect={name => { setSchema(name); setObject(null); }} />
      {schema && <Catalog<ServerObject> key={schema} title="테이블과 뷰" engine={engine} command={prefix + "_objects"} args={objectArgs}
        revision={revision} id={item => String(item.id)} name={item => item.name} selected={object ? String(object.id) : ""}
        detail={item => objectKind[item.kind]} onSelect={setObject} />}
    </div>
    {object ? <ObjectDetail key={object.id} id={session.id} profile={profile} object={object} revision={revision} refresh={refresh} engine={engine} prefix={prefix} /> :
      <section className="results-card"><div className="panel-heading"><h2>객체 조회</h2>
        <button type="button" className="secondary small" onClick={refresh}><RefreshCw size={14} aria-hidden /> 새로 고침</button>
      </div><p className="result-empty">스키마에서 테이블 또는 뷰를 선택하세요.</p></section>}
  </div>;
}

function Catalog<T>({ title, command, args, revision, id, name, selected, detail, onSelect, engine }: {
  title: string; command: string; args: Record<string, unknown>; revision: number; engine: string;
  id: (item: T) => string; name: (item: T) => string; selected: string; detail?: (item: T) => string; onSelect: (item: T) => void;
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const input = useMemo(() => ({ ...args, search, page }), [args, search, page]);
  const result = useNativeRead<CatalogPage<T>>(command, input, revision);

  return <section className="results-card" aria-label={`${engine} ${title} 목록`} aria-busy={result.loading}>
    <div className="panel-heading"><h2>{title}</h2></div>
    <form className="mysql-search" onSubmit={event => { event.preventDefault(); setSearch(draft); setPage(0); }}>
      <input type="search" aria-label={`${title} 검색`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={128} />
      <button type="submit" className="secondary small">검색</button>
    </form>
    <ReadStatus {...result} empty={result.data?.items.length === 0} />
    <ul className="mysql-catalog-items">{result.data?.items.map(item => <li key={id(item)}>
      <button type="button" aria-current={id(item) === selected ? "true" : undefined} onClick={() => onSelect(item)}>
        <span>{name(item)}</span>{detail && <small>{detail(item)}</small>}
      </button>
    </li>)}</ul>
    <PostgresPager label={title} page={page} next={result.data?.has_next === true} change={setPage} />
  </section>;
}

function ObjectDetail({ id, profile, object, revision, refresh, engine, prefix }: {
  id: string; profile: Profile; object: ServerObject; revision: number; refresh: () => void;
} & Adapter) {
  const [view, setView] = useState<"data" | "columns">("data");
  const [page, setPage] = useState(0);
  const [clauses, setClauses] = useState<TableQueryClauses>(emptyTableQueryClauses);
  const dataErrorId = useId();
  const target = useMemo(() => ({ id, object: object.id }), [id, object.id]);
  const presetTarget = useMemo(() => ({
    engine: prefix, profile_id: profile.id, revision: profile.revision, schema: object.schema, object: object.name,
  }), [prefix, profile.id, profile.revision, object.schema, object.name]);
  const pageArgs = useMemo(() => view === "data" ? { ...target, page, clauses } : null, [target, page, view, clauses]);
  const data = useNativeRead<DataPage>(prefix + "_data", pageArgs, revision);
  const columns = useNativeRead<CatalogPage<Column>>(prefix + "_columns", target, revision);
  return <section className="results-card mysql-detail" aria-label={engine + " 객체 상세"} aria-busy={data.loading || columns.loading}>
    <div className="panel-heading"><h2>{object.name}</h2><span>{object.schema} · {objectKind[object.kind]}</span>
      <button type="button" className="secondary small" onClick={refresh}><RefreshCw size={14} aria-hidden /> 새로 고침</button>
    </div>
    <div className="mysql-views" role="group" aria-label="객체 보기">
      <button type="button" className="secondary small" aria-pressed={view === "data"} onClick={() => setView("data")}>데이터</button>
      <button type="button" className="secondary small" aria-pressed={view === "columns"} onClick={() => setView("columns")}>열 구조</button>
    </div>
    <div hidden={view !== "data"}>
      <TableQueryControls columns={columns.data?.items.map(column => column.name) ?? []}
        busy={data.loading || columns.loading} target={presetTarget} errorId={data.error ? dataErrorId : undefined}
        apply={settings => { setPage(0); setClauses(settings); }} />
    </div>
    {view === "data" ? <>
      <ReadStatus {...data} errorId={dataErrorId} empty={data.data?.rows.length === 0} />
      {data.data && <>
        {!data.data.stable_order && <p className="form-note mysql-table-note">{prefix === "snowflake"
          ? "미리보기는 최대 50행을 표시합니다." : "기본 키가 없어 최대 50행을 한 번에 표시합니다."}</p>}
        {data.data.more_columns && <p className="form-note mysql-table-note">앞 64개 열을 표시합니다.</p>}
        {data.data.query_sql && <details className="table-query-sql">
          <summary>조회 SQL</summary>
          <p className="form-note">필터 값은 별도 매개변수로 전달됩니다.</p>
          <pre><code>{data.data.query_sql}</code></pre>
        </details>}
        {data.data.rows.length > 0 && <DatabasePreviewGrid columns={data.data.columns} rows={data.data.rows} label={engine + " 데이터 미리보기"} />}
      </>}
      <PostgresPager label="데이터" page={page} next={data.data?.has_next === true} change={setPage} />
    </> : <>
      <ReadStatus {...columns} empty={columns.data?.items.length === 0} />
      {columns.data?.has_next && <p className="form-note mysql-table-note">앞 64개 열을 표시합니다.</p>}
      {!!columns.data?.items.length && <div className="mysql-table" tabIndex={0} role="region" aria-label={engine + " 열 구조 스크롤"}>
        <table aria-label={engine + " 열 구조"}><thead><tr>
          <th scope="col">이름</th><th scope="col">타입</th><th scope="col">NULL 허용</th><th scope="col">IDENTITY</th>
        </tr></thead><tbody>{columns.data.items.map(column => <tr key={column.name}>
          <th scope="row">{column.name}</th><td>{column.data_type}</td><td>{column.nullable ? "예" : "아니요"}</td>
          <td>{column.identity ? "예" : "—"}</td>
        </tr>)}</tbody></table>
      </div>}
    </>}
  </section>;
}

function ReadStatus({ error, loading, empty, errorId }: { error: string; loading: boolean; empty: boolean; errorId?: string }) {
  if (loading) return <p className="result-empty" role="status">조회 중…</p>;
  if (error) return <p className="form-error mysql-table-note" role="alert" id={errorId}>{error}</p>;
  return empty ? <p className="result-empty">조회 결과가 없습니다.</p> : null;
}
