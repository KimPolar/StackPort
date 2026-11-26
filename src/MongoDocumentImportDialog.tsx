import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type ImportReview = {
  token: string;
  bytes: number;
  document_count: number;
  sample: { json: string; truncated: boolean }[];
  atomic: boolean;
  expires_seconds: number;
};

export type MongoImportReport = {
  status: "complete" | "stopped" | "unconfirmed";
  document_count: number;
  inserted: number;
  stopped_at: number | null;
  reason: string | null;
  audit_warning: boolean;
};

const numbers = new Intl.NumberFormat("ko-KR");

export function MongoDocumentImportDialog({ id, database, collection, environment, onBusy, onClose, onDone }: {
  id: string; database: string; collection: string; environment: string;
  onBusy: (busy: boolean) => void; onClose: () => void; onDone: (report: MongoImportReport) => void;
}) {
  const [path, setPath] = useState("");
  const [review, setReview] = useState<ImportReview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [acceptPartial, setAcceptPartial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const token = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const production = environment === "PROD";
  const partialPossible = Boolean(review && !review.atomic && review.document_count > 1);
  const approvalRequired = review && ((!acceptPartial && partialPossible) || (production && confirmation !== "PROD"));

  useEffect(() => () => {
    if (token.current) void invoke("discard_mongo_document_import", { id, token: token.current }).catch(() => {});
  }, [id]);
  useEffect(() => { if (review) heading.current?.focus(); }, [review]);

  function resetReview() {
    if (token.current) void invoke("discard_mongo_document_import", { id, token: token.current }).catch(() => {});
    token.current = null;
    setReview(null);
    setConfirmation("");
    setAcceptPartial(false);
    setError("");
  }

  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try { await action(); }
    catch (cause) { resetReview(); setError(String(cause)); }
    finally { pending.current = false; onBusy(false); setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (approvalRequired) return;
    void perform(async () => {
      if (review) {
        const result = await invoke<MongoImportReport>("apply_mongo_document_import", { id, token: review.token, confirmation, acceptPartial });
        token.current = null;
        onDone(result);
      } else {
        const result = await invoke<ImportReview>("review_mongo_document_import", { id, database, collection, path });
        token.current = result.token;
        setReview(result);
      }
    });
  }

  return <Dialog title="MongoDB 문서 가져오기" busy={busy} className="restore-dialog mongo-namespace-dialog" onClose={onClose}>
    <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{environment}</strong> · {database}.{collection}</p>
      <label className="field">가져올 JSON 파일 경로<span className="file-input">
        <input required readOnly={Boolean(review)} disabled={busy} value={path} onChange={event => setPath(event.target.value)}
          placeholder="JSON 파일의 절대 경로" />
        {!review && <button type="button" className="secondary" disabled={busy} onClick={() => void perform(async () => {
          const file = await invoke<string | null>("choose_mongo_import_file");
          if (file) setPath(file);
        })}>파일 선택</button>}
      </span></label>
      {!review ? <p className="form-note">UTF-8 JSON 객체·배열 또는 줄마다 한 문서인 JSON Lines를 가져옵니다. 파일당 32 MiB와 문서 1,000개까지 검토할 수 있습니다.</p> : <>
        <h3 className="mongo-edit-review-heading" ref={heading} tabIndex={-1}>문서 {numbers.format(review.document_count)}개 추가 · {numbers.format(review.bytes)} B</h3>
        <p className="form-note">미리보기는 최대 3개 문서를 Canonical Extended JSON으로 표시합니다. 검토는 {review.expires_seconds / 60}분 동안 유효합니다.</p>
        <div className="mongo-edit-compare">
          {review.sample.map((sample, index) => <section key={index}>
            <strong>문서 {index + 1}{sample.truncated && " · 일부 표시"}</strong>
            <pre aria-label={`문서 ${index + 1} 미리보기`}>{sample.json}{sample.truncated && "…"}</pre>
          </section>)}
        </div>
        {review.atomic ? <p className="form-note">한 트랜잭션으로 저장합니다. 중복 키나 검증 오류가 발생하면 전체 작업을 취소합니다.</p>
          : partialPossible && <label className="files-check"><input type="checkbox" checked={acceptPartial} disabled={busy}
            onChange={event => setAcceptPartial(event.target.checked)} /> 첫 오류에서 중단되며 그 전에 저장된 문서는 유지됩니다.</label>}
        {production && <label className="field">운영 환경 확인<input required autoComplete="off" placeholder="PROD" disabled={busy}
          value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {review && <button type="button" className="secondary" disabled={busy} onClick={resetReview}>다시 검토</button>}
        <button type="submit" className="primary" disabled={busy || Boolean(approvalRequired)}>
          {busy ? "처리 중…" : review ? "검토한 문서 추가" : "파일 검토"}
        </button>
      </div>
    </form>
  </Dialog>;
}

export function MongoDocumentImportReport({ report }: { report: MongoImportReport }) {
  const status = report.status === "complete" ? "가져오기 완료" : report.status === "stopped" ? "가져오기 중단" : "저장 결과 미확인";
  return <p className={report.status === "complete" ? "form-note mongo-note" : "error-banner"} role={report.status === "complete" ? "status" : "alert"}>
    {status} · {numbers.format(report.document_count)}개 중 저장 확인 {numbers.format(report.inserted)}개
    {report.stopped_at !== null && (report.status === "unconfirmed"
      ? ` · 문서 ${numbers.format(report.stopped_at)}부터 결과 미확인`
      : ` · 문서 ${numbers.format(report.stopped_at)}에서 중단`)}
    {report.reason && ` · ${report.reason}`}
    {report.audit_warning && " · 완료 감사 기록 저장 실패"}
  </p>;
}
