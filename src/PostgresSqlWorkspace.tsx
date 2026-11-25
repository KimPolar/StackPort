import { useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowRight, FileDown, FolderOpen, GitBranch, Play, Square } from "lucide-react";
import { CodeTextarea } from "./CodeTextarea";
import { Dialog } from "./Dialog";
import { GridCopyControls, GridSelectionButton, GridSelectPage, GridSelectRow, postgresCopyCell, useGridRowSelection } from "./GridRowSelection";
import { PostgresParameterDialog, type PostgresBindings, type PostgresParameter } from "./PostgresParameterDialog";
import { PostgresQueryPlan, type PostgresPlan } from "./PostgresQueryPlan";
import type { PostgresExportTarget, PostgresScope } from "./PostgresResultExport";
import { PostgresScriptResults, type PostgresScriptOutcome } from "./PostgresScriptResults";
import { sqlTabButtonId, sqlTabPanelId, sqlTabTitle, SqlTabStrip, type SqlDraft, type SqlTabSet } from "./SqlTabs";
import type { QueryActivity } from "./WorkspaceStatus";

export type PostgresEditorState = {
  tabs: SqlTabSet;
  select: (id: string) => void;
  add: (text?: string) => void;
  close: (draft: SqlDraft) => void;
  edit: (id: string, text: string) => void;
  openFile: () => void;
  saveFile: (draft: SqlDraft) => void;
};

type Mode = "query" | "estimate" | "analyze" | "script";
type ResultView = "data" | "plan" | "script";
export type PostgresCell = { value: string | null; truncated: boolean };
type Completed = { status: "completed"; columns: { name: string; data_type: string }[]; rows: PostgresCell[][];
  total_columns: number; more_rows: boolean; elapsed_ms: number };
type QueryStatus = Completed | { status: "plan"; plan: PostgresPlan } | { status: "failed"; error: string; position?: number | null } |
  { status: "interrupted"; timed_out: boolean; server_confirmed: boolean } | { status: "script"; script: PostgresScriptOutcome };
type ParametersNeeded = { status: "parameters_required"; parameters: PostgresParameter[]; error: string | null };
type Outcome = (QueryStatus | ParametersNeeded) & { connection_closed?: boolean };
type Preview = { id: string; target: QueryTarget; outcome: QueryStatus };
type TabPreview = { tab: string; active: ResultView } & Partial<Record<ResultView, Preview>>;
type ScriptTarget = PostgresExportTarget & { tab: string; mode: "script"; autocommit: boolean; confirmation: string; exportDestination?: string };
type QueryTarget = (PostgresExportTarget & { tab: string; mode: Exclude<Mode, "script"> }) | ScriptTarget;
type Running = QueryTarget & { request: string };
type ParameterRequest = { id: string; target: QueryTarget; parameters: PostgresParameter[]; error: string | null };
const editorId = "postgres-sql-editor";
const resultPageSize = 25;
const retainedPreviews = 4;
const resultViews: ResultView[] = ["data", "plan", "script"];
const viewNames: Record<ResultView, string> = { data: "조회 결과", plan: "계획 결과", script: "스크립트 결과" };
const resultView = (mode: Mode): ResultView => mode === "query" ? "data" : mode === "script" ? "script" : "plan";
const modeNames: Record<Mode, string> = { query: "쿼리 실행", estimate: "실행 계획", analyze: "실행 분석", script: "스크립트 실행" };

