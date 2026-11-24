import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ChevronDown, ChevronUp, Ellipsis, FileDown, Pin, Plug, Plus, Search, TerminalSquare, X } from "lucide-react";
import type { SshOpenRequest, SshProfile } from "./ssh-profile-types";
import { NetworkDiagnosticResult, type NetworkDiagnostics } from "./NetworkDiagnosticsPanel";
import { TerminalOutputDialog, terminalText, type TerminalOutputFormat } from "./TerminalOutputDialog";
import { TerminalTabDialog } from "./TerminalTabDialog";
import { SshRouteDialog } from "./SshRouteDialog";
import { terminalDirectoryFromOsc, type TerminalDirectory } from "./terminalDirectory";
import type { ColorScheme } from "./appearance";
import "@xterm/xterm/css/xterm.css";

type LocalShell = "powershell" | "cmd";
type Shell = LocalShell | "ssh";
type TerminalInfo = { id: string; shell: Shell; process_id: number | null; target: string | null; environment: SshProfile["environment"] | null; cwd_authority: string | null };
type TerminalExit = { code: number | null; error: string | null };
type TerminalRead = { data: number[]; exit: TerminalExit | null; output_closed: boolean; output_error: string | null };
type DirectSshTarget = { host: string; port: number; username: string };
type TerminalLaunch = { kind: "local"; shell: LocalShell }
  | { kind: "saved_ssh"; projectId: string; profileId: string; revision: number; authentication: SshAuthenticationMode }
  | { kind: "routed_ssh"; projectId: string; profileId: string; revision: number; hops: Pick<SshProfile, "id" | "name">[] }
  | { kind: "direct_ssh"; target: DirectSshTarget; authentication: SshAuthenticationMode };
type ClosedTab = { number: number; name: string; launch: TerminalLaunch };
type Tab = TerminalInfo & { number: number; exit: TerminalExit | null; directory: string | null; unreadOutput: boolean; pinned: boolean; launch: TerminalLaunch };
type SshDialogRequest = {
  profile: SshProfile | null;
  target?: DirectSshTarget;
  profiles?: SshProfile[];
  route?: { ids: string[]; returnToConnection: boolean };
  authentication?: SshAuthenticationMode;
  reopen?: number;
};
type SshKey = { algorithm: string; fingerprint: string };
type SshAuthenticationMode = "automatic" | "key_files" | "password" | "keyboard_interactive";
type SshHost = { status: "trusted" | "unknown" | "replacement"; host: string; port: number; token: string | null; keys: SshKey[]; previous: SshKey | null };

const call = <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args);
const errorText = (error: unknown) => typeof error === "string" ? error : String(error);
const shellName = (shell: Shell) => shell === "powershell" ? "PowerShell" : shell === "cmd" ? "CMD" : "SSH";
const tabName = (tab: Tab) => `${shellName(tab.shell)} ${tab.number}${tab.target ? ` · ${tab.target}` : ""}`;

const lightAnsi = {
  black: "#223630", red: "#993e36", green: "#176747", yellow: "#805b13",
  blue: "#225e9a", magenta: "#7a407c", cyan: "#0f6470", white: "#3f5850",
  brightBlack: "#536c62", brightRed: "#a9312b", brightGreen: "#155f35", brightYellow: "#855214",
  brightBlue: "#244e9e", brightMagenta: "#843486", brightCyan: "#087179", brightWhite: "#2d453c",
};

function terminalTheme(host: HTMLElement) {
  const styles = getComputedStyle(host);
  const background = styles.getPropertyValue("--terminal-background").trim();
  return {
    background,
    foreground: styles.getPropertyValue("--terminal-foreground").trim(),
    cursor: styles.getPropertyValue("--terminal-cursor").trim(),
    cursorAccent: background,
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
    ...(styles.colorScheme === "light" ? lightAnsi : {}),
  };
}

