import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity } from "lucide-react";
import { WebDiagnosticResult, type WebDiagnostic } from "./WebDiagnosticResult";

type TcpStatus = "connected" | "refused" | "unreachable" | "timed_out" | "failed" | "not_tested";
export type NetworkDiagnostics = { host: string; port: number; dns: { status: "literal" | "resolved" | "failed" | "timed_out" | "busy"; elapsed_ms: number }; tcp: { status: TcpStatus; elapsed_ms: number }; addresses: string[]; attempts: { address: string; status: Exclude<TcpStatus, "not_tested">; elapsed_ms: number }[]; connected_address: string | null };
type RouteDiagnostic = { target: string; timed_out: boolean; exit_code: number | null; elapsed_ms: number; output: string; errors: string; truncated: boolean };
type Tool = "tcp" | "ping" | "trace" | "web";

export function NetworkDiagnosticResult({ result, ssh = false }: { result: NetworkDiagnostics; ssh?: boolean }) {
  const dnsLabels = { literal: "IP 주소 · DNS 조회 불필요", resolved: "이름 조회 성공", failed: "이름 조회 실패", timed_out: "이름 조회 시간 초과", busy: "이전 DNS 조회가 아직 진행 중" };
  const tcpLabels = { connected: "TCP 연결 성공", refused: "TCP 연결 거부", unreachable: "네트워크에 도달할 수 없음", timed_out: "TCP 연결 시간 초과 또는 일부 주소 응답 없음", failed: "TCP 연결 실패", not_tested: "TCP 연결 미검사" };
  const attemptLabels = { connected: "연결 성공", refused: "연결 거부", unreachable: "도달할 수 없음", timed_out: "연결 시간 초과", failed: "연결 실패" };
  return <section className="ssh-diagnostic-result" aria-label="연결 진단 결과" role="status">
    <strong>{result.host.includes(":") ? `[${result.host}]` : result.host}:{result.port} 진단</strong>
    <dl><dt>DNS</dt><dd>{dnsLabels[result.dns.status]} · {result.dns.elapsed_ms} ms</dd><dt>TCP</dt><dd>{result.attempts.length > 1 && result.tcp.status !== "connected" ? "TCP 연결 실패 또는 응답 없음" : tcpLabels[result.tcp.status]}{result.tcp.status !== "not_tested" && ` · ${result.tcp.elapsed_ms} ms`}</dd></dl>
    {result.addresses.length > 0 && <p>대상 주소: {result.addresses.join(", ")}{result.connected_address && ` · 연결된 주소: ${result.connected_address}`}</p>}
    {result.attempts.length > 1 && <ul>{result.attempts.map(attempt => <li key={attempt.address}>{attempt.address} · {attemptLabels[attempt.status]} · {attempt.elapsed_ms} ms</li>)}</ul>}
    <p>{ssh ? "SSH 호스트 키, 인증 및 서버 권한은 검사하지 않았습니다." : "TCP 연결을 검사하며 애플리케이션 데이터를 전송하지 않습니다."}</p>
  </section>;
}

export function NetworkDiagnosticsPanel() {
  const [tool, setTool] = useState<Tool>("tcp");
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("443");
  const [family, setFamily] = useState("auto");
  const [address, setAddress] = useState("");
  const [method, setMethod] = useState("HEAD");
  const [samples, setSamples] = useState("1");
  const [tcp, setTcp] = useState<NetworkDiagnostics | null>(null);
  const [route, setRoute] = useState<RouteDiagnostic | null>(null);
  const [web, setWeb] = useState<WebDiagnostic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function diagnose() {
    if (busy) return;
    setBusy(true); setTcp(null); setRoute(null); setWeb(null); setError("");
    try {
      if (tool === "tcp") {
        setTcp(await invoke<NetworkDiagnostics>("diagnose_ssh_network", { host: target, port: Number(port) }));
      } else if (tool === "web") {
        setWeb(await invoke<WebDiagnostic>("run_web_diagnostic", { address, method, samples: Number(samples) }));
      } else {
        setRoute(await invoke<RouteDiagnostic>("run_route_diagnostic", { target, tool, family }));
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="network-diagnostics" aria-label="연결 진단 도구">
    <div className="terminal-heading"><div><h1><Activity size={20} /> 연결 진단</h1></div></div>
    <form className="results-card network-diagnostic-form" onSubmit={event => { event.preventDefault(); void diagnose(); }}>
      <fieldset className="network-filters" disabled={busy}>
        <label>진단 유형<select value={tool} onChange={event => {
          setTool(event.target.value as Tool); setTcp(null); setRoute(null); setWeb(null); setError("");
        }}><option value="tcp">DNS·TCP</option><option value="ping">Ping</option><option value="trace">경로 추적</option><option value="web">HTTP/HTTPS</option></select></label>
        {tool === "web" ? <>
          <label className="web-target">대상 URL<input required type="url" maxLength={4096} value={address} onChange={event => setAddress(event.target.value)} placeholder="https://example.com/health" autoComplete="off" spellCheck={false} /></label>
          <label>요청 메서드<select value={method} onChange={event => setMethod(event.target.value)}><option>HEAD</option><option>GET</option></select></label>
          <label>요청 횟수<select value={samples} onChange={event => setSamples(event.target.value)}>{[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count}회</option>)}</select></label>
        </> : <>
          <label>대상 호스트 또는 IP<input required value={target} onChange={event => setTarget(event.target.value)} autoComplete="off" /></label>
          {tool === "tcp"
            ? <label>대상 포트<input required type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label>
            : <label>진단 IP 버전<select value={family} onChange={event => setFamily(event.target.value)}><option value="auto">자동</option><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option></select></label>}
        </>}
        <button type="submit" className="primary small" disabled={busy}>{busy ? "진단 중…" : "진단 실행"}</button>
      </fieldset>
    </form>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {tcp && <NetworkDiagnosticResult result={tcp} />}
    {web && <WebDiagnosticResult diagnostic={web} />}
    {route && <section className="results-card route-result" aria-label="경로 진단 결과" role="status">
      <div className="panel-heading"><div><strong>{route.target}</strong><span>{route.timed_out ? "시간 초과" : `종료 코드 ${route.exit_code ?? "확인 불가"}`} · {route.elapsed_ms} ms</span></div></div>
      {route.output && <pre>{route.output}</pre>}
      {route.errors && <pre>{route.errors}</pre>}
      {route.truncated && <p className="form-note">긴 출력의 앞부분을 표시합니다.</p>}
    </section>}
  </section>;
}