export function PostgresSqlWorkspace({ session, environment, editor, onExport, onQueryActivity }: {
  session: string | null;
  environment: string;
  editor: PostgresEditorState;
  onExport: (target: PostgresExportTarget) => void;
  onQueryActivity: (activity: QueryActivity) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const active = useRef<Running | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [written, setWritten] = useState(0);
  const [cancelStatus, setCancelStatus] = useState("");
  const [selection, setSelection] = useState<{ tab: string; start: number; end: number } | null>(null);
  const [previews, setPreviews] = useState<TabPreview[]>([]);
  const [parameterRequest, setParameterRequest] = useState<ParameterRequest | null>(null);
  const [analysisTarget, setAnalysisTarget] = useState<QueryTarget | null>(null);
  const [scriptMode, setScriptMode] = useState(false);
  const [autocommit, setAutocommit] = useState(true);
  const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
  const { tabs, select, add, close, edit, openFile, saveFile } = editor;
  const draft = tabs.tabs.find(item => item.id === tabs.activeId);
  const tabPreview = previews.find(item => item.tab === tabs.activeId);
  const availableViews = resultViews.filter(view => tabPreview?.[view]);
  const source = draft?.document.text ?? "";
  const selected = selection && selection.tab === draft?.id && selection.start !== selection.end
    ? source.slice(selection.start, selection.end) : "";
  const busy = running !== null;
  const exporting = running?.mode === "script" && running.exportDestination ? running : null;
  const exportProgress = exporting ? `${written.toLocaleString("ko-KR")}행 기록 · 결과 파일 만드는 중…` : "";
  const cannotRun = !session || busy || !source.trim();
  const activity = session && running?.session === session
    ? cancelStatus === "취소 요청 중…" ? "cancelling" : "running" : null;
  useEffect(() => {
    onQueryActivity(activity);
    return () => onQueryActivity(null);
  }, [activity, onQueryActivity]);
  useEffect(() => {
    if (!exporting) return;
    let pending = false;
    const timer = window.setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const rows = await invoke<number | null>("postgres_export_progress", { id: exporting.session, request: exporting.request });
        if (rows !== null && active.current === exporting) setWritten(rows);
      } catch {
        // The execution response reports file errors.
      } finally { pending = false; }
    }, 400);
    return () => window.clearInterval(timer);
  }, [exporting]);

  async function run(target: QueryTarget, bindings?: PostgresBindings, parameters?: PostgresParameter[]) {
    if (session !== target.session || active.current || !target.source.trim()) return;
    const operation: Running = { ...target, request: crypto.randomUUID() };
    active.current = operation;
    setRunning(operation);
    setCancelStatus("");
    setWritten(0);
    let outcome: Outcome;
    try {
      const request = { id: target.session, request: operation.request };
      const sql = { source: target.source, scope: target.scope };
      if (target.mode === "script") {
        const script = await invoke<PostgresScriptOutcome | { status: "parameters_required"; parameter_indexes: number[] }>("execute_postgres_script", {
          ...request, input: { ...sql, autocommit: target.autocommit, confirmation: target.confirmation,
            export_destination: target.exportDestination,
            bindings: bindings && parameters?.map(({ index }, offset) => ({ index, value: bindings.values[offset] })),
          },
        });
        outcome = script.status === "parameters_required"
          ? { status: "parameters_required", error: null,
            parameters: script.parameter_indexes.map(index => ({ index, oid: 0, data_type: "서버에서 타입 추론" })) }
          : { status: "script", script };
      } else {
        outcome = await invoke<Outcome>("execute_postgres_sql", { ...request, ...sql, bindings, mode: target.mode });
      }
    } catch (error) { outcome = { status: "failed", error: String(error) }; }
    active.current = null;
    setRunning(null);
    setCancelStatus("");
    if (outcome.status === "parameters_required" && !outcome.connection_closed) {
      const { parameters, error } = outcome;
      setParameterRequest(previous => {
        const sameTypes = previous?.parameters.length === parameters.length && parameters.every((item, index) =>
          item.oid === previous.parameters[index].oid && item.index === previous.parameters[index].index);
        const id = previous?.target === target && sameTypes ? previous.id : operation.request;
        return { id, target, parameters, error };
      });
      return;
    }
    setParameterRequest(null);
    const result: QueryStatus = outcome.status === "parameters_required"
      ? { status: "failed", error: "PostgreSQL 연결을 다시 연 뒤 매개변수를 입력하세요." } : outcome;
    const view = resultView(target.mode);
    setPreviews(previous => {
      const existing = previous.find(item => item.tab === target.tab);
      return [{ ...existing, tab: target.tab, active: view, [view]: { id: operation.request, target, outcome: result } },
        ...previous.filter(item => item.tab !== target.tab)].slice(0, retainedPreviews);
    });
  }

  async function stop() {
    if (!running || cancelStatus === "취소 요청 중…") return;
    setCancelStatus("취소 요청 중…");
    try {
      const accepted = await invoke<boolean>("cancel_postgres_sql", { id: running.session, request: running.request });
      if (!accepted && active.current === running) setCancelStatus("실행 상태를 확인하는 중입니다. 잠시 후 다시 시도할 수 있습니다.");
    } catch (error) {
      if (active.current === running) setCancelStatus(String(error));
    }
  }

  function execute(current: boolean, mode: Mode = scriptMode ? "script" : "query", field = input.current,
    options: { whole?: boolean; exportResults?: boolean } = {}) {
    if (!field || !session || !draft || cannotRun || active.current ||
      parameterRequest?.target.session === session || analysisTarget?.session === session || scriptTarget?.session === session) return;
    const { selectionStart: start, selectionEnd: end } = field;
    const scope: PostgresScope = current ? { kind: "current", cursor: start } : options.whole || start === end ? { kind: "document" } : { kind: "selection", start, end };
    const target = { session, tab: draft.id, title: sqlTabTitle(draft), source, scope };
    if (mode === "script") {
      const script: ScriptTarget = { ...target, mode, autocommit, confirmation: "", exportDestination: options.exportResults ? "" : undefined };
      if (environment === "PROD" || options.exportResults) setScriptTarget(script);
      else void run(script);
    } else if (mode === "analyze") setAnalysisTarget({ ...target, mode });
    else void run({ ...target, mode });
  }

  function showResult(view: ResultView) {
    setPreviews(previous => previous.map(item => item.tab === tabs.activeId ? { ...item, active: view } : item));
  }

  function closeTab(item: SqlDraft) {
    if (item.id !== running?.tab) close(item);
  }

  const fileActions = <div className="sql-file-actions">
    <button type="button" className="secondary small" onClick={openFile}><FolderOpen size={14} aria-hidden /> SQL 파일 열기</button>
    <button type="button" className="secondary small" disabled={!draft} onClick={() => draft && saveFile(draft)}><FileDown size={14} aria-hidden /> SQL 파일로 저장</button>
  </div>;
  return <div className="postgres-sql">
    <section className="editor-card" aria-label="PostgreSQL SQL 편집기">
      <div className="panel-heading">
        <strong>SQL 편집기</strong>
        <div className="sql-editor-actions">
          <button type="button" className="secondary small" title="Ctrl+Shift+Enter" disabled={cannotRun}
            onClick={() => execute(true)}>현재 문장 실행</button>
          {!scriptMode && <><button type="button" className="secondary small" disabled={cannotRun} onClick={() => execute(false, "estimate")}>
            <GitBranch size={14} aria-hidden /> 실행 계획</button>
          <button type="button" className="secondary small" disabled={cannotRun} onClick={() => execute(false, "analyze")}>실행 분석</button></>}
          {scriptMode && selected && <button type="button" className="secondary small" disabled={cannotRun}
            onClick={() => execute(false, "script", input.current, { whole: true })}>전체 실행</button>}
          {scriptMode && <button type="button" className="secondary small" disabled={cannotRun}
            onClick={() => execute(false, "script", input.current, { exportResults: true })}><FileDown size={14} aria-hidden /> 실행 및 저장</button>}
          <button type="button" className="primary small" title="Ctrl+Enter" disabled={!session || busy || !(selected || source).trim()}
            onClick={() => execute(false)}><Play size={14} aria-hidden />{selected ? "선택 영역 실행" : scriptMode ? "전체 실행" : "쿼리 실행"}</button>
          {busy && <button type="button" className="secondary small" disabled={cancelStatus === "취소 요청 중…"}
            onClick={() => void stop()}><Square size={13} aria-hidden /> 쿼리 취소</button>}
        </div>
      </div>
      <div className="postgres-script-toolbar">
        <div className="postgres-result-views" role="group" aria-label="PostgreSQL SQL 실행 모드">
          <button type="button" className="secondary small" aria-pressed={!scriptMode} disabled={busy}
            onClick={() => setScriptMode(false)}>읽기 전용 조회</button>
          <button type="button" className="secondary small" aria-pressed={scriptMode} disabled={busy}
            onClick={() => setScriptMode(true)}>SQL 스크립트</button>
        </div>
        {scriptMode && <label className="files-check"><input type="checkbox" checked={autocommit} disabled={busy}
          onChange={event => setAutocommit(event.target.checked)} /> 자동 커밋</label>}
      </div>
      {scriptMode && <p className="form-note postgres-page-note">자동 커밋을 끄면 스크립트의 COMMIT으로 변경을 저장합니다. 실행 종료 시 열린 트랜잭션은 롤백합니다.</p>}
      <SqlTabStrip group={tabs} onSelect={id => { setSelection(null); select(id); }} onNew={() => add()} onClose={closeTab}
        closeDisabledFor={running?.tab} />
      {tabs.tabs.map(item => <div key={item.id} role="tabpanel" id={sqlTabPanelId(item.id)}
        aria-labelledby={sqlTabButtonId(item.id)} hidden={item.id !== tabs.activeId}>
        {item.id === draft?.id && <>
          <label className="sr-only" htmlFor={editorId}>PostgreSQL SQL 쿼리</label>
          <CodeTextarea id={editorId} editorRef={input} language="postgres" value={source} spellCheck={false} footer={fileActions}
            placeholder={'SELECT *\nFROM 스키마.테이블;'}
            onChange={event => edit(draft.id, event.target.value)}
            onSelect={event => setSelection({ tab: draft.id, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
              if (event.key === "Enter") { event.preventDefault(); execute(event.shiftKey, undefined, event.currentTarget); }
              else if (event.key.toLowerCase() === "s") { event.preventDefault(); saveFile(draft); }
            }} />
        </>}
      </div>)}
      {!draft && <><p className="sql-tabs-empty">열린 SQL 탭이 없습니다.</p><div className="editor-footer">{fileActions}</div></>}
    </section>
    {!session && <p className="form-note">PostgreSQL에 연결하면 SQL을 실행할 수 있습니다.</p>}
    {running && <p className="form-note" role="status">{cancelStatus || exportProgress || `${running.title} · ${modeNames[running.mode]} 중…`}</p>}
    {tabPreview && availableViews.length > 1 && <div className="postgres-result-views" role="group" aria-label="PostgreSQL 결과 보기">
      {availableViews.map(view => <button key={view} type="button" className="secondary small"
        aria-pressed={tabPreview.active === view} onClick={() => showResult(view)}>{viewNames[view]}</button>)}
    </div>}
    {tabPreview && resultViews.map(view => {
      const preview = tabPreview[view];
      if (!preview) return null;
      const pending = running?.tab === tabs.activeId && view === resultView(running.mode);
      return <div key={view} className="postgres-sql-result" hidden={tabPreview.active !== view || pending}>
        <PostgresSqlResult key={preview.id} outcome={preview.outcome}
          onExport={!running && session === preview.target.session && preview.outcome.status === "completed"
            ? () => onExport({ ...preview.target, title: `${preview.target.title}에서 마지막 실행한 문장` }) : undefined}
          jump={source === preview.target.source ? position => {
          input.current?.focus();
          input.current?.setSelectionRange(position, position);
        } : undefined} />
      </div>;
    })}
    {analysisTarget && session === analysisTarget.session && <Dialog title="PostgreSQL 실행 분석" busy={false}
      onClose={() => { setAnalysisTarget(null); requestAnimationFrame(() => input.current?.focus()); }}>
      <div className="workspace-exit-body">
        <p className="confirm-copy"><strong>{analysisTarget.title}</strong>의 조회를 서버에서 실제로 실행해 시간, 행 수와 버퍼 사용량을 측정합니다. 서버 실행 제한은 8초입니다.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" autoFocus onClick={() => setAnalysisTarget(null)}>취소</button>
          <button type="button" className="primary" onClick={() => { setAnalysisTarget(null); void run(analysisTarget); }}>분석 실행</button>
        </div>
      </div>
    </Dialog>}
    {scriptTarget && session === scriptTarget.session && <ScriptRunDialog target={scriptTarget} environment={environment}
      onClose={() => { setScriptTarget(null); requestAnimationFrame(() => input.current?.focus()); }}
      onRun={target => { setScriptTarget(null); void run(target); }} />}
    {parameterRequest && session === parameterRequest.target.session && <PostgresParameterDialog key={parameterRequest.id}
      parameters={parameterRequest.parameters} title={`${parameterRequest.target.title} · ${modeNames[parameterRequest.target.mode]}`} error={parameterRequest.error}
      running={busy} cancelStatus={cancelStatus || exportProgress} onSubmit={bindings => void run(parameterRequest.target, bindings, parameterRequest.parameters)}
      onClose={() => { setParameterRequest(null); requestAnimationFrame(() => input.current?.focus()); }}
      onCancelQuery={() => void stop()} />}
  </div>;
}