export function TerminalWorkspace({ visible, colorScheme, onCountChange, request, sshProfiles, onRequestHandled, onDirectoryChange }: {
  visible: boolean;
  colorScheme: ColorScheme;
  onCountChange: (count: number) => void;
  request: SshOpenRequest | null;
  sshProfiles: SshProfile[];
  onRequestHandled: () => void;
  onDirectoryChange: (directory: TerminalDirectory | null) => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [selectedId, setActiveId] = useState("");
  const [recentTabs, setRecentTabs] = useState<ClosedTab[]>([]);
  const [tabDialogOpen, setTabDialogOpen] = useState(false);
  const [dropTarget, setDropTarget] = useState("");
  const [opening, setOpening] = useState(false);
  const [sshDialog, setSshDialog] = useState<SshDialogRequest | null>(null);
  const [sshOpening, setSshOpening] = useState(false);
  const [closing, setClosing] = useState<string[]>([]);
  const [error, setError] = useState("");
  const closingRef = useRef(new Set<string>());
  const openingRef = useRef(false);
  const draggedTab = useRef("");
  const nextNumber = useRef(1);
  const sshRequestGeneration = useRef(0);
  const activeId = tabs.some(tab => tab.id === selectedId) ? selectedId : tabs.at(-1)?.id ?? "";
  const activeIndex = tabs.findIndex(tab => tab.id === activeId);
  const activeTab = tabs[activeIndex];
  const activeDirectory = activeTab?.exit ? null : activeTab?.directory;
  const activeLaunch = activeTab?.launch;

  useEffect(() => { onCountChange(tabs.length + (opening ? 1 : 0) + (sshOpening ? 1 : 0)); }, [tabs.length, opening, sshOpening, onCountChange]);
  useEffect(() => {
    if (activeDirectory && activeLaunch?.kind === "local") {
      onDirectoryChange({ kind: "local", path: activeDirectory });
    } else if (activeDirectory && (activeLaunch?.kind === "saved_ssh" || activeLaunch?.kind === "routed_ssh")) {
      onDirectoryChange({ kind: "ssh", path: activeDirectory, profileId: activeLaunch.profileId, revision: activeLaunch.revision });
    } else {
      onDirectoryChange(null);
    }
  }, [activeDirectory, activeLaunch, onDirectoryChange]);
  useEffect(() => {
    if (!visible || !activeId) return;
    setTabs(current => current.some(tab => tab.id === activeId && tab.unreadOutput)
      ? current.map(tab => tab.id === activeId ? { ...tab, unreadOutput: false } : tab)
      : current);
  }, [visible, activeId]);
  useEffect(() => {
    if (!request) return;
    sshRequestGeneration.current++;
    setSshDialog({ profile: request.profile });
    onRequestHandled();
  }, [request, onRequestHandled]);

  function addTerminal(terminal: TerminalInfo, launch: TerminalLaunch, reopened?: number) {
    const number = nextNumber.current++;
    setTabs(current => [...current, { ...terminal, launch, number, exit: null, directory: null, unreadOutput: false, pinned: false }]);
    if (reopened !== undefined) setRecentTabs(current => current.filter(tab => tab.number !== reopened));
    setActiveId(terminal.id);
  }

  async function openTerminal(launch: TerminalLaunch, reopened?: number) {
    if (openingRef.current) return;
    setTabDialogOpen(false);
    setError("");
    if (launch.kind === "direct_ssh") {
      setSshDialog({ profile: null, target: launch.target, authentication: launch.authentication, reopen: reopened });
      return;
    }
    const generation = ++sshRequestGeneration.current;
    openingRef.current = true; setOpening(true);
    try {
      if (launch.kind === "local") {
        const terminal = await call<TerminalInfo>("open_terminal", { shell: launch.shell, rows: 24, cols: 80 });
        addTerminal(terminal, launch, reopened);
      } else {
        const profiles = await call<SshProfile[]>("list_ssh_profiles", { projectId: launch.projectId });
        if (generation !== sshRequestGeneration.current) return;
        const profile = profiles.find(item => item.id === launch.profileId);
        if (!profile) throw "저장된 SSH 연결을 찾을 수 없습니다.";
        if (launch.kind === "routed_ssh") {
          const ids = launch.hops.map(hop => hop.id);
          const endpoints = [profile, ...ids.map(id => profiles.find(item => item.id === id))];
          if (endpoints.some(item => !item) || new Set(endpoints.map(item => `${item?.host}:${item?.port}`)).size !== endpoints.length) {
            throw "이전 경유 연결을 사용할 수 없습니다. 저장된 연결에서 경유 서버를 다시 선택하세요.";
          }
          setSshDialog({ profile, profiles, route: { ids, returnToConnection: false }, reopen: reopened });
        } else {
          setSshDialog({ profile, profiles, authentication: launch.authentication, reopen: reopened });
        }
      }
    } catch (e) { if (launch.kind === "local" || generation === sshRequestGeneration.current) setError(errorText(e)); }
    finally { openingRef.current = false; setOpening(false); }
  }

  async function closeTabs(targets: Tab[], warning: string) {
    const available = targets.filter(tab => !closingRef.current.has(tab.id));
    if (!available.length || !window.confirm(warning)) return;
    setTabDialogOpen(false);
    setError("");
    for (const tab of available) closingRef.current.add(tab.id);
    setClosing([...closingRef.current]);
    const results = await Promise.allSettled(available.map(tab => call("close_terminal", { id: tab.id })));
    const closed = available.filter((_, index) => results[index].status === "fulfilled");
    const closedIds = new Set(closed.map(tab => tab.id));
    setTabs(current => current.filter(tab => !closedIds.has(tab.id)));
    setRecentTabs(current => [...closed.map(tab => ({ number: tab.number, name: tabName(tab), launch: tab.launch })), ...current].slice(0, 12));
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [`${tabName(available[index])} · ${errorText(result.reason)}`] : []);
    if (failures.length) setError(failures.join(" · "));
    for (const tab of available) closingRef.current.delete(tab.id);
    setClosing([...closingRef.current]);
  }

  function closeTerminal(tab: Tab) {
    const warning = tab.exit ? `${tabName(tab)} 셸은 종료되었습니다. 남아 있는 연결된 프로세스가 종료될 수 있습니다. 닫으시겠습니까?`
      : `${tabName(tab)} 터미널을 닫으면 실행 중인 작업과 연결된 하위 프로세스가 종료됩니다. 닫으시겠습니까?`;
    return closeTabs([tab], warning);
  }

  const unpinnedTabs = tabs.filter(tab => !tab.pinned && !closing.includes(tab.id));

  function closeUnpinned() {
    const names = unpinnedTabs.slice(0, 8).map(tabName).join("\n");
    const remaining = unpinnedTabs.length > 8 ? `\n그 외 ${unpinnedTabs.length - 8}개` : "";
    return closeTabs(unpinnedTabs, `고정하지 않은 터미널 ${unpinnedTabs.length}개를 닫으면 실행 중인 작업과 하위 프로세스가 종료됩니다.\n\n${names}${remaining}\n\n닫으시겠습니까?`);
  }

  function reportExit(id: string, exit: TerminalExit) {
    setTabs(current => current.map(tab => tab.id === id ? { ...tab, exit } : tab));
  }

  function reportDirectory(id: string, directory: string | null) {
    setTabs(current => current.some(tab => tab.id === id && tab.directory !== directory)
      ? current.map(tab => tab.id === id ? { ...tab, directory } : tab)
      : current);
  }

  function reportActivity(id: string) {
    setTabs(current => current.some(tab => tab.id === id && !tab.unreadOutput)
      ? current.map(tab => tab.id === id ? { ...tab, unreadOutput: true } : tab)
      : current);
  }

  function reorderTab(id: string, targetId: string) {
    setTabs(current => {
      const source = current.findIndex(tab => tab.id === id);
      const target = current.findIndex(tab => tab.id === targetId);
      if (source < 0 || target < 0 || source === target || current[source].pinned !== current[target].pinned) return current;
      const reordered = [...current];
      const [tab] = reordered.splice(source, 1);
      reordered.splice(target, 0, tab);
      return reordered;
    });
  }

  function togglePinned(id: string) {
    setTabs(current => {
      const tab = current.find(item => item.id === id);
      if (!tab) return current;
      const remaining = current.filter(item => item.id !== id);
      const firstUnpinned = remaining.findIndex(item => !item.pinned);
      remaining.splice(firstUnpinned < 0 ? remaining.length : firstUnpinned, 0, { ...tab, pinned: !tab.pinned });
      return remaining;
    });
  }

  function openTabDialog(tab: Tab) {
    setActiveId(tab.id);
    setTabDialogOpen(true);
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const tab = tabs[index];
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openTabDialog(tab);
      return;
    }
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const target = tabs[index + (event.key === "ArrowLeft" ? -1 : 1)];
      if (!target || target.pinned !== tab.pinned) return;
      reorderTab(tab.id, target.id);
      requestAnimationFrame(() => document.getElementById(`terminal-tab-${tab.id}`)?.focus());
      return;
    }
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
    <header className="terminal-heading session-heading">
      <h1><TerminalSquare size={20} aria-hidden /> 터미널</h1>
      <div className="terminal-actions" role="group" aria-label="새 터미널">
        <button type="button" className="primary small" disabled={opening} onClick={() => void openTerminal({ kind: "local", shell: "powershell" })}><Plus size={14} aria-hidden /> PowerShell 열기</button>
        <button type="button" className="secondary small" disabled={opening} onClick={() => void openTerminal({ kind: "local", shell: "cmd" })}><Plus size={14} aria-hidden /> CMD 열기</button>
        <button type="button" className="secondary small" disabled={opening}
          onClick={() => setSshDialog({ profile: null })}><Plug size={14} aria-hidden /> SSH 연결</button>
      </div>
    </header>
    {opening && <p className="terminal-hint" role="status">터미널을 여는 중…</p>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    {tabs.length === 0 ? <div className="terminal-empty">
      <TerminalSquare size={30} aria-hidden /><strong>열린 터미널이 없습니다</strong>
      <span>상단에서 새 터미널을 열거나 탐색기에서 저장된 SSH 연결을 선택하세요.</span>
      {recentTabs.length > 0 && <button type="button" className="secondary small" aria-haspopup="dialog" onClick={() => setTabDialogOpen(true)}>최근 닫은 탭</button>}
    </div> : <div className="terminal-card">
      <div className="terminal-tab-strip">
        <div className="terminal-tabs" role="tablist" aria-label="터미널 목록">{tabs.map((tab, index) => <div
          className={`terminal-tab ${tab.id === activeId ? "selected" : ""}`} data-drop-target={tab.id === dropTarget || undefined} key={tab.id}>
          <button type="button" role="tab" id={`terminal-tab-${tab.id}`} aria-label={tabName(tab)}
            aria-describedby={[tab.pinned && `terminal-pin-${tab.id}`, tab.unreadOutput && `terminal-activity-${tab.id}`, tab.exit && `terminal-exit-tab-${tab.id}`].filter(Boolean).join(" ") || undefined}
            aria-selected={tab.id === activeId} aria-controls={`terminal-panel-${tab.id}`} tabIndex={tab.id === activeId ? 0 : -1}
            onKeyDown={event => moveTab(event, index)} onClick={() => setActiveId(tab.id)}
            onContextMenu={event => { event.preventDefault(); openTabDialog(tab); }}
            draggable={!closing.includes(tab.id)} onDragStart={event => {
              draggedTab.current = tab.id;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-stackport-terminal-tab", "move");
            }} onDragOver={event => {
              const source = tabs.find(item => item.id === draggedTab.current);
              if (!source || source.id === tab.id || source.pinned !== tab.pinned) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTarget(tab.id);
            }} onDragLeave={() => setDropTarget(current => current === tab.id ? "" : current)}
            onDragEnd={() => { draggedTab.current = ""; setDropTarget(""); }} onDrop={event => {
              if (!draggedTab.current) return;
              event.preventDefault();
              reorderTab(draggedTab.current, tab.id);
              draggedTab.current = "";
              setDropTarget("");
            }}>
            {tab.pinned ? <><Pin size={14} aria-hidden /><span className="sr-only" id={`terminal-pin-${tab.id}`}>고정됨</span></> : <TerminalSquare size={14} aria-hidden />}
            <span>{tabName(tab)}</span>
            {tab.unreadOutput && <small className="terminal-activity" id={`terminal-activity-${tab.id}`}>새 출력</small>}
            {tab.exit && <small id={`terminal-exit-tab-${tab.id}`}>종료</small>}
          </button>
          <button type="button" className="terminal-close" aria-label={`${tabName(tab)} 터미널 닫기`}
            disabled={closing.includes(tab.id)} onClick={() => void closeTerminal(tab)}><X size={14} aria-hidden /></button>
        </div>)}</div>
        <button type="button" className="icon-button terminal-tab-menu" aria-label="터미널 탭 관리" aria-haspopup="dialog"
          title="터미널 탭 관리" disabled={!activeTab} onClick={() => setTabDialogOpen(true)}><Ellipsis size={17} aria-hidden /></button>
      </div>
      {tabs.map(tab => <TerminalPane key={tab.id} tab={tab} colorScheme={colorScheme} visible={visible && tab.id === activeId} onExit={reportExit}
        onActivity={reportActivity} onDirectory={reportDirectory} />)}
    </div>}
    {tabDialogOpen && <TerminalTabDialog name={activeTab && tabName(activeTab)} pinned={activeTab?.pinned ?? false}
      canMoveLeft={Boolean(activeTab && tabs[activeIndex - 1]?.pinned === activeTab.pinned)}
      canMoveRight={Boolean(activeTab && tabs[activeIndex + 1]?.pinned === activeTab.pinned)}
      recent={recentTabs} opening={opening} unpinnedCount={unpinnedTabs.length} onCloseUnpinned={() => void closeUnpinned()}
      onPin={() => { if (activeTab) togglePinned(activeTab.id); }}
      onMove={offset => { if (activeTab) reorderTab(activeTab.id, tabs[activeIndex + offset].id); }}
      onDuplicate={() => { if (activeTab) void openTerminal(activeTab.launch); }}
      onReopen={number => {
        const item = recentTabs.find(tab => tab.number === number);
        if (item) void openTerminal(item.launch, number);
      }}
      onClose={() => setTabDialogOpen(false)} />}
    {sshDialog?.route && sshDialog.profile ? <SshRouteDialog<TerminalInfo> tool="terminal"
      target={sshDialog.profile} profiles={sshDialog.profiles ?? sshProfiles} initialHops={sshDialog.route.ids}
      onBusy={setSshOpening} onClose={() => setSshDialog(sshDialog.route?.returnToConnection ? { ...sshDialog, route: undefined } : null)}
      onOpened={(terminal, hops) => {
        const profile = sshDialog.profile!;
        addTerminal(terminal, { kind: "routed_ssh", projectId: profile.project_id, profileId: profile.id,
          revision: profile.revision, hops: hops.map(({ id, name }) => ({ id, name })) }, sshDialog.reopen);
        setSshDialog(null);
      }} /> : sshDialog && <SshDialog profile={sshDialog.profile} target={sshDialog.target} initialAuthentication={sshDialog.authentication}
      onRoute={sshDialog.profile && (sshDialog.profiles ?? sshProfiles).some(item => item.host !== sshDialog.profile?.host || item.port !== sshDialog.profile?.port)
        ? () => setSshDialog({ ...sshDialog, route: { ids: [], returnToConnection: true } }) : undefined}
      onClose={() => setSshDialog(null)} onOpeningChange={setSshOpening}
      onOpened={(terminal, launch) => { addTerminal(terminal, launch, sshDialog.reopen); setSshDialog(null); }} />}
  </section>;
}

