import { useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Square } from "lucide-react";
import { CodeTextarea } from "./CodeTextarea";
import { DatabasePreviewGrid, type DatabasePreviewValue } from "./DatabasePreviewGrid";

type Scope = "document" | "current" | "selection";
type ResultSet = {
  columns: { name: string; data_type: string }[];
  rows: (DatabasePreviewValue | null)[][];
  rows_received: number;
  more_columns: boolean;
};
type Statement = { line: number; rows_affected: number | null; data: ResultSet | null; warning: string | null };
type Outcome = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  statements: Statement[];
  elapsed_ms: number;
  error: { line: number | null; code: number | null; message: string } | null;
  server_interrupted: boolean | null;
  transaction: "not_started" | "rolled_back" | "unknown";
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

export function OracleSqlWorkspace({ id, database }: { id: string; database: string }) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [statementIndex, setStatementIndex] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const active = useRef<string | null>(null);
  const editorId = useId();
  const noteId = useId();
  const ready = !busy && Boolean(text.trim());

  async function run(scope: Scope) {
    const field = editor.current;
    if (!field || active.current) return;
    const { value, selectionStart, selectionEnd, selectionDirection } = field;
    const sql = scope === "selection" ? value.slice(selectionStart, selectionEnd) : value;
    if (!sql.trim()) return;
    const caret = selectionDirection === "backward" ? selectionStart : selectionEnd;
    const requestId = crypto.randomUUID();
    active.current = requestId;
    setBusy(true); setStopping(false); setError(""); setOutcome(null); setStatementIndex(0);
    try {
      setOutcome(await invoke<Outcome>("run_oracle_query", {
        id, requestId,
        input: {
          sql,
          first_line: scope === "selection" ? value.slice(0, selectionStart).split("\n").length : 1,
          cursor_byte: scope === "current" ? encoder.encode(value.slice(0, caret)).length : null,
        },
      }));
    } catch (cause) { setError(String(cause)); }
    finally { active.current = null; setBusy(false); setStopping(false); }
  }

  async function stop() {
    const requestId = active.current;
    if (!requestId || stopping) return;
    setStopping(true); setError("");
    try {
      const accepted = await invoke<boolean>("cancel_oracle_query", { id, requestId });
      if (!accepted && active.current === requestId) {
        setStopping(false);
        setError("중단할 실행을 찾을 수 없습니다. 실행 중이라면 다시 시도하세요.");
      }
    } catch (cause) {
      if (active.current === requestId) { setStopping(false); setError(String(cause)); }
    }
  }

  return <section className="results-card mysql-sql relational-query-editor" aria-label="Oracle SQL 편집기">
    <div className="panel-heading"><h2>SQL 편집기</h2><span>{database}</span></div>
    <div className="mysql-sql-actions" role="group" aria-label="SQL 실행">
      <button type="button" className="primary small" disabled={!ready} onClick={() => void run("document")}><Play size={14} aria-hidden /> 전체 실행</button>
      <button type="button" className="secondary small" disabled={!ready} onClick={() => void run("current")}>현재 문장 실행</button>
      <button type="button" className="secondary small" disabled={!ready || !selected} onClick={() => void run("selection")}>선택 실행</button>
      {busy && <button type="button" className="secondary small" disabled={stopping} onClick={() => void stop()}><Square size={14} aria-hidden /> 실행 중단</button>}
      <span role="status">{stopping ? "중단 요청됨 · 진행 중인 호출 처리 중…" : busy ? "실행 중…" : ""}</span>
    </div>
    <CodeTextarea id={editorId} editorRef={editor} value={text} language="oracle" maxLength={256 * 1024} readOnly={busy}
      aria-label="Oracle SQL 문장" aria-describedby={noteId} placeholder="SELECT … FROM DUAL"
      onChange={event => setText(event.target.value)}
      onSelect={event => setSelected(event.currentTarget.selectionStart !== event.currentTarget.selectionEnd)}
      onKeyDown={event => {
        if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        void run(event.currentTarget.selectionStart === event.currentTarget.selectionEnd ? "current" : "selection");
      }} footer={<span>Ctrl + Enter · 현재 문장 또는 선택 실행</span>} />
    <p className="form-note mysql-table-note" id={noteId}>PL/SQL 블록은 별도 줄의 <code>/</code>로 구분합니다. 실행 연결을 닫을 때 열린 트랜잭션은 롤백합니다.</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {outcome && <OracleResults outcome={outcome} index={statementIndex} onSelect={setStatementIndex} />}
  </section>;
}

function OracleResults({ outcome, index, onSelect }: { outcome: Outcome; index: number; onSelect: (index: number) => void }) {
  const statement = outcome.statements[index];
  const data = statement?.data;
  return <section aria-label="Oracle 실행 결과">
    <div className="panel-heading"><h3>실행 결과</h3><span>{number.format(outcome.elapsed_ms)} ms</span></div>
    <p className="form-note mysql-table-note" role="status">{statusText[outcome.status]} · 완료한 문장 {number.format(outcome.statements.length)}개
      {outcome.server_interrupted === true && <> · 서버가 실행 중단을 확인했습니다.</>}
      {outcome.server_interrupted === false && <> · 서버의 중단 응답을 확인하지 못했습니다.</>} {transactionText[outcome.transaction]}</p>
    {outcome.error && <p className="error-banner" role="alert">
      {outcome.error.line !== null && <>문장 시작 {outcome.error.line}행 · </>}{outcome.error.message}
    </p>}
    {outcome.audit_warning && <p className="form-note mysql-table-note">SQL 실행을 감사 로그에 저장하지 못했습니다.</p>}
    {outcome.statements.length > 1 && <div className="mysql-sql-actions">
      <label className="field">문장 결과<select value={index} onChange={event => onSelect(Number(event.target.value))}>
        {outcome.statements.map((result, position) => <option key={position} value={position}>문장 {position + 1} · {result.line}행</option>)}
      </select></label>
    </div>}
    {statement?.warning && <p className="form-note mysql-table-note">{statement.warning}</p>}
    {statement?.rows_affected != null && <p className="form-note mysql-table-note">영향받은 행 {number.format(statement.rows_affected)}개</p>}
    {data && <>
      <p className="form-note mysql-table-note">{number.format(data.rows_received)}행 수신
        {data.rows.length < data.rows_received && <> · 앞 {number.format(data.rows.length)}행 표시</>}
        {data.more_columns && <> · 앞 {data.columns.length}개 열 표시</>}</p>
      <DatabasePreviewGrid columns={data.columns} rows={data.rows} label="Oracle SQL 결과 표" />
    </>}
  </section>;
}
