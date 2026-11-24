import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

export type RedisBytes = { text: string; encoding: "utf8" | "hex"; bytes: number; truncated: boolean };
export type RedisEditKind = "string" | "hash" | "list" | "set" | "zset" | "stream";
type InputBytes = { encoding: "utf8" | "hex"; text: string };
type StreamField = { id: number; field: InputBytes; value: InputBytes };
type EditInput = { kind: "string"; value: InputBytes } | { kind: "hash"; field: InputBytes; value: InputBytes }
  | { kind: "list"; index: string; value: InputBytes } | { kind: "set"; member: InputBytes }
  | { kind: "zset"; member: InputBytes; score: string } | { kind: "stream"; fields: { field: InputBytes; value: InputBytes }[] };
type Change = { selector: RedisBytes | null; before: RedisBytes | null; after: RedisBytes };
type Review = { token: string; key: RedisBytes; kind: string; ttl_ms: number | null; changes: Change[];
  stream_length: number | null; expires_seconds: number };
export type RedisEditReport = { status: "applied" | "conflict" | "rejected"; entry_id: string | null; audit_warning: boolean };

const emptyBytes: InputBytes = { encoding: "utf8", text: "" };
const operation: Record<RedisEditKind, string> = {
  string: "String 값 교체", hash: "Hash 필드 저장", list: "List 항목 교체",
  set: "Set 멤버 추가", zset: "Sorted Set 점수 저장", stream: "Stream 메시지 추가",
};
const number = new Intl.NumberFormat("ko-KR");

