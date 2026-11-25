import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

const keyTypes = { asc: "오름차순", desc: "내림차순", text: "텍스트", sphere: "2dsphere", planar: "2d", hashed: "해시" };
type KeyType = keyof typeof keyTypes;
type KeyRow = { id: number; field: string; kind: KeyType };
export type MongoIndexAction = { kind: "create" } | { kind: "drop"; name: string };
type Review = {
  token: string; definition: string; unique: boolean; ttl_seconds: number | null; hidden: boolean;
  usage: { operations: string; observed_nodes: number } | null; expires_seconds: number;
};
const displayNumber = new Intl.NumberFormat("ko-KR");

export function MongoIndexDialog({ target, action, environment, onBusy, onClose, onDone }: {
  target: { id: string; database: string; collection: string }; action: MongoIndexAction; environment: string;
  onBusy: (busy: boolean) => void; onClose: () => void; onDone: (auditWarning: boolean) => void;
}) {
  const [name, setName] = useState(action.kind === "drop" ? action.name : "");
  const [keys, setKeys] = useState<KeyRow[]>([{ id: 0, field: "", kind: "asc" }]);
  const [unique, setUnique] = useState(false);
  const [ttl, setTtl] = useState("");
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || needsApproval) return;
    pending.current = true; setBusy(true); onBusy(true); setError("");
    try {
      if (review) {
        const result = await invoke<{ audit_warning: boolean }>("apply_mongo_index_change", { id, token: review.token, approval, confirmation });
        token.current = null;
        onDone(result.audit_warning);
      } else {
        const input = action.kind === "drop" ? action : {
          kind: "create", name, keys: keys.map(({ field, kind }) => ({ field, kind })), unique,
          expire_after_seconds: ttl === "" ? null : Number(ttl),
        };
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

  return <Dialog title={dropping ? "MongoDB 인덱스 삭제" : "MongoDB 인덱스 생성"} busy={busy}
    className="restore-dialog mongo-index-dialog" onClose={onClose}>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <p className="confirm-copy"><strong>{environment}</strong> · {target.database}.{target.collection}{dropping && <> · {name}</>}</p>
      {review ? <>
        <h3 ref={reviewHeading} tabIndex={-1}>{dropping ? "삭제 영향 검토" : "생성 설정 검토"}</h3>
        <pre className="mongo-index-definition" aria-label="인덱스 정의" tabIndex={0}>{review.definition}</pre>
        {dropping && <ul className="mongo-index-impact">
          <li>{review.hidden ? "숨김 인덱스입니다." : "이 인덱스를 선택하는 조회의 실행 계획이 바뀔 수 있습니다."}</li>
          {review.unique && <li>이 인덱스가 적용하던 고유 제약이 제거됩니다.</li>}
          {review.ttl_seconds !== null && <li>이 인덱스의 TTL 자동 만료가 중단됩니다.</li>}
          <li>{review.usage ? `조회된 노드 ${review.usage.observed_nodes}곳의 사용 횟수 ${displayNumber.format(BigInt(review.usage.operations))}회` : "서버 사용 통계를 조회할 수 없습니다."}</li>
        </ul>}
        {!dropping && review.ttl_seconds !== null && <p className="form-note">TTL이 적용되면 서버가 이미 만료된 문서를 삭제할 수 있습니다.</p>}
        <p className="form-note">검토는 {review.expires_seconds / 60}분 동안 유효합니다.</p>
        {dropping && <label className="field">인덱스 삭제 승인<input value={approval} placeholder="DROP" autoComplete="off"
          required disabled={busy} onChange={event => setApproval(event.target.value)} /></label>}
        {production && <label className="field">운영 환경 확인<input value={confirmation} placeholder="PROD" autoComplete="off"
          required disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      </> : !dropping && <fieldset className="mongo-index-fields" disabled={busy}>
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
      </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        {review && !dropping && <button type="button" className="secondary" disabled={busy} onClick={resetReview}>설정 수정</button>}
        <button type="submit" className={review && dropping ? "danger" : "primary"} disabled={busy || needsApproval}>
          {review ? (dropping ? "검토한 인덱스 삭제" : "인덱스 생성 적용") : (dropping ? "삭제 영향 조회" : "생성 검토")}
        </button>
      </div>
    </form>
  </Dialog>;
}