function TerminalPane({ tab, visible, colorScheme, onExit, onActivity, onDirectory }: {
  tab: Tab;
  visible: boolean;
  colorScheme: ColorScheme;
  onExit: (id: string, exit: TerminalExit) => void;
  onActivity: (id: string) => void;
  onDirectory: (id: string, directory: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const searchAddon = useRef<SearchAddon | null>(null);
  const serializeAddon = useRef<SerializeAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const fit = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  const exitCallback = useRef(onExit);
  const activityCallback = useRef(onActivity);
  const directoryCallback = useRef(onDirectory);
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
  directoryCallback.current = onDirectory;

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => { fit.current?.(); });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    if (container.current && terminal.current) {
      terminal.current.options.theme = terminalTheme(container.current);
    }
  }, [colorScheme]);

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
        theme: terminalTheme(host),
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
      const directoryUpdates = emulator.parser.registerOscHandler(7, data => {
        if (tab.cwd_authority || tab.launch.kind === "saved_ssh" || tab.launch.kind === "routed_ssh") {
          const directory = terminalDirectoryFromOsc(data, tab.cwd_authority);
          if (directory !== undefined) directoryCallback.current(tab.id, directory);
        }
        return true;
      });
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
        observer.disconnect(); input.dispose(); resized.dispose(); directoryUpdates.dispose(); emulator.dispose();
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
    {tab.target && <div className={`terminal-remote ${tab.environment === "PROD" ? "prod" : ""}`}><strong>SSH · {tab.target} · {tab.environment ?? "환경 미지정"}</strong>
      <span>{tab.launch.kind === "routed_ssh" ? `경유 ${tab.launch.hops.map(hop => hop.name).join(" → ")}` : "이 터미널의 명령은 원격 서버에서 실행됩니다."}</span>
    </div>}
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

