import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plus, TerminalSquare, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

type Shell = "powershell" | "cmd";
type TerminalInfo = { id: string; shell: Shell; process_id: number | null };
type TerminalExit = { code: number | null; error: string | null };
type TerminalRead = { data: number[]; exit: TerminalExit | null; output_closed: boolean; output_error: string | null };
type Tab = TerminalInfo & { number: number; exit: TerminalExit | null };

const call = <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args);
const errorText = (error: unknown) => typeof error === "string" ? error : String(error);
const shellName = (shell: Shell) => shell === "powershell" ? "PowerShell" : "CMD";

export function TerminalWorkspace({ visible, onCountChange }: { visible: boolean; onCountChange: (count: number) => void }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [shell, setShell] = useState<Shell>("powershell");
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<string[]>([]);
  const [error, setError] = useState("");
  const tabsRef = useRef(tabs);
  const closingRef = useRef(new Set<string>());
  const openingRef = useRef(false);
  const nextNumber = useRef(1);
  tabsRef.current = tabs;

  useEffect(() => { onCountChange(tabs.length + (opening ? 1 : 0)); }, [tabs.length, opening, onCountChange]);

  async function openTerminal() {
    if (openingRef.current) return;
    openingRef.current = true; setOpening(true); setError("");
    try {
      const terminal = await call<TerminalInfo>("open_terminal", { shell, rows: 24, cols: 80 });
      const number = nextNumber.current++;
      setTabs(current => [...current, { ...terminal, number, exit: null }]);
      setActiveId(terminal.id);
    } catch (e) { setError(errorText(e)); }
    finally { openingRef.current = false; setOpening(false); }
  }

  async function closeTerminal(tab: Tab) {
    if (closingRef.current.has(tab.id)) return;
    const warning = tab.exit ? `${shellName(tab.shell)} 셸은 종료되었습니다. 남아 있는 연결된 프로세스가 종료될 수 있습니다. 닫으시겠습니까?`
      : `${shellName(tab.shell)} 터미널을 닫으면 실행 중인 작업과 연결된 하위 프로세스가 종료됩니다. 닫으시겠습니까?`;
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

  return <section className="terminal-workspace" aria-label="로컬 터미널">
    <div className="terminal-heading">
      <div><h1><TerminalSquare size={20} /> 로컬 터미널</h1><p>Windows PowerShell과 CMD를 이 장치에서 실행합니다.</p></div>
      <div className="terminal-actions"><label htmlFor="terminal-shell">셸</label><select id="terminal-shell" value={shell} onChange={event => setShell(event.target.value as Shell)} disabled={opening}><option value="powershell">PowerShell</option><option value="cmd">CMD</option></select><button className="primary" disabled={opening} onClick={() => void openTerminal()}><Plus size={15} /> {opening ? "여는 중…" : "새 터미널"}</button></div>
    </div>
    <p className="terminal-hint">StackPort는 터미널 입력과 출력을 저장하지 않습니다. 셸이나 실행한 프로그램의 기록 설정은 별도로 적용됩니다.</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {tabs.length === 0 ? <div className="terminal-empty"><TerminalSquare size={30} /><strong>열린 터미널이 없습니다</strong><span>셸을 선택하고 새 터미널을 여세요.</span></div> : <div className="terminal-card">
      <div className="terminal-tabs" role="tablist" aria-label="터미널 목록">{tabs.map((tab, index) => <div className={`terminal-tab ${tab.id === activeId ? "selected" : ""}`} key={tab.id}>
        <button role="tab" id={`terminal-tab-${tab.id}`} aria-selected={tab.id === activeId} aria-controls={`terminal-panel-${tab.id}`} tabIndex={tab.id === activeId ? 0 : -1} onKeyDown={event => moveTab(event, index)} onClick={() => setActiveId(tab.id)}><TerminalSquare size={14} /><span>{shellName(tab.shell)} {tab.number}</span>{tab.exit && <small>종료</small>}</button>
        <button className="terminal-close" aria-label={`${shellName(tab.shell)} ${tab.number} 터미널 닫기`} disabled={closing.includes(tab.id)} onClick={() => void closeTerminal(tab)}><X size={14} /></button>
      </div>)}</div>
      {tabs.map(tab => <TerminalPane key={tab.id} tab={tab} visible={visible && tab.id === activeId} onExit={reportExit} />)}
    </div>}
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
        if (/[\r\n]/.test(value) && !window.confirm("여러 줄을 터미널에 붙여넣으면 명령이 실행될 수 있습니다. 계속하시겠습니까?")) {
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
    {tab.exit && <div className="terminal-exit" role="status">{tab.exit.error ?? `셸이 종료되었습니다. 종료 코드: ${tab.exit.code ?? "확인 불가"}`}</div>}
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <div className="terminal-screen" ref={container} aria-label={`${shellName(tab.shell)} 터미널 화면`} />
  </div>;
}
