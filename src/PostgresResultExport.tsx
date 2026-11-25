import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PostgresParameterDialog, type PostgresBindings, type PostgresParameter } from "./PostgresParameterDialog";
import { ResultFileDialog, type ExportDriver, type ExportFileOptions, type ExportOutcome, type ExportReport } from "./ResultExportDialog";

export type PostgresScope = { kind: "document" } | { kind: "selection"; start: number; end: number } | { kind: "current"; cursor: number };
export type PostgresExportTarget = { session: string; source: string; scope: PostgresScope; title: string; bindings?: PostgresBindings };
type NativeOutcome = { status: "exported"; report: ExportReport } |
  { status: "failed"; error: string } |
  { status: "interrupted"; timed_out: boolean } |
  { status: "parameters_required"; parameters: PostgresParameter[]; error: string | null; parameter_scope: string };
type Prompt = { token: string; parameters: PostgresParameter[]; error: string | null; parameterScope: string };

export function PostgresResultExport({ profile, projectId, target, unavailable, onClose, onExported }: {
  profile: { name: string; environment: string };
  projectId: string;
  target: PostgresExportTarget;
  unavailable: string;
  onClose: () => void;
  onExported: (report: ExportReport) => void;
}) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelStatus, setCancelStatus] = useState("");
  const [written, setWritten] = useState(0);
  const resolveValues = useRef<((value: PostgresBindings | null) => void) | null>(null);
  const connectionError = useRef(unavailable);
  connectionError.current = unavailable;

  function answer(value: PostgresBindings | null) {
    const resolve = resolveValues.current;
    if (!resolve) return;
    resolveValues.current = null;
    if (value) setSubmitting(true);
    resolve(value);
  }

  useEffect(() => () => { resolveValues.current?.(null); resolveValues.current = null; }, []);
  useEffect(() => { if (unavailable) { resolveValues.current?.(null); resolveValues.current = null; } }, [unavailable]);

  const cancelQuery = (token: string) => invoke<boolean>("cancel_postgres_sql", { id: target.session, request: token });
  async function run(token: string, options: ExportFileOptions): Promise<ExportOutcome> {
    let bindings = target.bindings;
    setWritten(0);
    try {
      for (;;) {
        if (connectionError.current) throw new Error(connectionError.current);
        const response = await invoke<NativeOutcome & { connection_closed: boolean }>("execute_postgres_sql", {
          id: target.session, request: token, source: target.source, scope: target.scope, bindings,
          export: { ...options, format: options.format.toLowerCase() },
        });
        if (response.status === "exported") return response;
        if (response.status === "interrupted") return { status: response.timed_out ? "timed_out" : "cancelled" };
        if (response.status === "failed") throw new Error(response.error);
        if (response.status !== "parameters_required" || response.connection_closed) {
          throw new Error("PostgreSQL 연결을 확인한 뒤 다시 내보내세요.");
        }
        if (connectionError.current) throw new Error(connectionError.current);
        if (target.bindings) throw new Error("그리드에서 필터를 다시 적용한 뒤 내보내세요.");
        setSubmitting(false); setCancelStatus("");
        const next = await new Promise<PostgresBindings | null>(resolve => {
          resolveValues.current = resolve;
          setPrompt({ token, parameters: response.parameters, error: response.error, parameterScope: response.parameter_scope });
        });
        if (!next) return { status: "cancelled" };
        bindings = next;
      }
    } finally {
      setPrompt(null); setSubmitting(false); setCancelStatus("");
    }
  }

  async function cancelPromptQuery(token: string) {
    setCancelStatus("취소 요청 중…");
    try {
      if (!await cancelQuery(token)) setCancelStatus("내보내기 상태를 확인하고 있습니다.");
    } catch (error) { setCancelStatus(String(error)); }
  }

  const driver: ExportDriver = {
    prepare: async () => crypto.randomUUID(),
    run,
    progress: async token => {
      const progress = await invoke<number | null>("postgres_export_progress", { id: target.session, request: token });
      if (progress !== null) setWritten(progress);
      return progress;
    },
    cancel: cancelQuery,
  };
  return <>
    <ResultFileDialog profile={profile} source={target.title} driver={driver} onClose={onClose} onExported={onExported} unavailable={unavailable} />
    {prompt && !unavailable && <PostgresParameterDialog key={prompt.parameterScope}
      parameters={prompt.parameters} title={target.title} error={prompt.error} running={submitting}
      setScope={{ project_id: projectId, engine: "postgres", key: prompt.parameterScope }}
      cancelStatus={cancelStatus || String(written) + "행 기록 · 파일을 만드는 중"}
      onSubmit={answer} onClose={() => answer(null)} onCancelQuery={() => void cancelPromptQuery(prompt.token)} />}
  </>;
}
