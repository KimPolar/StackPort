import { useMemo, useState, type FormEvent } from "react";
import { PostgresPager } from "./PostgresPager";
import { usePostgresRead } from "./usePostgresRead";

type Order = "maximum" | "mean" | "total" | "calls";
type Unavailable = "not_installed" | "not_loaded" | "permission_denied" | "incompatible_view";
type Row = { username: string | null; query_id: string | null; query: string | null; query_truncated: boolean; top_level: boolean;
  calls: string; rows: string; mean_ms: number; max_ms: number; total_ms: number; shared_hits: string; shared_reads: string;
  temp_reads: string; temp_writes: string };
type Report = { status: "available"; version: string; sampled_at_ms: number; stats_reset_ms: number | null;
  evictions: string | null; tracking: string | null; rows: Row[]; has_next: boolean } | { status: "unavailable"; reason: Unavailable };

const reasons: Record<Unavailable, string> = {
  not_installed: "이 데이터베이스에 pg_stat_statements 확장이 설치되어 있지 않습니다.",
  not_loaded: "서버에서 pg_stat_statements를 사전 로드해야 누적 통계를 조회할 수 있습니다.",
  permission_denied: "현재 역할에 pg_stat_statements를 조회할 권한이 없습니다.",
  incompatible_view: "설치된 pg_stat_statements 뷰에서 실행 시간 통계를 읽을 수 없습니다.",
};
const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" });
const count = (value: string) => number.format(BigInt(value));
const time = (ms: number) => ms >= 1000 ? `${number.format(ms / 1000)}초` : `${number.format(ms)} ms`;

export function PostgresStatementStats({ id, visible }: { id: string; visible: boolean }) {
  const [order, setOrder] = useState<Order>("maximum");
  const [ownOnly, setOwnOnly] = useState(false);
  const [minimum, setMinimum] = useState(0);
  const [threshold, setThreshold] = useState("0");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const args = useMemo(() => visible ? { id, input: { order, own_only: ownOnly, minimum_ms: minimum, page } } : null,
    [id, visible, order, ownOnly, minimum, page]);
  const read = usePostgresRead<Report>("postgres_statement_stats", args, revision, true);
  const report = read.data;

  function applyThreshold(event: FormEvent) {
    event.preventDefault();
    const ms = Number(threshold);
    if (Number.isInteger(ms) && ms >= 0 && ms <= 4294967295) { setMinimum(ms); setPage(0); }
  }

  return <section aria-label="PostgreSQL 누적 쿼리 통계" hidden={!visible}>
    <form className="postgres-monitor-controls" onSubmit={applyThreshold}>
      <label className="field">정렬<select value={order} onChange={event => { setOrder(event.target.value as Order); setPage(0); }}>
        <option value="maximum">최대 실행 시간</option><option value="mean">평균 실행 시간</option>
        <option value="total">누적 실행 시간</option><option value="calls">호출 횟수</option>
      </select></label>
      <label className="field postgres-monitor-threshold">최대 실행 시간 하한(ms)
        <input value={threshold} type="number" min={0} max={4294967295} required onChange={event => setThreshold(event.target.value)} /></label>
      <button type="submit" className="secondary small">기준 적용</button>
      <label className="postgres-monitor-auto"><input type="checkbox" checked={ownOnly}
        onChange={event => { setOwnOnly(event.target.checked); setPage(0); }} /> 현재 역할의 쿼리만</label>
      <button type="button" className="secondary small" disabled={read.loading} onClick={() => setRevision(value => value + 1)}>통계 새로 고침</button>
    </form>
    {read.loading && !report && <p className="result-empty" role="status">누적 쿼리 통계를 읽는 중…</p>}
    {read.error && <p className="error-banner" role="alert">{read.error}</p>}
    {report?.status === "unavailable" && <p className="result-empty" role="status">{reasons[report.reason]}</p>}
    {report?.status === "available" && <>
      <p className="form-note postgres-monitor-sample">pg_stat_statements {report.version} · 조회 {date.format(report.sampled_at_ms)}
        {report.stats_reset_ms !== null && ` · 전체 통계 초기화 ${date.format(report.stats_reset_ms)}`}
        {report.evictions !== null && ` · 제거된 통계 ${count(report.evictions)}건`}
        {report.tracking === "none" && " · 현재 연결의 새 쿼리 추적 꺼짐"}</p>
      {report.rows.length ? <div className="table-wrap" role="region" tabIndex={0} aria-label="PostgreSQL 누적 쿼리 스크롤">
        <table aria-label="PostgreSQL 누적 쿼리"><thead><tr><th scope="col">역할 · 대표 SQL</th><th scope="col">호출</th>
          <th scope="col">평균</th><th scope="col">최대</th><th scope="col">누적</th><th scope="col">처리 행</th><th scope="col">블록 통계</th></tr></thead>
          <tbody>{report.rows.map((item, index) => <tr key={`${item.username}-${item.query_id}-${item.top_level}-${index}`}>
            <th scope="row"><span>{item.username ?? "—"}</span>{!item.top_level && <small>내부 실행</small>}
              {item.query ? <details><summary>SQL 보기</summary><pre tabIndex={0}>{item.query}</pre>
                {item.query_truncated && <small>표시 한도 2,048자</small>}</details> : <small>{item.query_id ? "SQL 텍스트 없음" : "SQL 조회 권한 제한"}</small>}</th>
            <td>{count(item.calls)}</td><td>{time(item.mean_ms)}</td><td>{time(item.max_ms)}</td><td>{time(item.total_ms)}</td><td>{count(item.rows)}</td>
            <td><small>공유 적중 {count(item.shared_hits)} · 읽기 {count(item.shared_reads)}</small>
              <small>임시 읽기 {count(item.temp_reads)} · 쓰기 {count(item.temp_writes)}</small></td>
          </tr>)}</tbody></table>
      </div> : <p className="result-empty" role="status">조건에 맞는 누적 쿼리 통계가 없습니다.</p>}
      <PostgresPager label="누적 쿼리" page={page} next={report.has_next} change={setPage} />
    </>}
  </section>;
}
