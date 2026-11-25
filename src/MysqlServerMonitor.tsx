import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PostgresPager } from "./PostgresPager";
import { useNativeRead } from "./usePostgresRead";

type Filter = "all" | "running" | "blocked" | "slow";
type Session = {
  id: string; username: string; database: string | null; command: string; state: string | null; state_seconds: number;
  lock_wait: boolean; blocker_ids: string[]; more_blockers: boolean; hidden_blocker: boolean;
  sql: string | null; sql_truncated: boolean;
};
type Snapshot = {
  sampled_at_ms: number;
  server: {
    version: string; charset: string; time_zone: string; system_time_zone: string; default_engine: string;
    max_connections: string; slow_query_threshold: string; performance_schema: boolean;
  };
  counters: Record<"uptime" | "connected" | "running" | "connections" | "aborted_connects" | "peak_connections" |
    "questions" | "slow_queries" | "bytes_received" | "bytes_sent" | "row_lock_waits" | "deadlocks", string | null>;
  lock_metadata: "available" | "restricted" | "unavailable";
  lock_pairs_truncated: boolean;
  sessions: Session[];
  has_next: boolean;
};

const number = new Intl.NumberFormat("ko-KR");
const date = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" });
const count = (value: string | null) => value && /^\d+$/.test(value) ? number.format(BigInt(value)) : "—";
const commands: Record<string, string> = { Sleep: "유휴", Query: "쿼리", Execute: "준비 문장 실행", Connect: "접속", Daemon: "백그라운드" };

export function MysqlServerMonitor({ id }: { id: string }) {
  const [monitorId, setMonitorId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [threshold, setThreshold] = useState("5");
  const [slowSeconds, setSlowSeconds] = useState(5);
  const [includeSql, setIncludeSql] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const active = useRef<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const args = useMemo(() => monitorId ? { id, monitorId, input: { filter, slow_seconds: slowSeconds, page, include_sql: includeSql } } : null,
    [id, monitorId, filter, slowSeconds, page, includeSql]);
  const read = useNativeRead<Snapshot>("mysql_server_activity", args, revision, true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const prior = active.current;
      active.current = null;
      if (prior) void invoke("close_mysql_monitor", { id, monitorId: prior }).catch(() => {});
    };
  }, [id]);

  useEffect(() => {
    if (!monitorId || !read.error.includes("MySQL 모니터 연결이 닫혔습니다")) return;
    active.current = null;
    setMonitorId(null);
    setError(read.error);
  }, [monitorId, read.error]);

  useEffect(() => {
    if (!args || !automatic || read.loading || read.error) return;
    const timer = window.setTimeout(() => setRevision(value => value + 1), 5000);
    return () => clearTimeout(timer);
  }, [args, automatic, read.loading, read.error, revision]);

  async function connect() {
    if (pending.current) return;
    pending.current = true;
    setConnecting(true);
    setError("");
    try {
      const opened = await invoke<string>("open_mysql_monitor", { id });
      if (!mounted.current) { await invoke("close_mysql_monitor", { id, monitorId: opened }); return; }
      active.current = opened;
      setMonitorId(opened);
      setPage(0);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      pending.current = false;
      if (mounted.current) setConnecting(false);
    }
  }

  async function disconnect() {
    const prior = active.current;
    if (!prior || pending.current) return;
    pending.current = true;
    setConnecting(true);
    setError("");
    setMonitorId(null);
    try {
      await invoke("close_mysql_monitor", { id, monitorId: prior });
      active.current = null;
    } catch (reason) {
      if (mounted.current) { setError(String(reason)); setMonitorId(prior); }
    } finally {
      pending.current = false;
      if (mounted.current) setConnecting(false);
    }
  }

  return <section className="results-card mysql-monitor" aria-label="MySQL 서버 모니터">
    <div className="panel-heading"><h2>서버 모니터</h2>
      <div className="sql-editor-actions">
        {monitorId ? <>
          <button type="button" className="secondary small" disabled={read.loading} onClick={() => setRevision(value => value + 1)}>새로 고침</button>
          <button type="button" className="secondary small" onClick={() => void disconnect()}>모니터 연결 끊기</button>
        </> : <button type="button" className="primary small" disabled={connecting}
          onClick={() => void connect()}>{connecting ? "연결 처리 중…" : "모니터 연결"}</button>}
      </div>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {!monitorId && !error && <p className="form-note mysql-monitor-note">읽기 전용 연결로 현재 계정에 공개된 서버 활동을 조회합니다.</p>}
    {read.data && <Totals data={read.data} />}
    {monitorId && <form className="mysql-monitor-controls" onSubmit={event => {
      event.preventDefault();
      const seconds = Number(threshold);
      if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600) { setSlowSeconds(seconds); setPage(0); }
    }}>
      <label className="field">세션 범위<select value={filter} onChange={event => { setFilter(event.target.value as Filter); setPage(0); }}>
        <option value="all">모든 세션</option><option value="running">실행 중</option>
        <option value="blocked">잠금 대기</option><option value="slow">느린 실행</option>
      </select></label>
      {filter === "slow" && <>
        <label className="field">느린 실행 기준(초)<input type="number" required min={1} max={3600} value={threshold}
          onChange={event => setThreshold(event.target.value)} /></label>
        <button type="submit" className="secondary small">기준 적용</button>
      </>}
      <label className="mysql-monitor-toggle"><input type="checkbox" checked={includeSql}
        onChange={event => setIncludeSql(event.target.checked)} /> 실행 SQL 가져오기</label>
      <label className="mysql-monitor-toggle"><input type="checkbox" checked={automatic}
        onChange={event => setAutomatic(event.target.checked)} /> 5초마다 새로 고침</label>
    </form>}
    {read.error && <p className="error-banner" role="alert">{read.error}</p>}
    {read.loading && !read.data && <p className="result-empty" role="status">서버 활동을 읽는 중…</p>}
    {read.data && <>
      {read.data.lock_metadata !== "available" && <p className="form-note mysql-monitor-note">
        {read.data.lock_metadata === "restricted" ? "현재 계정에 잠금 관계 조회 권한이 없습니다." : "서버의 잠금 관계 메타데이터를 사용할 수 없습니다."}
        {" "}세션 상태에 표시된 잠금 대기는 확인할 수 있습니다.
      </p>}
      {read.data.lock_pairs_truncated && <p className="form-note mysql-monitor-note">잠금 관계를 처음 1,000개까지 확인했습니다.</p>}
      <ActivityTable rows={read.data.sessions} includeSql={includeSql} />
      <PostgresPager label="세션" page={page} next={read.data.has_next && !read.loading} change={setPage} />
    </>}
  </section>;
}

