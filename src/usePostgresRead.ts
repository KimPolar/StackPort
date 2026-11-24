import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function usePostgresRead<T>(command: string, args: Record<string, unknown> | null, revision = 0) {
  const [result, setResult] = useState<{ args: Record<string, unknown>; revision: number; data: T | null; error: string } | null>(null);
  useEffect(() => {
    if (!args) return;
    let live = true;
    void invoke<T>(command, args).then(data => { if (live) setResult({ args, revision, data, error: "" }); })
      .catch(reason => { if (live) setResult({ args, revision, data: null, error: String(reason) }); });
    return () => { live = false; };
  }, [command, args, revision]);
  return result?.args === args && result.revision === revision ? { ...result, loading: false } : { data: null, error: "", loading: args !== null };
}
