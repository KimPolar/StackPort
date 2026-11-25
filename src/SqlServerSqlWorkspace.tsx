import { useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Square } from "lucide-react";
import { CodeTextarea } from "./CodeTextarea";
import { DatabasePreviewGrid, type DatabasePreviewValue } from "./DatabasePreviewGrid";

type Scope = "document" | "batch" | "selection";
type ResultSet = {
  columns: { name: string; data_type: string }[];
  rows: (DatabasePreviewValue | null)[][];
  rows_received: number;
  more_columns: boolean;
};
type Outcome = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  result_sets: ResultSet[];
  more_sets: boolean;
  completed_batches: number;
  elapsed_ms: number;
  error: { message: string; code: number | null; line: number | null; procedure: string | null } | null;
  attention: "not_sent" | "confirmed" | "unconfirmed" | null;
  transaction: "not_started" | "none_open" | "rolled_back" | "unknown";
  audit_warning: boolean;
};

const statusText = { succeeded: "실행 완료", failed: "실행 실패", cancelled: "실행 중단", timed_out: "시간 초과" };
const transactionText = {
  not_started: "실행 연결에서 시작한 트랜잭션이 없습니다.",
  none_open: "열린 트랜잭션 없이 실행 연결을 닫았습니다.",
  rolled_back: "열린 트랜잭션을 롤백했습니다.",
  unknown: "실행 연결을 닫았습니다. 열린 트랜잭션의 롤백 완료는 확인되지 않았습니다.",
};
const attentionText = {
  not_sent: "중단 시점에 서버 응답을 기다리는 배치가 없었습니다.",
  confirmed: "서버가 중단 요청을 확인했습니다.",
  unconfirmed: "서버의 중단 응답을 확인하지 못했습니다.",
};
const number = new Intl.NumberFormat("ko-KR");
const sqlLimit = 256 * 1024;

export function SqlServerSqlWorkspace({ id, database }: { id: string; database: string }) {
  const [text, setText] = useState("");
  const [hasSelection, setHasSelection] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [resultIndex, setResultIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  const active = useRef<string | null>(null);
  const editorId = useId();
  const noteId = useId();
  const ready = !busy && Boolean(text.trim());
  const result = outcome?.result_sets[resultIndex];

  async function run(scope: Scope) {
    const field = editor.current;
    if (!field || active.current || !field.value.trim()) return;
    const { value, selectionStart, selectionEnd, selectionDirection } = field;
    const selected = scope === "selection";
    const sql = selected ? value.slice(selectionStart, selectionEnd) : value;
    if (!sql.trim()) return;
    const line = (offset: number) => value.slice(0, offset).split("\n").length;
    const requestId = crypto.randomUUID();
    active.current = requestId;
    setBusy(true); setStopping(false); setError(""); setOutcome(null); setResultIndex(0);
    try {
      setOutcome(await invoke<Outcome>("run_sql_server_query", {
        id, requestId,
        input: {
          sql,
          first_line: selected ? line(selectionStart) : 1,
          cursor_line: scope === "batch" ? line(selectionDirection === "backward" ? selectionStart : selectionEnd) : null,
        },
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      active.current = null;
      setBusy(false); setStopping(false);
    }
  }

  async function stop() {
    const requestId = active.current;
    if (!requestId || stopping) return;
    setStopping(true); setError("");
    try {
      const accepted = await invoke<boolean>("cancel_sql_server_query", { id, requestId });
      if (!accepted && active.current === requestId) {
        setStopping(false);
        setError("중단할 실행을 찾을 수 없습니다. 실행 중이라면 다시 시도하세요.");
      }
    } catch (cause) {
      if (active.current === requestId) {
        setStopping(false);
        setError(String(cause));
      }
    }
  }

  return <section className="results-card mysql-sql sql-server-query" aria-label="SQL Server SQL 편집기">
    <div className="panel-heading"><h2>SQL 편집기</h2><span>{database}</span></div>
    <div className="mysql-sql-actions" role="group" aria-label="SQL 실행">
      <button type="button" className="primary small" disabled={!ready} onClick={() => void run("document")}>
        <Play size={14} aria-hidden /> 전체 실행
      </button>
      <button type="button" className="secondary small" disabled={!ready} onClick={() => void run("batch")}>현재 배치 실행</button>
      <button type="button" className="secondary small" disabled={!ready || !hasSelection} onClick={() => void run("selection")}>선택 실행</button>
      {busy && <button type="button" className="secondary small" disabled={stopping} onClick={() => void stop()}>
        <Square size={14} aria-hidden /> 실행 중단
      </button>}
      <span role="status">{stopping ? "중단 요청 중…" : busy ? "실행 중…" : ""}</span>
    </div>
    <CodeTextarea id={editorId} editorRef={editor} value={text} language="tsql" maxLength={sqlLimit} readOnly={busy}
      aria-label="SQL Server SQL 문장" aria-describedby={noteId} placeholder="SELECT …"
      onChange={event => setText(event.target.value)}
      onSelect={event => setHasSelection(event.currentTarget.selectionStart !== event.currentTarget.selectionEnd)}
      onKeyDown={event => {
        if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        const { selectionStart, selectionEnd } = event.currentTarget;
        void run(selectionStart === selectionEnd ? "batch" : "selection");
      }}
      footer={<span>Ctrl + Enter · 현재 배치 또는 선택 실행</span>} />
    <p className="form-note mysql-table-note" id={noteId}>로그인 계정의 권한으로 실행합니다. 커밋된 변경은 유지되고 열린 트랜잭션은 실행 연결이 닫힐 때 롤백됩니다.</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {outcome && <section aria-label="SQL Server 실행 결과">
      <div className="panel-heading"><h3>실행 결과</h3><span>{number.format(outcome.elapsed_ms)} ms</span></div>
      <p className="form-note mysql-table-note" role="status">{statusText[outcome.status]} · 완료한 배치 {number.format(outcome.completed_batches)}개
        {outcome.attention && <> · {attentionText[outcome.attention]}</>} {transactionText[outcome.transaction]}</p>
      {outcome.error && <p className="error-banner" role="alert">
        {outcome.error.code !== null && <>오류 {outcome.error.code} · </>}
        {outcome.error.procedure && <>{outcome.error.procedure} · </>}
        {outcome.error.line !== null && <>{outcome.error.line}행 · </>}{outcome.error.message}
      </p>}
      {outcome.audit_warning && <p className="form-note mysql-table-note">SQL 실행을 감사 로그에 저장하지 못했습니다.</p>}
      {outcome.more_sets && <p className="form-note mysql-table-note">앞 {outcome.result_sets.length}개 결과 집합을 표시합니다.</p>}
      {outcome.result_sets.length > 1 && <div className="mysql-sql-actions">
        <label className="field">결과 집합<select value={resultIndex} onChange={event => setResultIndex(Number(event.target.value))}>
          {outcome.result_sets.map((_, index) => <option key={index} value={index}>결과 {index + 1}</option>)}
        </select></label>
      </div>}
      {result && <>
        <p className="form-note mysql-table-note">{number.format(result.rows_received)}행 수신
          {result.rows.length < result.rows_received && <> · 앞 {number.format(result.rows.length)}행 표시</>}
          {result.more_columns && <> · 앞 {result.columns.length}개 열 표시</>}</p>
        <DatabasePreviewGrid columns={result.columns} rows={result.rows} label="SQL Server SQL 결과 표" />
      </>}
    </section>}
  </section>;
}
