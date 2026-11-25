import { useState } from "react";
import { DatabasePreviewGrid, type DatabasePreviewValue } from "./DatabasePreviewGrid";

type ResultSet = {
  columns: { name: string; data_type: string }[];
  rows: (DatabasePreviewValue | null)[][];
  more_rows: boolean;
  more_columns: boolean;
  affected_rows: number | null;
  warnings: number | null;
};

export type MysqlScriptOutcome = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  statements: { line: number; elapsed_ms: number; sets: ResultSet[]; more_sets: boolean }[];
  elapsed_ms: number;
  error: { line: number | null; code: number | null; sql_state: string | null; message: string } | null;
  server_interrupted: boolean | null;
  transaction: "not_started" | "cleanup_confirmed" | "unknown";
  audit_warning: boolean;
};

const statusText = { succeeded: "실행 완료", failed: "실행 실패", cancelled: "실행 중단", timed_out: "시간 초과" };
const transactionText = {
  not_started: "실행 연결을 열지 않았습니다.",
  cleanup_confirmed: "종료 시 남은 트랜잭션을 정리했습니다.",
  unknown: "실행 연결을 닫았습니다. 롤백 완료는 확인되지 않았습니다.",
};
const number = new Intl.NumberFormat("ko-KR");

export function MysqlScriptResults({ outcome }: { outcome: MysqlScriptOutcome }) {
  const [statementIndex, setStatementIndex] = useState(0);
  const [setIndex, setSetIndex] = useState(0);
  const statement = outcome.statements[statementIndex];
  const result = statement?.sets[setIndex];
  return <section aria-label="MySQL 스크립트 결과">
    <div className="panel-heading"><h3>스크립트 결과</h3><span>{number.format(outcome.elapsed_ms)} ms</span></div>
    <p className="form-note mysql-table-note" role="status">{statusText[outcome.status]} · 결과를 받은 문장 {number.format(outcome.statements.length)}개
      {outcome.server_interrupted === true && <> · 서버가 실행 중단을 확인했습니다.</>}
      {outcome.server_interrupted === false && <> · 서버 실행 중단 여부는 확인되지 않았습니다.</>}
      <> {transactionText[outcome.transaction]}</></p>
    {outcome.error && <p className="error-banner" role="alert">
      {outcome.error.line !== null && <>문장 시작 {outcome.error.line}행 · </>}
      {outcome.error.message}{outcome.error.sql_state && <> · SQLSTATE {outcome.error.sql_state}</>}
    </p>}
    {outcome.audit_warning && <p className="form-note mysql-table-note">스크립트 실행을 감사 로그에 저장하지 못했습니다.</p>}
    {statement && <>
      <div className="mysql-sql-actions">
        {outcome.statements.length > 1 && <label className="field">문장 결과<select value={statementIndex} onChange={event => {
          setStatementIndex(Number(event.target.value)); setSetIndex(0);
        }}>
          {outcome.statements.map((item, index) => <option key={index} value={index}>문장 {index + 1} · {item.line}행</option>)}
        </select></label>}
        {statement.sets.length > 1 && <label className="field">결과 집합<select value={setIndex} onChange={event => setSetIndex(Number(event.target.value))}>
          {statement.sets.map((_, index) => <option key={index} value={index}>결과 {index + 1}</option>)}
        </select></label>}
      </div>
      <p className="form-note mysql-table-note">{statement.line}행 · {number.format(statement.elapsed_ms)} ms
        {statement.more_sets && " · 일부 결과 집합 표시"}
        {result?.affected_rows != null && <> · 영향받은 행 {number.format(result.affected_rows)}개</>}
        {!!result?.warnings && <> · 경고 {number.format(result.warnings)}건</>}</p>
      {!!result?.columns.length && <>
        <p className="form-note mysql-table-note">{number.format(result.rows.length)}행 표시
          {result.more_rows && " · 추가 행 있음"}{result.more_columns && " · 앞 128개 열"}</p>
        <DatabasePreviewGrid columns={result.columns} rows={result.rows} label="MySQL 스크립트 결과 표" />
      </>}
    </>}
  </section>;
}
