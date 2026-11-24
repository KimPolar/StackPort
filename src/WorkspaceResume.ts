import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type SplitDirection, type ToolPane, type WorkspaceLayout } from "./WorkspaceLayout";

type SavedLayout = ToolPane | { kind: "split"; direction: SplitDirection; size: number; first: SavedLayout; second: SavedLayout };
export type ResumeState = { project_id: string | null; profile_id: string | null; explorer_open: boolean; layout: SavedLayout };
export type ResumeRecord = { revision: number; state: ResumeState | null; recovered: boolean };
type ResumeWrite = { status: "saved" | "conflict"; revision: number };
type ResumeNotice = { message: string; retry: boolean };

export function saveLayout(layout: WorkspaceLayout): SavedLayout {
  if (layout.kind === "tool") return layout;
  const { direction, size, first, second } = layout;
  return { kind: "split", direction, size, first: saveLayout(first), second: saveLayout(second) };
}

export function restoreLayout(layout: SavedLayout, nextId: () => number): WorkspaceLayout {
  if (layout.kind === "tool") return layout;
  return { ...layout, id: nextId(), first: restoreLayout(layout.first, nextId), second: restoreLayout(layout.second, nextId) };
}

export function useWorkspaceResume(state: ResumeState | null) {
  const [notice, setNotice] = useState<ResumeNotice | null>(null);
  const current = useRef<{ state: ResumeState; fingerprint: string } | null>(null);
  const revision = useRef<number | null>(null);
  const fingerprint = useRef<string | null>(null);
  const blocked = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const stateKey = state ? JSON.stringify(state) : null;
  current.current = state && stateKey ? { state, fingerprint: stateKey } : null;

  const initialize = useCallback((record: ResumeRecord, initialState: ResumeState) => {
    revision.current = record.revision;
    fingerprint.current = JSON.stringify(initialState);
    if (record.recovered) {
      setNotice({
        message: record.state ? "이전 작업 공간 배치를 복구했습니다." : "저장된 배치를 읽을 수 없어 기본 작업 공간으로 열었습니다.",
        retry: false,
      });
    }
  }, []);

  const flush = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    if (blocked.current || revision.current === null) return Promise.resolve();

    async function save() {
      while (current.current && current.current.fingerprint !== fingerprint.current) {
        const pending = current.current;
        const output = await invoke<ResumeWrite>("save_workspace_resume", { expectedRevision: revision.current, state: pending.state });
        revision.current = output.revision;
        if (output.status === "conflict") {
          blocked.current = true;
          setNotice({ message: "다른 창에서 작업 공간 배치를 저장했습니다.", retry: true });
          return;
        }
        fingerprint.current = pending.fingerprint;
        setNotice(null);
      }
    }
    inFlight.current = save().catch(() => {
      blocked.current = true;
      setNotice({ message: "작업 공간 배치를 저장하지 못했습니다.", retry: true });
    }).finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, []);

  useEffect(() => {
    if (!stateKey) return;
    const timer = window.setTimeout(() => void flush(), 300);
    return () => window.clearTimeout(timer);
  }, [stateKey, flush]);

  function retry() {
    blocked.current = false;
    void flush();
  }

  return { initialize, flush, notice, retry };
}
