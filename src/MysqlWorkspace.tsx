import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Code2, Database, Plug, RefreshCw, ShieldCheck, Table2 } from "lucide-react";
import { Dialog } from "./Dialog";
import { MysqlDataGrid, type MysqlValue } from "./MysqlDataGrid";
import type { MysqlProfile } from "./MysqlProfileDialog";
import { MysqlSqlWorkspace } from "./MysqlSqlWorkspace";
import { networkAddressText } from "./quickConnect";
import { useNativeRead } from "./usePostgresRead";
import "./mysqlWorkspace.css";

type Session = { id: string; version: string; engine: "MySQL" | "MariaDB"; database: string | null };
type Page<T> = { items: T[]; has_next: boolean };
type ObjectInfo = { name: string; kind: string; engine: string | null };
type Column = { name: string; data_type: string; column_type: string; nullable: boolean; key: string };
type Sample = { columns: Column[]; rows: (MysqlValue | null)[][]; more_columns: boolean; more_rows: boolean };

export function MysqlWorkspace({ profile }: { profile: MysqlProfile }) {
  const settings = profile.settings;
  const [session, setSession] = useState<Session | null>(null);
  const [login, setLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [database, setDatabase] = useState<string | null>(null);
  const [object, setObject] = useState<ObjectInfo | null>(null);
  const [view, setView] = useState<"columns" | "rows">("columns");
  const [sqlOpen, setSqlOpen] = useState(false);
  const [schemaSearch, setSchemaSearch] = useState("");
  const [objectSearch, setObjectSearch] = useState("");
  const [schemaPage, setSchemaPage] = useState(0);
  const [objectPage, setObjectPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const active = useRef<string | null>(null);
  const mounted = useRef(false);
  const connecting = useRef(false);
  const production = settings.environment === "PROD";

  const schemaArgs = useMemo(() => session ? { id: session.id, search: schemaSearch, page: schemaPage } : null, [session, schemaSearch, schemaPage]);
  const objectArgs = useMemo(() => session && database ? { id: session.id, database, search: objectSearch, page: objectPage } : null,
    [session, database, objectSearch, objectPage]);
  const detailArgs = useMemo(() => session && database && object ? { id: session.id, database, table: object.name, includeRows: view === "rows" } : null,
    [session, database, object, view]);
  const schemas = useNativeRead<Page<string>>("mysql_databases", schemaArgs, revision);
  const objects = useNativeRead<Page<ObjectInfo>>("mysql_objects", objectArgs, revision);
  const detail = useNativeRead<Sample>("mysql_table", detailArgs, revision);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void invoke("close_mysql", { id: active.current }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const lost = [schemas.error, objects.error, detail.error].find(message => message.includes("MySQL 연결이 닫혔습니다"));
    if (!lost || !active.current) return;
    const id = active.current;
    active.current = null; setSession(null); setError(lost);
    void invoke("close_mysql", { id }).catch(() => {});
  }, [schemas.error, objects.error, detail.error]);

  function chooseDatabase(name: string | null) {
    setDatabase(name); setObject(null); setObjectSearch(""); setObjectPage(0); setView("columns");
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (connecting.current) return;
    connecting.current = true; setBusy(true); setError(""); setPassword("");
    try {
      const next = await invoke<Session>("open_mysql", { profileId: profile.id, revision: profile.revision, password, confirmation });
      if (!mounted.current) { await invoke("close_mysql", { id: next.id }); return; }
      active.current = next.id; chooseDatabase(next.database); setSchemaSearch(""); setSchemaPage(0);
      setSession(next); setSqlOpen(false); setLogin(false);
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { connecting.current = false; if (mounted.current) setBusy(false); }
  }

  async function disconnect() {
    const id = active.current;
    if (!id) return;
    active.current = null; setSession(null); chooseDatabase(null); setError("");
    try { await invoke("close_mysql", { id }); }
    catch (cause) { if (mounted.current) setError(String(cause)); }
  }

  return <section className="mysql-workspace" aria-label="MySQL 작업 공간">
    <div className="content-header">
      <div className="database-target">
        <h1><Database size={21} aria-hidden /><span>{settings.name}</span><span className={`environment ${settings.environment.toLowerCase()}`}>{settings.environment}</span></h1>
        <p className="path">{session ? `${session.engine} · ${session.version}` : "MySQL · MariaDB"} · {networkAddressText(settings)}</p>
      </div>
      <div className="header-actions">
        <span className="readonly"><ShieldCheck size={14} aria-hidden /> 읽기 전용</span>
        {session ? <><button type="button" className="secondary" aria-pressed={sqlOpen} onClick={() => setSqlOpen(value => !value)}><Code2 size={15} aria-hidden /> SQL 편집기</button>
          <button type="button" className="secondary" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} aria-hidden /> 새로 고침</button>
          <button type="button" className="secondary" onClick={() => void disconnect()}>MySQL 연결 끊기</button></> :
          <button type="button" className="primary" onClick={() => { setError(""); setConfirmation(""); setLogin(true); }}><Plug size={15} aria-hidden /> MySQL 연결</button>}
      </div>
    </div>
    {error && !login && <p className="error-banner" role="alert">{error}</p>}
    {session && <div className="mysql-layout">
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
            <button type="button" aria-current={object?.name === item.name || undefined} onClick={() => { setObject(item); setView("columns"); setSqlOpen(false); }}>
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
            <button type="button" className="secondary small" aria-pressed={view === "columns"} onClick={() => setView("columns")}>열 구조</button>
            <button type="button" className="secondary small" aria-pressed={view === "rows"} onClick={() => setView("rows")}>데이터 미리보기</button>
          </div>
          <ReadNotice loading={detail.loading} error={detail.error} />
          {detail.data && <TablePreview data={detail.data} rows={view === "rows"} />}
        </>}
      </section>
      <div hidden={!sqlOpen}><MysqlSqlWorkspace key={session.id} id={session.id} database={database} /></div>
      </div>
    </div>}
    {login && <Dialog title="MySQL 계열 연결" busy={busy} onClose={() => { setLogin(false); setPassword(""); setError(""); }}>
      <form aria-busy={busy} onSubmit={event => void connect(event)}>
        <p className="confirm-copy"><strong>{settings.name} · {settings.environment}</strong><br />{networkAddressText(settings)} · {settings.username}</p>
        <label className="field">MySQL 암호<input type="password" autoComplete="off" maxLength={4096} value={password}
          disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        {production && <label className="field">운영 환경 확인<input required placeholder="PROD" value={confirmation}
          autoComplete="off" disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
        {!settings.tls && <p className="form-note">일반 TCP 연결에는 TLS 전송 보호가 적용되지 않습니다.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="submit" className="primary" disabled={busy || (production && confirmation !== "PROD")}>{busy ? "연결 중…" : "연결"}</button></div>
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

function Pager({ page, loading, hasNext, onPage }: { page: number; loading: boolean; hasNext: boolean; onPage: (page: number) => void }) {
  if (!page && !hasNext) return null;
  return <div className="mysql-pager">
    <button type="button" className="secondary small" disabled={loading || !page} onClick={() => onPage(page - 1)}>이전</button>
    <span>{page + 1} 페이지</span>
    <button type="button" className="secondary small" disabled={loading || !hasNext} onClick={() => onPage(page + 1)}>다음</button>
  </div>;
}

function TablePreview({ data, rows }: { data: Sample; rows: boolean }) {
  return <>
    {data.more_columns && <p className="form-note mysql-table-note">앞 128개 열을 표시합니다.</p>}
    {rows ? <>
      <p className="form-note mysql-table-note">{data.more_rows ? "처음 50개 행을 표시합니다." : `${data.rows.length}개 행`}</p>
      <MysqlDataGrid columns={data.columns} rows={data.rows} label="MySQL 데이터 미리보기" />
    </> : <div className="mysql-table" tabIndex={0} role="region" aria-label="MySQL 열 구조 스크롤">
      <table aria-label="MySQL 열 구조"><thead><tr><th scope="col">열</th><th scope="col">타입</th><th scope="col">NULL 허용</th><th scope="col">키</th></tr></thead>
        <tbody>{data.columns.map(column => <tr key={column.name}><th scope="row">{column.name}</th><td><code>{column.column_type}</code></td>
          <td>{column.nullable ? "예" : "아니요"}</td><td>{column.key || "—"}</td></tr>)}</tbody>
      </table>
    </div>}
  </>;
}
