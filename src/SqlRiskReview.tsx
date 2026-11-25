import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import type { SqlSourceRange } from "./sqlHistory";

type RiskKind = "data_change" | "all_rows" | "bulk" | "schema" | "opaque";
type SqlRisk = { line: number; action: string; kind: RiskKind; repeat: number };
export type SqlExecutionReview = { risks: SqlRisk[]; more_risks: boolean; source_range?: SqlSourceRange; delimiter?: string };
export type SqlReviewTarget = { connection: string; database: string | null; environment: string; scope: string };

const descriptions: Record<RiskKind, string> = {
  data_change: "데이터를 변경할 수 있습니다.",
  all_rows: "행을 제한하는 WHERE 조건을 확인할 수 없습니다.",
  bulk: "여러 행 또는 대량의 데이터를 변경할 수 있습니다.",
  schema: "객체 구조 또는 권한을 변경할 수 있습니다.",
  opaque: "서버에서 실행될 내용에 따라 데이터나 구조가 변경될 수 있습니다.",
};

export function needsSqlReview(review: SqlExecutionReview, environment: string) {
  return review.more_risks || review.risks.some(risk => environment === "PROD" || risk.kind !== "data_change");
}

export function useSqlExecutionCheck(environment: string) {
  const mounted = useRef(false);
  const pending = useRef(false);
  const [checking, setChecking] = useState(false);
  const [proposal, setProposal] = useState<{
    review: SqlExecutionReview;
    scope: string;
    proceed: (confirmation: string, review: SqlExecutionReview) => void;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function check(command: string, args: Record<string, unknown>, scope: string,
    proceed: (confirmation: string, review: SqlExecutionReview) => void, error: (message: string) => void) {
    if (pending.current || proposal) return;
    pending.current = true;
    setChecking(true);
    try {
      const review = await invoke<SqlExecutionReview>(command, args);
      if (!mounted.current) return;
      if (needsSqlReview(review, environment)) setProposal({ review, scope, proceed });
      else proceed("", review);
    } catch (cause) {
      if (mounted.current) error(String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setChecking(false);
    }
  }

  return {
    checking, proposal, check, close: () => setProposal(null),
    confirm: (confirmation: string) => {
      setProposal(null);
      proposal?.proceed(confirmation, proposal.review);
    },
  };
}

export function SqlRiskSummary({ target, review }: { target: SqlReviewTarget; review: SqlExecutionReview }) {
  return <>
    <p className="confirm-copy"><strong>{target.connection} · {target.environment}</strong><br />
      {target.database ? "기본 데이터베이스 " + target.database : "기본 데이터베이스 미선택"} · {target.scope}</p>
    {review.risks.length > 0 && <>
      <ul className="sql-risk-list" tabIndex={0} aria-label="변경 가능성이 있는 SQL">
        {review.risks.map((risk, index) => <li key={index}>
          <strong>{risk.line}줄 · {risk.action}{risk.repeat > 1 && " · " + risk.repeat + "회 실행"}</strong>
          <span>{risk.action === "TRUNCATE" ? "대상 테이블의 모든 행을 제거할 수 있습니다."
            : risk.action === "DROP" ? "객체와 관련 데이터를 삭제할 수 있습니다." : descriptions[risk.kind]}</span>
        </li>)}
      </ul>
      {review.more_risks && <p className="form-note">표시한 100건 외에도 변경 가능성이 있는 문장이 있습니다.</p>}
      <p className="form-note">SQL 구문을 바탕으로 확인한 영향입니다. 실제 변경 행 수는 서버에서 실행한 뒤 확정됩니다.</p>
    </>}
    {target.environment === "PROD" && !review.risks.length &&
      <p className="form-note">운영 연결에서 실행하기 전에 선택한 SQL과 대상 연결을 확인하세요.</p>}
  </>;
}

export function SqlRiskDialog({ target, review, onClose, onConfirm }: {
  target: SqlReviewTarget;
  review: SqlExecutionReview;
  onClose: () => void;
  onConfirm: (confirmation: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const production = target.environment === "PROD";
  const enabled = !production || confirmation === "PROD";
  return <Dialog title={production ? "운영 SQL 실행 검토" : "SQL 실행 검토"} busy={false} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (enabled) onConfirm(confirmation); }}>
      <SqlRiskSummary target={target} review={review} />
      {production && <label className="field">운영 환경 확인
        <input autoFocus value={confirmation} placeholder="PROD" autoComplete="off" onChange={event => setConfirmation(event.target.value)} />
      </label>}
      <div className="dialog-actions">
        <button type="button" className="secondary" autoFocus={!production} onClick={onClose}>취소</button>
        <button type="submit" className="primary" disabled={!enabled}>SQL 실행</button>
      </div>
    </form>
  </Dialog>;
}
