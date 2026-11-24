import type { KeyboardEvent } from "react";
import { Database, FolderOpen, Monitor, Network, TerminalSquare } from "lucide-react";

export type WorkspacePage = "workspace" | "terminal" | "files" | "rdp" | "network";

const tools = [
  { id: "workspace", label: "데이터베이스", Icon: Database },
  { id: "terminal", label: "터미널", Icon: TerminalSquare, native: true },
  { id: "files", label: "파일 탐색", Icon: FolderOpen, native: true },
  { id: "rdp", label: "원격 화면", Icon: Monitor },
  { id: "network", label: "네트워크", Icon: Network, native: true },
] as const;

export function WorkspaceNavigation({ page, desktop, historyOpen, terminalCount, rdpCount, onSelect }: {
  page: WorkspacePage;
  desktop: boolean;
  historyOpen: boolean;
  terminalCount: number;
  rdpCount: number;
  onSelect: (page: WorkspacePage) => void;
}) {
  function moveFocus(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return <nav className="tool-strip" aria-label="작업 도구" onKeyDown={moveFocus}>
    {tools.map(tool => {
      const current = !historyOpen && page === tool.id;
      const count = tool.id === "terminal" ? terminalCount : tool.id === "rdp" ? rdpCount : 0;
      return <button key={tool.id} type="button" className="tool-tab" aria-current={current ? "page" : undefined}
        disabled={"native" in tool && !desktop}
        aria-description={count > 0 ? `열린 세션 ${count}개` : undefined}
        onClick={() => onSelect(tool.id)}>
        <tool.Icon size={16} aria-hidden /><span>{tool.label}</span>
        {count > 0 && <span className="tool-count" aria-hidden title={`열린 세션 ${count}개`}>{count}</span>}
      </button>;
    })}
  </nav>;
}
