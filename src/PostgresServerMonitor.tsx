import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import { PostgresPager } from "./PostgresPager";
import { PostgresStatementStats } from "./PostgresStatementStats";
import { usePostgresRead } from "./usePostgresRead";
import { DatabasePasswordField, useDatabaseCredentials } from "./DatabasePasswordField";
import type { PostgresProfile } from "./PostgresWorkspace";

type Filter = "all" | "running" | "blocked" | "slow" | "idle_in_transaction";
type ActivitySession = { pid: number; username: string | null; application: string; state: string | null;
  wait_type: string | null; wait_event: string | null; query_elapsed_ms: number | null; transaction_elapsed_ms: number | null;
  blocker_pids: number[]; more_blockers: boolean; query: string | null; query_truncated: boolean };
type Snapshot = { sampled_at_ms: number; server_uptime_seconds: number; database_backends: number; max_connections: number;
  commits: string; rollbacks: string; blocks_read: string; cache_hits: string; cache_hit_percent: number | null;
  temp_bytes: string; deadlocks: string; stats_reset_ms: number | null; track_counts: boolean;
  sessions: ActivitySession[]; has_next: boolean };

const statuses: Record<string, string> = { active: "실행 중", idle: "유휴", "idle in transaction": "트랜잭션 대기",
  "idle in transaction (aborted)": "실패한 트랜잭션 대기", "fastpath function call": "함수 실행 중", disabled: "추적 꺼짐" };
const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" });
const count = (value: string) => number.format(BigInt(value));
const duration = (ms: number) => ms < 1000 ? `${number.format(ms)} ms` : `${number.format(ms / 1000)}초`;

function uptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (days) return `${number.format(days)}일 ${hours}시간`;
  if (hours) return `${hours}시간 ${minutes}분`;
  if (minutes) return `${minutes}분 ${seconds % 60}초`;
  return `${seconds}초`;
}

