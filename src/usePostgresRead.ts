import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function usePostgresRead<T>(command: string, args: Record<string, unknown> | null, revision = 0, retainWhileRefreshing = false) {
  const [result, setResult] = useState<{ args: Record<string, unknown>; revision: number; data: T | null; error: string } | null>(null);
  useEffect(() => {
    if (!args) return;
    let live = true;
    void invoke<T>(command, args).then(data => { if (live) setResult({ args, revision, data, error: "" }); })
      .catch(reason => { if (live) setResult({ args, revision, data: null, error: String(reason) }); });
    return () => { live = false; };
  }, [command, args, revision]);
  if (result?.args === args && result.revision === revision) return { ...result, loading: false };
  if (retainWhileRefreshing && result?.args === args && result.data !== null) return { ...result, loading: true };
  return { data: null, error: "", loading: args !== null };
}
