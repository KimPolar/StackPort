import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plus, TerminalSquare, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

type Shell = "powershell" | "cmd" | "ssh";
type TerminalInfo = { id: string; shell: Shell; process_id: number | null; target: string | null };
type TerminalExit = { code: number | null; error: string | null };
type TerminalRead = { data: number[]; exit: TerminalExit | null; output_closed: boolean; output_error: string | null };
type Tab = TerminalInfo & { number: number; exit: TerminalExit | null };
type SshKey = { algorithm: string; fingerprint: string };
type SshHost = { status: "trusted" | "unknown" | "replacement"; host: string; port: number; token: string | null; keys: SshKey[]; previous: SshKey | null };

const call = <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args);
const errorText = (error: unknown) => typeof error === "string" ? error : String(error);
const shellName = (shell: Shell) => shell === "powershell" ? "PowerShell" : shell === "cmd" ? "CMD" : "SSH";
const tabName = (tab: Tab) => `${shellName(tab.shell)} ${tab.number}${tab.target ? ` · ${tab.target}` : ""}`;

export function TerminalWorkspace({ visible, onCountChange }: { visible: boolean; onCountChange: (count: number) => void }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [shell, setShell] = useState<Shell>("powershell");
  const [opening, setOpening] = useState(false);
  const [sshDialog, setSshDialog] = useState(false);
  const [sshOpening, setSshOpening] = useState(false);
  const [closing, setClosing] = useState<string[]>([]);
  const [error, setError] = useState("");
  const tabsRef = useRef(tabs);
  const closingRef = useRef(new Set<string>());
  const openingRef = useRef(false);
  const nextNumber = useRef(1);
  tabsRef.current = tabs;

  useEffect(() => { onCountChange(tabs.length + (opening ? 1 : 0) + (sshOpening ? 1 : 0)); }, [tabs.length, opening, sshOpening, onCountChange]);

  function addTerminal(terminal: TerminalInfo) {
    const number = nextNumber.current++;
    setTabs(current => [...current, { ...terminal, number, exit: null }]);
    setActiveId(terminal.id);
  }

  async function openTerminal() {
    if (shell === "ssh") { setSshDialog(true); return; }
    if (openingRef.current) return;
    openingRef.current = true; setOpening(true); setError("");
    try {
      const terminal = await call<TerminalInfo>("open_terminal", { shell, rows: 24, cols: 80 });
      addTerminal(terminal);
    } catch (e) { setError(errorText(e)); }
    finally { openingRef.current = false; setOpening(false); }
  }

  async function closeTerminal(tab: Tab) {
    if (closingRef.current.has(tab.id)) return;
    const warning = tab.exit ? `${tabName(tab)} 셸은 종료되었습니다. 남아 있는 연결된 프로세스가 종료될 수 있습니다. 닫으시겠습니까?`
      : `${tabName(tab)} 터미널을 닫으면 실행 중인 작업과 연결된 하위 프로세스가 종료됩니다. 닫으시겠습니까?`;
    if (!window.confirm(warning)) return;
    closingRef.current.add(tab.id);
    setClosing(current => [...current, tab.id]); setError("");
    try {
      await call("close_terminal", { id: tab.id });
      const remaining = tabsRef.current.filter(item => item.id !== tab.id);
      setTabs(current => current.filter(item => item.id !== tab.id));
      setActiveId(current => current === tab.id ? remaining.at(-1)?.id ?? "" : current);
    } catch (e) { setError(errorText(e)); }
    finally { closingRef.current.delete(tab.id); setClosing(current => current.filter(id => id !== tab.id)); }
  }

  function reportExit(id: string, exit: TerminalExit) {
    setTabs(current => current.map(tab => tab.id === id ? { ...tab, exit } : tab));
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const destination = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (destination < 0) return;
    event.preventDefault();
    const next = tabs[destination].id;
    setActiveId(next);
    requestAnimationFrame(() => document.getElementById(`terminal-tab-${next}`)?.focus());
  }

  return <section className="terminal-workspace" aria-label="터미널">
    <div className="terminal-heading">
      <div><h1><TerminalSquare size={20} /> 터미널</h1><p>로컬 PowerShell·CMD와 호스트 키를 확인한 SSH 세션을 엽니다.</p></div>
      <div className="terminal-actions"><label htmlFor="terminal-shell">셸</label><select id="terminal-shell" value={shell} onChange={event => setShell(event.target.value as Shell)} disabled={opening}><option value="powershell">PowerShell</option><option value="cmd">CMD</option><option value="ssh">SSH</option></select><button className="primary" disabled={opening} onClick={() => void openTerminal()}><Plus size={15} /> {opening ? "여는 중…" : shell === "ssh" ? "SSH 연결" : "새 터미널"}</button></div>
    </div>
    <p className="terminal-hint">StackPort는 터미널 입력과 출력을 저장하지 않습니다. 셸이나 실행한 프로그램의 기록 설정은 별도로 적용됩니다.</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {tabs.length === 0 ? <div className="terminal-empty"><TerminalSquare size={30} /><strong>열린 터미널이 없습니다</strong><span>셸을 선택하고 새 터미널을 여세요.</span></div> : <div className="terminal-card">
      <div className="terminal-tabs" role="tablist" aria-label="터미널 목록">{tabs.map((tab, index) => <div className={`terminal-tab ${tab.id === activeId ? "selected" : ""}`} key={tab.id}>
        <button role="tab" id={`terminal-tab-${tab.id}`} aria-selected={tab.id === activeId} aria-controls={`terminal-panel-${tab.id}`} tabIndex={tab.id === activeId ? 0 : -1} onKeyDown={event => moveTab(event, index)} onClick={() => setActiveId(tab.id)}><TerminalSquare size={14} /><span>{tabName(tab)}</span>{tab.exit && <small>종료</small>}</button>
        <button className="terminal-close" aria-label={`${tabName(tab)} 터미널 닫기`} disabled={closing.includes(tab.id)} onClick={() => void closeTerminal(tab)}><X size={14} /></button>
      </div>)}</div>
      {tabs.map(tab => <TerminalPane key={tab.id} tab={tab} visible={visible && tab.id === activeId} onExit={reportExit} />)}
    </div>}
    {sshDialog && <SshDialog onClose={() => setSshDialog(false)} onOpeningChange={setSshOpening} onOpened={terminal => { addTerminal(terminal); setSshDialog(false); }} />}
  </section>;
}

