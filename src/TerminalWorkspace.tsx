import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ChevronDown, ChevronUp, FileDown, Plus, Search, TerminalSquare, X } from "lucide-react";
import type { SshOpenRequest, SshProfile } from "./ssh-profile-types";
import { NetworkDiagnosticResult, type NetworkDiagnostics } from "./NetworkDiagnosticsPanel";
import { TerminalOutputDialog, terminalText, type TerminalOutputFormat } from "./TerminalOutputDialog";
import "@xterm/xterm/css/xterm.css";

type Shell = "powershell" | "cmd" | "ssh";
type TerminalInfo = { id: string; shell: Shell; process_id: number | null; target: string | null; environment: SshProfile["environment"] | null };
type TerminalExit = { code: number | null; error: string | null };
type TerminalRead = { data: number[]; exit: TerminalExit | null; output_closed: boolean; output_error: string | null };
type Tab = TerminalInfo & { number: number; exit: TerminalExit | null; unreadOutput: boolean };
type SshKey = { algorithm: string; fingerprint: string };
type SshAuthenticationMode = "automatic" | "key_files" | "password" | "keyboard_interactive";
type SshHost = { status: "trusted" | "unknown" | "replacement"; host: string; port: number; token: string | null; keys: SshKey[]; previous: SshKey | null };

const call = <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args);
const errorText = (error: unknown) => typeof error === "string" ? error : String(error);
const shellName = (shell: Shell) => shell === "powershell" ? "PowerShell" : shell === "cmd" ? "CMD" : "SSH";
const tabName = (tab: Tab) => `${shellName(tab.shell)} ${tab.number}${tab.target ? ` · ${tab.target}` : ""}`;

