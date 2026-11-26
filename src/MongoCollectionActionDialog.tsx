import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import type { MongoNamespaceReport } from "./MongoNamespaceDialog";

export type MongoCollectionAction = "drop" | "rename";
type Review = { token: string; dependent_views: string[]; expires_seconds: number } & ({
  estimated_documents: string | null;
  index_count: number | null;
} | { new_name: string; destination_views: string[] });
const displayNumber = new Intl.NumberFormat("ko-KR");

export function MongoCollectionActionDialog({ id, database, name, action, environment, onBusy, onClose, onDone }: {
  id: string; database: string; name: string; action: MongoCollectionAction; environment: string;
  onBusy: (busy: boolean) => void; onClose: () => void; onDone: (report: MongoNamespaceReport) => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [newName, setNewName] = useState("");
  const [approval, setApproval] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const token = useRef<string | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const production = environment === "PROD";
  const dropping = action === "drop";
  const awaitingApproval = Boolean(review && ((dropping && approval !== "DROP") || (production && confirmation !== "PROD")));

  useEffect(() => () => {
    if (token.current) void invoke("discard_mongo_namespace_review", { id, token: token.current }).catch(() => {});
  }, [id]);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);

  function resetReview() {
    if (token.current) void invoke("discard_mongo_namespace_review", { id, token: token.current }).catch(() => {});
    token.current = null;
    setReview(null);
    setApproval("");
    setConfirmation("");
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || awaitingApproval) return;
    pending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      if (review) {
        const args = { id, token: review.token, confirmation };
        const result = dropping
          ? await invoke<MongoNamespaceReport>("apply_mongo_collection_drop", { ...args, approval })
          : await invoke<MongoNamespaceReport>("apply_mongo_collection_rename", args);
        token.current = null;
        onDone(result);
      } else {
        const args = { id, database, name };
        const result = dropping ? await invoke<Review>("review_mongo_collection_drop", args)
          : await invoke<Review>("review_mongo_collection_rename", { ...args, newName });
        token.current = result.token;
        setReview(result);
      }
    } catch (cause) {
      resetReview();
      setError(String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  return <Dialog title={dropping ? "MongoDB 컬렉션 삭제" : "MongoDB 컬렉션 이름 변경"}
    busy={busy} className="restore-dialog mongo-namespace-dialog" onClose={onClose}>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <p className="confirm-copy"><strong>{environment}</strong> · {database}.{name}
        {review && "new_name" in review && <> → {database}.{review.new_name}</>}
      </p>
      {dropping && <p className="form-note">컬렉션의 모든 문서와 인덱스가 삭제됩니다.</p>}
      {!dropping && !review && <label className="field">새 컬렉션 이름<input required value={newName} maxLength={256}
        disabled={busy} onChange={event => setNewName(event.target.value)} /></label>}
      {review && <>
        <h3 ref={reviewHeading} tabIndex={-1}>{dropping ? "삭제 영향 검토" : "이름 변경 검토"}</h3>
        {"estimated_documents" in review ? <ul className="mongo-index-impact">
          <li>{review.estimated_documents === null ? "문서 수 추정치 조회 불가"
            : "문서 약 " + displayNumber.format(BigInt(review.estimated_documents)) + "개"}</li>
          <li>{review.index_count === null ? "인덱스 수 조회 불가" : "인덱스 " + displayNumber.format(review.index_count) + "개"}</li>
        </ul> : <p className="form-note">이 컬렉션의 열려 있는 커서와 변경 스트림이 중단될 수 있습니다.</p>}
        {review.dependent_views.length > 0 ? <>
          <p className="form-note">{dropping ? "같은 데이터베이스의 다음 뷰에서 결과가 바뀌거나 조회가 실패할 수 있습니다."
            : "다음 뷰는 기존 이름을 사용하므로 결과가 바뀌거나 조회가 실패할 수 있습니다."}</p>
          <ul className="mongo-affected-views" aria-label={dropping ? "영향을 받는 뷰" : "기존 이름을 사용하는 뷰"}>
            {review.dependent_views.map(view => <li key={view}>{view}</li>)}
          </ul>
        </> : <p className="form-note">{dropping ? "이 데이터베이스에 이 컬렉션을 사용하는 뷰가 없습니다."
          : "이 데이터베이스에서 기존 이름을 사용하는 뷰가 없습니다."}</p>}
        {"destination_views" in review && review.destination_views.length > 0 && <>
          <p className="form-note">다음 뷰의 새 이름 참조가 이 컬렉션을 가리키게 됩니다.</p>
          <ul className="mongo-affected-views" aria-label="새 이름을 사용하는 뷰">
            {review.destination_views.map(view => <li key={view}>{view}</li>)}
          </ul>
        </>}
        <p className="form-note">검토는 {review.expires_seconds / 60}분 동안 유효합니다.</p>
        {dropping && <label className="field">컬렉션 삭제 승인<input required autoComplete="off" placeholder="DROP"
          value={approval} disabled={busy} onChange={event => setApproval(event.target.value)} /></label>}
        {production && <label className="field">운영 환경 확인<input required autoComplete="off" placeholder="PROD"
          value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {!dropping && review && <button type="button" className="secondary" disabled={busy} onClick={resetReview}>입력 수정</button>}
        <button type="submit" className={dropping && review ? "danger" : "primary"} disabled={busy || awaitingApproval}>
          {busy ? "처리 중…" : dropping ? (review ? "검토한 컬렉션 삭제" : "삭제 영향 조회")
            : (review ? "검토한 이름 적용" : "이름 변경 검토")}
        </button>
      </div>
    </form>
  </Dialog>;
}
