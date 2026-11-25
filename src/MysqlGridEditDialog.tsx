import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import type { MysqlValue } from "./MysqlDataGrid";

export type MysqlRowStamp = { keys: string[]; schema: string; row: string };
type Field = { name: string; column_type: string; nullable: boolean; cell: MysqlValue | null };
export type MysqlEditTarget = {
  id: string;
  database: string;
  table: string;
  keys: string[];
  stamp: MysqlRowStamp;
  fields: Field[];
};

type Value = { kind: "text"; value: string } | { kind: "null" | "default" };
type DraftKind = "keep" | Value["kind"];
type Preview = { token: string; changes: { column: string; before: MysqlValue | null; after: Value }[] };
export type MysqlEditOutcome = { status: "applied"; affected_rows: number; audit_warning: boolean } | { status: "unknown" };

function showCell(cell: MysqlValue | null) {
  if (!cell) return "NULL";
  return (cell.text || "(빈 문자열)") + (cell.truncated ? "…" : "");
}

function showValue(value: Value) {
  if (value.kind === "text") return value.value || "(빈 문자열)";
  return value.kind === "null" ? "NULL" : "서버 기본값";
}

export function MysqlGridEditDialog({ target, environment, unavailable, onClose, onApplied }: {
  target: MysqlEditTarget;
  environment: string;
  unavailable: boolean;
  onClose: () => void;
  onApplied: (outcome: MysqlEditOutcome) => void;
}) {
  const [draft, setDraft] = useState<Map<string, Value>>(new Map());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const activeToken = useRef<string | null>(null);
  const mounted = useRef(false);
  const production = environment === "PROD";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeToken.current) void invoke("discard_mysql_grid_edit", { id: target.id, token: activeToken.current }).catch(() => {});
    };
  }, [target.id]);

  function change(field: Field, kind: DraftKind, value = "") {
    setDraft(current => {
      const next = new Map(current);
      if (kind === "keep") next.delete(field.name);
      else next.set(field.name, kind === "text" ? { kind, value } : { kind });
      return next;
    });
  }

  function clearPreview() {
    const token = activeToken.current;
    activeToken.current = null;
    setPreview(null);
    setConfirmation("");
    if (token) void invoke("discard_mysql_grid_edit", { id: target.id, token }).catch(() => {});
  }

  function requestClose() {
    if (pending.current) return;
    if (draft.size) setDiscard(true);
    else onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || unavailable || discard || !draft.size) return;
    pending.current = true; setBusy(true); setError("");
    try {
      if (preview) {
        const outcome = await invoke<MysqlEditOutcome>("apply_mysql_grid_edit", { id: target.id, token: preview.token, confirmation });
        activeToken.current = null;
        if (mounted.current) onApplied(outcome);
      } else {
        const changes = Array.from(draft, ([column, value]) => ({ column, value }));
        const next = await invoke<Preview>("preview_mysql_grid_edit", {
          id: target.id, database: target.database, table: target.table, stamp: target.stamp, changes,
        });
        if (!mounted.current) {
          await invoke("discard_mysql_grid_edit", { id: target.id, token: next.token });
          return;
        }
        activeToken.current = next.token;
        setPreview(next);
      }
    } catch (cause) {
      if (mounted.current) { setError(String(cause)); if (preview) clearPreview(); }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <Dialog title="MySQL 행 편집" className="mysql-edit-dialog" busy={busy} interceptEscape onClose={requestClose}>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <p className="confirm-copy"><strong>{target.database}.{target.table} · {environment}</strong></p>
      <dl className="mysql-edit-keys">{target.keys.map((key, index) => <div key={key}><dt>{key}</dt><dd><code>{target.stamp.keys[index]}</code></dd></div>)}</dl>
      {unavailable && <p className="form-error" role="alert">MySQL 연결이 끊겼습니다. 다시 연결한 뒤 행을 새로 읽으세요.</p>}
      {preview ? <>
        <div className="mysql-table" role="region" aria-label="변경 전후 스크롤" tabIndex={0}>
          <table aria-label="변경 전후"><thead><tr><th scope="col">열</th><th scope="col">현재 값</th><th scope="col">변경할 값</th></tr></thead>
            <tbody>{preview.changes.map(item => <tr key={item.column}><th scope="row">{item.column}</th>
              <td><code>{showCell(item.before)}</code></td><td><code>{showValue(item.after)}</code></td></tr>)}</tbody></table>
        </div>
        {production && <label className="field">운영 환경 확인<input required value={confirmation} placeholder="PROD"
          autoComplete="off" disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      </> : <fieldset className="mysql-edit-fields" disabled={busy || unavailable}>
        {target.fields.map(field => {
          const input = draft.get(field.name);
          return <div className="mysql-edit-field" key={field.name}>
            <div><strong>{field.name}</strong><small>{field.column_type}</small><code>{showCell(field.cell)}</code></div>
            <label className="field">변경 방식<select aria-label={`${field.name} 변경 방식`} value={input?.kind ?? "keep"} onChange={event =>
              change(field, event.target.value as DraftKind, field.cell?.encoding === "utf8" && !field.cell.truncated ? field.cell.text : "")}>
              <option value="keep">유지</option><option value="text">값 지정</option>
              {field.nullable && <option value="null">NULL</option>}<option value="default">서버 기본값</option>
            </select></label>
            {input?.kind === "text" && <label className="field mysql-edit-input">새 값<textarea className="edit-value"
              aria-label={`${field.name} 새 값`} maxLength={65536} value={input.value}
              onChange={event => change(field, "text", event.target.value)} /></label>}
          </div>;
        })}
      </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {discard ? <div className="mysql-edit-discard">
        <p role="status">적용하지 않은 변경이 있습니다.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => setDiscard(false)}>계속 편집</button>
          <button type="button" className="danger" onClick={onClose}>변경 버리기</button>
        </div>
      </div> : <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={requestClose}>취소</button>
        {preview && <button type="button" className="secondary" disabled={busy} onClick={clearPreview}>값 다시 편집</button>}
        <button type="submit" className="primary" disabled={busy || unavailable || !draft.size || (preview !== null && production && confirmation !== "PROD")}>
          {busy ? "처리 중…" : preview ? "변경 적용" : "변경 미리보기"}
        </button>
      </div>}
    </form>
  </Dialog>;
}