function TerminalPane({ tab, visible, onExit }: { tab: Tab; visible: boolean; onExit: (id: string, exit: TerminalExit) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  const exitCallback = useRef(onExit);
  const [error, setError] = useState("");
  visibleRef.current = visible;
  exitCallback.current = onExit;

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => { fit.current?.(); });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    let stopped = false;
    let dispose = () => {};
    // StrictMode may mount and immediately unmount an effect in development.
    // Starting after that cleanup prevents two readers consuming one stream.
    queueMicrotask(() => {
      const host = container.current;
      if (stopped || !host) return;
      const emulator = new Terminal({
        cursorBlink: false, fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 14,
        scrollback: 10000,
        theme: { background: "#172523", foreground: "#e4f1e9", cursor: "#a4e5c7", selectionBackground: "#477763" },
      });
      const addon = new FitAddon();
      emulator.loadAddon(addon);
      emulator.open(host);
      host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.setAttribute("aria-label", "터미널 입력");
      terminal.current = emulator;
      let inputQueue = Promise.resolve();
      let resizeQueue = Promise.resolve();
      let reportedExit = false;
      const encoder = new TextEncoder();
      const input = emulator.onData(value => {
        if (reportedExit) return;
        const data = encoder.encode(value);
        inputQueue = inputQueue.then(async () => {
          for (let start = 0; start < data.length && !stopped; start += 16384) {
            await call("write_terminal", { id: tab.id, data: Array.from(data.subarray(start, start + 16384)) });
          }
        }).catch(e => { if (!stopped) setError(`입력을 보내지 못했습니다: ${errorText(e)}`); });
      });
      const resized = emulator.onResize(({ rows, cols }) => {
        resizeQueue = resizeQueue.then(async () => {
          if (!stopped) await call("resize_terminal", { id: tab.id, rows, cols });
        }).catch(e => { if (!stopped) setError(`크기를 변경하지 못했습니다: ${errorText(e)}`); });
      });
      const fitNow = () => {
        if (visibleRef.current && host.clientWidth > 0 && host.clientHeight > 0) addon.fit();
      };
      fit.current = fitNow;
      const observer = new ResizeObserver(fitNow);
      observer.observe(host);
      const onPaste = (event: ClipboardEvent) => {
        const value = event.clipboardData?.getData("text/plain") ?? "";
        const target = tab.target ? `원격 ${tab.target}` : "터미널";
        if (/[\r\n]/.test(value) && !window.confirm(`여러 줄을 ${target}에 붙여넣으면 명령이 실행될 수 있습니다. 계속하시겠습니까?`)) {
          event.preventDefault(); event.stopImmediatePropagation();
        }
      };
      host.addEventListener("paste", onPaste, true);
      fitNow();
      if (visibleRef.current) emulator.focus();

      void (async () => {
        try {
          while (!stopped) {
            const output = await call<TerminalRead>("read_terminal", { id: tab.id });
            if (stopped) break;
            if (output.data.length) await new Promise<void>(resolve => emulator.write(new Uint8Array(output.data), resolve));
            if (output.exit && !reportedExit) { reportedExit = true; emulator.options.disableStdin = true; exitCallback.current(tab.id, output.exit); }
            if (output.output_error) { setError(output.output_error); break; }
            if (output.output_closed && output.exit) break;
            if (output.output_closed) await new Promise(resolve => setTimeout(resolve, 250));
          }
        } catch (e) { if (!stopped) setError(`출력을 읽지 못했습니다: ${errorText(e)}`); }
      })();

      dispose = () => {
        host.removeEventListener("paste", onPaste, true);
        observer.disconnect(); input.dispose(); resized.dispose(); emulator.dispose();
        fit.current = null; terminal.current = null;
      };
    });
    return () => { stopped = true; dispose(); };
  }, [tab.id]);

  return <div role="tabpanel" id={`terminal-panel-${tab.id}`} aria-labelledby={`terminal-tab-${tab.id}`} className="terminal-panel" hidden={!visible}>
    {tab.target && <div className="terminal-remote"><strong>SSH · {tab.target}</strong><span>이 터미널의 명령은 원격 서버에서 실행됩니다.</span></div>}
    {tab.exit && <div className="terminal-exit" role="status">{tab.exit.error ?? `셸이 종료되었습니다. 종료 코드: ${tab.exit.code ?? "확인 불가"}`}</div>}
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <div className="terminal-screen" ref={container} aria-label={`${tabName(tab)} 터미널 화면`} />
  </div>;
}