export function TerminalWorkspace({ visible, onCountChange, request, onRequestHandled }: { visible: boolean; onCountChange: (count: number) => void; request: SshOpenRequest | null; onRequestHandled: () => void }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [shell, setShell] = useState<Shell>("powershell");
  const [opening, setOpening] = useState(false);
  const [sshDialog, setSshDialog] = useState(false);
  const [dialogProfile, setDialogProfile] = useState<SshProfile | null>(null);
  const [sshOpening, setSshOpening] = useState(false);
  const [closing, setClosing] = useState<string[]>([]);
  const [error, setError] = useState("");
  const tabsRef = useRef(tabs);
  const closingRef = useRef(new Set<string>());
  const openingRef = useRef(false);
  const nextNumber = useRef(1);
  tabsRef.current = tabs;

  useEffect(() => { onCountChange(tabs.length + (opening ? 1 : 0) + (sshOpening ? 1 : 0)); }, [tabs.length, opening, sshOpening, onCountChange]);
  useEffect(() => {
    if (!visible || !activeId) return;
    setTabs(current => current.some(tab => tab.id === activeId && tab.unreadOutput)
      ? current.map(tab => tab.id === activeId ? { ...tab, unreadOutput: false } : tab)
      : current);
  }, [visible, activeId]);
  useEffect(() => {
    if (!request) return;
    setDialogProfile(request.profile);
    setSshDialog(true);
    onRequestHandled();
  }, [request, onRequestHandled]);

  function addTerminal(terminal: TerminalInfo) {
    const number = nextNumber.current++;
    setTabs(current => [...current, { ...terminal, number, exit: null, unreadOutput: false }]);
    setActiveId(terminal.id);
  }

  async function openTerminal() {
    if (shell === "ssh") { setDialogProfile(null); setSshDialog(true); return; }
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

  function reportActivity(id: string) {
    setTabs(current => current.some(tab => tab.id === id && !tab.unreadOutput)
      ? current.map(tab => tab.id === id ? { ...tab, unreadOutput: true } : tab)
      : current);
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
    <p className="terminal-hint">터미널 출력은 메모리에 유지되며, 출력 저장을 선택하면 파일로 내보낼 수 있습니다. 셸과 실행한 프로그램은 자체 기록 설정을 사용합니다.</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {tabs.length === 0 ? <div className="terminal-empty"><TerminalSquare size={30} /><strong>열린 터미널이 없습니다</strong><span>셸을 선택하고 새 터미널을 여세요.</span></div> : <div className="terminal-card">
      <div className="terminal-tabs" role="tablist" aria-label="터미널 목록">{tabs.map((tab, index) => <div className={`terminal-tab ${tab.id === activeId ? "selected" : ""}`} key={tab.id}>
        <button role="tab" id={`terminal-tab-${tab.id}`} aria-label={tabName(tab)} aria-describedby={[tab.unreadOutput && `terminal-activity-${tab.id}`, tab.exit && `terminal-exit-tab-${tab.id}`].filter(Boolean).join(" ") || undefined} aria-selected={tab.id === activeId} aria-controls={`terminal-panel-${tab.id}`} tabIndex={tab.id === activeId ? 0 : -1} onKeyDown={event => moveTab(event, index)} onClick={() => setActiveId(tab.id)}><TerminalSquare size={14} /><span>{tabName(tab)}</span>{tab.unreadOutput && <small className="terminal-activity" id={`terminal-activity-${tab.id}`}>새 출력</small>}{tab.exit && <small id={`terminal-exit-tab-${tab.id}`}>종료</small>}</button>
        <button className="terminal-close" aria-label={`${tabName(tab)} 터미널 닫기`} disabled={closing.includes(tab.id)} onClick={() => void closeTerminal(tab)}><X size={14} /></button>
      </div>)}</div>
      {tabs.map(tab => <TerminalPane key={tab.id} tab={tab} visible={visible && tab.id === activeId} onExit={reportExit} onActivity={reportActivity} />)}
    </div>}
    {sshDialog && <SshDialog profile={dialogProfile} onClose={() => setSshDialog(false)} onOpeningChange={setSshOpening} onOpened={terminal => { addTerminal(terminal); setSshDialog(false); }} />}
  </section>;
}

function TerminalPane({ tab, visible, onExit, onActivity }: { tab: Tab; visible: boolean; onExit: (id: string, exit: TerminalExit) => void; onActivity: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const searchAddon = useRef<SearchAddon | null>(null);
  const serializeAddon = useRef<SerializeAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const fit = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  const exitCallback = useRef(onExit);
  const activityCallback = useRef(onActivity);
  const [error, setError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [searchStatus, setSearchStatus] = useState("");
  const [outputDialog, setOutputDialog] = useState(false);
  const [savedOutput, setSavedOutput] = useState<{ path: string; bytes: number } | null>(null);
  visibleRef.current = visible;
  exitCallback.current = onExit;
  activityCallback.current = onActivity;

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => { fit.current?.(); });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (!document.querySelector("dialog[open]") && event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      }
    }
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
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
      const search = new SearchAddon();
      const serializer = new SerializeAddon();
      emulator.loadAddon(addon);
      emulator.loadAddon(search);
      emulator.loadAddon(serializer);
      emulator.open(host);
      host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.setAttribute("aria-label", "터미널 입력");
      terminal.current = emulator;
      searchAddon.current = search;
      serializeAddon.current = serializer;
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
            if (output.data.length) {
              if (!visibleRef.current) activityCallback.current(tab.id);
              await new Promise<void>(resolve => emulator.write(new Uint8Array(output.data), resolve));
            }
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
        fit.current = null; terminal.current = null; searchAddon.current = null; serializeAddon.current = null;
      };
    });
    return () => { stopped = true; dispose(); };
  }, [tab.id]);

  function clearSearch() {
    searchAddon.current?.clearDecorations();
    terminal.current?.clearSelection();
    setSearchStatus("");
  }

  function closeSearch() {
    clearSearch(); setSearchText(""); setCaseSensitive(false); setSearchOpen(false);
    terminal.current?.focus();
  }

  function find(direction: "next" | "previous") {
    const search = searchAddon.current;
    if (!search || !searchText) return;
    const options = { caseSensitive };
    const found = direction === "next" ? search.findNext(searchText, options) : search.findPrevious(searchText, options);
    setSearchStatus(found ? "일치하는 내용을 선택했습니다." : "일치하는 내용이 없습니다.");
  }

  function captureOutput(format: TerminalOutputFormat) {
    const emulator = terminal.current;
    if (!emulator) return "";
    if (format === "ansi") return serializeAddon.current?.serialize({ excludeAltBuffer: true, excludeModes: true }) ?? "";
    return terminalText(emulator.buffer.normal, emulator.cols);
  }

  return <div role="tabpanel" id={`terminal-panel-${tab.id}`} aria-labelledby={`terminal-tab-${tab.id}`} className="terminal-panel" hidden={!visible}>
    {tab.target && <div className={`terminal-remote ${tab.environment === "PROD" ? "prod" : ""}`}><strong>SSH · {tab.target} · {tab.environment ?? "환경 미지정"}</strong><span>이 터미널의 명령은 원격 서버에서 실행됩니다.</span></div>}
    <div className="terminal-tools">
      <button className="terminal-tool-button" aria-haspopup="dialog" onClick={() => { setSavedOutput(null); setOutputDialog(true); }}><FileDown size={14} /> 출력 저장</button>
      <button className="terminal-tool-button" aria-expanded={searchOpen} onClick={() => { if (searchOpen) closeSearch(); else { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); } }}><Search size={14} /> 출력 찾기 <span>Ctrl+Shift+F</span></button>
    </div>
    {searchOpen && <form className="terminal-search" role="search" aria-label={`${tabName(tab)} 출력 검색`} onSubmit={event => { event.preventDefault(); find("next"); }}>
      <label className="sr-only" htmlFor={`terminal-search-${tab.id}`}>터미널 출력 검색어</label><input id={`terminal-search-${tab.id}`} ref={searchInput} type="search" maxLength={512} autoComplete="off" spellCheck={false} value={searchText} onChange={event => { setSearchText(event.target.value); clearSearch(); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeSearch(); } else if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); find("previous"); } }} placeholder="스크롤백에서 찾기" />
      <label className="terminal-search-case"><input type="checkbox" checked={caseSensitive} onChange={event => { setCaseSensitive(event.target.checked); clearSearch(); }} /> 대소문자 구분</label>
      <button type="button" aria-label="이전 결과" disabled={!searchText} onClick={() => find("previous")}><ChevronUp size={16} /></button><button type="submit" aria-label="다음 결과" disabled={!searchText}><ChevronDown size={16} /></button><button type="button" aria-label="검색 닫기" onClick={closeSearch}><X size={16} /></button>
      <span className="terminal-search-status" role="status">{searchStatus}</span>
    </form>}
    {tab.exit && <div className="terminal-exit" role="status">{tab.exit.error ?? `셸이 종료되었습니다. 종료 코드: ${tab.exit.code ?? "확인 불가"}`}</div>}
    {savedOutput && <div className="terminal-exit terminal-output-saved" role="status"><span>출력을 저장했습니다.</span> <span>{savedOutput.path} · {savedOutput.bytes.toLocaleString("ko-KR")} bytes</span></div>}
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <div className="terminal-screen" ref={container} aria-label={`${tabName(tab)} 터미널 화면`} />
    {outputDialog && <TerminalOutputDialog tab={tabName(tab)} capture={captureOutput} onClose={() => setOutputDialog(false)} onSaved={(path, bytes) => { setSavedOutput({ path, bytes }); setOutputDialog(false); }} />}
  </div>;
}

