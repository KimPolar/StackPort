import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import type { PostgresEditExitGuard, PostgresRowStamp } from "./PostgresEditDialog";

type Key = { name: string; kind: string; value: string };
type Insert = { kind: "insert" };
type Target = { engine: "sqlite"; profileId: string; change: Insert | { kind: "delete"; keys: Key[] } }
  | { engine: "postgres"; id: string; object: number; change: Insert | { kind: "delete"; stamp: PostgresRowStamp } };
export type RowChangeRequest = Target & {
  profileName: string;
  location: string;
  environment: "DEV" | "STAGING" | "PROD";
  table: string;
};
type Cell = { kind: string; display: string; truncated: boolean };
type Field = { name: string } & ({ kind: "explicit"; cell: Cell } | { kind: "default"; expression: string | null; auto_key: boolean });
type InsertColumn = { name: string; declared_type: string; nullable: boolean; required: boolean; auto_key: boolean; default_value: string | null;
  editable: boolean };
type Preview = { approval: string; fields: Field[] };
type Session = { token: string; columns: InsertColumn[]; preview: Preview | null };
export type RowChangeResult = { fields: Field[]; audit_warning: string | null };
type PostgresOutcome = { status: "applied"; result: RowChangeResult } | { status: "unknown" };
type InputKind = "default" | "null" | "text" | "integer" | "real";
type Input = { kind: InputKind; value: string };

function initialInput(column: InsertColumn, postgres: boolean): Input {
  const type = column.declared_type.toUpperCase();
  const kind = !column.required ? "default" : postgres ? "text" : type.includes("INT") ? "integer" : /REAL|FLOA|DOUB/.test(type) ? "real" : "text";
  return { kind, value: "" };
}

function renderField(field: Field, autoLabel: string) {
  if (field.kind === "default") {
    if (field.auto_key) return autoLabel;
    return field.expression == null ? "기본값 없음 · NULL" : `DB 기본값 · ${field.expression}`;
  }
  if (field.cell.kind === "text" && field.cell.display === "") return "빈 문자열";
  return field.cell.display + (field.cell.truncated ? "…" : "");
}

export function RowChangeFields({ fields, autoLabel = "자동 기본 키" }: { fields: Field[]; autoLabel?: string }) {
  return <dl className="row-change-values">{fields.map(field => <div key={field.name}>
    <dt>{field.name}</dt><dd>{renderField(field, autoLabel)}</dd>
  </div>)}</dl>;
}

