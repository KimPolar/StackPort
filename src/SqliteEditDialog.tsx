import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog, type GridEditExitGuard } from "./Dialog";

type Kind = "text" | "integer" | "real" | "null";
type Cell = { kind: string; display: string };
type Input = { kind: Kind; value: string };
export type EditKey = { name: string; kind: string; value: string };
export type SqliteEditRequest = { profileId: string; profileName: string; location: string; environment: string; table: string; keys: EditKey[] };
type Field = { name: string; declared_type: string; current: Cell; editable: boolean; reason: string | null };
type Session = { token: string; environment: string; keys: EditKey[]; fields: Field[]; expires_seconds: number; max_changes: number };
type Preview = { approval: string; changes: { column: string; before: Cell; after: Cell }[] };
export type SqliteEditResult = { cells: { column: string; actual: Cell }[]; audit_warning: string | null };

function fromCell(cell: Cell): Input {
  const kind = cell.kind === "integer" || cell.kind === "real" || cell.kind === "null" ? cell.kind : "text";
  return { kind, value: kind === "null" ? "" : cell.display };
}

export function sqliteEditValue(cell: Cell) {
  return cell.kind === "null" ? "NULL" : cell.display || "(빈 문자열)";
}

function CellValue({ label, cell }: { label: string; cell: Cell }) {
  return <div className="edit-current"><span>{label} · {cell.kind}</span><pre>{sqliteEditValue(cell)}</pre></div>;
}

