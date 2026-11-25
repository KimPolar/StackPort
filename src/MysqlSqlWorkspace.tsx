import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Play, Square } from "lucide-react";
import { CodeTextarea } from "./CodeTextarea";
import { Dialog } from "./Dialog";
import { DatabasePreviewGrid, type DatabasePreviewValue as MysqlValue } from "./DatabasePreviewGrid";
import { MysqlQueryPlan, type MysqlPlan } from "./MysqlQueryPlan";
import { MysqlScriptResults, type MysqlScriptOutcome } from "./MysqlScriptResults";
import type { MysqlExportTarget, MysqlSqlBinding } from "./MysqlResultExport";

type ParameterKind = "text" | "integer" | "real" | "null";
type Parameter = { kind: ParameterKind; value: string; masked: boolean };
type Action = "execute" | "estimate" | "analyze" | "script";
type ScriptScope = { kind: "document" } | { kind: "current"; cursor_byte: number }
  | { kind: "selection"; start_byte: number; end_byte: number };
type Statement = { sql: string; database: string | null; scope: "문장" | "선택 영역" | "전체 문서" | "현재 문장";
  script?: { scope: ScriptScope; autocommit: boolean; confirmation: string } };
type Result = { columns: { name: string; data_type: string }[]; rows: (MysqlValue | null)[][];
  more_rows: boolean; more_columns: boolean; elapsed_ms: number };

const number = new Intl.NumberFormat("ko-KR");
const byteLimit = 128 * 1024;
const encoder = new TextEncoder();