export function RowChangeDialog({ request, onClose, onApplied, onUnknown, onBusy, onExitGuard, unavailable = "" }: {
  request: RowChangeRequest; onClose: () => void; onApplied: (result: RowChangeResult) => void;
  onUnknown?: () => void; onBusy?: (busy: boolean) => void; onExitGuard?: (guard: PostgresEditExitGuard | null) => void;
  unavailable?: string;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [draft, setDraft] = useState<Map<string, Input>>(new Map());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [restart, setRestart] = useState(false);
  const [edited, setEdited] = useState(false);
  const [discard, setDiscard] = useState<{ after?: () => void } | null>(null);
  const deleting = request.change.kind === "delete";
  const postgres = request.engine === "postgres";
  const title = `${postgres ? "PostgreSQL" : "SQLite"} ${deleting ? "행 삭제" : "행 추가"}`;
  const autoLabel = postgres ? "자동 생성" : "자동 기본 키";
  const production = request.environment === "PROD";
  const dirty = !deleting && (edited || preview !== null);

  useEffect(() => {
    let live = true;
    let token: string | null = null;
    const args = request.engine === "postgres" ? { id: request.id, object: request.object, change: request.change }
      : { profileId: request.profileId, table: request.table, change: request.change };
    const cancel = (token: string) => {
      const cleanup = request.engine === "postgres" ? invoke("cancel_postgres_row_change", { id: request.id, token })
        : invoke("cancel_row_change", { token });
      void cleanup.catch(() => {});
    };
    invoke<Session>(postgres ? "begin_postgres_row_change" : "begin_row_change", args)
      .then(result => {
        token = result.token;
        if (!live) { cancel(token); return; }
        setSession(result);
        setDraft(new Map(result.columns.map(column => [column.name, initialInput(column, postgres)])));
        setPreview(result.preview);
      })
      .catch(reason => { if (live) setError(String(reason)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; if (token) cancel(token); };
  }, [request, postgres]);

  useEffect(() => {
    if (!dirty || !onExitGuard) return;
    onExitGuard(after => setDiscard({ after }));
    return () => onExitGuard(null);
  }, [dirty, onExitGuard]);

  function requestClose() {
    if (discard) setDiscard(null);
    else if (dirty) setDiscard({});
    else onClose();
  }

  function edit(name: string, input: Input) {
    setDraft(previous => new Map(previous).set(name, input));
    setEdited(true);
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || busy || restart || unavailable || discard || (deleting && !preview)) return;
    if (preview && production && confirmation !== "PROD") { setError("운영 환경을 확인하려면 PROD를 입력하세요."); return; }
    setBusy(true);
    setError("");
    onBusy?.(true);
    try {
      const token = session.token;
      if (preview) {
        const approval = preview.approval;
        if (request.engine === "postgres") {
          const outcome = await invoke<PostgresOutcome>("apply_postgres_row_change", { id: request.id, token, approval, confirmation });
          if (outcome.status === "applied") onApplied(outcome.result);
          else { setRestart(true); onUnknown?.(); }
        } else onApplied(await invoke<RowChangeResult>("apply_row_change", { token, approval, confirmation }));
      } else {
        const fields = [...draft].filter(([, input]) => input.kind !== "default").map(([column, input]) => ({ column, input }));
        const next = request.engine === "postgres" ? await invoke<Preview>("preview_postgres_row_insert", { id: request.id, token, fields })
          : await invoke<Preview>("preview_row_insert", { token, fields });
        setPreview(next);
      }
    } catch (reason) {
      setError(String(reason));
      if (preview) setRestart(true);
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }

  return <Dialog title={title} onClose={requestClose} busy={busy} interceptEscape className="row-change-dialog">
    <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{request.profileName} · {request.table}</strong>{" "}
        <span className={`environment ${request.environment.toLowerCase()}`}>{request.environment}</span><br />{request.location}</p>
      {!session && busy && <p role="status">{deleting ? "삭제할 행을 읽는 중…" : "열을 읽는 중…"}</p>}
      {unavailable && <p className="form-error" role="alert">{unavailable}</p>}
      {discard ? <>
        <p className="confirm-copy">입력한 행을 저장하지 않고 닫을까요?</p>
        <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setDiscard(null)}>계속 편집</button>
          <button type="button" className="danger" onClick={() => { onExitGuard?.(null); onClose(); discard.after?.(); }}>변경 버리기</button></div>
      </> : <>
      {session && !preview && <div className="row-change-inputs">{session.columns.map(column => {
        const input = draft.get(column.name) ?? initialInput(column, postgres);
        return <fieldset key={column.name} disabled={busy || Boolean(unavailable)}>
          <legend>{column.name}{column.declared_type && <small>{column.declared_type}</small>}{column.required && <small>필수</small>}</legend>
          <label className="field">값 형식<select aria-label={`${column.name} 값 형식`} value={input.kind} disabled={!column.editable}
            onChange={event => edit(column.name, { ...input, kind: event.target.value as InputKind })}>
            {!column.required && <option value="default">{column.auto_key ? autoLabel : column.default_value == null ? "미입력 · NULL" : "DB 기본값"}</option>}
            {column.nullable && <option value="null">NULL</option>}
            <option value="text">{postgres ? "값 입력" : "문자열"}</option>
            {!postgres && <><option value="integer">정수</option><option value="real">실수</option></>}
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
        <RowChangeFields fields={preview.fields} autoLabel={autoLabel} />
        <p>{deleting ? "이 행을 삭제합니다. 적용 전에 행이 바뀌면 삭제를 중단합니다." : "DB가 기본값을 계산하고 제약 조건을 확인한 뒤 행을 저장합니다."}</p>
      </section>}
      {preview && production && !restart && <label className="field">운영 환경 확인 · PROD 입력
        <input value={confirmation} disabled={busy} autoComplete="off" onChange={event => setConfirmation(event.target.value)} />
      </label>}
      {error && <p className="form-error" role="alert">{error}{restart && " 닫은 뒤 테이블을 다시 조회하세요."}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={requestClose} disabled={busy}>취소</button>
        {preview && !deleting && !restart && <button type="button" className="secondary" disabled={busy} onClick={() => {
          setPreview(null); setConfirmation("");
        }}>다시 편집</button>}
        {session && !restart && <button type="submit" className={deleting ? "danger" : "primary"} disabled={busy || Boolean(unavailable)}>
          {busy ? "처리 중…" : deleting ? "행 삭제 적용" : preview ? "행 추가 적용" : "행 추가 미리보기"}
        </button>}
      </div>
      </>}
    </form>
  </Dialog>;
}
