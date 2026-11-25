import { useState } from "react";
import { DatabasePreviewGrid } from "./DatabasePreviewGrid";
import type { PostgresCell } from "./PostgresSqlWorkspace";
import type { ExportReport } from "./ResultExportDialog";

type Statement = {
  line: number;
  elapsed_ms: number;
  columns: { name: string; data_type: string }[];
  total_columns: number;
  rows: (PostgresCell & { hex?: boolean })[][];
  more_rows: boolean;
  affected_rows: number | null;
  notices: { severity: string; sql_state: string; message: string }[];
};

export type PostgresScriptOutcome = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  statements: Statement[];
  elapsed_ms: number;
  error: { line: number | null; position: number | null; sql_state: string | null; message: string } | null;
  server_confirmed: boolean | null;
  transaction: "not_started" | "cleanup_confirmed" | "unknown";
  connection_closed: boolean;
  audit_warning: boolean;
  export_report?: ExportReport;
  export_error?: string;
};

const statusLabels = { succeeded: "실행 완료", failed: "실행 실패", cancelled: "실행 중단", timed_out: "시간 초과" };
const transactionLabels = {
  not_started: "스크립트를 서버에 보내지 않았습니다.",
  cleanup_confirmed: "종료 시 남은 트랜잭션을 정리했습니다.",
  unknown: "남은 트랜잭션의 정리 여부를 확인하지 못했습니다.",
};
const number = new Intl.NumberFormat("ko-KR");

export function PostgresScriptResults({ outcome, jump }: {
  outcome: PostgresScriptOutcome;
  jump?: (position: number) => void;
}) {
  const [index, setIndex] = useState(0);
  const statement = outcome.statements[index];
  const error = outcome.error;
  const position = error?.position;

  return <section className="results-card postgres-script-result" aria-label="PostgreSQL 스크립트 결과">
    <div className="panel-heading"><strong>스크립트 결과</strong>
      <span className="result-count">{number.format(outcome.elapsed_ms)} ms</span>
    </div>
    <p className="form-note postgres-page-note" role="status">
      {statusLabels[outcome.status]} · 결과를 받은 문장 {number.format(outcome.statements.length)}개
      {outcome.server_confirmed === true && " · 서버에서 중단을 확인했습니다."}
      {outcome.server_confirmed === false && " · 서버 중단 여부를 확인하지 못했습니다."}
      {" "}{transactionLabels[outcome.transaction]}
      {outcome.connection_closed && " PostgreSQL 연결을 닫았습니다."}
    </p>
    {error && <div className="error-banner" role="alert">
      {error.line !== null && <>문장 시작 {error.line}행 · </>}
      {error.message}{error.sql_state && <> · SQLSTATE {error.sql_state}</>}
      {position != null && jump && <button type="button" className="secondary small"
        onClick={() => jump(position)}>오류 위치로 이동</button>}
    </div>}
    {outcome.export_report && <p className="form-note postgres-page-note" role="status">
      JSON 저장 완료 · {number.format(outcome.export_report.rows)}행 · {number.format(outcome.export_report.size_bytes)} B{" "}
      <code>{outcome.export_report.path}</code>
    </p>}
    {outcome.export_error && <p className="error-banner" role="alert">{outcome.export_error}</p>}
    {outcome.audit_warning && <p className="form-note postgres-page-note">이 작업의 감사 기록을 완료하지 못했습니다.</p>}
    {statement && <>
      {outcome.statements.length > 1 && <div className="postgres-script-toolbar">
        <label className="field">문장 결과<select value={index} aria-label="문장 결과" onChange={event => setIndex(Number(event.target.value))}>
          {outcome.statements.map((item, index) => <option key={index} value={index}>문장 {index + 1} · {item.line}행</option>)}
        </select></label>
      </div>}
      <p className="form-note postgres-page-note">{statement.line}행 · {number.format(statement.elapsed_ms)} ms
        {statement.columns.length === 0 && statement.affected_rows !== null && <> · 영향받은 행 {number.format(statement.affected_rows)}개</>}
        {statement.total_columns > 0 && <> · {number.format(statement.rows.length)}행 표시</>}
        {statement.more_rows && " · 추가 행 있음"}
        {statement.total_columns > statement.columns.length && <> · 전체 {statement.total_columns}열 중 {statement.columns.length}열</>}
      </p>
      {statement.notices.length > 0 && <ul className="form-note postgres-script-notices">
        {statement.notices.map((notice, index) => <li key={index}>{notice.severity} · {notice.message} · {notice.sql_state}</li>)}
      </ul>}
      {statement.columns.length > 0 && <DatabasePreviewGrid columns={statement.columns} label="PostgreSQL 스크립트 데이터"
        rows={statement.rows.map(row => row.map(cell => cell.value === null ? null : {
          text: cell.value, truncated: cell.truncated, encoding: cell.hex ? "hex" : "utf8", bytes: null,
        }))} />}
    </>}
  </section>;
}
