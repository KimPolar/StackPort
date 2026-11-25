import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

const keyTypes = { asc: "오름차순", desc: "내림차순", text: "텍스트", sphere: "2dsphere", planar: "2d", hashed: "해시" };
type KeyType = keyof typeof keyTypes;
type KeyRow = { id: number; field: string; kind: KeyType };
export type MongoIndexAction = { kind: "create" } | { kind: "drop"; name: string }
  | { kind: "modify"; name: string; hidden: boolean; ttlSeconds: number | null; ttlEligible: boolean };
export const mongoIndexActionLabels = { create: "생성", drop: "삭제", modify: "옵션 변경" };
type Review = {
  token: string; definition: string; previous_definition: string | null; unique: boolean;
  ttl_seconds: number | null; ttl_may_expire_documents: boolean; hidden: boolean; visibility_changed: boolean;
  usage: { operations: string; observed_nodes: number } | null; expires_seconds: number;
};
const displayNumber = new Intl.NumberFormat("ko-KR");

export function MongoIndexDialog({ target, action, environment, onBusy, onClose, onDone }: {
  target: { id: string; database: string; collection: string }; action: MongoIndexAction; environment: string;
  onBusy: (busy: boolean) => void; onClose: () => void; onDone: (auditWarning: boolean) => void;
}) {
  const [name, setName] = useState(action.kind === "create" ? "" : action.name);
  const [keys, setKeys] = useState<KeyRow[]>([{ id: 0, field: "", kind: "asc" }]);
  const [unique, setUnique] = useState(false);
  const [ttl, setTtl] = useState(action.kind === "modify" && action.ttlSeconds !== null ? String(action.ttlSeconds) : "");
  const [hideIndex, setHideIndex] = useState(action.kind === "modify" && action.hidden);
  const [updateTtl, setUpdateTtl] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [approval, setApproval] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const token = useRef<string | null>(null);
  const pending = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const dropping = action.kind === "drop";
  const actionLabel = mongoIndexActionLabels[action.kind];
  const production = environment === "PROD";
  const { id } = target;

  useEffect(() => () => {
    if (token.current) void invoke("discard_mongo_index_review", { id, token: token.current }).catch(() => {});
  }, [id]);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);

  function replaceKey(index: number, change: Partial<Pick<KeyRow, "field" | "kind">>) {
    setKeys(rows => rows.map((key, at) => at === index ? { ...key, ...change } : key));
  }

  function moveKey(index: number, to: number) {
    setKeys(rows => {
      const reordered = rows.slice();
      reordered.splice(to, 0, ...reordered.splice(index, 1));
      return reordered;
    });
  }

  function resetReview() {
    if (token.current) void invoke("discard_mongo_index_review", { id, token: token.current }).catch(() => {});
    token.current = null;
    setReview(null); setError(""); setApproval(""); setConfirmation("");
  }

  const needsApproval = Boolean(review && ((production && confirmation !== "PROD") || (dropping && approval !== "DROP")));
  const expireAfterSeconds = ttl === "" ? null : Number(ttl);
  const hiddenChange = action.kind === "modify" && hideIndex !== action.hidden ? hideIndex : null;
  const ttlChange = action.kind === "modify" && updateTtl && expireAfterSeconds !== action.ttlSeconds ? expireAfterSeconds : null;
  const noOptionChange = !review && action.kind === "modify" && hiddenChange === null && ttlChange === null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || needsApproval || noOptionChange) return;
    pending.current = true; setBusy(true); onBusy(true); setError("");
    try {
      if (review) {
        const result = await invoke<{ audit_warning: boolean }>("apply_mongo_index_change", { id, token: review.token, approval, confirmation });
        token.current = null;
        onDone(result.audit_warning);
      } else {
        const input = action.kind === "create" ? {
          kind: action.kind, name, keys: keys.map(({ field, kind }) => ({ field, kind })), unique, expire_after_seconds: expireAfterSeconds,
        } : action.kind === "modify" ? {
          kind: action.kind, name, hidden: hiddenChange, expire_after_seconds: ttlChange,
        } : action;
        const result = await invoke<Review>("review_mongo_index_change", { ...target, input });
        token.current = result.token;
        setReview(result);
      }
    } catch (cause) {
      if (review) resetReview();
      setError(String(cause));
    } finally {
      pending.current = false; setBusy(false); onBusy(false);
    }
  }

  return <Dialog title={`MongoDB 인덱스 ${actionLabel}`} busy={busy}
    className="restore-dialog mongo-index-dialog" onClose={onClose}>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <p className="confirm-copy"><strong>{environment}</strong> · {target.database}.{target.collection}{action.kind !== "create" && <> · {name}</>}</p>
      {review ? <>
        <h3 ref={reviewHeading} tabIndex={-1}>{dropping ? "삭제 영향 검토" : `${actionLabel} 검토`}</h3>
        {review.previous_definition === null ? <pre className="mongo-index-definition" aria-label="인덱스 정의" tabIndex={0}>{review.definition}</pre>
          : <div className="mongo-index-comparison">
            <section><h4>변경 전</h4><pre className="mongo-index-definition" aria-label="변경 전 인덱스 정의" tabIndex={0}>{review.previous_definition}</pre></section>
            <section><h4>변경 후</h4><pre className="mongo-index-definition" aria-label="변경 후 인덱스 정의" tabIndex={0}>{review.definition}</pre></section>
          </div>}
        {dropping && <ul className="mongo-index-impact">
          <li>{review.hidden ? "숨김 인덱스입니다." : "이 인덱스를 선택하는 조회의 실행 계획이 바뀔 수 있습니다."}</li>
          {review.unique && <li>이 인덱스가 적용하던 고유 제약이 제거됩니다.</li>}
          {review.ttl_seconds !== null && <li>이 인덱스의 TTL 자동 만료가 중단됩니다.</li>}
          <li>{review.usage ? `조회된 노드 ${review.usage.observed_nodes}곳의 사용 횟수 ${displayNumber.format(BigInt(review.usage.operations))}회` : "서버 사용 통계를 조회할 수 없습니다."}</li>
        </ul>}
        {review.visibility_changed && <p className="form-note">{review.hidden ? "쿼리 플래너에서 이 인덱스를 제외합니다." : "쿼리 플래너가 이 인덱스를 다시 선택할 수 있습니다."}
          {review.usage && ` 조회된 노드 ${review.usage.observed_nodes}곳의 사용 횟수 ${displayNumber.format(BigInt(review.usage.operations))}회.`}</p>}
        {review.ttl_may_expire_documents && <p className="form-note">TTL이 적용되면 서버가 이미 만료된 문서를 삭제할 수 있습니다.</p>}
        <p className="form-note">검토는 {review.expires_seconds / 60}분 동안 유효합니다.</p>
        {dropping && <label className="field">인덱스 삭제 승인<input value={approval} placeholder="DROP" autoComplete="off"
          required disabled={busy} onChange={event => setApproval(event.target.value)} /></label>}
        {production && <label className="field">운영 환경 확인<input value={confirmation} placeholder="PROD" autoComplete="off"
          required disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      </> : action.kind === "create" ? <fieldset className="mongo-index-fields" disabled={busy}>
        <label className="field">인덱스 이름<input required value={name} maxLength={128} onChange={event => setName(event.target.value)} /></label>
        <ol className="mongo-index-keys">{keys.map((key, index) => <li key={key.id}>
          <div className="mongo-sort">
            <label className="field">필드 경로<input required value={key.field} maxLength={256} placeholder="profile.city"
              onChange={event => replaceKey(index, { field: event.target.value })} /></label>
            <label className="field">키 유형<select value={key.kind} onChange={event => replaceKey(index, { kind: event.target.value as KeyType })}>
              {Object.entries(keyTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          </div>
          {keys.length > 1 && <div className="mongo-find-actions">
            <button type="button" className="secondary small" disabled={index === 0} onClick={() => moveKey(index, index - 1)}>위로</button>
            <button type="button" className="secondary small" disabled={index === keys.length - 1} onClick={() => moveKey(index, index + 1)}>아래로</button>
            <button type="button" className="secondary small" onClick={() => setKeys(rows => rows.filter(row => row.id !== key.id))}>키 제거</button>
          </div>}
        </li>)}</ol>
        <button type="button" className="secondary small" disabled={keys.length === 32}
          onClick={() => setKeys([...keys, { id: nextId.current++, field: "", kind: "asc" }])}>키 추가</button>
        <label className="mongo-find-combine"><input type="checkbox" checked={unique} onChange={event => setUnique(event.target.checked)} /> 고유 값만 허용</label>
        <label className="field">TTL (초)<input type="number" min={0} max={2147483647} step={1} value={ttl} placeholder="만료 없음"
          onChange={event => setTtl(event.target.value)} /></label>
      </fieldset> : action.kind === "modify" && <fieldset className="mongo-index-fields" disabled={busy}>
        <label className="mongo-find-combine"><input type="checkbox" checked={hideIndex}
          onChange={event => setHideIndex(event.target.checked)} /> 쿼리 플래너에서 숨기기</label>
        {action.ttlEligible && <>
          <label className="mongo-find-combine"><input type="checkbox" checked={updateTtl}
            onChange={event => setUpdateTtl(event.target.checked)} /> {action.ttlSeconds === null ? "TTL 추가" : "TTL 변경"}</label>
          {updateTtl && <label className="field">TTL (초)<input type="number" required min={0} max={2147483647} step={1} value={ttl}
            onChange={event => setTtl(event.target.value)} /></label>}
        </>}
      </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        {review && !dropping && <button type="button" className="secondary" disabled={busy} onClick={resetReview}>설정 수정</button>}
        <button type="submit" className={review && dropping ? "danger" : "primary"} disabled={busy || needsApproval || noOptionChange}>
          {review ? (dropping ? "검토한 인덱스 삭제" : `인덱스 ${actionLabel} 적용`) : (dropping ? "삭제 영향 조회" : `${actionLabel} 검토`)}
        </button>
      </div>
    </form>
  </Dialog>;
}