function SshDialog({ profile, target, initialAuthentication = "automatic", onRoute, onClose, onOpened, onOpeningChange }: {
  profile: SshProfile | null;
  target?: DirectSshTarget;
  initialAuthentication?: SshAuthenticationMode;
  onRoute?: () => void;
  onClose: () => void;
  onOpened: (terminal: TerminalInfo, launch: TerminalLaunch) => void;
  onOpeningChange: (opening: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [host, setHost] = useState(profile?.host ?? target?.host ?? "");
  const [port, setPort] = useState(String(profile?.port ?? target?.port ?? 22));
  const [username, setUsername] = useState(profile?.username ?? target?.username ?? "");
  const [authentication, setAuthentication] = useState(initialAuthentication);
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
      const launch: TerminalLaunch = profile
        ? { kind: "saved_ssh", projectId: profile.project_id, profileId: profile.id, revision: profile.revision, authentication }
        : { kind: "direct_ssh", target: { host: info.host, port: info.port, username }, authentication };
      onOpened(terminal, launch);
    } catch (e) { setError(errorText(e)); }
    finally { onOpeningChange(false); setBusy(""); }
  }

  return <dialog ref={dialog} className="dialog ssh-dialog" aria-labelledby="ssh-session-title" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2 id="ssh-session-title">SSH 연결</h2><button className="icon-button" aria-label="닫기" disabled={Boolean(busy)} onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={inspect} aria-busy={Boolean(busy)}>
      {profile && <p className="ssh-profile-context"><strong>{profile.name}</strong> <span className={`environment ${profile.environment.toLowerCase()}`}>{profile.environment}</span>
        {onRoute && <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={onRoute}>경유 서버 사용</button>}
      </p>}
      <div className="ssh-connection-fields ssh-endpoint">
        <label className="field">호스트 또는 IP<input autoFocus={!profile} required disabled={Boolean(profile) || Boolean(info) || Boolean(busy)} value={host} onChange={event => { setHost(event.target.value); setDiagnostic(null); }} placeholder="예: server.example.com" /></label>
        <label className="field">포트<input required type="number" min="1" max="65535" step="1" disabled={Boolean(profile) || Boolean(info) || Boolean(busy)} value={port} onChange={event => { setPort(event.target.value); setDiagnostic(null); }} /></label>
      </div>
      <div className="ssh-connection-fields">
        <label className="field">사용자 이름<input required pattern="[A-Za-z0-9_.][A-Za-z0-9._-]*" disabled={Boolean(profile) || Boolean(info) || Boolean(busy)} value={username} onChange={event => setUsername(event.target.value)} placeholder="SSH 사용자" /></label>
        <label className="field">SSH 인증 방식<select autoFocus={Boolean(profile)} disabled={Boolean(busy)} value={authentication} onChange={event => { setAuthentication(event.target.value as SshAuthenticationMode); setError(""); }}>
          <option value="automatic">자동</option>
          <option value="key_files">지정한 키 파일</option>
          <option value="password">암호</option>
          <option value="keyboard_interactive">서버 대화형 인증</option>
        </select></label>
      </div>
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
