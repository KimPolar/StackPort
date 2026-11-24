import type { WorkspacePage } from "./WorkspaceNavigation";

export type SplitDirection = "side" | "stack";
export type ToolPane = { kind: "tool"; tool: WorkspacePage };
export type SplitPane = {
  kind: "split";
  id: number;
  direction: SplitDirection;
  size: number;
  first: WorkspaceLayout;
  second: WorkspaceLayout;
};
export type WorkspaceLayout = ToolPane | SplitPane;

export const toolPane = (tool: WorkspacePage): ToolPane => ({ kind: "tool", tool });

export function splitPane(id: number, direction: SplitDirection, first: WorkspaceLayout, second: WorkspaceLayout): SplitPane {
  return { kind: "split", id, direction, size: 50, first, second };
}

export function paneTools(layout: WorkspaceLayout): WorkspacePage[] {
  if (layout.kind === "tool") return [layout.tool];
  return [...paneTools(layout.first), ...paneTools(layout.second)];
}

export function editTool(layout: WorkspaceLayout, edit: (tool: WorkspacePage) => WorkspaceLayout): WorkspaceLayout {
  if (layout.kind === "tool") return edit(layout.tool);
  return { ...layout, first: editTool(layout.first, edit), second: editTool(layout.second, edit) };
}

export function replacePaneTool(layout: WorkspaceLayout, current: WorkspacePage, next: WorkspacePage): WorkspaceLayout {
  return editTool(layout, tool => {
    if (tool === current) return toolPane(next);
    if (tool === next) return toolPane(current);
    return toolPane(tool);
  });
}

export function removePaneTool(layout: WorkspaceLayout, target: WorkspacePage): WorkspaceLayout | null {
  if (layout.kind === "tool") return layout.tool === target ? null : layout;
  const first = removePaneTool(layout.first, target);
  const second = removePaneTool(layout.second, target);
  return first && second ? { ...layout, first, second } : first ?? second;
}

export function resizePane(layout: WorkspaceLayout, id: number, size: number): WorkspaceLayout {
  if (layout.kind === "tool") return layout;
  if (layout.id === id) return { ...layout, size };
  return { ...layout, first: resizePane(layout.first, id, size), second: resizePane(layout.second, id, size) };
}
