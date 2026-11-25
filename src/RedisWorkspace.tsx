import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, Database, Pencil, Plug, RefreshCw, ShieldCheck } from "lucide-react";
import { Dialog } from "./Dialog";
import type { RedisProfile } from "./RedisProfileDialog";
import { networkAddressText } from "./quickConnect";
import { RedisEditDialog, type RedisBytes, type RedisEditKind, type RedisEditReport } from "./RedisEditDialog";
import { RedisServerMonitor } from "./RedisServerMonitor";
import { useNativeRead } from "./usePostgresRead";
import "./redisWorkspace.css";

const kinds = ["string", "hash", "list", "set", "zset", "stream"] as const;
type Kind = (typeof kinds)[number];
type Key = { id: string; display: RedisBytes };
type KeyPage = { keys: Key[]; cursor: string; total: number | null };
type Position = { kind: "index"; index: number } | { kind: "scan"; cursor: string } | { kind: "stream"; after: string };
type Value = { kind: string; ttl_ms: number | null; memory_bytes: number | null; length: number | null;
  columns: string[]; rows: RedisBytes[][]; next: Position | null };
type Session = { id: string; engine: string; version: string; allow_edits: boolean };
const number = new Intl.NumberFormat("ko-KR");

export function RedisWorkspace({ profile, onBusy }: { profile: RedisProfile; onBusy: (busy: boolean) => void }) {
  const settings = profile.settings;
  const [session, setSession] = useState<Session | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [allowEdits, setAllowEdits] = useState(false);
  const [editor, setEditor] = useState<{ key: Key; kind: RedisEditKind } | null>(null);
  const [editReport, setEditReport] = useState<RedisEditReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [pattern, setPattern] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [filter, setFilter] = useState<{ pattern: string; kind: Kind | null }>({ pattern: "", kind: null });
  const [cursors, setCursors] = useState(["0"]);
  const [selected, setSelected] = useState<Key | null>(null);
  const [positions, setPositions] = useState<(Position | null)[]>([null]);
  const [revision, setRevision] = useState(0);
  const [valueRevision, setValueRevision] = useState(0);
  const mounted = useRef(true);
  const active = useRef<string | null>(null);
  const connecting = useRef(false);
  const production = settings.environment === "PROD";
  const cursor = cursors.at(-1)!;
  const position = positions.at(-1) ?? null;
  const searchArgs = useMemo(() => session ? { id: session.id, input: { cursor, ...filter } } : null, [session, cursor, filter]);
  const valueArgs = useMemo(() => session && selected ? { id: session.id, input: { key: selected.id, position } } : null,
    [session, selected, position]);
  const page = useNativeRead<KeyPage>("redis_keys", searchArgs, revision);
  const detail = useNativeRead<Value>("redis_value", valueArgs, valueRevision);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void invoke("close_redis", { id: active.current }).catch(() => {});
    };
  }, []);

  const handleFailure = useCallback((message: string) => {
    if (!(message.includes("연결이 닫혔습니다") || message.includes("연결이 끊겼습니다"))) return false;
    const id = active.current;
    if (id) {
      active.current = null; setSession(null); setEditor(null); setEditReport(null); setMonitorOpen(false); setError(message);
      void invoke("close_redis", { id }).catch(() => {});
    }
    return true;
  }, []);
  useEffect(() => {
    handleFailure(page.error);
    handleFailure(detail.error);
  }, [page.error, detail.error, handleFailure]);

  function resetKeys() {
    setEditReport(null);
    setCursors(["0"]); setSelected(null); setPositions([null]);
    setRevision(value => value + 1);
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (connecting.current) return;
    connecting.current = true; setPending(true); setError(""); setPassword("");
    try {
      const opened = await invoke<Session>("open_redis", { profileId: profile.id, revision: profile.revision, password, confirmation, allowEdits });
      if (!mounted.current) { await invoke("close_redis", { id: opened.id }); return; }
      active.current = opened.id;
      setSession(opened); setConnectOpen(false); resetKeys();
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { connecting.current = false; if (mounted.current) setPending(false); }
  }

  async function disconnect() {
    const id = active.current;
    if (!id) return;
    active.current = null;
    setSession(null); setSelected(null); setEditor(null); setEditReport(null); setMonitorOpen(false); setError("");
    try { await invoke("close_redis", { id }); }
    catch (reason) { if (mounted.current) setError(String(reason)); }
  }

  function chooseKey(key: Key) {
    setEditReport(null);
    setSelected(key); setPositions([null]); setValueRevision(value => value + 1);
  }

  const editable = session?.allow_edits && selected && detail.data && kinds.includes(detail.data.kind as Kind)
    ? { key: selected, kind: detail.data.kind as RedisEditKind } : null;

  return <section className="redis-workspace" aria-label="Redis 작업 공간">
    <div className="content-header">
      <div className="database-target">
        <h1><Database size={21} aria-hidden /><span>{settings.name}</span><span className={`environment ${settings.environment.toLowerCase()}`}>{settings.environment}</span></h1>
        <p className="path">Redis · {networkAddressText(settings)} / DB {settings.database}</p>
      </div>
      <div className="header-actions">
        <span className="readonly"><ShieldCheck size={14} aria-hidden /> {session?.allow_edits ? "키 편집 허용" : "읽기 전용"}</span>
        {session && <button type="button" className="secondary" aria-haspopup="dialog" onClick={() => setMonitorOpen(true)}>
          <Activity size={15} aria-hidden /> 서버 모니터</button>}
        {session ? <button type="button" className="secondary" onClick={() => void disconnect()}>Redis 연결 끊기</button> :
          <button type="button" className="primary" onClick={() => { setError(""); setConfirmation(""); setAllowEdits(false); setConnectOpen(true); }}>
            <Plug size={15} aria-hidden /> Redis 연결</button>}
      </div>
    </div>
    {error && !connectOpen && <p className="error-banner" role="alert">{error}</p>}
    {session && <p className="redis-server" role="status">{session.engine} {session.version} · DB {settings.database} · {settings.tls ? "TLS" : "일반 TCP"}</p>}
    {session && <div className="redis-layout">
      <section className="results-card redis-keys" aria-label="Redis 키 탐색">
        <div className="panel-heading"><h2>키</h2>
          {page.data?.total != null && <span>DB 전체 {number.format(page.data.total)}개</span>}</div>
        <form className="redis-search" onSubmit={event => { event.preventDefault(); setFilter({ pattern, kind: kind || null }); resetKeys(); }}>
          <label className="field">검색 패턴<input type="search" placeholder="예: cache:*" maxLength={1024}
            value={pattern} onChange={event => setPattern(event.target.value)} /></label>
          <label className="field">타입<select value={kind} onChange={event => setKind(event.target.value as Kind | "")}>
            <option value="">모든 타입</option>{kinds.map(item => <option key={item}>{item}</option>)}
          </select></label>
          <button type="submit" className="secondary small" disabled={page.loading}>검색</button>
        </form>
        {page.loading && <p className="result-empty" role="status">키를 검색하는 중…</p>}
        {page.error && <p className="error-banner" role="alert">{page.error}</p>}
        {page.data && <>
          <ul className="redis-key-list">{page.data.keys.map(key => <li key={key.id}>
            <button type="button" aria-current={selected?.id === key.id || undefined} onClick={() => chooseKey(key)}>
              {key.display.encoding === "hex" && <small>HEX</small>}
              <code>{key.display.text || "(빈 키)"}{key.display.truncated && "…"}</code>
            </button>
          </li>)}</ul>
          {!page.data.keys.length && <p className="result-empty">이번 탐색에 일치하는 키가 없습니다.</p>}
        </>}
        <div className="redis-page" aria-label="키 탐색 페이지" role="group">
          <button className="secondary small" type="button" disabled={page.loading || cursors.length <= 1}
            onClick={() => { setCursors(values => values.slice(0, -1)); setSelected(null); }}>이전 키</button>
          <span>{cursors.length} 페이지</span>
          <button className="secondary small" type="button" disabled={!page.data || page.data.cursor === "0" || page.data.cursor === cursor}
            onClick={() => { if (page.data) setCursors(values => [...values, page.data!.cursor]); setSelected(null); }}>다음 키</button>
        </div>
      </section>
      <section className="results-card redis-detail" aria-label="Redis 키 상세">
        <div className="panel-heading"><h2>{selected?.display.text || (selected ? "(빈 키)" : "키 상세")}{selected?.display.truncated && "…"}</h2>
          {selected && <div className="redis-detail-actions">
            {editable && <button className="secondary small" type="button" aria-haspopup="dialog" onClick={() => setEditor(editable)}>
              <Pencil size={14} aria-hidden /> 값 편집</button>}
            <button className="secondary small" type="button" disabled={detail.loading} onClick={() => chooseKey(selected)}>
              <RefreshCw size={14} aria-hidden /> 값 새로고침</button>
          </div>}</div>
        {editReport && <p className="success-banner" role="status">Redis 변경 완료{editReport.entry_id && ` · 메시지 ${editReport.entry_id}`}
          {editReport.audit_warning && <strong className="audit-warning">작업 기록을 저장할 수 없습니다.</strong>}</p>}
        {!selected && <p className="result-empty">값을 확인할 키를 선택하세요.</p>}
        {detail.loading && <p className="result-empty" role="status">값을 읽는 중…</p>}
        {detail.error && <p className="error-banner" role="alert">{detail.error}</p>}
        {detail.data && <KeyValue value={detail.data} positions={positions} setPositions={setPositions} />}
      </section>
    </div>}
    {connectOpen && <Dialog title="Redis 연결" busy={pending} onClose={() => { setConnectOpen(false); setPassword(""); setError(""); }}>
      <form onSubmit={event => void connect(event)} aria-busy={pending}>
        <p className="confirm-copy"><strong>{settings.name} · {settings.environment}</strong><br />{networkAddressText(settings)} / DB {settings.database}
          {settings.username && ` · ${settings.username}`}</p>
        <label className="field">Redis 암호<input type="password" autoComplete="off" value={password} disabled={pending}
          maxLength={4096} onChange={event => setPassword(event.target.value)} /></label>
        <label className="redis-edit-permission"><input type="checkbox" checked={allowEdits} disabled={pending}
          onChange={event => setAllowEdits(event.target.checked)} /> 이 연결에서 키 편집 허용</label>
        {!settings.tls && <p className="form-note">일반 TCP 연결로 암호와 데이터를 평문으로 전송합니다.</p>}
        {production && <label className="field">운영 환경 확인<input value={confirmation} required disabled={pending}
          autoComplete="off" placeholder="PROD" onChange={event => setConfirmation(event.target.value)} /></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="primary" type="submit" disabled={pending || (production && confirmation !== "PROD")}>
          {pending ? "연결 중…" : "연결"}</button></div>
      </form>
    </Dialog>}
    {editor && session && <RedisEditDialog id={session.id} keyId={editor.key.id} display={editor.key.display} kind={editor.kind}
      environment={settings.environment} onBusy={onBusy} onFailure={handleFailure} onClose={() => setEditor(null)}
      onApplied={report => { setEditor(null); chooseKey(editor.key); setEditReport(report); }} />}
    {monitorOpen && session && <RedisServerMonitor id={session.id} selectedDatabase={settings.database}
      target={`${settings.name} · ${settings.environment} · ${networkAddressText(settings)}`}
      onFailure={handleFailure} onClose={() => setMonitorOpen(false)} />}
  </section>;
}

function KeyValue({ value, positions, setPositions }: {
  value: Value; positions: (Position | null)[]; setPositions: (positions: (Position | null)[]) => void;
}) {
  if (value.kind === "none") return <p className="result-empty" role="status">키가 만료되었거나 삭제되었습니다.</p>;
  return <>
    <dl className="redis-key-meta">
      <div><dt>타입</dt><dd>{value.kind}</dd></div>
      <div><dt>TTL</dt><dd>{value.ttl_ms === null ? "만료 없음" : `${number.format(value.ttl_ms)} ms`}</dd></div>
      <div><dt>메모리</dt><dd>{value.memory_bytes === null ? "조회 불가" : `${number.format(value.memory_bytes)} B`}</dd></div>
      {value.length !== null && <div><dt>{value.kind === "string" ? "값 크기" : "항목 수"}</dt>
        <dd>{number.format(value.length)}{value.kind === "string" ? " B" : "개"}</dd></div>}
    </dl>
    {value.columns.length ? <div className="redis-values" role="region" tabIndex={0} aria-label="Redis 값 목록">
      <table aria-label="Redis 값"><thead><tr>{value.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{value.rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i}>
          {cell.encoding === "hex" && <small>HEX </small>}<code>{cell.text || "(빈 값)"}</code>
          {cell.truncated && <small> … ({number.format(cell.bytes)} B)</small>}
        </td>)}</tr>)}</tbody>
      </table>
    </div> : <p className="result-empty">이 키 타입의 값 미리보기를 사용할 수 없습니다.</p>}
    {(positions.length > 1 || value.next) && <div className="redis-page" role="group" aria-label="값 탐색 페이지">
      <button className="secondary small" type="button" disabled={positions.length <= 1} onClick={() => setPositions(positions.slice(0, -1))}>이전 값</button>
      <span>{positions.length} 페이지</span>
      <button className="secondary small" type="button" disabled={!value.next} onClick={() => setPositions([...positions, value.next])}>다음 값</button>
    </div>}
  </>;
}
