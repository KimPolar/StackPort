import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Key = { name: string; kind: string; value: string };
type Intent = { kind: "insert" } | { kind: "delete"; keys: Key[] };
export type RowChangeRequest = {
  profile: { id: string; name: string; path: string; environment: "DEV" | "STAGING" | "PROD" };
  table: string;
  change: Intent;
};
type Cell = { kind: string; display: string; truncated: boolean };
type Field = { name: string } & ({ kind: "explicit"; cell: Cell } | { kind: "default"; expression: string | null; auto_key: boolean });
type InsertColumn = { name: string; declared_type: string; nullable: boolean; required: boolean; auto_key: boolean; default_value: string | null };
type Preview = { approval: string; fields: Field[] };
type Session = { token: string; columns: InsertColumn[]; preview: Preview | null };
export type RowChangeResult = { fields: Field[]; audit_warning: string | null };
type InputKind = "default" | "null" | "text" | "integer" | "real";
type Input = { kind: InputKind; value: string };

function initialInput(column: InsertColumn): Input {
  const type = column.declared_type.toUpperCase();
  const kind = !column.required ? "default" : type.includes("INT") ? "integer" : /REAL|FLOA|DOUB/.test(type) ? "real" : "text";
  return { kind, value: "" };
}

function renderField(field: Field) {
  if (field.kind === "default") {
    if (field.auto_key) return "자동 기본 키";
    return field.expression == null ? "기본값 없음 · NULL" : `DB 기본값 · ${field.expression}`;
  }
  if (field.cell.kind === "text" && field.cell.display === "") return "빈 문자열";
  return field.cell.display + (field.cell.truncated ? "…" : "");
}

export function SqliteRowFields({ fields }: { fields: Field[] }) {
  return <dl className="sqlite-row-values">{fields.map(field => <div key={field.name}>
    <dt>{field.name}</dt><dd>{renderField(field)}</dd>
  </div>)}</dl>;
}

export function SqliteRowChangeDialog({ request, onClose, onApplied }: {
  request: RowChangeRequest; onClose: () => void; onApplied: (result: RowChangeResult) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [draft, setDraft] = useState<Map<string, Input>>(new Map());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [restart, setRestart] = useState(false);
  const deleting = request.change.kind === "delete";
  const title = deleting ? "SQLite 행 삭제" : "SQLite 행 추가";
  const production = request.profile.environment === "PROD";

  useEffect(() => {
    let live = true;
    let token: string | null = null;
    const cancel = (token: string) => { void invoke("cancel_row_change", { token }).catch(() => {}); };
    invoke<Session>("begin_row_change", { profileId: request.profile.id, table: request.table, change: request.change })
      .then(result => {
        token = result.token;
        if (!live) { cancel(token); return; }
        setSession(result);
        setDraft(new Map(result.columns.map(column => [column.name, initialInput(column)])));
        setPreview(result.preview);
      })
      .catch(reason => { if (live) setError(String(reason)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; if (token) cancel(token); };
  }, [request]);

  function edit(name: string, input: Input) {
    setDraft(previous => new Map(previous).set(name, input));
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || busy || restart || (deleting && !preview)) return;
    if (preview && production && confirmation !== "PROD") { setError("운영 환경을 확인하려면 PROD를 입력하세요."); return; }
    setBusy(true);
    setError("");
    try {
      if (preview) {
        const result = await invoke<RowChangeResult>("apply_row_change", { token: session.token, approval: preview.approval, confirmation });
        onApplied(result);
      } else {
        const fields = [...draft].filter(([, input]) => input.kind !== "default").map(([column, input]) => ({ column, input }));
        setPreview(await invoke<Preview>("preview_row_insert", { token: session.token, fields }));
      }
    } catch (reason) {
      setError(String(reason));
      if (preview) setRestart(true);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title={title} onClose={onClose} busy={busy} className="sqlite-row-dialog">
    <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{request.profile.name} · {request.table}</strong>{" "}
        <span className={`environment ${request.profile.environment.toLowerCase()}`}>{request.profile.environment}</span><br />{request.profile.path}</p>
      {!session && busy && <p role="status">{deleting ? "삭제할 행을 읽는 중…" : "열을 읽는 중…"}</p>}
      {session && !preview && <div className="sqlite-row-inputs">{session.columns.map(column => {
        const input = draft.get(column.name) ?? initialInput(column);
        return <fieldset key={column.name} disabled={busy}>
          <legend>{column.name}{column.declared_type && <small>{column.declared_type}</small>}{column.required && <small>필수</small>}</legend>
          <label className="field">값 형식<select aria-label={`${column.name} 값 형식`} value={input.kind}
            onChange={event => edit(column.name, { ...input, kind: event.target.value as InputKind })}>
            {!column.required && <option value="default">{column.auto_key ? "자동 기본 키" : column.default_value == null ? "미입력 · NULL" : "DB 기본값"}</option>}
            {column.nullable && <option value="null">NULL</option>}
            <option value="text">문자열</option><option value="integer">정수</option><option value="real">실수</option>
          </select></label>
          {input.kind === "default" && !column.auto_key && column.default_value != null && <code>{column.default_value}</code>}
          {input.kind !== "default" && input.kind !== "null" && <label className="field">값
            {input.kind === "text" ? <textarea aria-label={`${column.name} 값`} rows={2} value={input.value}
              onChange={event => edit(column.name, { ...input, value: event.target.value })} />
              : <input aria-label={`${column.name} 값`} inputMode={input.kind === "integer" ? "numeric" : "decimal"} value={input.value}
                onChange={event => edit(column.name, { ...input, value: event.target.value })} />}
          </label>}
        </fieldset>;
      })}</div>}
      {preview && <section className="edit-preview" aria-label={deleting ? "삭제할 행" : "추가할 행"}>
        <strong>{deleting ? "삭제할 행 1개" : "추가할 행 1개"}</strong>
        <SqliteRowFields fields={preview.fields} />
        <p>{deleting ? "이 행을 삭제합니다. 적용 전에 행이 바뀌면 삭제를 중단합니다." : "DB가 기본값을 계산하고 제약 조건을 확인한 뒤 행을 저장합니다."}</p>
      </section>}
      {preview && production && !restart && <label className="field">운영 환경 확인 · PROD 입력
        <input value={confirmation} disabled={busy} autoComplete="off" onChange={event => setConfirmation(event.target.value)} />
      </label>}
      {error && <p className="form-error" role="alert">{error}{restart && " 닫은 뒤 테이블을 다시 조회하세요."}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>취소</button>
        {preview && !deleting && !restart && <button type="button" className="secondary" disabled={busy} onClick={() => {
          setPreview(null); setConfirmation("");
        }}>다시 편집</button>}
        {session && !restart && <button type="submit" className={deleting ? "danger" : "primary"} disabled={busy}>
          {busy ? "처리 중…" : deleting ? "행 삭제 적용" : preview ? "행 추가 적용" : "행 추가 미리보기"}
        </button>}
      </div>
    </form>
  </Dialog>;
}