function Totals({ data }: { data: Snapshot }) {
  const { server, counters } = data;
  return <>
    <dl className="mysql-monitor-totals">
      <div><dt>가동 시간</dt><dd>{count(counters.uptime)}초</dd><small>{server.version}</small></div>
      <div><dt>연결 중 · 실행 중</dt><dd>{count(counters.connected)} · {count(counters.running)}</dd>
        <small>연결 한도 {count(server.max_connections)} · 최고 {count(counters.peak_connections)}</small></div>
      <div><dt>연결 시도 · 실패</dt><dd>{count(counters.connections)} · {count(counters.aborted_connects)}</dd></div>
      <div><dt>문장 · 느린 쿼리 누적</dt><dd>{count(counters.questions)} · {count(counters.slow_queries)}</dd>
        <small>서버 느린 쿼리 기준 {server.slow_query_threshold}초</small></div>
      <div><dt>행 잠금 대기 · 교착 상태 누적</dt><dd>{count(counters.row_lock_waits)} · {count(counters.deadlocks)}</dd></div>
      <div><dt>수신 · 송신 누적</dt><dd>{count(counters.bytes_received)} B · {count(counters.bytes_sent)} B</dd></div>
    </dl>
    <p className="form-note mysql-monitor-note">{server.charset} · {server.default_engine} · 서버 시간대 {server.time_zone}
      {server.time_zone === "SYSTEM" && ` (${server.system_time_zone})`} · 조회 {date.format(data.sampled_at_ms)}</p>
  </>;
}

function ActivityTable({ rows, includeSql }: { rows: Session[]; includeSql: boolean }) {
  if (!rows.length) return <p className="result-empty">조건에 맞는 세션이 없습니다.</p>;
  return <div className="mysql-table" tabIndex={0} role="region" aria-label="MySQL 세션 스크롤">
    <table aria-label="MySQL 세션 활동"><thead><tr>
      <th scope="col">연결 ID</th><th scope="col">사용자</th><th scope="col">데이터베이스</th><th scope="col">명령 · 상태</th>
      <th scope="col">상태 경과</th><th scope="col">잠금 대기</th>{includeSql && <th scope="col">실행 SQL</th>}
    </tr></thead><tbody>{rows.map(session => <tr key={session.id}>
      <th scope="row">{session.id}</th><td>{session.username || "—"}</td><td>{session.database ?? "—"}</td>
      <td>{commands[session.command] ?? session.command}{session.state && <small>{session.state}</small>}</td>
      <td>{number.format(session.state_seconds)}초</td>
      <td>{session.lock_wait ? <>대기 중
        {session.blocker_ids.length > 0 && <small>차단 세션 {session.blocker_ids.join(", ")}{session.more_blockers && " 외"}</small>}
        {session.hidden_blocker && <small>일부 차단 세션 정보 없음</small>}
      </> : "—"}</td>
      {includeSql && <td>{session.sql ? <details><summary>SQL 보기</summary>
        <pre tabIndex={0}>{session.sql}</pre>{session.sql_truncated && <small>앞 2,048자</small>}</details> : "—"}</td>}
    </tr>)}</tbody></table>
  </div>;
}