export function MysqlSqlWorkspace({ id, database, environment, text, onTextChange, onExport }: {
  id: string;
  database: string | null;
  environment: string;
  text: string;
  onTextChange: (text: string) => void;
  onExport: (source: MysqlExportTarget) => void;
}) {
  const [hasSelection, setHasSelection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [draft, setDraft] = useState<{ statement: Statement; parameters: Parameter[]; action: Action | "export" } | null>(null);
  const [result, setResult] = useState<{ data: Result; statement: Statement; parameterFields: Pick<Parameter, "kind" | "masked">[] } | null>(null);
  const [plan, setPlan] = useState<MysqlPlan | null>(null);
  const [view, setView] = useState<"data" | "plan">("data");
  const [analysisTarget, setAnalysisTarget] = useState<Statement | null>(null);
  const [scriptMode, setScriptMode] = useState(false);
  const [autocommit, setAutocommit] = useState(true);
  const [scriptConfirmation, setScriptConfirmation] = useState<{ statement: Statement; text: string } | null>(null);
  const [scriptResult, setScriptResult] = useState<MysqlScriptOutcome | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const active = useRef<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void invoke("cancel_mysql_sql", { id, requestId: active.current }).catch(() => {});
    };
  }, [id]);

  function prepare(selected: boolean, action: Action = "execute") {
    if (pending.current || draft || analysisTarget) return;
    const field = editor.current;
    const selection = selected && field && field.selectionStart !== field.selectionEnd
      ? text.slice(field.selectionStart, field.selectionEnd) : null;
    if (selected && action === "execute" && selection === null) return;
    const sql = selection ?? text;
    if (!sql.trim()) return;
    const statement: Statement = { sql, database, scope: selection === null ? "문장" : "선택 영역" };
    if (action === "analyze") setAnalysisTarget(statement);
    else void prepareRequest(statement, action);
  }

  function prepareScript(kind: ScriptScope["kind"]) {
    const field = editor.current;
    if (!field || pending.current || draft || scriptConfirmation || !field.value.trim()) return;
    const { value, selectionStart, selectionEnd, selectionDirection } = field;
    const position = (chars: number) => encoder.encode(value.slice(0, chars)).length;
    let scope: ScriptScope = { kind: "document" };
    if (kind === "selection") {
      if (selectionStart === selectionEnd) return;
      scope = { kind, start_byte: position(selectionStart), end_byte: position(selectionEnd) };
    } else if (kind === "current") {
      scope = { kind, cursor_byte: position(selectionDirection === "backward" ? selectionStart : selectionEnd) };
    }
    const statement: Statement = { sql: value, database, scope: kind === "document" ? "전체 문서" : kind === "current" ? "현재 문장" : "선택 영역",
      script: { scope, autocommit, confirmation: "" } };
    if (environment === "PROD") setScriptConfirmation({ statement, text: "" });
    else void prepareRequest(statement, "script");
  }

  async function prepareRequest(statement: Statement, action: Action) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const count = statement.script
        ? await invoke<number>("mysql_script_parameters", { id, sql: statement.sql, scope: statement.script.scope })
        : await invoke<number>("mysql_sql_parameters", { id, sql: statement.sql, selectOnly: action !== "execute" });
      if (!mounted.current) return;
      if (count) setDraft({ statement, action, parameters: Array.from({ length: count }, () => ({ kind: "text", value: "", masked: false })) });
      else await execute(statement, [], action);
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  async function execute(statement: Statement, values: Parameter[], action: Action) {
    const requestId = crypto.randomUUID();
    active.current = requestId; setRunning(requestId);
    const args = { id, requestId, database: statement.database, sql: statement.sql, parameters: bindings(values) };
    try {
      if (action === "script" && statement.script) {
        setScriptResult(null);
        const outcome = await invoke<MysqlScriptOutcome>("run_mysql_script", { id, requestId, input: {
          ...statement.script, sql: statement.sql, database: statement.database, parameters: args.parameters,
        } });
        if (mounted.current) setScriptResult(outcome);
      } else if (action === "execute") {
        const data = await invoke<Result>("run_mysql_sql", args);
        if (mounted.current) {
          setResult({ data, statement, parameterFields: values.map(({ kind, masked }) => ({ kind, masked })) });
          setView("data");
        }
      } else {
        const data = await invoke<MysqlPlan>("mysql_sql_plan", { ...args, analyzed: action === "analyze" });
        if (mounted.current) { setPlan(data); setView("plan"); }
      }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally {
      active.current = null;
      if (mounted.current) { setRunning(null); setCancelPending(false); }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending.current) return;
    if (draft.action === "export") {
      exportResult(draft.statement, bindings(draft.parameters));
      setDraft(null);
      return;
    }
    pending.current = true; setBusy(true); setError(""); setDraft(null);
    try { await execute(draft.statement, draft.parameters, draft.action); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  function exportResult(statement: Statement, parameters: MysqlSqlBinding[]) {
    onExport({ kind: "sql", database: statement.database, sql: statement.sql, parameters });
  }

  async function cancel(requestId: string) {
    setCancelPending(true);
    try {
      const sent = await invoke<boolean>("cancel_mysql_sql", { id, requestId });
      if (!sent && mounted.current) setCancelPending(false);
    } catch (cause) {
      if (mounted.current) { setCancelPending(false); setError(String(cause)); }
    }
  }

  function updateParameter(index: number, change: Partial<Parameter>) {
    setDraft(current => current && { ...current, parameters: current.parameters.map((parameter, i) => i === index ? { ...parameter, ...change } : parameter) });
  }

  return <section className="results-card mysql-sql" aria-label="MySQL SQL 편집기">
    <div className="panel-heading"><h2>SQL 편집기</h2><span>{database ?? "기본 DB 선택 안 됨"}</span></div>
    <div className="mysql-sql-actions" role="group" aria-label="MySQL 실행 방식">
      <button type="button" className="secondary small" disabled={busy || !!draft} aria-pressed={!scriptMode}
        onClick={() => { setScriptMode(false); setError(""); }}>읽기 전용 조회</button>
      <button type="button" className="secondary small" disabled={busy || !!draft} aria-pressed={scriptMode}
        onClick={() => { setScriptMode(true); setError(""); }}>SQL 스크립트</button>
    </div>
    <div className="mysql-sql-actions">
      {scriptMode ? <>
        <button type="button" className="primary small" disabled={busy || !!draft || !text.trim()} onClick={() => prepareScript("document")}>
          <Play size={14} aria-hidden /> 전체 실행</button>
        <button type="button" className="secondary small" disabled={busy || !!draft || !text.trim()} onClick={() => prepareScript("current")}>현재 문장 실행</button>
        <button type="button" className="secondary small" disabled={busy || !!draft || !hasSelection} onClick={() => prepareScript("selection")}>선택 실행</button>
        <label className="mysql-mask"><input type="checkbox" checked={autocommit} disabled={busy || !!draft}
          onChange={event => setAutocommit(event.target.checked)} /> 자동 커밋</label>
      </> : <>
      <button type="button" className="primary small" disabled={busy || !!draft || !text.trim()} onClick={() => void prepare(false)}>
        <Play size={14} aria-hidden /> 문장 실행</button>
      <button type="button" className="secondary small" disabled={busy || !!draft || !hasSelection} onClick={() => void prepare(true)}>선택 실행</button>
      <button type="button" className="secondary small" disabled={busy || !!draft || !text.trim()} onClick={() => prepare(true, "estimate")}>실행 계획</button>
      <button type="button" className="secondary small" disabled={busy || !!draft || !text.trim()} onClick={() => prepare(true, "analyze")}>실행 분석</button>
      </>}
      {running && <button type="button" className="secondary small" disabled={cancelPending} onClick={() => void cancel(running)}>
        <Square size={14} aria-hidden /> 실행 중단</button>}
      {busy && <span role="status">{cancelPending ? "중단 요청 중…" : running ? "실행 중…" : "문장 확인 중…"}</span>}
    </div>
    <CodeTextarea id="mysql-sql-editor" editorRef={editor} aria-label="MySQL SQL 문장" value={text} language="mysql" maxLength={byteLimit}
      readOnly={busy || Boolean(draft)} placeholder="SELECT ..." onChange={event => onTextChange(event.target.value)}
      onSelect={event => setHasSelection(event.currentTarget.selectionStart !== event.currentTarget.selectionEnd)}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          const selected = event.currentTarget.selectionStart !== event.currentTarget.selectionEnd;
          if (scriptMode) prepareScript(selected ? "selection" : "current");
          else prepare(selected);
        }
      }} footer={<span>{scriptMode ? "Ctrl + Enter · 현재 문장 또는 선택 실행" : "Ctrl + Enter · 한 번에 한 문장"}</span>} />
    {scriptMode && <p className="form-note mysql-table-note">스크립트가 끝나면 열린 트랜잭션을 롤백합니다. 일부 DDL은 자동 커밋 설정과 관계없이 커밋됩니다. 프로시저 본문은 <code>DELIMITER</code>로 구분하세요.</p>}
    {draft && <form className="mysql-sql-parameters" onSubmit={event => void submit(event)}>
      <h3>{draft.action === "export" ? "내보내기 매개변수 다시 입력"
        : draft.action === "estimate" ? "실행 계획 매개변수" : draft.action === "analyze" ? "실행 분석 매개변수" : "SQL 매개변수"}</h3>
      <p className="form-note">{draft.statement.scope} · {draft.statement.database ?? "기본 DB 선택 안 됨"}</p>
      {draft.parameters.map((parameter, index) => <fieldset className="mysql-parameter" key={index}>
        <legend>매개변수 {index + 1}</legend>
        <label className="field">타입<select value={parameter.kind} onChange={event => updateParameter(index, { kind: event.target.value as ParameterKind })}>
          <option value="text">문자열</option><option value="integer">정수</option><option value="real">실수</option><option value="null">NULL</option>
        </select></label>
        {parameter.kind !== "null" && <>
          <label className="field">값<input type={parameter.masked ? "password" : "text"} autoComplete="off" aria-label={`매개변수 ${index + 1} 값`}
            value={parameter.value} maxLength={65536} onChange={event => updateParameter(index, { value: event.target.value })} /></label>
          <label className="mysql-mask"><input type="checkbox" checked={parameter.masked} onChange={event => updateParameter(index, { masked: event.target.checked })} /> 값 숨기기</label>
        </>}
      </fieldset>)}
      <div className="mysql-sql-actions">
        <button type="button" className="secondary small" onClick={() => setDraft(null)}>취소</button>
        <button type="submit" className="primary small">{draft.action === "export" ? "파일 설정"
          : draft.action === "estimate" ? "계획 확인" : "바인딩하고 실행"}</button>
      </div>
    </form>}
    {analysisTarget && <Dialog title="MySQL 실행 분석" busy={false} onClose={() => setAnalysisTarget(null)}>
      <form onSubmit={event => {
        event.preventDefault();
        setAnalysisTarget(null);
        void prepareRequest(analysisTarget, "analyze");
      }}>
        <p className="confirm-copy">읽기 전용으로 {analysisTarget.scope}을 실제 실행해 행 수와 시간을 측정합니다.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => setAnalysisTarget(null)}>취소</button>
          <button type="submit" className="primary">분석 실행</button>
        </div>
      </form>
    </Dialog>}
    {scriptConfirmation && <Dialog title="운영 스크립트 실행" busy={false} onClose={() => setScriptConfirmation(null)}>
      <form onSubmit={event => {
        event.preventDefault();
        const { statement, text } = scriptConfirmation;
        if (text !== "PROD" || !statement.script) return;
        setScriptConfirmation(null);
        void prepareRequest({ ...statement, script: { ...statement.script, confirmation: text } }, "script");
      }}>
        <p className="confirm-copy">실행 범위는 {scriptConfirmation.statement.scope}입니다. 실행하면 운영 데이터나 구조가 변경될 수 있습니다.</p>
        <label className="field">운영 환경 확인<input autoFocus value={scriptConfirmation.text} placeholder="PROD" autoComplete="off"
          onChange={event => setScriptConfirmation({ ...scriptConfirmation, text: event.target.value })} /></label>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => setScriptConfirmation(null)}>취소</button>
          <button type="submit" className="primary" disabled={scriptConfirmation.text !== "PROD"}>계속</button>
        </div>
      </form>
    </Dialog>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {scriptMode && scriptResult && <MysqlScriptResults outcome={scriptResult} />}
    {!scriptMode && result && plan && <div className="mysql-sql-actions" role="group" aria-label="MySQL 결과 보기">
      <button type="button" className="secondary small" aria-pressed={view === "data"} onClick={() => setView("data")}>데이터 결과</button>
      <button type="button" className="secondary small" aria-pressed={view === "plan"} onClick={() => setView("plan")}>계획 결과</button>
    </div>}
    {!scriptMode && view === "plan" && plan && <MysqlQueryPlan plan={plan} />}
    {!scriptMode && view === "data" && result && <section aria-label="MySQL 실행 결과">
      <div className="panel-heading"><h3>실행 결과</h3><span>{result.statement.scope} · {result.statement.database ?? "기본 DB 선택 안 됨"}</span></div>
      <p className="form-note mysql-table-note" role="status">{number.format(result.data.rows.length)}행{result.data.more_rows && " 표시 · 추가 행 있음"}
        {result.data.more_columns && " · 앞 128개 열"} · {number.format(result.data.elapsed_ms)} ms</p>
      <div className="mysql-sql-actions"><button type="button" className="secondary small" disabled={busy || !!draft} onClick={() => {
        if (!result.parameterFields.length) exportResult(result.statement, []);
        else setDraft({ statement: result.statement, action: "export", parameters: result.parameterFields.map(field => ({ ...field, value: "" })) });
      }}><Download size={14} aria-hidden /> 결과 내보내기</button></div>
      <DatabasePreviewGrid columns={result.data.columns} rows={result.data.rows} label="MySQL SQL 결과 표" />
    </section>}
  </section>;
}

function bindings(values: Parameter[]): MysqlSqlBinding[] {
  return values.map(({ kind, value }) => kind === "null" ? { kind } : { kind, value });
}
