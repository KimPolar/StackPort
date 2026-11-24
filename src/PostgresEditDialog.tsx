import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog, type GridEditExitGuard } from "./Dialog";
import type { PostgresCell } from "./PostgresSqlWorkspace";

export type PostgresRowStamp = { tuple: string; version: string; keys: string[] };
type EditField = {
  column: string; data_type: string;
  current: PostgresCell; nullable: boolean; default_sql: string | null;
};
type EditSession = EditField & { token: string; table: string; keys: [string, string][]; columns: string[] };
type PreviewCell = { column: string; before: PostgresCell; after: PostgresCell; default_sql: string | null };
type Preview = { approval: string; changes: PreviewCell[] };
type Outcome = { status: "applied"; affected_cells: number; audit_warning: boolean } | { status: "unknown" };
type InputKind = "text" | "null" | "default";
type Draft = { field: EditField; kind: InputKind; value: string };
type Discard = { after?: () => void };
type DraftValue = Pick<Draft, "kind" | "value">;

export type PostgresGridEditRow = { number: number; stamp: PostgresRowStamp };
type GridSession = { token: string; table: string; keys: [string, string][][]; columns: string[];
  max_cells_per_row: number; max_total_cells: number };
type GridPreview = { approval: string; rows: { row: number; changes: PreviewCell[] }[] };
type GridOutcome = { status: "applied"; affected_rows: number; affected_cells: number; audit_warning: boolean } | { status: "unknown" };
const maxCells = 16;

const fromField = (field: EditField): Draft => ({
  field, kind: field.current.value === null ? "null" : "text", value: field.current.value ?? "",
});

function changed({ field, kind, value }: Draft) {
  if (kind === "default") return true;
  return (kind === "null" ? null : value) !== field.current.value;
}

