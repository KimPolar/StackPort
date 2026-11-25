import { useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Braces, Play, Square } from "lucide-react";
import { CodeTextarea } from "./CodeTextarea";
import { DatabasePreviewGrid, type DatabasePreviewValue } from "./DatabasePreviewGrid";
import { Dialog } from "./Dialog";
import { OracleParameterFields, SnowflakeParameterFields, type OracleParameterValue, type SnowflakeParameterValue } from "./SqlParameterFields";
import type { ParameterPlan } from "./SqlParameterSets";
import { sqlDocumentEditorId, sqlTabTextLimit, useSqlTabBusy, type SqlTabEditor } from "./SqlTabs";

type Scope = "document" | "current" | "selection";
type Engine = "oracle" | "snowflake";
type QuerySource = { sql: string; first_line: number; cursor_byte: number | null };
type OracleBinding = OracleParameterValue & { name: string };
type ParameterRequest = { input: QuerySource; parameterScope: string } &
  ({ engine: "oracle"; names: string[] } | { engine: "snowflake"; count: number });
type ResultSet = {
  columns: { name: string; data_type: string }[];
  rows: (DatabasePreviewValue | null)[][];
  rows_received: number;
  more_columns: boolean;
};
type Statement = {
  line: number;
  rows_affected?: number | null;
  data: ResultSet | null;
  warning: string | null;
  query_id?: string | null;
  stats?: Partial<Record<"num_rows_inserted" | "num_rows_updated" | "num_rows_deleted" | "num_duplicate_rows_updated", number | null>> | null;
};
type Outcome = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  statements: Statement[];
  elapsed_ms: number;
  error: { line: number | null; code: number | string | null; message: string; sql_state?: string | null; query_id?: string | null } | null;
  server_interrupted: boolean | null;
  transaction?: "not_started" | "rolled_back" | "unknown";
  server_completed?: boolean;
  audit_warning: boolean;
};

const statusText = { succeeded: "실행 완료", failed: "실행 실패", cancelled: "실행 중단", timed_out: "시간 초과" };
const transactionText = {
  not_started: "실행 연결에서 시작한 트랜잭션이 없습니다.",
  rolled_back: "실행 연결의 트랜잭션을 정리했습니다.",
  unknown: "실행 연결을 닫았습니다. 롤백 완료는 확인되지 않았습니다.",
};
const number = new Intl.NumberFormat("ko-KR");
const encoder = new TextEncoder();
const engineName = { oracle: "Oracle", snowflake: "Snowflake" };
const statsFields = [
  ["num_rows_inserted", "삽입"], ["num_rows_updated", "수정"],
  ["num_rows_deleted", "삭제"], ["num_duplicate_rows_updated", "중복 수정"],
] as const;

