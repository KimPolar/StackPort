import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Play, Square } from "lucide-react";
import { CodeTextarea } from "./CodeTextarea";
import { MysqlDataGrid, type MysqlValue } from "./MysqlDataGrid";
import type { MysqlExportTarget, MysqlSqlBinding } from "./MysqlResultExport";

type ParameterKind = "text" | "integer" | "real" | "null";
type Parameter = { kind: ParameterKind; value: string; masked: boolean };
type Statement = { sql: string; database: string | null; scope: "문장" | "선택 영역" };
type Result = { columns: { name: string; data_type: string }[]; rows: (MysqlValue | null)[][];
  more_rows: boolean; more_columns: boolean; elapsed_ms: number };

const number = new Intl.NumberFormat("ko-KR");
const byteLimit = 128 * 1024;

export function MysqlSqlWorkspace({ id, database, onExport }: {
  id: string;
  database: string | null;
  onExport: (source: MysqlExportTarget) => void;
}) {
  const [text, setText] = useState("");
  const [hasSelection, setHasSelection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [draft, setDraft] = useState<{ statement: Statement; parameters: Parameter[]; action: "execute" | "export" } | null>(null);
  const [result, setResult] = useState<{ data: Result; statement: Statement; parameterFields: Pick<Parameter, "kind" | "masked">[] } | null>(null);
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

  async function prepare(selected: boolean) {
    if (pending.current || draft) return;
    const field = editor.current;
    const sql = selected && field ? text.slice(field.selectionStart, field.selectionEnd) : text;
    if (!sql.trim()) return;
    const statement: Statement = { sql, database, scope: selected ? "선택 영역" : "문장" };
    pending.current = true; setBusy(true); setError("");
    try {
      const count = await invoke<number>("mysql_sql_parameters", { id, sql });
      if (!mounted.current) return;
      if (count) setDraft({ statement, action: "execute", parameters: Array.from({ length: count }, () => ({ kind: "text", value: "", masked: false })) });
      else await execute(statement, []);
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  async function execute(statement: Statement, values: Parameter[]) {
    const requestId = crypto.randomUUID();
    active.current = requestId; setRunning(requestId); setResult(null);
    const parameters = bindings(values);
    try {
      const data = await invoke<Result>("run_mysql_sql", { id, requestId, database: statement.database, sql: statement.sql, parameters });
      if (mounted.current) setResult({
        data, statement, parameterFields: values.map(({ kind, masked }) => ({ kind, masked })),
      });
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
    try { await execute(draft.statement, draft.parameters); }
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
    <div className="mysql-sql-actions">
      <button type="button" className="primary small" disabled={busy || !!draft || !text.trim()} onClick={() => void prepare(false)}>
        <Play size={14} aria-hidden /> 문장 실행</button>
      <button type="button" className="secondary small" disabled={busy || !!draft || !hasSelection} onClick={() => void prepare(true)}>선택 실행</button>
      {running && <button type="button" className="secondary small" disabled={cancelPending} onClick={() => void cancel(running)}>
        <Square size={14} aria-hidden /> 실행 중단</button>}
      {busy && <span role="status">{cancelPending ? "중단 요청 중…" : running ? "실행 중…" : "문장 확인 중…"}</span>}
    </div>
    <CodeTextarea id="mysql-sql-editor" editorRef={editor} aria-label="MySQL SQL 문장" value={text} language="mysql" maxLength={byteLimit}
      readOnly={busy || Boolean(draft)} placeholder="SELECT ..." onChange={event => setText(event.target.value)}
      onSelect={event => setHasSelection(event.currentTarget.selectionStart !== event.currentTarget.selectionEnd)}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault(); void prepare(event.currentTarget.selectionStart !== event.currentTarget.selectionEnd);
        }
      }} footer={<span>Ctrl + Enter · 한 번에 한 문장</span>} />
    {draft && <form className="mysql-sql-parameters" onSubmit={event => void submit(event)}>
      <h3>{draft.action === "export" ? "내보내기 매개변수 다시 입력" : "SQL 매개변수"}</h3>
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
        <button type="submit" className="primary small">{draft.action === "export" ? "파일 설정" : "바인딩하고 실행"}</button>
      </div>
    </form>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {result && <section aria-label="MySQL 실행 결과">
      <div className="panel-heading"><h3>실행 결과</h3><span>{result.statement.scope} · {result.statement.database ?? "기본 DB 선택 안 됨"}</span></div>
      <p className="form-note mysql-table-note" role="status">{number.format(result.data.rows.length)}행{result.data.more_rows && " 표시 · 추가 행 있음"}
        {result.data.more_columns && " · 앞 128개 열"} · {number.format(result.data.elapsed_ms)} ms</p>
      <div className="mysql-sql-actions"><button type="button" className="secondary small" disabled={busy || !!draft} onClick={() => {
        if (!result.parameterFields.length) exportResult(result.statement, []);
        else setDraft({ statement: result.statement, action: "export", parameters: result.parameterFields.map(field => ({ ...field, value: "" })) });
      }}><Download size={14} aria-hidden /> 결과 내보내기</button></div>
      <MysqlDataGrid columns={result.data.columns} rows={result.data.rows} label="MySQL SQL 결과 표" />
    </section>}
  </section>;
}

function bindings(values: Parameter[]): MysqlSqlBinding[] {
  return values.map(({ kind, value }) => kind === "null" ? { kind } : { kind, value });
}
