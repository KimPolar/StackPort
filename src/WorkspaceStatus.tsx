import { Activity, Database, Monitor, Route, TerminalSquare } from "lucide-react";

export type QueryActivity = "running" | "cancelling" | null;

function queryStatus(engine: string, activity: QueryActivity) {
  return activity ? `${engine} 쿼리 ${activity === "cancelling" ? "취소" : "실행"} 중` : "";
}

export function WorkspaceStatus({ hidden, desktop, storage, dataPath, version, terminalTabs, rdpWindows, tunnels, sqlite, postgres,
  openTerminal, openRdp, openTunnels, openPostgres }: {
  hidden: boolean; desktop: boolean; storage: string; dataPath?: string; version?: string;
  terminalTabs: number; rdpWindows: number; tunnels: number;
  sqlite: QueryActivity; postgres: { connected: boolean; query: QueryActivity };
  openTerminal: () => void; openRdp: () => void; openTunnels: () => void; openPostgres: () => void;
}) {
  const tasks = [queryStatus("SQLite", sqlite), queryStatus("PostgreSQL", postgres.query)].filter(Boolean);

  return <footer className="statusbar" id="workspace-status" hidden={hidden} aria-label="작업 공간 상태">
    <span className="workspace-storage" title={dataPath ?? storage}>{storage}</span>
    {desktop && <div className="workspace-status-items" role="group" aria-label="세션과 실행 상태">
      <button type="button" aria-label={`터미널 탭 ${terminalTabs}개`} onClick={openTerminal}>
        <TerminalSquare size={13} aria-hidden /><span>터미널</span><strong>{terminalTabs}</strong>
      </button>
      <button type="button" aria-label={`RDP 창 ${rdpWindows}개`} onClick={openRdp}>
        <Monitor size={13} aria-hidden /><span>RDP</span><strong>{rdpWindows}</strong>
      </button>
      <button type="button" aria-label={`활성 SSH 터널 ${tunnels}개`} onClick={openTunnels}>
        <Route size={13} aria-hidden /><span>SSH 터널</span><strong>{tunnels}</strong>
      </button>
      {postgres.connected && <button type="button" className="workspace-connected" onClick={openPostgres}>
        <Database size={13} aria-hidden /><span>PostgreSQL 연결됨</span>
      </button>}
      <span className="workspace-activity" role="status">
        {tasks.length > 0 && <><Activity size={13} aria-hidden />{tasks.join(" · ")}</>}
      </span>
    </div>}
    {version && <span className="version" aria-label="StackPort 버전">v{version}</span>}
  </footer>;
}