export function RelationalScriptWorkspace({ id, projectId, database, engine, tab }: {
  id: string; projectId: string; database: string; engine: Engine; tab: SqlTabEditor;
}) {
  const { text, onTextChange } = tab;
  const [selected, setSelected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [parameterRequest, setParameterRequest] = useState<ParameterRequest | null>(null);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [statementIndex, setStatementIndex] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const active = useRef<string | null>(null);
  const editorId = sqlDocumentEditorId(tab.tabId);
  const noteId = useId();
  const ready = !busy && !preparing && !parameterRequest && Boolean(text.trim());
  const name = engineName[engine];
  useSqlTabBusy(tab, busy || preparing || !!parameterRequest);

  async function run(scope: Scope, withParameters = false) {
    const field = editor.current;
    if (!field || active.current || parameterRequest) return;
    const { value, selectionStart, selectionEnd, selectionDirection } = field;
    const sql = scope === "selection" ? value.slice(selectionStart, selectionEnd) : value;
    if (!sql.trim()) return;
    const caret = selectionDirection === "backward" ? selectionStart : selectionEnd;
    const input: QuerySource = {
      sql,
      first_line: scope === "selection" ? value.slice(0, selectionStart).split("\n").length : 1,
      cursor_byte: scope === "current" ? encoder.encode(value.slice(0, caret)).length : null,
    };
    if (engine === "oracle" || withParameters) {
      active.current = crypto.randomUUID();
      setPreparing(true); setError("");
      try {
        if (engine === "snowflake") {
          const plan = await invoke<ParameterPlan<number>>("snowflake_query_parameters", { input, withScope: true });
          setParameterRequest({ engine, input, count: plan.parameters, parameterScope: plan.parameter_scope });
          return;
        }
        const plan = await invoke<ParameterPlan<string[]>>("oracle_query_parameters", { id, input, withScope: true });
        if (plan.parameters.length) {
          setParameterRequest({ engine, input, names: plan.parameters, parameterScope: plan.parameter_scope });
          return;
        }
      } catch (cause) {
        setError(String(cause));
        return;
      } finally {
        active.current = null;
        setPreparing(false);
      }
    }
    await execute(input);
  }

  async function execute(input: QuerySource & { parameters?: OracleBinding[] | SnowflakeParameterValue[] }) {
    if (active.current) return;
    const requestId = crypto.randomUUID();
    active.current = requestId;
    setBusy(true); setStopping(false); setError(""); setOutcome(null); setStatementIndex(0);
    try {
      setOutcome(await invoke<Outcome>(`run_${engine}_query`, { id, requestId, input }));
    } catch (cause) { setError(String(cause)); }
    finally { active.current = null; setBusy(false); setStopping(false); }
  }

  async function stop() {
    const requestId = active.current;
    if (!requestId || stopping) return;
    setStopping(true); setError("");
    try {
      const accepted = await invoke<boolean>(`cancel_${engine}_query`, { id, requestId });
      if (!accepted && active.current === requestId) {
        setStopping(false);
        setError("중단할 실행을 찾을 수 없습니다. 실행 중이라면 다시 시도하세요.");
      }
    } catch (cause) {
      if (active.current === requestId) { setStopping(false); setError(String(cause)); }
    }
  }

  return <section className="results-card mysql-sql relational-query-editor" aria-label={name + " SQL 편집기"}>
    <div className="panel-heading"><h2>SQL 편집기</h2><span>{database}</span></div>
    <div className="mysql-sql-actions" role="group" aria-label="SQL 실행">
      <button type="button" className="primary small" disabled={!ready} onClick={() => void run("document")}><Play size={14} aria-hidden /> 전체 실행</button>
      <button type="button" className="secondary small" disabled={!ready} onClick={() => void run("current")}>현재 문장 실행</button>
      <button type="button" className="secondary small" disabled={!ready || !selected} onClick={() => void run("selection")}>선택 실행</button>
      {engine === "snowflake" && <button type="button" className="secondary small" disabled={!ready}
        onClick={() => void run(selected ? "selection" : "current", true)}><Braces size={14} aria-hidden /> 매개변수 실행</button>}
      {busy && <button type="button" className="secondary small" disabled={stopping} onClick={() => void stop()}><Square size={14} aria-hidden /> 실행 중단</button>}
      <span role="status">{stopping ? (engine === "oracle" ? "중단 요청됨 · 진행 중인 호출 처리 중…" : "중단 요청 중…") : busy ? "실행 중…" : preparing ? "바인드 변수 확인 중…" : ""}</span>
    </div>
    <CodeTextarea id={editorId} editorRef={editor} value={text} language={engine} maxLength={sqlTabTextLimit} readOnly={busy || preparing || Boolean(parameterRequest)}
      aria-label={name + " SQL 문장"} aria-describedby={noteId} placeholder={engine === "oracle" ? "SELECT … FROM DUAL" : "SELECT …"}
      onChange={event => onTextChange(event.target.value)}
      onSelect={event => setSelected(event.currentTarget.selectionStart !== event.currentTarget.selectionEnd)}
      onKeyDown={event => {
        if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        void run(event.currentTarget.selectionStart === event.currentTarget.selectionEnd ? "current" : "selection");
      }} footer={<span>Ctrl + Enter · 현재 문장 또는 선택 실행</span>} />
    <p className="form-note mysql-table-note" id={noteId}>{engine === "oracle"
      ? <>PL/SQL 블록은 별도 줄의 <code>/</code>로 구분합니다. <code>:name</code> 변수는 실행 전에 값을 입력합니다. 실행 연결을 닫을 때 열린 트랜잭션은 롤백합니다.</>
      : <>같은 트랜잭션의 문장은 한 번에 실행하고 익명 블록은 <code>EXECUTE IMMEDIATE $$…$$</code>로 감싸세요. <code>?</code> 값은 한 문장을 대상으로 매개변수 실행에서 입력합니다.</>}</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {outcome && <ScriptResults engine={engine} outcome={outcome} index={statementIndex} onSelect={setStatementIndex} />}
    {parameterRequest && <Dialog title={`${name} SQL 바인드 변수`} busy={false} onClose={() => setParameterRequest(null)}>
      {parameterRequest.engine === "oracle" ? <OracleParameterFields parameters={parameterRequest.names.map((name, index) => ({ index: index + 1, name: oracleBindLabel(name) }))}
        setScope={{ project_id: projectId, engine: "oracle", key: parameterRequest.parameterScope }}
        dismiss={() => setParameterRequest(null)} submit={values => {
          const parameters = parameterRequest.names.map((name, index) => ({ ...values[index], name }));
          setParameterRequest(null);
          void execute({ ...parameterRequest.input, parameters });
        }} /> : <SnowflakeParameterFields count={parameterRequest.count}
          setScope={{ project_id: projectId, engine: "snowflake", key: parameterRequest.parameterScope }}
          dismiss={() => setParameterRequest(null)} submit={parameters => {
          setParameterRequest(null);
          void execute({ ...parameterRequest.input, parameters });
        }} />}
    </Dialog>}
  </section>;
}

function oracleBindLabel(name: string) {
  return /^[A-Z][A-Z0-9_#$]*$|^\d+$/.test(name) ? `:${name}` : `:"${name}"`;
}

function ScriptResults({ engine, outcome, index, onSelect }: { engine: Engine; outcome: Outcome; index: number; onSelect: (index: number) => void }) {
  const statement = outcome.statements[index];
  const data = statement?.data;
  const state = outcome.server_completed && outcome.status !== "succeeded"
    ? `서버 실행 완료 · 결과 수신 ${outcome.status === "cancelled" ? "중단" : outcome.status === "timed_out" ? "시간 초과" : "실패"}`
    : statusText[outcome.status];
  const statistics = statsFields.flatMap(([key, label]) => {
    const value = statement?.stats?.[key];
    return value == null ? [] : [`${label} ${number.format(value)}행`];
  });
  return <section aria-label={engineName[engine] + " 실행 결과"}>
    <div className="panel-heading"><h3>실행 결과</h3><span>{number.format(outcome.elapsed_ms)} ms</span></div>
    <p className="form-note mysql-table-note" role="status">{state} · {engine === "snowflake" ? "결과를 받은 문장" : "완료한 문장"} {number.format(outcome.statements.length)}개
      {outcome.server_interrupted === true && <> · 서버가 실행 중단을 확인했습니다.</>}
      {outcome.server_interrupted === false && <> · 서버의 중단 응답을 확인하지 못했습니다.</>}
      {outcome.transaction && <> {transactionText[outcome.transaction]}</>}</p>
    {outcome.error && <p className="error-banner" role="alert">
      {outcome.error.line !== null && <>문장 시작 {outcome.error.line}행 · </>}
      {engine === "snowflake" && outcome.error.code && <>오류 {outcome.error.code} · </>}
      {outcome.error.sql_state && <>SQLSTATE {outcome.error.sql_state} · </>}
      {outcome.error.message}
      {outcome.error.query_id && <>{"\n"}쿼리 ID <code>{outcome.error.query_id}</code></>}
    </p>}
    {outcome.audit_warning && <p className="form-note mysql-table-note">SQL 실행을 감사 로그에 저장하지 못했습니다.</p>}
    {outcome.statements.length > 1 && <div className="mysql-sql-actions">
      <label className="field">문장 결과<select value={index} onChange={event => onSelect(Number(event.target.value))}>
        {outcome.statements.map((result, position) => <option key={position} value={position}>문장 {position + 1} · {result.line}행</option>)}
      </select></label>
    </div>}
    {statement?.warning && <p className="form-note mysql-table-note">{statement.warning}</p>}
    {statement?.query_id && <p className="form-note mysql-table-note">쿼리 ID <code>{statement.query_id}</code></p>}
    {statement?.rows_affected != null && <p className="form-note mysql-table-note">영향받은 행 {number.format(statement.rows_affected)}개</p>}
    {statistics.length > 0 && <p className="form-note mysql-table-note">{statistics.join(" · ")}</p>}
    {data && <>
      <p className="form-note mysql-table-note">{number.format(data.rows_received)}행 {engine === "snowflake" ? "결과" : "수신"}
        {data.rows.length < data.rows_received && <> · 앞 {number.format(data.rows.length)}행 표시</>}
        {data.more_columns && <> · 앞 {data.columns.length}개 열 표시</>}</p>
      <DatabasePreviewGrid columns={data.columns} rows={data.rows} label={engineName[engine] + " SQL 결과 표"} />
    </>}
  </section>;
}
