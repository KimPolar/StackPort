import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import type { PostgresCell } from "./PostgresSqlWorkspace";

export type PostgresRowStamp = { tuple: string; version: string; keys: string[] };
type EditSession = {
  token: string; table: string; column: string; data_type: string; keys: [string, string][];
  current: PostgresCell; nullable: boolean; default_sql: string | null;
};
type Preview = { approval: string; before: PostgresCell; after: PostgresCell; use_default: boolean };
type Outcome = { status: "applied"; actual: PostgresCell; audit_warning: boolean } | { status: "unknown" };
type InputKind = "text" | "null" | "default";

export function PostgresEditDialog({ id, object, stamp, column, profile, onBusy, onClose, onApplied, onUnknown }: {
  id: string; object: number; stamp: PostgresRowStamp; column: string;
  profile: { name: string; environment: string };
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onApplied: (auditWarning: boolean) => void;
  onUnknown: () => void;
}) {
  const [session, setSession] = useState<EditSession | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [kind, setKind] = useState<InputKind>("text");
  const [value, setValue] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const pending = useRef(false);
  const live = useRef(false);
  const errorId = useId();
  const production = profile.environment === "PROD";

  useEffect(() => {
    let active = true;
    live.current = true;
    let token: string | undefined;
    const cancel = (token: string) => { void invoke("cancel_postgres_edit", { id, token }).catch(() => {}); };
    invoke<EditSession>("begin_postgres_edit", { id, object, stamp, column }).then(result => {
      token = result.token;
      if (!active) { cancel(token); return; }
      setSession(result);
      setValue(result.current.value ?? "");
    }, reason => { if (active) setError(String(reason)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; live.current = false; if (token) cancel(token); };
  }, [id, object, stamp, column]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !session || expired || (preview && production && confirmation !== "PROD")) return;
    pending.current = true;
    setBusy(true);
    setError("");
    if (preview) onBusy(true);
    try {
      if (!preview) {
        const input = kind === "text" ? { kind, value } : { kind };
        const result = await invoke<Preview>("preview_postgres_edit", { id, token: session.token, input });
        if (live.current) setPreview(result);
      } else {
        const result = await invoke<Outcome>("apply_postgres_edit", { id, token: session.token, approval: preview.approval, confirmation });
        if (live.current) {
          if (result.status === "applied") onApplied(result.audit_warning);
          else onUnknown();
        }
      }
    } catch (reason) {
      if (live.current) { setError(String(reason)); if (preview) setExpired(true); }
    } finally {
      if (preview) onBusy(false);
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  const formTitle = session ? `${session.table} · ${session.column}` : column;
  return <Dialog title="PostgreSQL 셀 편집" onClose={onClose} busy={busy}>
    <form onSubmit={event => void submit(event)} aria-busy={busy} aria-describedby={error ? errorId : undefined}>
      <p className="confirm-copy"><strong>{profile.name} · {formTitle}</strong> <span className={`environment ${profile.environment.toLowerCase()}`}>{profile.environment}</span></p>
      {busy && !session && <p className="form-note" role="status">현재 행을 읽는 중…</p>}
      {session && <>
        <p className="form-note">기본 키 {session.keys.map(([name, value]) => `${name} = ${value}`).join(", ")}</p>
        <p className="form-note">열 타입 {session.data_type} · 편집 가능 시간 5분</p>
        {!preview && <EditValue label="현재 값" value={session.current.value} />}
        {!preview && <>
          <label className="field">값 입력 방식<select value={kind} disabled={busy}
            onChange={event => setKind(event.target.value as InputKind)}>
            <option value="text">값 입력</option>
            {session.nullable && <option value="null">NULL</option>}
            {session.default_sql !== null && <option value="default">서버 기본값</option>}
          </select></label>
          {kind === "text" && <label className="field">변경할 값<textarea className="edit-value" value={value} disabled={busy}
            maxLength={8192} onChange={event => setValue(event.target.value)} /></label>}
          {kind === "default" && <EditValue label="서버 기본값 식" value={session.default_sql} />}
        </>}
        {preview && <div className="edit-preview">
          <strong>변경 미리보기 · 1행 / 1열</strong>
          <EditValue label="이전 값" value={preview.before.value} />
          <EditValue label={preview.use_default ? "서버 기본값 식" : "변경 값"} value={preview.use_default ? session.default_sql : preview.after.value} />
          {preview.use_default && <p className="form-note">실제 기본값은 적용할 때 서버에서 계산합니다.</p>}
        </div>}
        {preview && production && !expired && <label className="field">운영 환경 확인<input value={confirmation} disabled={busy}
          autoComplete="off" required pattern="PROD" aria-describedby="postgres-edit-prod-help"
          onChange={event => setConfirmation(event.target.value)} /></label>}
        {preview && production && !expired && <p id="postgres-edit-prod-help" className="form-note">적용하려면 PROD를 입력하세요.</p>}
      </>}
      {error && <p id={errorId} className="form-error" role="alert">{error}{expired && " 창을 닫은 뒤 행을 다시 조회하세요."}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>닫기</button>
        {preview && !expired && <button type="button" className="secondary" disabled={busy}
          onClick={() => { setPreview(null); setConfirmation(""); setError(""); }}>다시 편집</button>}
        {session && !expired && <button type="submit" className={preview ? "danger" : "primary"} disabled={busy}>
          {busy ? "처리 중…" : preview ? "변경 적용" : "변경 미리보기"}
        </button>}
      </div>
    </form>
  </Dialog>;
}

function EditValue({ label, value }: { label: string; value: string | null }) {
  return <div className="edit-current"><span>{label}</span><pre>{value === null ? "NULL" : value || "(빈 문자열)"}</pre></div>;
}