export function SqliteEditDialog({ request, onClose, onApplied, onBusy, onExitGuard }: {
  request: SqliteEditRequest; onClose: () => void; onApplied: (report: SqliteEditResult) => void;
  onBusy: (busy: boolean) => void; onExitGuard: (guard: GridEditExitGuard | null) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [column, setColumn] = useState("");
  const [drafts, setDrafts] = useState(new Map<string, Input>());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [needsRestart, setNeedsRestart] = useState(false);
  const [discard, setDiscard] = useState<{ after?: () => void } | null>(null);
  const live = useRef(false);
  const pending = useRef(false);
  const errorId = useId();
  const productionHelp = useId();
  const dirty = drafts.size > 0;
  const current = session?.fields.find(field => field.name === column && field.editable);
  const currentDraft = drafts.get(column);
  const defaultInput = current ? fromCell(current.current) : null;
  const input = currentDraft ?? defaultInput;
  const atLimit = session !== null && drafts.size >= session.max_changes && !currentDraft;
  const production = session?.environment === "PROD";

  useEffect(() => {
    let active = true;
    live.current = true;
    let token: string | undefined;
    const cancel = (token: string) => { void invoke("cancel_cell_edit", { token }).catch(() => {}); };
    invoke<Session>("begin_cell_edit", { profileId: request.profileId, table: request.table, keys: request.keys })
      .then(result => {
        token = result.token;
        if (!active) { cancel(token); return; }
        setSession(result);
        setColumn(result.fields.find(field => field.editable)?.name ?? "");
      }, reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; live.current = false; if (token) cancel(token); };
  }, [request]);

  useEffect(() => {
    if (!dirty) return;
    onExitGuard(after => setDiscard({ after }));
    return () => onExitGuard(null);
  }, [dirty, onExitGuard]);

  function requestClose() {
    if (discard) setDiscard(null);
    else if (dirty) setDiscard({});
    else onClose();
  }

  function update(next: Input) {
    if (!defaultInput || atLimit) return;
    const same = defaultInput.kind === next.kind && (next.kind === "null" || next.value === defaultInput.value);
    setDrafts(previous => {
      const updated = new Map(previous);
      if (same) updated.delete(column);
      else updated.set(column, next);
      return updated;
    });
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || busy || pending.current || needsRestart || discard || !dirty) return;
    if (preview && production && confirmation !== "PROD") { setError("운영 환경을 확인하려면 PROD를 입력하세요."); return; }
    pending.current = true;
    setBusy(true);
    setError("");
    if (preview) onBusy(true);
    try {
      const token = session.token;
      if (preview) {
        const report = await invoke<SqliteEditResult>("apply_sqlite_row_edit", {
          token, approval: preview.approval, productionConfirmation: confirmation,
        });
        if (live.current) onApplied(report);
      } else {
        const changes = [...drafts].map(([column, input]) => ({ column, input }));
        const next = await invoke<Preview>("preview_sqlite_row_edit", { token, changes });
        if (live.current) setPreview(next);
      }
    } catch (reason) {
      if (live.current) { setError(String(reason)); if (preview) setNeedsRestart(true); }
    } finally {
      if (preview) onBusy(false);
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  return <Dialog title="SQLite 행 편집" onClose={requestClose} busy={busy} interceptEscape className="row-change-dialog">
    <form onSubmit={submit} aria-busy={busy} aria-describedby={error ? errorId : undefined}>
      <p className="confirm-copy"><strong>{request.profileName} · {request.table}</strong>{" "}
        <span className={`environment ${request.environment.toLowerCase()}`}>{request.environment}</span><br />{request.location}</p>
      {busy && !session && <p className="form-note" role="status">현재 행을 읽는 중…</p>}
      {discard ? <>
        <p role="alert" className="form-note">적용하지 않은 변경이 있습니다.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" autoFocus onClick={() => setDiscard(null)}>계속 편집</button>
          <button type="button" className="danger" onClick={() => { onExitGuard(null); onClose(); discard.after?.(); }}>변경 버리기</button>
        </div>
      </> : <>
        {session && <>
          <p className="form-note">기본 키 · {session.keys.map(key => `${key.name} = ${key.value}`).join(", ")}</p>
          <p className="form-note">편집 가능 시간 {session.expires_seconds / 60}분 · 최대 {session.max_changes}개 열</p>
          {!preview && <>
            {dirty && <div className="sqlite-edit-drafts" role="group" aria-label={`변경된 열 ${drafts.size}개`}>
              {[...drafts.keys()].map(name => <button key={name} type="button" className="secondary small"
                aria-pressed={name === column} disabled={busy} onClick={() => { setColumn(name); setError(""); }}>{name}</button>)}
            </div>}
            <label className="field">변경할 열<select value={column} disabled={busy} onChange={event => { setColumn(event.target.value); setError(""); }}>
              {session.fields.map(field => <option key={field.name} value={field.name} disabled={!field.editable}>
                {field.name}{field.editable ? drafts.has(field.name) ? " · 변경됨" : "" : ` — ${field.reason}`}
              </option>)}
            </select></label>
            {current && input && <fieldset className="sqlite-edit-fields" disabled={busy || atLimit}>
              <legend>{current.name}{current.declared_type && ` · ${current.declared_type}`}{currentDraft && " · 변경됨"}</legend>
              <CellValue label="현재 값" cell={current.current} />
              <label className="field">새 값의 형식<select value={input.kind} onChange={event => update({ ...input, kind: event.target.value as Kind })}>
                <option value="text">문자열</option><option value="integer">정수</option><option value="real">실수</option><option value="null">NULL</option>
              </select></label>
              {input.kind !== "null" && <label className="field">변경할 값<textarea className="edit-value" value={input.value}
                onChange={event => update({ ...input, value: event.target.value })} /></label>}
              {currentDraft && defaultInput && <button type="button" className="secondary small" onClick={() => update(defaultInput)}>이 열의 변경 취소</button>}
            </fieldset>}
            {atLimit && <p className="form-note" role="status">한 번에 {session.max_changes}개 열을 변경할 수 있습니다. 편집한 열을 하나 취소하면 다른 열을 선택할 수 있습니다.</p>}
          </>}
          {preview && <div className="edit-preview">
            <strong>변경 미리보기 · 1행 / {preview.changes.length}열</strong>
            {preview.changes.map(change => <section className="sqlite-edit-comparison" key={change.column} aria-label={`${change.column} 변경 비교`}>
              <strong>{change.column}</strong><CellValue label="이전 값" cell={change.before} /><CellValue label="변경 값" cell={change.after} />
            </section>)}
            <p>변경 전체를 한 트랜잭션에서 적용합니다. 제약조건 위반이나 값 형식 변환이 발생하면 전체를 롤백합니다.</p>
          </div>}
          {preview && production && !needsRestart && <label className="field">운영 환경 확인<input value={confirmation} disabled={busy}
            aria-required="true" aria-describedby={productionHelp} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></label>}
          {preview && production && !needsRestart && <p id={productionHelp} className="form-note">적용하려면 PROD를 입력하세요.</p>}
        </>}
        {error && <p id={errorId} className="form-error" role="alert">{error}{needsRestart && " 창을 닫은 뒤 행을 다시 조회하세요."}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={requestClose}>닫기</button>
          {preview && !needsRestart && <button type="button" className="secondary" disabled={busy}
            onClick={() => { setPreview(null); setConfirmation(""); setError(""); }}>다시 편집</button>}
          {session && !needsRestart && <button type="submit" className={preview ? "danger" : "primary"} disabled={busy || !dirty}>
            {busy ? "처리 중…" : preview ? "변경 적용" : "변경 미리보기"}
          </button>}
        </div>
      </>}
    </form>
  </Dialog>;
}