function ScriptRunDialog({ target, environment, onClose, onRun }: {
  target: ScriptTarget;
  environment: string;
  onClose: () => void;
  onRun: (target: ScriptTarget) => void;
}) {
  const pathId = useId();
  const [confirmation, setConfirmation] = useState("");
  const [destination, setDestination] = useState(target.exportDestination ?? "");
  const [error, setError] = useState("");
  const exporting = target.exportDestination !== undefined;
  const production = environment === "PROD";
  const enabled = (!production || confirmation === "PROD") && (!exporting || Boolean(destination.trim()));

  async function chooseFolder() {
    setError("");
    try {
      const folder = await invoke<string | null>("choose_result_export_directory");
      if (folder) {
        const separator = /[\\/]$/.test(folder) ? "" : folder.includes("\\") ? "\\" : "/";
        setDestination(`${folder}${separator}stackport-script-results.json`);
      }
    } catch (error) { setError(String(error)); }
  }

  return <Dialog title={exporting ? "스크립트 실행 및 저장" : "운영 스크립트 실행"} busy={false} onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      if (enabled) onRun({ ...target, confirmation, exportDestination: exporting ? destination.trim() : undefined });
    }}>
      <p className="form-note"><strong>{target.title}</strong> · {environment}
        {exporting ? " · 이번 실행의 문장별 전체 결과를 JSON으로 저장합니다." : " · 운영 PostgreSQL에 스크립트를 실행합니다."}
      </p>
      {exporting && <div className="field"><label htmlFor={pathId}>새 JSON 파일 경로</label><span className="file-input">
        <input id={pathId} required autoFocus value={destination} placeholder="새 파일의 절대 경로"
          onChange={event => setDestination(event.target.value)} />
        <button type="button" className="secondary" onClick={() => void chooseFolder()}>폴더 선택</button>
      </span></div>}
      {production && <label className="field">운영 확인<input autoFocus={!exporting} value={confirmation} placeholder="PROD"
        onChange={event => setConfirmation(event.target.value)} /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>취소</button>
        <button type="submit" className="primary" disabled={!enabled}>{exporting ? "실행 및 JSON 저장" : "스크립트 실행"}</button>
      </div>
    </form>
  </Dialog>;
}

