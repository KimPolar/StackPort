import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

export type FavoriteScope = "personal" | "project";
export type FavoriteTarget = { kind: "sqlite" | "postgres" | "ssh"; profile_id: string }
  | { kind: "sqlite_object"; profile_id: string; object_name: string };
type Favorite = { scope: FavoriteScope; target: FavoriteTarget };
type Snapshot = { projectId: string; items: Favorite[] };

export function favoriteKey(target: FavoriteTarget) {
  return JSON.stringify([target.kind, target.profile_id, "object_name" in target ? target.object_name : ""]);
}

export function useWorkspaceFavorites(projectId: string, desktop: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<{ projectId: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const active = useRef(projectId);
  active.current = projectId;

  const refresh = useCallback(async () => {
    if (!desktop || !projectId || active.current !== projectId) return;
    const ticket = ++generation.current;
    try {
      const items = await invoke<Favorite[]>("list_workspace_favorites", { projectId });
      if (active.current === projectId && ticket === generation.current) {
        setSnapshot({ projectId, items });
        setError(null);
      }
    } catch (reason) {
      if (active.current === projectId && ticket === generation.current) setError({ projectId, message: String(reason) });
    }
  }, [desktop, projectId]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { generation.current++; window.removeEventListener("focus", refresh); };
  }, [refresh]);

  async function change(scope: FavoriteScope, target: FavoriteTarget, present: boolean) {
    if (pending.current || !desktop || !projectId || snapshot?.projectId !== projectId) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await invoke("set_workspace_favorite", { projectId, scope, target, present });
      await refresh();
    } catch (reason) {
      if (active.current === projectId) setError({ projectId, message: String(reason) });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return {
    items: snapshot?.projectId === projectId ? snapshot.items : [],
    ready: snapshot?.projectId === projectId,
    error: error?.projectId === projectId ? error.message : "",
    busy, refresh, change,
  };
}

export type WorkspaceFavorites = ReturnType<typeof useWorkspaceFavorites>;