export function RedisEditDialog({ id, keyId, display, kind, environment, onBusy, onFailure, onClose, onApplied }: {
  id: string; keyId: string; display: RedisBytes; kind: RedisEditKind; environment: string;
  onBusy: (busy: boolean) => void; onFailure: (message: string) => boolean;
  onClose: () => void; onApplied: (report: RedisEditReport) => void;
}) {
  const [value, setValue] = useState(emptyBytes);
  const [selector, setSelector] = useState(emptyBytes);
  const [index, setIndex] = useState("");
  const [score, setScore] = useState("");
  const [fields, setFields] = useState<StreamField[]>([{ id: 0, field: emptyBytes, value: emptyBytes }]);
  const [review, setReview] = useState<Review | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const token = useRef<string | null>(null);
  const nextField = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const production = environment === "PROD";

  useEffect(() => () => {
    if (token.current) void invoke("discard_redis_edit", { id, token: token.current }).catch(() => {});
  }, [id]);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);

  function resetReview() {
    if (token.current) void invoke("discard_redis_edit", { id, token: token.current }).catch(() => {});
    token.current = null;
    setReview(null); setConfirm("");
  }

  function input(): EditInput {
    switch (kind) {
      case "string": return { kind, value };
      case "hash": return { kind, field: selector, value };
      case "list": return { kind, index, value };
      case "set": return { kind, member: selector };
      case "zset": return { kind, member: selector, score };
      case "stream": return { kind, fields: fields.map(({ field, value }) => ({ field, value })) };
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || (review && production && confirm !== "PROD")) return;
    pending.current = true; setBusy(true); setError(""); onBusy(true);
    try {
      if (!review) {
        const next = await invoke<Review>("preview_redis_edit", { id, key: keyId, input: input() });
        token.current = next.token;
        setReview(next);
      } else {
        const report = await invoke<RedisEditReport>("apply_redis_edit", { id, token: review.token, confirmation: confirm });
        token.current = null;
        if (report.status === "applied") {
          onApplied(report);
        } else {
          resetReview();
          const message = report.status === "conflict"
            ? "미리보기 이후 키가 바뀌었습니다. 현재 값을 다시 미리 보세요."
            : "Redis 서버가 변경을 거부했습니다. 역할 권한과 키 상태를 확인하세요.";
          setError(report.audit_warning ? message + " 작업 기록을 저장할 수 없습니다." : message);
        }
      }
    } catch (cause) {
      const message = String(cause);
      if (!onFailure(message)) {
        if (review) resetReview();
        setError(message);
      }
    } finally { pending.current = false; setBusy(false); onBusy(false); }
  }

  function updateField(fieldId: number, part: "field" | "value", value: InputBytes) {
    setFields(current => current.map(field => field.id === fieldId ? { ...field, [part]: value } : field));
  }

  return <Dialog title="Redis 키 편집" className="restore-dialog redis-edit-dialog" busy={busy} onClose={onClose}>
    <form aria-busy={busy} onSubmit={event => void submit(event)}>
      <p className="confirm-copy"><strong>{operation[kind]} · {environment}</strong><br />
        <PreviewBytes value={review?.key ?? display} empty="빈 키" /></p>
      {review ? <>
        <h3 ref={reviewHeading} tabIndex={-1}>변경 미리보기</h3>
        <p className="form-note">{review.ttl_ms === null ? "만료 없음" : `미리보기 시 남은 TTL ${number.format(review.ttl_ms)} ms`}
          {review.stream_length !== null && ` · 현재 메시지 ${number.format(review.stream_length)}개`}</p>
        <div className="redis-values" role="region" tabIndex={0} aria-label="Redis 변경 비교">
          <table aria-label="Redis 변경 내용"><thead><tr><th scope="col">대상</th><th scope="col">현재</th><th scope="col">변경 후</th></tr></thead>
            <tbody>{review.changes.map((change, row) => <tr key={row}>
              <td>{change.selector ? <PreviewBytes value={change.selector} /> : kind === "set" ? "멤버" : "값"}</td>
              <td>{change.before ? <PreviewBytes value={change.before} /> : "새 항목"}</td>
              <td><PreviewBytes value={change.after} /></td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="form-note">변경은 키의 만료 시간을 유지합니다. 미리보기는 {review.expires_seconds / 60}분 동안 유효합니다.</p>
        {kind === "hash" && <p className="form-note">필드별 만료가 설정된 경우 HSET은 변경한 필드의 만료를 해제합니다.</p>}
        {production && <label className="field">운영 환경 확인<input value={confirm} placeholder="PROD" required autoComplete="off"
          disabled={busy} onChange={event => setConfirm(event.target.value)} /></label>}
      </> : <fieldset className="redis-edit-fields" disabled={busy}>
        {(kind === "hash" || kind === "set" || kind === "zset") && <ByteField label={kind === "hash" ? "필드" : "멤버"} value={selector} setValue={setSelector} />}
        {kind === "list" && <label className="field">목록 위치<input required inputMode="numeric" value={index} placeholder="0 또는 -1"
          onChange={event => setIndex(event.target.value)} /></label>}
        {kind === "list" && <p className="form-note">첫 항목은 0, 마지막 항목은 -1로 지정합니다.</p>}
        {kind === "zset" && <label className="field">점수<input required inputMode="decimal" value={score}
          onChange={event => setScore(event.target.value)} /></label>}
        {(kind === "string" || kind === "hash" || kind === "list") && <ByteField label="새 값" value={value} setValue={setValue} />}
        {kind === "stream" && <>
          {fields.map((field, index) => <div key={field.id} className="redis-edit-stream-field">
            <ByteField label={`필드 ${index + 1}`} value={field.field} setValue={value => updateField(field.id, "field", value)} />
            <ByteField label={`값 ${index + 1}`} value={field.value} setValue={value => updateField(field.id, "value", value)} />
            {fields.length > 1 && <button type="button" className="secondary small"
              onClick={() => setFields(current => current.filter(item => item.id !== field.id))}>필드 {index + 1} 제거</button>}
          </div>)}
          <button className="secondary small" type="button" disabled={fields.length >= 64}
            onClick={() => setFields([...fields, { id: ++nextField.current, field: emptyBytes, value: emptyBytes }])}>필드 추가</button>
        </>}
      </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        {review && <button type="button" className="secondary" disabled={busy} onClick={() => { resetReview(); setError(""); }}>다시 입력</button>}
        <button type="submit" className="primary" disabled={busy || Boolean(review && production && confirm !== "PROD")}>
          {review ? "변경 적용" : "변경 미리보기"}</button>
      </div>
    </form>
  </Dialog>;
}

function ByteField({ label, value, setValue }: { label: string; value: InputBytes; setValue: (value: InputBytes) => void }) {
  return <div className="redis-edit-bytes">
    <label className="field">{label}<textarea rows={2} value={value.text} maxLength={2097152}
      placeholder={value.encoding === "hex" ? "00 FF 61" : undefined}
      onChange={event => setValue({ ...value, text: event.target.value })} /></label>
    <label className="field">{label} 형식<select value={value.encoding}
      onChange={event => setValue({ ...value, encoding: event.target.value as InputBytes["encoding"] })}>
      <option value="utf8">UTF-8</option><option value="hex">HEX</option>
    </select></label>
  </div>;
}

function PreviewBytes({ value, empty = "빈 값" }: { value: RedisBytes; empty?: string }) {
  return <><code>{value.encoding === "hex" && "HEX "}{value.text || `(${empty})`}</code>
    {value.truncated && <small> … 전체 {number.format(value.bytes)} B</small>}</>;
}
