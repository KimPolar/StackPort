import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Grid2X2, PanelsTopLeft, Plus } from "lucide-react";
import { workspaceTools, type WorkspacePage } from "./WorkspaceNavigation";
import { paneTools, type SplitDirection, type SplitPane, type WorkspaceLayout } from "./WorkspaceLayout";

const minimumSize = 25;
const maximumSize = 75;
const dividerThickness = 10;
const maxPanes = 4;
const label = (tool: WorkspacePage) => workspaceTools.find(entry => entry.id === tool)?.label ?? tool;

export function WorkspaceSplitControls({ layout, tools, onToggle, onSelect, onDirectionChange, onAdd, onRemove, onGrid }: {
  layout: WorkspaceLayout;
  tools: WorkspacePage[];
  onToggle: () => void;
  onSelect: (previous: WorkspacePage, next: WorkspacePage) => void;
  onDirectionChange: (direction: SplitDirection) => void;
  onAdd: (target: WorkspacePage, direction: SplitDirection) => void;
  onRemove: (target: WorkspacePage) => void;
  onGrid: () => void;
}) {
  const [selectedArea, setSelectedArea] = useState<WorkspacePage | null>(null);
  const [nextDirection, setNextDirection] = useState<SplitDirection>("stack");
  const split = layout.kind === "split";
  const target = selectedArea && tools.includes(selectedArea) ? selectedArea : tools[0];

  return <div className="split-controls" role="group" aria-label="화면 배치">
    <button type="button" className="secondary small" aria-pressed={split} aria-controls="workspace-panes" onClick={onToggle}>
      <PanelsTopLeft size={15} aria-hidden /><span>화면 분할</span>
    </button>
    {split && tools.length === 2 && <>
      <select aria-label="두 번째 도구" title="두 번째 도구" value={tools[1]} onChange={event => onSelect(tools[1], event.target.value as WorkspacePage)}>
        {workspaceTools.filter(tool => tool.id !== tools[0]).map(tool => <option key={tool.id} value={tool.id}>{tool.label}</option>)}
      </select>
      <select aria-label="분할 방향" title="분할 방향" value={layout.direction} onChange={event => onDirectionChange(event.target.value as SplitDirection)}>
        <option value="side">좌우</option><option value="stack">상하</option>
      </select>
    </>}
    {split && <details className="split-options" onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}>
      <summary>배치 설정</summary>
      <div className="split-options-panel">
        <button className="secondary small" type="button" onClick={onGrid}><Grid2X2 size={14} aria-hidden /> 2×2 배치</button>
        <div className="field">
          <label htmlFor="split-edit-area">편집할 영역</label>
          <select id="split-edit-area" value={target} onChange={event => setSelectedArea(event.target.value as WorkspacePage)}>
            {tools.map(tool => <option key={tool} value={tool}>{label(tool)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="split-area-tool">영역에 표시할 도구</label>
          <select id="split-area-tool" value={target} onChange={event => {
            const next = event.target.value as WorkspacePage;
            onSelect(target, next);
            setSelectedArea(next);
          }}>
            {workspaceTools.map(tool => <option key={tool.id} value={tool.id}>{tool.label}</option>)}
          </select>
        </div>
        <div className="split-options-actions">
          <select aria-label="새 분할 방향" value={nextDirection} onChange={event => setNextDirection(event.target.value as SplitDirection)}>
            <option value="side">좌우</option><option value="stack">상하</option>
          </select>
          <button className="secondary small" type="button" disabled={tools.length >= maxPanes} onClick={() => onAdd(target, nextDirection)}><Plus size={14} aria-hidden /> 영역 나누기</button>
          <button className="secondary small" type="button" disabled={tools.length <= 2} onClick={() => onRemove(target)}>영역 닫기</button>
        </div>
      </div>
    </details>}
  </div>;
}

type Frame = { left: number; top: number; width: number; height: number };
type Placement = { kind: "tool"; tool: WorkspacePage; frame: Frame }
  | { kind: "separator"; split: SplitPane; frame: Frame; scope: Frame };

function placePanes(layout: WorkspaceLayout, frame: Frame): Placement[] {
  if (layout.kind === "tool") return [{ kind: "tool", tool: layout.tool, frame }];
  const side = layout.direction === "side";
  const length = side ? frame.width : frame.height;
  const gap = Math.min(dividerThickness, length);
  const firstSize = (length - gap) * layout.size / 100;
  const secondSize = length - gap - firstSize;
  const first = side ? { ...frame, width: firstSize } : { ...frame, height: firstSize };
  const divider = side ? { ...frame, left: frame.left + firstSize, width: gap } : { ...frame, top: frame.top + firstSize, height: gap };
  const second = side ? { ...frame, left: divider.left + gap, width: secondSize } : { ...frame, top: divider.top + gap, height: secondSize };
  return [...placePanes(layout.first, first), { kind: "separator", split: layout, frame: divider, scope: frame }, ...placePanes(layout.second, second)];
}

export function WorkspacePanes({ layout, panels, onResize }: {
  layout: WorkspaceLayout;
  panels: Partial<Record<WorkspacePage, ReactNode>>;
  onResize: (id: number, size: number) => void;
}) {
  const container = useRef<HTMLElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const positioned = layout.kind === "split";
  const placements = placePanes(layout, { left: 0, top: 0, ...bounds });
  const visible = paneTools(layout);
  const elements = placements.map(place => place.kind === "separator"
    ? <WorkspaceSeparator key={`split-${place.split.id}`} place={place} onResize={onResize} />
    : <div key={place.tool} className="workspace-pane-slot" style={positioned ? place.frame : undefined}>{panels[place.tool]}</div>);
  for (const [tool, panel] of Object.entries(panels)) {
    if (panel && !visible.includes(tool as WorkspacePage)) elements.push(<div key={tool} className="workspace-pane-slot" hidden>{panel}</div>);
  }
  return <main ref={container} id="workspace-panes" className="workspace-panes" aria-label="작업 공간" data-split={positioned ? "true" : undefined}>
    {elements}
  </main>;
}

function WorkspaceSeparator({ place, onResize }: {
  place: Extract<Placement, { kind: "separator" }>;
  onResize: (id: number, size: number) => void;
}) {
  const { split, frame, scope } = place;
  const { direction, size } = split;
  const side = direction === "side";
  const first = paneTools(split.first);

  function resize(next: number) {
    onResize(split.id, Math.max(minimumSize, Math.min(maximumSize, Math.round(next))));
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
    if (!separator.hasPointerCapture(event.pointerId)) return;
    const bounds = separator.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    const offset = side ? event.clientX - bounds.left - scope.left : event.clientY - bounds.top - scope.top;
    const length = side ? scope.width : scope.height;
    const gap = side ? frame.width : frame.height;
    if (length > gap) resize((offset - gap / 2) * 100 / (length - gap));
  }

  return <div className="workspace-separator" role="separator" tabIndex={0} aria-orientation={side ? "vertical" : "horizontal"} style={frame}
    aria-label={`${first.map(label).join(" · ")} 창 크기`} aria-controls={first.map(tool => `workspace-pane-${tool}`).join(" ")}
    aria-valuemin={minimumSize} aria-valuemax={maximumSize} aria-valuenow={size} aria-valuetext={`${size}%`}
    onKeyDown={onKeyDown}
    onPointerDown={event => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={onPointerMove} />;
}