export function PostgresEditDialog({ id, object, stamp, column, profile, unavailable, onBusy, onClose, onApplied, onUnknown, onExitGuard }: {
  id: string; object: number; stamp: PostgresRowStamp; column: string;
  profile: { name: string; environment: string };
  unavailable: string;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onApplied: (cells: number, auditWarning: boolean) => void;
  onUnknown: () => void;
  onExitGuard: (guard: GridEditExitGuard | null) => void;
}) {
  const [session, setSession] = useState<EditSession | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [nextColumn, setNextColumn] = useState("");
  const [discard, setDiscard] = useState<Discard | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const pending = useRef(false);
  const live = useRef(false);
  const errorId = useId();
  const productionHelp = useId();
  const production = profile.environment === "PROD";
  const changes = drafts.filter(changed);
  const dirty = changes.length > 0;
  const remaining = session?.columns.filter(name => !drafts.some(draft => draft.field.column === name)) ?? [];
  const next = remaining.includes(nextColumn) ? nextColumn : remaining[0] ?? "";

  useEffect(() => {
    let active = true;
    live.current = true;
    let token: string | undefined;
    const cancel = (token: string) => { void invoke("cancel_postgres_edit", { id, token }).catch(() => {}); };
    invoke<EditSession>("begin_postgres_edit", { id, object, stamp, column }).then(result => {
      token = result.token;
      if (!active) { cancel(token); return; }
      setSession(result);
      setDrafts([fromField(result)]);
    }, reason => { if (active) setError(String(reason)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; live.current = false; if (token) cancel(token); };
  }, [id, object, stamp, column]);

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

  function discardAndClose() {
    onExitGuard(null);
    onClose();
    discard?.after?.();
  }

  function update(name: string, patch: Partial<Pick<Draft, "kind" | "value">>) {
    setError("");
    setDrafts(values => values.map(draft => draft.field.column === name ? { ...draft, ...patch } : draft));
  }

  async function addField() {
    if (pending.current || !session || unavailable || !next || drafts.length >= maxCells) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const field = await invoke<EditField>("open_postgres_edit_field", { id, token: session.token, column: next });
      if (live.current) setDrafts(values => [...values, fromField(field)]);
    } catch (reason) {
      if (live.current) setError(String(reason));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !session || unavailable || expired || discard || !dirty ||
        (preview && production && confirmation !== "PROD")) return;
    pending.current = true;
    setBusy(true);
    setError("");
    if (preview) onBusy(true);
    try {
      if (!preview) {
        const selected = changes.map(({ field, kind, value }) => ({
          column: field.column, input: kind === "text" ? { kind, value } : { kind },
        }));
        const result = await invoke<Preview>("preview_postgres_row_edit", { id, token: session.token, changes: selected });
        if (live.current) setPreview(result);
      } else {
        const result = await invoke<Outcome>("apply_postgres_edit", { id, token: session.token, approval: preview.approval, confirmation });
        if (live.current) {
          if (result.status === "applied") onApplied(result.affected_cells, result.audit_warning);
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

  return <Dialog title="PostgreSQL 행 편집" onClose={requestClose} busy={busy} interceptEscape>
    <form onSubmit={event => void submit(event)} aria-busy={busy} aria-describedby={error ? errorId : undefined}>
      <p className="confirm-copy"><strong>{profile.name} · {session?.table ?? column}</strong> <span className={`environment ${profile.environment.toLowerCase()}`}>{profile.environment}</span></p>
      {unavailable && <p className="form-error" role="alert">{unavailable} 창을 닫고 다시 연결하세요.</p>}
      {busy && !session && <p className="form-note" role="status">현재 행을 읽는 중…</p>}
      {discard ? <>
        <p role="alert" className="form-note">적용하지 않은 변경이 있습니다.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" autoFocus onClick={() => setDiscard(null)}>계속 편집</button>
          <button type="button" className="danger" onClick={discardAndClose}>변경 버리기</button>
        </div>
      </> : <>
        {session && <>
        <p className="form-note">기본 키 {session.keys.map(([name, value]) => `${name} = ${value}`).join(", ")}</p>
        <p className="form-note">편집 가능 시간 5분 · 최대 16개 열</p>
        {!preview && <>
          {drafts.map(draft => <fieldset key={draft.field.column} className="postgres-edit-field" data-changed={changed(draft)} disabled={busy}>
            <legend>{draft.field.column} · {draft.field.data_type}{changed(draft) && " · 변경됨"}</legend>
            <EditInputFields draft={draft} onChange={patch => update(draft.field.column, patch)} />
            {drafts.length > 1 && <button type="button" className="secondary small" aria-label={`${draft.field.column} 변경 제거`}
              onClick={() => { setError(""); setDrafts(values => values.filter(item => item !== draft)); }}>이 열 제거</button>}
          </fieldset>)}
          {!unavailable && next && drafts.length < maxCells && <div className="postgres-edit-add">
            <label className="field">추가할 열<select value={next} disabled={busy} onChange={event => setNextColumn(event.target.value)}>
              {remaining.map(name => <option key={name} value={name}>{name}</option>)}
            </select></label>
            <button type="button" className="secondary" disabled={busy} onClick={() => void addField()}>열 추가</button>
          </div>}
        </>}
        {preview && <div className="edit-preview">
          <strong>변경 미리보기 · 1행 / {preview.changes.length}열</strong>
          {preview.changes.map(change => <section className="postgres-edit-comparison" key={change.column} aria-label={`${change.column} 변경 비교`}>
            <strong>{change.column}</strong>
            <EditValue label="이전 값" value={change.before.value} />
            <EditValue label={change.default_sql === null ? "변경 값" : "서버 기본값 식"}
              value={change.default_sql ?? change.after.value} />
          </section>)}
          {preview.changes.some(change => change.default_sql !== null) && <p className="form-note">실제 기본값은 적용할 때 서버에서 계산합니다.</p>}
          <p className="form-note">표시된 변경을 한 트랜잭션에서 적용합니다.</p>
        </div>}
        {preview && production && !expired && <label className="field">운영 환경 확인<input value={confirmation} disabled={busy}
          autoComplete="off" required pattern="PROD" aria-describedby={productionHelp}
          onChange={event => setConfirmation(event.target.value)} /></label>}
        {preview && production && !expired && <p id={productionHelp} className="form-note">적용하려면 PROD를 입력하세요.</p>}
        </>}
        {error && <p id={errorId} className="form-error" role="alert">{error}{expired && " 창을 닫은 뒤 행을 다시 조회하세요."}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={requestClose}>닫기</button>
          {preview && !expired && <button type="button" className="secondary" disabled={busy}
            onClick={() => { setPreview(null); setConfirmation(""); setError(""); }}>다시 편집</button>}
          {session && !expired && <button type="submit" className={preview ? "danger" : "primary"} disabled={busy || !dirty || Boolean(unavailable)}>
            {busy ? "처리 중…" : preview ? "변경 적용" : "변경 미리보기"}
          </button>}
        </div>
      </>}
    </form>
  </Dialog>;
}

export function PostgresGridEditDialog({ id, object, selected, profile, unavailable, onBusy, onClose, onApplied, onUnknown, onExitGuard }: {
  id: string; object: number; selected: PostgresGridEditRow[];
  profile: { name: string; environment: string }; unavailable: string;
  onBusy: (busy: boolean) => void; onClose: () => void; onApplied: (rows: number, cells: number, warning: boolean) => void;
  onUnknown: () => void; onExitGuard: (guard: GridEditExitGuard | null) => void;
}) {
  const [session, setSession] = useState<GridSession | null>(null);
  const [column, setColumn] = useState("");
  const [row, setRow] = useState(0);
  const [loaded, setLoaded] = useState<{ column: string; fields: (EditField | null)[] } | null>(null);
  const [drafts, setDrafts] = useState(new Map<number, Map<string, DraftValue>>());
  const [preview, setPreview] = useState<GridPreview | null>(null);
  const [discard, setDiscard] = useState<Discard | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(true);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(false);
  const submitting = useRef(false);
  const errorId = useId();
  const productionHelp = useId();
  const production = profile.environment === "PROD";
  const dirty = drafts.size > 0;
  const fields = loaded?.column === column ? loaded.fields : null;
  const field = fields?.[row];
  const rowDrafts = drafts.get(row);
  const local = rowDrafts?.get(column);
  const draft = field ? { ...fromField(field), ...local } : null;
  const count = draftCount(drafts);
  const atLimit = session && !local && ((rowDrafts?.size ?? 0) >= session.max_cells_per_row || count >= session.max_total_cells);

  useEffect(() => {
    let active = true;
    let token: string | undefined;
    live.current = true;
    const cancel = (token: string) => { void invoke("cancel_postgres_grid_edit", { id, token }).catch(() => {}); };
    invoke<GridSession>("begin_postgres_grid_edit", { id, object, stamps: selected.map(item => item.stamp) }).then(result => {
      token = result.token;
      if (!active) { cancel(token); return; }
      setSession(result);
      setColumn(result.columns[0]);
    }, reason => { if (active) { setError(String(reason)); setBusy(false); } });
    return () => { active = false; live.current = false; if (token) cancel(token); };
  }, [id, object, selected]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    setBusy(true);
    setError("");
    invoke<(EditField | null)[]>("open_postgres_grid_edit_column", { id, token: session.token, column }).then(result => {
      if (active) setLoaded({ column, fields: result });
    }, reason => { if (active) { setLoaded(null); setError(String(reason)); } }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [id, session, column]);

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

  function update(next: DraftValue, fill = false) {
    if (!session || !fields || busy || unavailable || atLimit) return;
    const updated = new Map(drafts);
    for (const index of fill ? fields.keys() : [row]) {
      const target = fields[index];
      if (!target) return;
      const cells = new Map(updated.get(index));
      if (changed({ field: target, ...next })) cells.set(column, next);
      else cells.delete(column);
      if (cells.size > session.max_cells_per_row) {
        setError("한 행에서 변경할 열 수를 줄인 뒤 다시 시도하세요.");
        return;
      }
      if (cells.size) updated.set(index, cells);
      else updated.delete(index);
    }
    if (draftCount(updated) > session.max_total_cells) {
      setError("변경할 셀 수를 줄인 뒤 다시 시도하세요.");
      return;
    }
    setDrafts(updated);
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || busy || submitting.current || expired || discard || !dirty || unavailable
      || (preview && production && confirmation !== "PROD")) return;
    setBusy(true);
    setError("");
    submitting.current = true;
    if (preview) onBusy(true);
    try {
      const target = { id, token: session.token };
      if (preview) {
        const result = await invoke<GridOutcome>("apply_postgres_grid_edit", { ...target, approval: preview.approval, confirmation });
        if (live.current) {
          if (result.status === "applied") onApplied(result.affected_rows, result.affected_cells, result.audit_warning);
          else onUnknown();
        }
      } else {
        const changes = [...drafts].sort(([first], [second]) => first - second).map(([row, cells]) => ({
          row, cells: [...cells].map(([column, { kind, value }]) => ({ column, input: kind === "text" ? { kind, value } : { kind } })),
        }));
        const result = await invoke<GridPreview>("preview_postgres_grid_edit", { ...target, changes });
        if (live.current) setPreview(result);
      }
    } catch (reason) {
      if (live.current) { setError(String(reason)); if (preview) setExpired(true); }
    } finally {
      if (preview) onBusy(false);
      if (live.current) setBusy(false);
      submitting.current = false;
    }
  }

  return <Dialog title="PostgreSQL 여러 행 편집" onClose={requestClose} busy={busy} interceptEscape className="row-change-dialog">
    <form onSubmit={event => void submit(event)} aria-busy={busy} aria-describedby={error ? errorId : undefined}>
      <p className="confirm-copy"><strong>{profile.name}{session && ` · ${session.table}`}</strong>{" "}
        <span className={`environment ${profile.environment.toLowerCase()}`}>{profile.environment}</span></p>
      {unavailable && <p className="form-error" role="alert">{unavailable} 창을 닫고 다시 연결하세요.</p>}
      {busy && !session && <p className="form-note" role="status">선택한 행을 읽는 중…</p>}
      {discard ? <>
        <p role="alert" className="form-note">적용하지 않은 변경이 있습니다.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" autoFocus onClick={() => setDiscard(null)}>계속 편집</button>
          <button type="button" className="danger" onClick={() => { onExitGuard(null); onClose(); discard.after?.(); }}>변경 버리기</button>
        </div>
      </> : <>
        {session && <>
          {!preview && <>
            <p className="form-note">편집 가능 시간 5분 · 행마다 최대 {session.max_cells_per_row}개 열 · 전체 최대 {session.max_total_cells}개 셀</p>
            <label className="field">편집할 행<select value={row} disabled={busy || Boolean(unavailable)}
              onChange={event => { setRow(Number(event.target.value)); setError(""); }}>
              {selected.map((item, index) => <option key={item.number} value={index}>
                {item.number}행{drafts.has(index) && ` · 변경된 열 ${drafts.get(index)?.size}개`}
              </option>)}
            </select></label>
            <p className="form-note">기본 키 · {session.keys[row].map(([name, value]) => `${name} = ${value}`).join(", ")}</p>
            {dirty && <p className="form-note">{drafts.size}행 · {count}개 셀 변경됨</p>}
            <label className="field">변경할 열<select value={column} disabled={busy || Boolean(unavailable)} onChange={event => setColumn(event.target.value)}>
              {session.columns.map(name => <option key={name} value={name}>{name}{rowDrafts?.has(name) && " · 변경됨"}</option>)}
            </select></label>
            {busy && !fields && <p className="form-note" role="status">열의 현재 값을 읽는 중…</p>}
            {fields && !field && <p className="form-note">이 행의 값은 4,096자를 초과합니다. 다른 행이나 열을 선택하세요.</p>}
            {atLimit && <p className="form-note" role="status">변경 한도에 도달했습니다. 기존 변경을 취소하면 다른 열을 편집할 수 있습니다.</p>}
            {draft && <fieldset disabled={busy || Boolean(unavailable) || Boolean(atLimit)} className="postgres-edit-field" data-changed={Boolean(local)}>
              <legend>{column} · {draft.field.data_type}{local && " · 변경됨"}</legend>
              <EditInputFields draft={draft} onChange={patch => update({ kind: draft.kind, value: draft.value, ...patch })} />
              {(fields?.every(Boolean) || local) && <div className="grid-edit-drafts">
                {fields?.every(Boolean) && <button type="button" className="secondary small"
                  onClick={() => update({ kind: draft.kind, value: draft.value }, true)}>선택한 모든 행의 이 열에 입력</button>}
                {local && <button type="button" className="secondary small"
                  onClick={() => update(fromField(draft.field))}>이 열의 변경 취소</button>}
              </div>}
            </fieldset>}
          </>}
          {preview && <div className="edit-preview">
            <strong>변경 미리보기 · {preview.rows.length}행 / {preview.rows.reduce((total, item) => total + item.changes.length, 0)}셀</strong>
            {preview.rows.map(item => <div key={item.row}>
              <p className="form-note">{selected[item.row].number}행 · 기본 키 · {session.keys[item.row].map(([name, value]) => `${name} = ${value}`).join(", ")}</p>
              {item.changes.map(change => <section className="postgres-edit-comparison" key={change.column}
                aria-label={`${selected[item.row].number}행 ${change.column} 변경 비교`}>
                <strong>{change.column}</strong>
                <EditValue label="이전 값" value={change.before.value} />
                <EditValue label={change.default_sql === null ? "변경 값" : "서버 기본값 식"}
                  value={change.default_sql ?? change.after.value} />
              </section>)}
            </div>)}
            {preview.rows.some(item => item.changes.some(change => change.default_sql !== null)) &&
              <p className="form-note">실제 기본값은 적용할 때 서버에서 계산합니다.</p>}
            <p className="form-note">변경 전체를 한 트랜잭션에 적용합니다. 한 행이라도 실패하면 전체를 롤백합니다.</p>
          </div>}
          {preview && production && !expired && <label className="field">운영 환경 확인<input value={confirmation} disabled={busy}
            autoComplete="off" required pattern="PROD" aria-describedby={productionHelp} onChange={event => setConfirmation(event.target.value)} /></label>}
          {preview && production && !expired && <p id={productionHelp} className="form-note">적용하려면 PROD를 입력하세요.</p>}
        </>}
        {error && <p className="form-error" id={errorId} role="alert">{error}{expired && " 창을 닫은 뒤 행을 다시 조회하세요."}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={requestClose}>닫기</button>
          {preview && !expired && <button type="button" className="secondary" disabled={busy}
            onClick={() => { setPreview(null); setConfirmation(""); setError(""); }}>다시 편집</button>}
          {session && !expired && <button type="submit" className={preview ? "danger" : "primary"} disabled={busy || !dirty || Boolean(unavailable)}>
            {busy ? "처리 중…" : preview ? "변경 적용" : "변경 미리보기"}
          </button>}
        </div>
      </>}
    </form>
  </Dialog>;
}

function draftCount(drafts: Map<number, Map<string, DraftValue>>) {
  return [...drafts.values()].reduce((total, cells) => total + cells.size, 0);
}

function EditInputFields({ draft, onChange }: { draft: Draft; onChange: (patch: Partial<DraftValue>) => void }) {
  return <>
    <EditValue label="현재 값" value={draft.field.current.value} />
    <label className="field">값 입력 방식<select value={draft.kind}
      onChange={event => onChange({ kind: event.target.value as InputKind })}>
      <option value="text">값 입력</option>
      {draft.field.nullable && <option value="null">NULL</option>}
      {draft.field.default_sql !== null && <option value="default">서버 기본값</option>}
    </select></label>
    {draft.kind === "text" && <label className="field">변경할 값<textarea className="edit-value" value={draft.value}
      maxLength={8192} onChange={event => onChange({ value: event.target.value })} /></label>}
    {draft.kind === "default" && <EditValue label="서버 기본값 식" value={draft.field.default_sql} />}
  </>;
}

function EditValue({ label, value }: { label: string; value: string | null }) {
  return <div className="edit-current"><span>{label}</span><pre>{value === null ? "NULL" : value || "(빈 문자열)"}</pre></div>;
}
