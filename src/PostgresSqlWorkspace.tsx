import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowRight, FileDown, FolderOpen, GitBranch, Play, Square } from "lucide-react";
import { CodeTextarea } from "./CodeTextarea";
import { Dialog } from "./Dialog";
import { PostgresParameterDialog, type PostgresBindings, type PostgresParameter } from "./PostgresParameterDialog";
import { PostgresQueryPlan, type PostgresPlan } from "./PostgresQueryPlan";
import { sqlTabButtonId, sqlTabPanelId, sqlTabTitle, SqlTabStrip, type SqlDraft, type SqlTabSet } from "./SqlTabs";

export type PostgresEditorState = {
  tabs: SqlTabSet;
  select: (id: string) => void;
  add: (text?: string) => void;
  close: (draft: SqlDraft) => void;
  edit: (id: string, text: string) => void;
  openFile: () => void;
  saveFile: (draft: SqlDraft) => void;
};

type Scope = { kind: "document" } | { kind: "selection"; start: number; end: number } | { kind: "current"; cursor: number };
type Mode = "query" | "estimate" | "analyze";
type ResultView = "data" | "plan";
export type PostgresCell = { value: string | null; truncated: boolean };
type Completed = { status: "completed"; columns: { name: string; data_type: string }[]; rows: PostgresCell[][];
  total_columns: number; more_rows: boolean; elapsed_ms: number };
type QueryStatus = Completed | { status: "plan"; plan: PostgresPlan } | { status: "failed"; error: string; position?: number | null } |
  { status: "interrupted"; timed_out: boolean; server_confirmed: boolean };
type ParametersNeeded = { status: "parameters_required"; parameters: PostgresParameter[]; error: string | null };
type Outcome = (QueryStatus | ParametersNeeded) & { connection_closed?: boolean };
type Preview = { id: string; source: string; outcome: QueryStatus };
type TabPreview = { tab: string; active: ResultView; data?: Preview; plan?: Preview };
type QueryTarget = { session: string; tab: string; title: string; source: string; scope: Scope; mode: Mode };
type Running = QueryTarget & { request: string };
type ParameterRequest = { id: string; target: QueryTarget; parameters: PostgresParameter[]; error: string | null };
const editorId = "postgres-sql-editor";
const resultPageSize = 25;
const retainedPreviews = 4;
const resultViews: ResultView[] = ["data", "plan"];
const resultView = (mode: Mode): ResultView => mode === "query" ? "data" : "plan";
const modeNames: Record<Mode, string> = { query: "쿼리 실행", estimate: "실행 계획", analyze: "실행 분석" };

