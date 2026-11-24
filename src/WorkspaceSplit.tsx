import type { KeyboardEvent, PointerEvent } from "react";
import { PanelsTopLeft } from "lucide-react";
import { workspaceTools, type WorkspacePage } from "./WorkspaceNavigation";

export type SplitDirection = "side" | "stack";
const minimumSize = 25;
const maximumSize = 75;

export function WorkspaceSplitControls({ primary, secondary, direction, onToggle, onSelect, onDirectionChange }: {
  primary: WorkspacePage;
  secondary: WorkspacePage | null;
  direction: SplitDirection;
  onToggle: () => void;
  onSelect: (page: WorkspacePage) => void;
  onDirectionChange: (direction: SplitDirection) => void;
}) {
  return <div className="split-controls" role="group" aria-label="화면 배치">
    <button type="button" className="secondary small" aria-pressed={Boolean(secondary)} aria-controls="workspace-panes" onClick={onToggle}>
      <PanelsTopLeft size={15} aria-hidden /><span>화면 분할</span>
    </button>
    {secondary && <>
      <select aria-label="두 번째 도구" title="두 번째 도구" value={secondary} onChange={event => onSelect(event.target.value as WorkspacePage)}>
        {workspaceTools.filter(tool => tool.id !== primary).map(tool => <option key={tool.id} value={tool.id}>{tool.label}</option>)}
      </select>
      <select aria-label="분할 방향" title="분할 방향" value={direction} onChange={event => onDirectionChange(event.target.value as SplitDirection)}>
        <option value="side">좌우</option><option value="stack">상하</option>
      </select>
    </>}
  </div>;
}

export function WorkspaceSeparator({ primary, direction, size, onResize }: {
  primary: WorkspacePage;
  direction: SplitDirection;
  size: number;
  onResize: (size: number) => void;
}) {
  const side = direction === "side";
  const tool = workspaceTools.find(tool => tool.id === primary);

  function resize(next: number) {
    onResize(Math.max(minimumSize, Math.min(maximumSize, Math.round(next))));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const increase = side ? "ArrowRight" : "ArrowDown";
    const decrease = side ? "ArrowLeft" : "ArrowUp";
    switch (event.key) {
      case increase: resize(size + 5); break;
      case decrease: resize(size - 5); break;
      case "Home": resize(minimumSize); break;
      case "End": resize(maximumSize); break;
      default: return;
    }
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const separator = event.currentTarget;
    const bounds = separator.parentElement?.getBoundingClientRect();
    if (!separator.hasPointerCapture(event.pointerId) || !bounds) return;
    const offset = side ? event.clientX - bounds.left : event.clientY - bounds.top;
    const length = side ? bounds.width : bounds.height;
    const gap = side ? separator.offsetWidth : separator.offsetHeight;
    if (length > gap) resize((offset - gap / 2) * 100 / (length - gap));
  }

  return <div className="workspace-separator" role="separator" tabIndex={0} aria-orientation={side ? "vertical" : "horizontal"}
    aria-label={`${tool?.label} 창 크기`} aria-controls={`workspace-pane-${primary}`}
    aria-valuemin={minimumSize} aria-valuemax={maximumSize} aria-valuenow={size} aria-valuetext={`${size}%`}
    onKeyDown={onKeyDown}
    onPointerDown={event => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={onPointerMove} />;
}