function SshDialog({ profile, onClose, onOpened, onOpeningChange }: { profile: SshProfile | null; onClose: () => void; onOpened: (terminal: TerminalInfo) => void; onOpeningChange: (opening: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [host, setHost] = useState(profile?.host ?? "");
  const [port, setPort] = useState(String(profile?.port ?? 22));
  const [username, setUsername] = useState(profile?.username ?? "");
  const [authentication, setAuthentication] = useState<SshAuthenticationMode>("automatic");
  const [identityPaths, setIdentityPaths] = useState([""]);
  const [info, setInfo] = useState<SshHost | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [prodConfirmation, setProdConfirmation] = useState("");
  const [diagnostic, setDiagnostic] = useState<NetworkDiagnostics | null>(null);
  const [busy, setBusy] = useState<"" | "file" | "diagnose" | "inspect" | "trust" | "open">("");
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);

  function updateIdentity(index: number, path: string) {
    setIdentityPaths(current => current.map((value, position) => position === index ? path : value));
  }

  async function chooseIdentity(index: number) {
    if (busy) return;
    setBusy("file"); setError("");
    try {
      const chosen = await call<string | null>("choose_ssh_identity_file");
      if (chosen) updateIdentity(index, chosen);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(""); }
  }

  async function diagnose() {
    if (busy) return;
    setBusy("diagnose"); setDiagnostic(null); setError("");
    try { setDiagnostic(await call<NetworkDiagnostics>("diagnose_ssh_network", { host, port: Number(port) })); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(""); }
  }

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
    if (authentication === "key_files" && identityPaths.some(path => !path.trim())) { setError("모든 SSH 키 파일 경로를 입력하거나 빈 줄을 삭제하세요."); return; }
    setBusy("open"); onOpeningChange(true); setError("");
    try {
      const selectedAuthentication = authentication === "key_files" ? { kind: authentication, paths: identityPaths } : { kind: authentication };
      const terminal = profile
        ? await call<TerminalInfo>("open_saved_ssh_terminal", { profile, confirmation: prodConfirmation, authentication: selectedAuthentication, rows: 24, cols: 80 })
        : await call<TerminalInfo>("open_ssh_terminal", { host: info.host, port: info.port, username, authentication: selectedAuthentication, rows: 24, cols: 80 });
      onOpened(terminal);
    } catch (e) { setError(errorText(e)); }
    finally { onOpeningChange(false); setBusy(""); }
  }

  return <dialog ref={dialog} className="dialog ssh-dialog" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2>SSH 연결</h2><button className="icon-button" aria-label="닫기" disabled={Boolean(busy)} onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={inspect} aria-busy={Boolean(busy)}>
      {profile && <p className="ssh-profile-context"><strong>{profile.name}</strong> <span className={`environment ${profile.environment.toLowerCase()}`}>{profile.environment}</span></p>}
      <label className="field">호스트 또는 IP<input autoFocus required disabled={Boolean(profile) || Boolean(info) || Boolean(busy)} value={host} onChange={event => { setHost(event.target.value); setDiagnostic(null); }} placeholder="예: server.example.com" /></label>
      <label className="field">포트<input required type="number" min="1" max="65535" step="1" disabled={Boolean(profile) || Boolean(info) || Boolean(busy)} value={port} onChange={event => { setPort(event.target.value); setDiagnostic(null); }} /></label>
      <label className="field">사용자 이름<input required pattern="[A-Za-z0-9_.][A-Za-z0-9._-]*" disabled={Boolean(profile) || Boolean(info) || Boolean(busy)} value={username} onChange={event => setUsername(event.target.value)} placeholder="SSH 사용자" /></label>
      <label className="field">SSH 인증 방식<select disabled={Boolean(busy)} value={authentication} onChange={event => { setAuthentication(event.target.value as SshAuthenticationMode); setError(""); }}>
        <option value="automatic">자동</option>
        <option value="key_files">지정한 키 파일</option>
        <option value="password">암호</option>
        <option value="keyboard_interactive">서버 대화형 인증</option>
      </select></label>
      {authentication === "key_files" && <div className="ssh-identity-fields">
        {identityPaths.map((path, index) => <div className="ssh-identity-row" key={index}>
          <label className="field">SSH 키 파일 {index + 1} 경로
            <input required disabled={Boolean(busy)} value={path} onChange={event => updateIdentity(index, event.target.value)} placeholder="개인 키 또는 에이전트에 등록된 공개 키의 절대 경로" autoComplete="off" />
          </label>
          <button type="button" className="secondary" aria-label={`SSH 키 파일 ${index + 1} 찾아보기`} disabled={Boolean(busy)} onClick={() => void chooseIdentity(index)}>찾아보기</button>
          {identityPaths.length > 1 && <button type="button" className="icon-button" aria-label={`SSH 키 파일 ${index + 1} 삭제`} disabled={Boolean(busy)} onClick={() => setIdentityPaths(current => current.filter((_, position) => position !== index))}><X size={16} /></button>}
        </div>)}
        <button type="button" className="secondary small" disabled={Boolean(busy) || identityPaths.length >= 8} onClick={() => setIdentityPaths(current => [...current, ""])}><Plus size={14} /> 키 파일 추가</button>
        <p className="form-note">지정한 키만 사용합니다. 필요한 키 암호는 연결 후 터미널에 입력하세요.</p>
      </div>}
      {authentication === "keyboard_interactive" && <p className="form-note">연결한 뒤 터미널에서 서버의 질문에 답하세요. 각 답변의 화면 표시 여부는 서버가 지정합니다.</p>}
      <div className="ssh-diagnostic-actions"><button type="button" className="secondary small" disabled={Boolean(busy) || !host.trim() || !port} onClick={() => void diagnose()}>DNS·TCP 진단</button><span>네트워크 연결을 시도하며 로그인하지 않습니다.</span></div>
      {diagnostic && <NetworkDiagnosticResult result={diagnostic} ssh />}
      {!info && <p className="form-note">먼저 서버의 호스트 키 지문을 확인합니다. 암호는 연결 후 터미널에 직접 입력하며 StackPort에 저장되지 않습니다.{!profile && " 직접 입력한 연결에는 환경이 지정되지 않습니다."}</p>}
      {info && <div className="ssh-verification">
        <strong>{info.host.includes(":") ? `[${info.host}]` : info.host}:{info.port} · {info.status === "trusted" ? "저장된 호스트 키" : info.status === "replacement" ? "호스트 키 재확인" : "확인이 필요한 호스트 키"}</strong>
        {info.status !== "trusted" ? <>{info.previous && <div className="ssh-previous"><span>기존에 신뢰한 지문</span><code>{info.previous.fingerprint}</code></div>}<p>이 지문은 서버가 제공한 값입니다. 서버 관리자에게 받은 지문과 별도의 경로로 비교한 후 신뢰할 키를 선택하세요.{info.previous && " 교체 후 새 연결에서는 기존 키가 차단되며, 이미 열린 세션은 유지됩니다."}</p><fieldset><legend>서버 지문 선택</legend>{info.keys.map(key => <label className="ssh-key" key={key.fingerprint}><input type="radio" name="ssh-key" value={key.fingerprint} disabled={Boolean(busy) || key.fingerprint === info.previous?.fingerprint} checked={fingerprint === key.fingerprint} onChange={() => setFingerprint(key.fingerprint)} /><span><strong>{key.algorithm}{key.fingerprint === info.previous?.fingerprint ? " · 현재 신뢰 키" : ""}</strong><code>{key.fingerprint}</code></span></label>)}</fieldset>{info.status === "replacement" && <label className="field ssh-confirm">키를 바꾸려면 교체 입력<input disabled={Boolean(busy)} value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="교체" /></label>}</> : <><p>실제 접속에서는 저장된 키만 허용합니다. 서버 키가 달라지면 연결이 차단됩니다.</p>{info.keys.map(key => <div className="ssh-key-value" key={key.fingerprint}><strong>{key.algorithm}</strong><code>{key.fingerprint}</code></div>)}<button type="button" className="secondary small ssh-reinspect" disabled={Boolean(busy)} onClick={() => void reinspect()}>다른 호스트 키 확인</button></>}
      </div>}
      {info?.status === "trusted" && profile?.environment === "PROD" && <label className="field ssh-prod-confirm">운영 환경 확인: PROD 입력<input disabled={Boolean(busy)} value={prodConfirmation} onChange={event => setProdConfirmation(event.target.value)} autoComplete="off" placeholder="PROD" /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p className="form-note" role="status">{busy === "file" ? "키 파일을 선택하는 중…" : busy === "diagnose" ? "DNS와 TCP 연결을 확인하는 중…" : busy === "inspect" ? "서버 지문을 조회하는 중…" : busy === "trust" ? "확인한 키를 저장하는 중…" : "SSH 세션을 여는 중…"}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={info ? () => { setInfo(null); setFingerprint(""); setConfirmation(""); setProdConfirmation(""); setError(""); } : onClose}>{info ? "다시 입력" : "취소"}</button>{!info ? <button type="submit" className="primary" disabled={Boolean(busy)}>지문 확인</button> : info.status !== "trusted" ? <button type="button" className={info.status === "replacement" ? "danger" : "primary"} disabled={Boolean(busy) || !fingerprint || (info.status === "replacement" && confirmation !== "교체")} onClick={() => void trust()}>{info.status === "replacement" ? "확인한 키로 교체" : "지문을 확인하고 신뢰"}</button> : <button type="button" className="primary" disabled={Boolean(busy) || (profile?.environment === "PROD" && prodConfirmation !== "PROD")} onClick={() => void connect()}>연결</button>}</div>
    </form>
  </dialog>;
}