export function PostgresSqlWorkspace({ session, editor, onClosed }: {
  session: string | null;
  editor: PostgresEditorState;
  onClosed: (id: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const active = useRef<Running | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [cancelStatus, setCancelStatus] = useState("");
  const [selection, setSelection] = useState<{ tab: string; start: number; end: number } | null>(null);
  const [previews, setPreviews] = useState<TabPreview[]>([]);
  const [parameterRequest, setParameterRequest] = useState<ParameterRequest | null>(null);
  const [analysisTarget, setAnalysisTarget] = useState<QueryTarget | null>(null);
  const { tabs, select, add, close, edit, openFile, saveFile } = editor;
  const draft = tabs.tabs.find(item => item.id === tabs.activeId);
  const tabPreview = previews.find(item => item.tab === tabs.activeId);
  const source = draft?.document.text ?? "";
  const selected = selection && selection.tab === draft?.id && selection.start !== selection.end
    ? source.slice(selection.start, selection.end) : "";
  const busy = running !== null;
  const cannotRun = !session || busy || !source.trim();

  async function run(target: QueryTarget, bindings?: PostgresBindings) {
    if (session !== target.session || active.current || !target.source.trim()) return;
    const operation: Running = { ...target, request: crypto.randomUUID() };
    active.current = operation;
    setRunning(operation);
    setCancelStatus("");
    let outcome: Outcome;
    try {
      outcome = await invoke<Outcome>("execute_postgres_sql", {
        id: target.session, request: operation.request, source: target.source, scope: target.scope, bindings, mode: target.mode,
      });
      if (outcome.connection_closed) onClosed(target.session);
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
      return [{ ...existing, tab: target.tab, active: view, [view]: { id: operation.request, source: target.source, outcome: result } },
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

  function execute(current: boolean, mode: Mode = "query", field = input.current) {
    if (!field || !session || !draft || parameterRequest || analysisTarget) return;
    const { selectionStart: start, selectionEnd: end } = field;
    const scope: Scope = current ? { kind: "current", cursor: start } : start === end ? { kind: "document" } : { kind: "selection", start, end };
    const target = { session, tab: draft.id, title: sqlTabTitle(draft), source, scope, mode };
    if (mode === "analyze") setAnalysisTarget(target);
    else void run(target);
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
          <button type="button" className="secondary small" disabled={cannotRun} onClick={() => execute(false, "estimate")}>
            <GitBranch size={14} aria-hidden /> 실행 계획</button>
          <button type="button" className="secondary small" disabled={cannotRun} onClick={() => execute(false, "analyze")}>실행 분석</button>
          <button type="button" className="primary small" title="Ctrl+Enter" disabled={!session || busy || !(selected || source).trim()}
            onClick={() => execute(false)}><Play size={14} aria-hidden />{selected ? "선택 영역 실행" : "쿼리 실행"}</button>
          {busy && <button type="button" className="secondary small" disabled={cancelStatus === "취소 요청 중…"}
            onClick={() => void stop()}><Square size={13} aria-hidden /> 쿼리 취소</button>}
        </div>
      </div>
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
              if (event.key === "Enter") { event.preventDefault(); execute(event.shiftKey, "query", event.currentTarget); }
              else if (event.key.toLowerCase() === "s") { event.preventDefault(); saveFile(draft); }
            }} />
        </>}
      </div>)}
      {!draft && <><p className="sql-tabs-empty">열린 SQL 탭이 없습니다.</p><div className="editor-footer">{fileActions}</div></>}
    </section>
    {!session && <p className="form-note">PostgreSQL에 연결하면 조회 SQL을 실행할 수 있습니다.</p>}
    {running && <p className="form-note" role="status">{cancelStatus || `${running.title} · ${modeNames[running.mode]} 중…`}</p>}
    {tabPreview?.data && tabPreview.plan && <div className="postgres-result-views" role="group" aria-label="PostgreSQL 결과 보기">
      <button type="button" className="secondary small" aria-pressed={tabPreview.active === "data"} onClick={() => showResult("data")}>조회 결과</button>
      <button type="button" className="secondary small" aria-pressed={tabPreview.active === "plan"} onClick={() => showResult("plan")}>계획 결과</button>
    </div>}
    {tabPreview && resultViews.map(view => {
      const preview = tabPreview[view];
      if (!preview) return null;
      const pending = running?.tab === tabs.activeId && view === resultView(running.mode);
      return <div key={view} className="postgres-sql-result" hidden={tabPreview.active !== view || pending}>
        <PostgresSqlResult key={preview.id} outcome={preview.outcome} jump={source === preview.source ? position => {
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
    {parameterRequest && session === parameterRequest.target.session && <PostgresParameterDialog key={parameterRequest.id}
      parameters={parameterRequest.parameters} title={`${parameterRequest.target.title} · ${modeNames[parameterRequest.target.mode]}`} error={parameterRequest.error}
      running={busy} cancelStatus={cancelStatus} onSubmit={bindings => void run(parameterRequest.target, bindings)}
      onClose={() => { setParameterRequest(null); requestAnimationFrame(() => input.current?.focus()); }}
      onCancelQuery={() => void stop()} />}
  </div>;
}

export function PostgresValue({ cell }: { cell: PostgresCell }) {
  return cell.value === null ? <span className="postgres-null">NULL</span> :
    <code>{cell.value}{cell.truncated && <span title="512자 미리보기">…</span>}</code>;
}

function PostgresSqlResult({ outcome, jump }: { outcome: QueryStatus; jump?: (position: number) => void }) {
  const [page, setPage] = useState(0);
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
  const start = page * resultPageSize;
  const rows = outcome.rows.slice(start, start + resultPageSize);
  return <section className="postgres-data results-card" aria-label="PostgreSQL SQL 조회 결과">
    <div className="panel-heading"><strong>마지막 실행 결과</strong><span className="result-count">{outcome.rows.length}행 · {outcome.elapsed_ms}ms</span></div>
    {(outcome.more_rows || outcome.total_columns > outcome.columns.length) && <p className="form-note postgres-page-note">
      미리보기 {outcome.more_rows && "100행"}{outcome.more_rows && outcome.total_columns > outcome.columns.length && " · "}
      {outcome.total_columns > outcome.columns.length && `전체 ${outcome.total_columns}열 중 ${outcome.columns.length}열`}
    </p>}
    {rows.length ? <div className="table-wrap" tabIndex={0} role="region" aria-label="PostgreSQL SQL 데이터 스크롤">
      <table aria-label="PostgreSQL SQL 데이터"><thead><tr>{outcome.columns.map((column, index) => <th key={index} scope="col">
        {column.name}<small>{column.data_type}</small></th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr key={start + rowIndex}>{row.map((cell, column) =>
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