export function PostgresValue({ cell, display }: { cell: PostgresCell; display?: string }) {
  return cell.value === null ? <span className="postgres-null">NULL</span> :
    <code>{display ?? cell.value}{cell.truncated && <span title="512자 미리보기">…</span>}</code>;
}

function PostgresSqlResult({ outcome, jump, onExport }: { outcome: QueryStatus; jump?: (position: number) => void; onExport?: () => void }) {
  const [page, setPage] = useState(0);
  const start = page * resultPageSize;
  const snapshot = useMemo(() => ({ outcome, page }), [outcome, page]);
  const length = outcome.status === "completed" ? Math.max(0, Math.min(outcome.rows.length - start, resultPageSize)) : 0;
  const rowSelection = useGridRowSelection(snapshot, length);
  if (outcome.status === "script") return <PostgresScriptResults outcome={outcome.script} jump={jump} />;
  if (outcome.status === "plan") return <PostgresQueryPlan plan={outcome.plan} />;
  if (outcome.status === "failed") return <div className="error-banner" role="alert">
    {outcome.error}
    {outcome.position != null && jump && <button type="button" className="secondary small"
      onClick={() => jump(outcome.position ?? 0)}>오류 위치로 이동</button>}
  </div>;
  if (outcome.status === "interrupted") return <div className="query-notice" role="status">
    {outcome.timed_out ? outcome.server_confirmed ? "서버가 쿼리를 중단했습니다. 실행 제한은 8초입니다." : "응답 시간이 초과됐습니다."
      : outcome.server_confirmed ? "PostgreSQL 서버에서 쿼리 중단을 확인했습니다." : "쿼리를 보내기 전에 취소했습니다."}
  </div>;
  const rows = outcome.rows.slice(start, start + resultPageSize);
  return <section className="postgres-data results-card" aria-label="PostgreSQL SQL 조회 결과">
    <div className="panel-heading"><strong>마지막 실행 결과</strong>
      <div className="sql-editor-actions"><span className="result-count">{outcome.rows.length}행 · {outcome.elapsed_ms}ms</span>
        {rows.length > 0 && <GridSelectionButton selection={rowSelection} />}
        {onExport && <button type="button" className="secondary small" onClick={onExport}>결과 내보내기</button>}
      </div></div>
    {(outcome.more_rows || outcome.total_columns > outcome.columns.length) && <p className="form-note postgres-page-note">
      미리보기 {outcome.more_rows && "100행"}{outcome.more_rows && outcome.total_columns > outcome.columns.length && " · "}
      {outcome.total_columns > outcome.columns.length && `전체 ${outcome.total_columns}열 중 ${outcome.columns.length}열`}
    </p>}
    {rowSelection.active && rows.length > 0 && <GridCopyControls selection={rowSelection} startRow={start + 1}
      columns={outcome.columns.map(column => column.name)} readCell={(row, column) => postgresCopyCell(rows[row][column], outcome.columns[column].data_type)} />}
    {rows.length ? <div className="table-wrap" tabIndex={0} role="region" aria-label="PostgreSQL SQL 데이터 스크롤">
      <table aria-label="PostgreSQL SQL 데이터"><thead><tr>{rowSelection.active && <th scope="col" className="grid-row-select"><GridSelectPage selection={rowSelection} /></th>}
        {outcome.columns.map((column, index) => <th key={index} scope="col">
        {column.name}<small>{column.data_type}</small></th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr key={start + rowIndex} data-grid-selected={rowSelection.rows.has(rowIndex) || undefined}>
          {rowSelection.active && <td className="grid-row-select"><GridSelectRow selection={rowSelection} index={rowIndex} rowNumber={start + rowIndex + 1} /></td>}
          {row.map((cell, column) =>
          <td key={column}><PostgresValue cell={cell} /></td>)}</tr>)}</tbody>
      </table>
    </div> : <p className="result-empty">조회된 행이 없습니다.</p>}
    {outcome.rows.length > resultPageSize && <div className="pagination">
      <span>페이지 {page + 1} / {Math.ceil(outcome.rows.length / resultPageSize)}</span><div>
        <button type="button" className="icon-button" disabled={!page} aria-label="이전 SQL 결과 페이지"
          onClick={() => setPage(page - 1)}><ArrowLeft size={15} aria-hidden /></button>
        <button type="button" className="icon-button" disabled={start + resultPageSize >= outcome.rows.length}
          aria-label="다음 SQL 결과 페이지" onClick={() => setPage(page + 1)}><ArrowRight size={15} aria-hidden /></button>
      </div>
    </div>}
  </section>;
}
