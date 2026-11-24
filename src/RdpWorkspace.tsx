import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Monitor, Plug } from "lucide-react";

type Display = "window" | "fullscreen" | "multiple_monitors";
type Availability = { available: boolean; reason: string | null };
type Client = { id: string; address: string; display: Display; process_id: number; admin: boolean };
const displayNames = { window: "창", fullscreen: "전체 화면", multiple_monitors: "다중 모니터" };

export function RdpWorkspace({ desktop, onCountChange }: { desktop: boolean; onCountChange: (count: number) => void }) {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("3389");
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [display, setDisplay] = useState<Display>("window");
  const [width, setWidth] = useState("1280");
  const [height, setHeight] = useState("800");
  const [depth, setDepth] = useState("32");
  const [admin, setAdmin] = useState(false);
  const [clipboard, setClipboard] = useState(false);
  const [printers, setPrinters] = useState(false);
  const [smartCards, setSmartCards] = useState(false);
  const [drives, setDrives] = useState("");
  const [keyboard, setKeyboard] = useState("fullscreen");
  const [resize, setResize] = useState(true);
  const [reconnect, setReconnect] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const snapshot = useRef(0);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    invoke<Availability>("rdp_availability").then(result => {
      if (live) setAvailability(result);
    }).catch(error => {
      if (live) setAvailability({ available: false, reason: String(error) });
    });
    return () => { live = false; };
  }, [desktop]);

  useEffect(() => { onCountChange(clients.length); }, [clients.length, onCountChange]);
  useEffect(() => {
    if (!availability?.available) return;
    let live = true;
    let checking = false;
    async function refresh() {
      if (active.current || checking) return;
      const version = snapshot.current;
      checking = true;
      try {
        const next = await invoke<Client[]>("list_rdp_clients");
        if (live && version === snapshot.current) setClients(next);
      } catch (error) {
        if (live && version === snapshot.current) setError(String(error));
      } finally {
        checking = false;
      }
    }
    void refresh();
    if (!clients.length) return () => { live = false; };
    const interval = window.setInterval(() => void refresh(), 1500);
    return () => { live = false; window.clearInterval(interval); };
  }, [availability?.available, clients.length]);

  async function open(event: FormEvent) {
    event.preventDefault();
    if (active.current || !availability?.available) return;
    active.current = true;
    snapshot.current++;
    setBusy(true);
    setError("");
    try {
      const client = await invoke<Client>("open_rdp", { request: {
        host, port: Number(port), username, domain,
        display: display === "window" ? { mode: display, width: Number(width), height: Number(height) } : { mode: display },
        color_depth: Number(depth), admin, clipboard, printers, smart_cards: smartCards, drives,
        keyboard, dynamic_resolution: resize, reconnect,
      } });
      setClients(current => [...current, client]);
    } catch (error) {
      setError(String(error));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function disconnect(id: string) {
    if (active.current) return;
    active.current = true;
    snapshot.current++;
    setBusy(true);
    setError("");
    try {
      await invoke("disconnect_rdp", { id });
      setClients(current => current.filter(client => client.id !== id));
    } catch (error) {
      setError(String(error));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  return <section className="network-workspace rdp-workspace" aria-label="원격 화면 도구">
    <div className="terminal-heading"><div><h1><Monitor size={20} /> 원격 데스크톱 (RDP)</h1></div></div>
    <p className="terminal-hint">인증과 원격 화면은 Windows 원격 데스크톱 창에서 열립니다.</p>
    {!desktop && <p className="error-banner" role="status">직접 RDP 연결에는 Windows 앱이 필요합니다.</p>}
    {desktop && !availability && <p className="form-note" role="status">Windows 원격 데스크톱을 확인하는 중…</p>}
    {availability?.reason && <p className="error-banner" role="status">{availability.reason}</p>}

    <div className="rdp-layout">
      <form className="results-card rdp-form" onSubmit={event => void open(event)}>
        <fieldset disabled={!availability?.available || busy}>
          <legend className="sr-only">RDP 연결 설정</legend>
          <div className="rdp-endpoint rdp-fields">
            <label className="field">대상 호스트 또는 IP<input required maxLength={255} value={host} autoComplete="off" onChange={event => setHost(event.target.value)} /></label>
            <label className="field">포트<input required type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} /></label>
          </div>
          <div className="rdp-fields">
            <label className="field">사용자 이름 (선택)<input maxLength={256} value={username} autoComplete="off" onChange={event => setUsername(event.target.value)} /></label>
            <label className="field">도메인 (선택)<input maxLength={256} value={domain} autoComplete="off" onChange={event => setDomain(event.target.value)} /></label>
          </div>
          <details className="rdp-options" onInvalid={event => { event.currentTarget.open = true; }}>
            <summary>화면 설정 <span>{displayNames[display]}</span></summary>
            <div className="rdp-options-body">
              <div className="rdp-fields">
                <label className="field">화면 모드<select value={display} onChange={event => setDisplay(event.target.value as Display)}>
                  <option value="window">창</option><option value="fullscreen">전체 화면</option><option value="multiple_monitors">다중 모니터</option>
                </select></label>
                <label className="field">색 깊이<select value={depth} onChange={event => setDepth(event.target.value)}>
                  <option value="16">16비트</option><option value="24">24비트</option><option value="32">32비트</option>
                </select></label>
              </div>
              {display === "window" && <div className="rdp-fields">
                <label className="field">가로 (픽셀)<input required type="number" min={200} max={8192} value={width} onChange={event => setWidth(event.target.value)} /></label>
                <label className="field">세로 (픽셀)<input required type="number" min={200} max={8192} value={height} onChange={event => setHeight(event.target.value)} /></label>
              </div>}
            </div>
          </details>
          <details className="rdp-options">
            <summary>인증·리디렉션·입력 설정</summary>
            <div className="rdp-options-grid">
              <label><input type="checkbox" checked={admin} onChange={event => setAdmin(event.target.checked)} /> 관리 콘솔 세션</label>
              <label><input type="checkbox" checked={reconnect} onChange={event => setReconnect(event.target.checked)} /> 자동 재연결</label>
              {display === "window" && <label><input type="checkbox" checked={resize} onChange={event => setResize(event.target.checked)} /> 창 크기에 맞춰 해상도 조정</label>}
              <label><input type="checkbox" checked={clipboard} onChange={event => setClipboard(event.target.checked)} /> 클립보드 공유</label>
              <label><input type="checkbox" checked={printers} onChange={event => setPrinters(event.target.checked)} /> 프린터 공유</label>
              <label><input type="checkbox" checked={smartCards} onChange={event => setSmartCards(event.target.checked)} /> 스마트카드 공유</label>
            </div>
            <div className="rdp-fields">
              <label className="field">공유할 드라이브<input value={drives} maxLength={104} placeholder="C:, D:" onChange={event => setDrives(event.target.value)} /></label>
              <label className="field">Windows 단축키 적용<select value={keyboard} onChange={event => setKeyboard(event.target.value)}>
                <option value="local">항상 로컬</option><option value="remote">항상 원격</option><option value="fullscreen">전체 화면에서 원격</option>
              </select></label>
            </div>
          </details>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="rdp-actions"><button type="submit" className="primary"><Plug size={15} /> {busy ? "처리 중…" : "Windows RDP 열기"}</button></div>
        </fieldset>
      </form>

      <section className="results-card rdp-clients" aria-label="열린 RDP 클라이언트">
        <div className="panel-heading"><div><Monitor size={15} aria-hidden /><strong>열린 RDP 클라이언트</strong><span>{clients.length}개</span></div></div>
        {clients.length ? <ul>{clients.map(client => <li key={client.id}>
          <div><strong>{client.address}</strong><span>{displayNames[client.display]}{client.admin && " · 관리 콘솔"} · PID {client.process_id}</span></div>
          <button type="button" className="secondary small" disabled={busy} onClick={() => void disconnect(client.id)} aria-label={`${client.address} 연결 끊기`}>연결 끊기</button>
        </li>)}</ul> : <p className="rdp-no-clients">열린 원격 데스크톱 창이 없습니다.</p>}
      </section>
    </div>
  </section>;
}