export function PostgresServerMonitor({ workspace, profile, environment, database, visible }: {
  workspace: { id: string; tunnel: string | null }; profile: PostgresProfile; environment: string; database: string; visible: boolean;
}) {
  const [id, setId] = useState<string | null>(null);
  const [login, setLogin] = useState(false);
  const [closing, setClosing] = useState(false);
  const [loss, setLoss] = useState("");
  const [view, setView] = useState<"activity" | "statements">("activity");
  const [filter, setFilter] = useState<Filter>("all");
  const [slowSeconds, setSlowSeconds] = useState(5);
  const [threshold, setThreshold] = useState("5");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [automatic, setAutomatic] = useState(false);
  const active = useRef<string | null>(null);
  const args = useMemo(() => id && view === "activity" ? { id, input: { filter, slow_seconds: slowSeconds, page } } : null,
    [id, view, filter, slowSeconds, page]);
  const read = usePostgresRead<Snapshot>("postgres_server_activity", args, revision, true);
  const snapshot = read.data;

  useEffect(() => () => { if (active.current) void invoke("close_postgres", { id: active.current }).catch(() => {}); }, []);
  useEffect(() => {
    if (!id) return;
    let watching = true;
    void invoke("wait_postgres_disconnect", { id }).then(() => {
      if (!watching || active.current !== id) return;
      active.current = null; setId(null); setLoss("서버 모니터 연결이 끊겼습니다.");
      void invoke("close_postgres", { id }).catch(() => {});
    }, reason => { if (watching && active.current === id) setLoss(String(reason)); });
    return () => { watching = false; };
  }, [id]);
  useEffect(() => {
    if (!visible || !args || !automatic || read.loading || read.error) return;
    const timer = window.setTimeout(() => setRevision(value => value + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [visible, args, automatic, read.loading, read.error, revision]);

  async function stop() {
    if (!id || closing) return;
    setClosing(true); setLoss(""); active.current = null;
    try {
      await invoke("close_postgres", { id });
      setId(null);
    } catch (reason) { active.current = id; setLoss(String(reason)); }
    finally { setClosing(false); }
  }

  return <section className="results-card postgres-monitor" aria-label="PostgreSQL 서버 모니터" hidden={!visible}>
    <div className="panel-heading">
      <strong>서버 모니터 · {database}</strong>
      {id ? <div className="sql-editor-actions">
        {view === "activity" && <button type="button" className="secondary small" disabled={read.loading || closing} onClick={() => setRevision(value => value + 1)}>새로 고침</button>}
        <button type="button" className="secondary small" disabled={closing} onClick={() => void stop()}>모니터 연결 끊기</button>
      </div> : <button type="button" className="primary small" onClick={() => setLogin(true)}>모니터 연결</button>}
    </div>
    {loss && <p className="error-banner" role="alert">{loss}</p>}
    {!id && <p className="result-empty">같은 데이터베이스에 별도의 읽기 전용 연결을 열어 실행 중인 쿼리와 잠금 대기를 확인합니다.</p>}
    {id && <nav className="postgres-result-views postgres-monitor-views" aria-label="서버 모니터 보기">
      <button type="button" className="secondary small" aria-pressed={view === "activity"} onClick={() => setView("activity")}>활동 세션</button>
      <button type="button" className="secondary small" aria-pressed={view === "statements"} onClick={() => setView("statements")}>누적 쿼리</button>
    </nav>}
    {id && <PostgresStatementStats id={id} visible={visible && view === "statements"} />}
    {id && view === "activity" && <>
      {snapshot && <MonitorTotals snapshot={snapshot} />}
      <form className="postgres-monitor-controls" onSubmit={event => {
        event.preventDefault(); const seconds = Number(threshold);
        if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600) { setSlowSeconds(seconds); setPage(0); }
      }}>
        <label className="field">세션 범위<select value={filter} onChange={event => { setFilter(event.target.value as Filter); setPage(0); }}>
          <option value="all">모든 세션</option><option value="running">실행 중</option><option value="blocked">잠금 대기</option>
          <option value="slow">느린 실행</option><option value="idle_in_transaction">열린 트랜잭션 대기</option>
        </select></label>
        {filter === "slow" && <>
          <label className="field postgres-monitor-threshold">느린 쿼리 기준(초)<input type="number" min={1} max={3600} value={threshold}
            required onChange={event => setThreshold(event.target.value)} /></label>
          <button type="submit" className="secondary small">기준 적용</button>
        </>}
        <label className="postgres-monitor-auto"><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} /> 5초마다 새로 고침</label>
      </form>
      {read.error && <p className="error-banner" role="alert">{read.error}</p>}
      {read.loading && !snapshot && <p className="result-empty" role="status">서버 활동을 읽는 중…</p>}
      {snapshot && <>
        {snapshot.sessions.length ? <div className="table-wrap" role="region" tabIndex={0} aria-label="PostgreSQL 세션 스크롤">
          <table aria-label="PostgreSQL 세션 활동"><thead><tr>
            <th scope="col">PID</th><th scope="col">사용자 · 앱</th><th scope="col">상태</th><th scope="col">대기 · 차단 세션</th>
            <th scope="col">실행 시간</th><th scope="col">열린 트랜잭션</th><th scope="col">실행 SQL</th>
          </tr></thead><tbody>{snapshot.sessions.map(item => <tr key={item.pid}>
            <th scope="row">{item.pid}</th>
            <td>{item.username ?? "—"}{item.application && <small>{item.application}</small>}</td>
            <td>{item.state ? statuses[item.state] ?? item.state : "세부 정보 제한"}</td>
            <td>{item.wait_type && item.wait_event ? `${item.wait_type} · ${item.wait_event}` : "—"}
              {item.blocker_pids.length > 0 && <small>차단 세션 {item.blocker_pids.map(pid => pid === 0 ? "준비된 트랜잭션" : pid).join(", ")}{item.more_blockers ? " 외" : ""}</small>}</td>
            <td>{item.query_elapsed_ms === null ? "—" : duration(item.query_elapsed_ms)}</td>
            <td>{item.transaction_elapsed_ms === null ? "—" : duration(item.transaction_elapsed_ms)}</td>
            <td>{item.query ? <details><summary>SQL 보기</summary><pre tabIndex={0}>{item.query}</pre>
              {item.query_truncated && <small>표시 한도 2,048자</small>}</details> : "—"}</td>
          </tr>)}</tbody></table>
        </div> : <p className="result-empty">조건에 맞는 세션이 없습니다.</p>}
        <PostgresPager label="세션" page={page} next={snapshot.has_next} change={setPage} />
      </>}
    </>}
    {login && visible && <MonitorLogin workspace={workspace} profile={profile} environment={environment} onClose={() => setLogin(false)} onOpened={next => {
      active.current = next; setId(next); setLoss(""); setLogin(false); setPage(0);
    }} />}
  </section>;
}

function MonitorTotals({ snapshot }: { snapshot: Snapshot }) {
  return <>
    <dl className="postgres-monitor-totals">
      <div><dt>서버 가동 시간</dt><dd>{uptime(snapshot.server_uptime_seconds)}</dd></div>
      <div><dt>현재 DB 백엔드</dt><dd>{number.format(snapshot.database_backends)}</dd><small>서버 연결 한도 {number.format(snapshot.max_connections)}</small></div>
      <div><dt>트랜잭션 커밋 · 롤백</dt><dd>{count(snapshot.commits)} · {count(snapshot.rollbacks)}</dd></div>
      <div><dt>버퍼 캐시 적중률</dt><dd>{snapshot.cache_hit_percent === null ? "—" : `${number.format(snapshot.cache_hit_percent)}%`}</dd>
        <small>적중 {count(snapshot.cache_hits)} · 블록 읽기 {count(snapshot.blocks_read)}</small></div>
      <div><dt>임시 파일 누적 기록</dt><dd>{count(snapshot.temp_bytes)} B</dd></div>
      <div><dt>교착 상태 누적</dt><dd>{count(snapshot.deadlocks)}</dd></div>
    </dl>
    <p className="form-note postgres-monitor-sample">조회 {date.format(snapshot.sampled_at_ms)}
      {snapshot.stats_reset_ms !== null && ` · 누적 통계 초기화 ${date.format(snapshot.stats_reset_ms)}`}
      {!snapshot.track_counts && " · 서버의 누적 통계 수집 꺼짐"}</p>
  </>;
}

function MonitorLogin({ workspace, profile, environment, onClose, onOpened }: {
  workspace: { id: string; tunnel: string | null }; profile: PostgresProfile; environment: string; onClose: () => void; onOpened: (id: string) => void;
}) {
  const credentials = useDatabaseCredentials("postgres", profile);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(false);
  const pending = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const opened = await invoke<{ id: string }>("open_postgres_monitor", { id: workspace.id, ...credentials.take(), confirmation });
      if (live.current) onOpened(opened.id);
      else await invoke("close_postgres", { id: opened.id });
    } catch (reason) { if (live.current) setError(String(reason)); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  }

  return <Dialog title="PostgreSQL 모니터 연결" onClose={onClose} busy={busy}>
    <form onSubmit={submit} aria-busy={busy}>
      <p className="form-note">읽기 전용 · {workspace.tunnel ? `SSH 터널 ${workspace.tunnel}` : "직접 연결"}</p>
      <DatabasePasswordField credentials={credentials} disabled={busy} autoFocus />
      {environment === "PROD" && <label className="field">운영 환경 확인<input required pattern="PROD" placeholder="PROD" value={confirmation}
        disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      {busy && <p className="form-note" role="status">서버 모니터에 연결하는 중…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>취소</button>
        <button type="submit" className="primary" disabled={busy}>연결</button></div>
    </form>
  </Dialog>;
}