function SshDialog({ onClose, onOpened, onOpeningChange }: { onClose: () => void; onOpened: (terminal: TerminalInfo) => void; onOpeningChange: (opening: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [info, setInfo] = useState<SshHost | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"" | "inspect" | "trust" | "open">("");
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy("inspect"); setError("");
    try {
      const result = await call<SshHost>("inspect_ssh_host", { host, port: Number(port) });
      setInfo(result); setFingerprint(""); setConfirmation("");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(""); }
  }

  async function trust() {
    if (!info?.token || !fingerprint || busy) return;
    setBusy("trust"); setError("");
    try { setInfo(await call<SshHost>("trust_ssh_host", { token: info.token, fingerprint, confirmation })); }
    catch (e) { setInfo(null); setError(`${errorText(e)} 다시 지문을 확인하세요.`); }
    finally { setBusy(""); }
  }

  async function reinspect() {
    if (!info || info.status !== "trusted" || busy) return;
    setBusy("inspect"); setError("");
    try {
      setInfo(await call<SshHost>("reinspect_ssh_host", { host: info.host, port: info.port }));
      setFingerprint(""); setConfirmation("");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(""); }
  }

  async function connect() {
    if (!info || info.status !== "trusted" || busy) return;
    setBusy("open"); onOpeningChange(true); setError("");
    try {
      const terminal = await call<TerminalInfo>("open_ssh_terminal", { host: info.host, port: info.port, username, rows: 24, cols: 80 });
      onOpened(terminal);
    } catch (e) { setError(errorText(e)); }
    finally { onOpeningChange(false); setBusy(""); }
  }

  return <dialog ref={dialog} className="dialog ssh-dialog" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2>SSH 연결</h2><button className="icon-button" aria-label="닫기" disabled={Boolean(busy)} onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={inspect} aria-busy={Boolean(busy)}>
      <label className="field">호스트 또는 IP<input autoFocus required disabled={Boolean(info) || Boolean(busy)} value={host} onChange={event => setHost(event.target.value)} placeholder="예: server.example.com" /></label>
      <label className="field">포트<input required type="number" min="1" max="65535" step="1" disabled={Boolean(info) || Boolean(busy)} value={port} onChange={event => setPort(event.target.value)} /></label>
      <label className="field">사용자 이름<input required pattern="[A-Za-z0-9_][A-Za-z0-9._-]*" disabled={Boolean(info) || Boolean(busy)} value={username} onChange={event => setUsername(event.target.value)} placeholder="SSH 사용자" /></label>
      {!info && <p className="form-note">먼저 서버의 호스트 키 지문을 확인합니다. 암호는 연결 후 터미널에 직접 입력하며 StackPort에 저장되지 않습니다.</p>}
      {info && <div className="ssh-verification">
        <strong>{info.host.includes(":") ? `[${info.host}]` : info.host}:{info.port} · {info.status === "trusted" ? "저장된 호스트 키" : info.status === "replacement" ? "호스트 키 재확인" : "확인이 필요한 호스트 키"}</strong>
        {info.status !== "trusted" ? <>{info.previous && <div className="ssh-previous"><span>기존에 신뢰한 지문</span><code>{info.previous.fingerprint}</code></div>}<p>이 지문은 서버가 제공한 값입니다. 서버 관리자에게 받은 지문과 별도의 경로로 비교한 후 신뢰할 키를 선택하세요.{info.previous && " 교체 후 새 연결에서는 기존 키가 차단되며, 이미 열린 세션은 유지됩니다."}</p><fieldset><legend>서버 지문 선택</legend>{info.keys.map(key => <label className="ssh-key" key={key.fingerprint}><input type="radio" name="ssh-key" value={key.fingerprint} disabled={Boolean(busy) || key.fingerprint === info.previous?.fingerprint} checked={fingerprint === key.fingerprint} onChange={() => setFingerprint(key.fingerprint)} /><span><strong>{key.algorithm}{key.fingerprint === info.previous?.fingerprint ? " · 현재 신뢰 키" : ""}</strong><code>{key.fingerprint}</code></span></label>)}</fieldset>{info.status === "replacement" && <label className="field ssh-confirm">키를 바꾸려면 교체 입력<input disabled={Boolean(busy)} value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="교체" /></label>}</> : <><p>실제 접속에서는 저장된 키만 허용합니다. 서버 키가 달라지면 연결이 차단됩니다.</p>{info.keys.map(key => <div className="ssh-key-value" key={key.fingerprint}><strong>{key.algorithm}</strong><code>{key.fingerprint}</code></div>)}<button type="button" className="secondary small ssh-reinspect" disabled={Boolean(busy)} onClick={() => void reinspect()}>다른 호스트 키 확인</button></>}
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p className="form-note" role="status">{busy === "inspect" ? "서버 지문을 조회하는 중…" : busy === "trust" ? "확인한 키를 저장하는 중…" : "SSH 세션을 여는 중…"}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={info ? () => { setInfo(null); setFingerprint(""); setConfirmation(""); setError(""); } : onClose}>{info ? "다시 입력" : "취소"}</button>{!info ? <button type="submit" className="primary" disabled={Boolean(busy)}>지문 확인</button> : info.status !== "trusted" ? <button type="button" className={info.status === "replacement" ? "danger" : "primary"} disabled={Boolean(busy) || !fingerprint || (info.status === "replacement" && confirmation !== "교체")} onClick={() => void trust()}>{info.status === "replacement" ? "확인한 키로 교체" : "지문을 확인하고 신뢰"}</button> : <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void connect()}>연결</button>}</div>
    </form>
  </dialog>;
}
