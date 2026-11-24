import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, ArrowLeft, ArrowRight, Network, RefreshCw, Route } from "lucide-react";
import { NetworkDiagnosticsPanel } from "./NetworkDiagnosticsPanel";
import { SshTunnelPanel } from "./SshTunnelPanel";
import type { SshProfile } from "./ssh-profile-types";

type Endpoint = { address: string; port: number };
type LocalPort = {
  transport: "TCP" | "UDP";
  family: "IPv4" | "IPv6";
  state: string;
  local: Endpoint;
  remote: Endpoint | null;
  pid: number;
  process: string | null;
};
type Snapshot = { ports: LocalPort[]; unavailable: string[] };
const pageSize = 100;

function address(endpoint: Endpoint) {
  const host = endpoint.address;
  return host.includes(":") ? `[${host}]:${endpoint.port}` : `${host}:${endpoint.port}`;
}

export function NetworkWorkspace({ projectId, profiles, visible, onTunnelCountChange }: {
  projectId: string; profiles: SshProfile[]; visible: boolean; onTunnelCountChange: (count: number) => void;
}) {
  const [mode, setMode] = useState<"ports" | "diagnostics" | "tunnels">("ports");
  const [tunnelsVisited, setTunnelsVisited] = useState(false);
  return <section className="network-workspace" aria-label="네트워크 도구">
    <header className="network-heading">
      <h1><Network size={20} aria-hidden /> 네트워크</h1>
      <nav className="network-navigation" aria-label="네트워크 화면">
        <button type="button" className="secondary small" aria-pressed={mode === "ports"} aria-controls="network-ports"
          onClick={() => setMode("ports")}><Network size={14} aria-hidden /> 로컬 포트</button>
        <button type="button" className="secondary small" aria-pressed={mode === "diagnostics"} aria-controls="network-diagnostics"
          onClick={() => setMode("diagnostics")}><Activity size={14} aria-hidden /> 연결 진단</button>
        <button type="button" className="secondary small" aria-pressed={mode === "tunnels"} aria-controls="network-tunnels"
          onClick={() => { setMode("tunnels"); setTunnelsVisited(true); }}><Route size={14} aria-hidden /> SSH 터널</button>
      </nav>
    </header>
    <div id="network-ports" hidden={mode !== "ports"}><LocalPorts /></div>
    <div id="network-diagnostics" hidden={mode !== "diagnostics"}><NetworkDiagnosticsPanel /></div>
    <div id="network-tunnels" hidden={mode !== "tunnels"}>{tunnelsVisited && <SshTunnelPanel projectId={projectId}
      profiles={profiles.filter(profile => profile.project_id === projectId)} visible={visible && mode === "tunnels"} onCountChange={onTunnelCountChange} />}</div>
  </section>;
}

function LocalPorts() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [transport, setTransport] = useState("");
  const [family, setFamily] = useState("");
  const [state, setState] = useState("");
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);

  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      const result = await invoke<Snapshot>("list_local_ports");
      if (request !== generation.current) return;
      setSnapshot(result); setPage(0);
    } catch (error) {
      if (request === generation.current) setError(String(error));
    } finally {
      if (request === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    void refresh();
    return () => { generation.current++; pending.current = false; };
  }, []);

  const needle = query.trim().toLocaleLowerCase();
  const states = [...new Set([state, ...(snapshot?.ports ?? []).map(port => port.state)])].filter(Boolean).sort();
  const rows = (snapshot?.ports ?? []).filter(port => {
    if ((transport && port.transport !== transport) || (family && port.family !== family) || (state && port.state !== state)) return false;
    if (!needle) return true;
    return [address(port.local), port.remote ? address(port.remote) : "", port.pid.toString(), port.process ?? ""]
      .some(value => value.toLocaleLowerCase().includes(needle));
  });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

  return <section aria-label="Windows 로컬 포트">
    <div className="network-panel-heading">
      <h2>로컬 포트</h2>
      <button type="button" className="secondary small" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} aria-hidden /> 포트 새로고침</button>
    </div>
    {error && <p className="error-banner" role="alert">{error}{snapshot && " 마지막으로 성공한 결과를 표시합니다."}</p>}
    {snapshot?.unavailable.length ? <p className="query-notice" role="status">일부 목록을 읽을 수 없습니다. {snapshot.unavailable.join(" · ")}</p> : null}
    <div className="results-card network-card" aria-busy={busy}>
      <div className="network-filters">
        <label>주소·포트·PID·프로세스 찾기<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
        <label>전송 프로토콜<select value={transport} onChange={event => { setTransport(event.target.value); setPage(0); }}>
          <option value="">모두</option><option>TCP</option><option>UDP</option>
        </select></label>
        <label>IP 버전<select value={family} onChange={event => { setFamily(event.target.value); setPage(0); }}>
          <option value="">모두</option><option>IPv4</option><option>IPv6</option>
        </select></label>
        <label>연결 상태<select value={state} onChange={event => { setState(event.target.value); setPage(0); }}>
          <option value="">모두</option>{states.map(state => <option key={state}>{state}</option>)}
        </select></label>
      </div>
      {snapshot ? <>
        <div className="table-wrap"><table aria-label="로컬 포트 목록">
          <thead><tr>{["프로토콜", "로컬 주소", "원격 주소", "상태", "PID", "프로세스"].map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
          <tbody>{rows.slice(page * pageSize, (page + 1) * pageSize).map((port, index) => <tr key={index}>
            <td>{port.transport} {port.family}</td><td><code>{address(port.local)}</code></td>
            <td><code>{port.remote ? address(port.remote) : "—"}</code></td><td>{port.state}</td>
            <td>{port.pid || "—"}</td><td>{port.process ?? "확인 불가"}</td>
          </tr>)}</tbody>
        </table></div>
        {!rows.length && <p className="result-empty">표시할 포트가 없습니다.</p>}
        <div className="pagination">
          <span>{rows.length.toLocaleString("ko-KR")}개 항목 · 페이지 {page + 1}/{pageCount}</span>
          <div>
            <button className="icon-button" disabled={!page} aria-label="이전 포트 페이지" onClick={() => setPage(page - 1)}><ArrowLeft size={16} /></button>
            <button className="icon-button" disabled={page + 1 >= pageCount} aria-label="다음 포트 페이지" onClick={() => setPage(page + 1)}><ArrowRight size={16} /></button>
          </div>
        </div>
      </> : <p className="result-empty" role="status">{busy ? "로컬 포트를 읽는 중…" : "조회 결과가 없습니다."}</p>}
    </div>
  </section>;
}
