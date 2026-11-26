import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Dialog } from "./Dialog";
import { useNativeRead } from "./usePostgresRead";

type SlowEntry = { id: string; occurred_at_seconds: number; duration_us: number; command: string | null };
type DatabaseStats = { database: number; keys: number; expiring: number | null; average_ttl_ms: number | null };
type Snapshot = {
  sampled_at_seconds: number;
  used_memory: number | null;
  peak_memory: number | null;
  max_memory: number | null;
  connected_clients: number | null;
  blocked_clients: number | null;
  operations_per_second: number | null;
  role: "primary" | "replica" | null;
  connected_replicas: number | null;
  upstream_link: boolean | null;
  keyspace: DatabaseStats[];
  more_databases: boolean;
  slow_log: { status: "available"; entries: SlowEntry[] } | { status: "unavailable"; reason: string };
};

const numbers = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const dates = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" });
const count = (value: number | null, unit = "") => value == null ? "—" : `${numbers.format(value)}${unit}`;

function timestamp(seconds: number) {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "—" : dates.format(date);
}

function memory(bytes: number | null) {
  if (bytes == null) return "—";
  const unit = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let index = 0;
  while (bytes >= 1024 && index < unit.length - 1) {
    bytes /= 1024;
    index += 1;
  }
  return `${numbers.format(bytes)} ${unit[index]}`;
}

export function RedisServerMonitor({ id, selectedDatabase, target, onClose, onFailure, onPersistence }: {
  id: string;
  selectedDatabase: number;
  target: string;
  onClose: () => void;
  onFailure: (message: string) => boolean;
  onPersistence: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const args = useMemo(() => ({ id }), [id]);
  const { data, error, loading } = useNativeRead<Snapshot>("redis_server_snapshot", args, revision, true);
  useEffect(() => { if (error) onFailure(error); }, [error, onFailure]);

  return <Dialog title="Redis 서버 모니터" onClose={onClose} busy={false} className="redis-monitor">
    <div className="redis-monitor-body" aria-busy={loading}>
      <div className="redis-monitor-toolbar">
        <p>{target}{data && <> · <span>조회 {timestamp(data.sampled_at_seconds)}</span></>}</p>
        <button type="button" className="secondary small" onClick={onPersistence}>백업 관리</button>
        <button type="button" className="secondary small" disabled={loading} onClick={() => setRevision(value => value + 1)}>
          <RefreshCw size={14} aria-hidden /> 새로 고침</button>
      </div>
      {loading && <p className="result-empty" role="status">서버 상태를 읽는 중…</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {data && <>
        <section className="results-card" aria-label="서버 리소스">
          <div className="panel-heading"><h3>서버 리소스</h3></div>
          <dl className="redis-key-meta">
            <div><dt>사용 메모리</dt><dd>{memory(data.used_memory)}</dd></div>
            <div><dt>최고 사용량</dt><dd>{memory(data.peak_memory)}</dd></div>
            <div><dt>메모리 한도</dt><dd>{data.max_memory === 0 ? "제한 없음" : memory(data.max_memory)}</dd></div>
            <div><dt>연결 클라이언트</dt><dd>{count(data.connected_clients)}</dd></div>
            <div><dt>차단 클라이언트</dt><dd>{count(data.blocked_clients)}</dd></div>
            <div><dt>초당 작업</dt><dd>{count(data.operations_per_second)}</dd></div>
            <div><dt>복제 역할</dt><dd>{data.role === "primary" ? "원본" : data.role === "replica" ? "복제본" : "—"}</dd></div>
            <div><dt>연결 복제본</dt><dd>{count(data.connected_replicas)}</dd></div>
            {data.role === "replica" && <div><dt>원본 연결</dt><dd>{data.upstream_link == null ? "—" : data.upstream_link ? "연결됨" : "끊김"}</dd></div>}
          </dl>
        </section>
        <section className="results-card" aria-label="DB별 키 통계">
          <div className="panel-heading"><h3>DB별 키 통계</h3></div>
          {data.keyspace.length ? <div className="redis-values" tabIndex={0} role="region" aria-label="DB별 키 통계 목록">
            <table><thead><tr><th scope="col">DB</th><th scope="col">전체 키</th><th scope="col">만료 설정</th><th scope="col">평균 TTL</th></tr></thead>
              <tbody>{data.keyspace.map(item => <tr key={item.database}>
                <th scope="row">{item.database}{item.database === selectedDatabase && <small>현재 DB</small>}</th>
                <td>{count(item.keys)}</td><td>{count(item.expiring)}</td><td>{count(item.average_ttl_ms, " ms")}</td>
              </tr>)}</tbody>
            </table>
          </div> : <p className="result-empty">서버가 보고한 DB별 키 통계가 없습니다.</p>}
          {data.more_databases && <p className="form-note">서버가 반환한 DB 중 256개를 표시합니다.</p>}
        </section>
        <section className="results-card" aria-label="슬로로그">
          <div className="panel-heading"><h3>슬로로그</h3><span>최근 최대 20건</span></div>
          {data.slow_log.status === "unavailable" ? <p className="result-empty">{data.slow_log.reason}</p> :
            data.slow_log.entries.length ? <div className="redis-values" tabIndex={0} role="region" aria-label="슬로로그 목록">
              <table><thead><tr><th scope="col">ID</th><th scope="col">실행 시각</th><th scope="col">명령</th><th scope="col">소요 시간</th></tr></thead>
                <tbody>{data.slow_log.entries.map(entry => <tr key={entry.id}>
                  <th scope="row">{entry.id}</th><td>{timestamp(entry.occurred_at_seconds)}</td>
                  <td><code>{entry.command ?? "—"}</code></td><td>{count(entry.duration_us, " µs")}</td>
                </tr>)}</tbody>
              </table>
            </div> : <p className="result-empty">서버에 기록된 느린 명령이 없습니다.</p>}
        </section>
      </>}
    </div>
  </Dialog>;
}
