import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import type { TableQueryClauses } from "./TableQueryControls";

export type TableQueryTarget =
  | { engine: "sqlite"; profile_id: string; object: string }
  | { engine: "postgres"; profile_id: string; revision: number; schema: string; object: string };
type Preset = { id: string; name: string; revision: number };
type Write =
  | { kind: "create"; name: string; clauses: TableQueryClauses }
  | { kind: "replace"; id: string; revision: number; clauses: TableQueryClauses }
  | { kind: "delete"; id: string; revision: number };

export function TableQueryPresetsDialog({ target, draft, valid, columns, onApply, onClose }: {
  target: TableQueryTarget;
  draft: TableQueryClauses;
  valid: boolean;
  columns: string[];
  onApply: (clauses: TableQueryClauses) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Preset[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [version, setVersion] = useState(0);
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<"replace" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const pending = useRef(false);
  const live = useRef(false);
  const errorId = useId();
  const helpId = useId();
  const selected = items?.find(item => item.id === selectedId);
  const draftEmpty = !draft.filters.length && !draft.sort.length;
  const canSave = valid && !draftEmpty;

  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    invoke<Preset[]>("list_table_query_presets", { target }).then(
      loaded => { if (current) setItems(loaded); },
      reason => { if (current) setCatalogError(String(reason)); },
    );
    return () => { current = false; };
  }, [target, version]);

  function reload() {
    setItems(null);
    setCatalogError("");
    setVersion(value => value + 1);
  }

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); }
    catch (reason) { if (live.current) setError(String(reason)); }
    finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  function apply(preset: Preset) {
    return run(async () => {
      const clauses = await invoke<TableQueryClauses>("read_table_query_preset", { target, id: preset.id, revision: preset.revision });
      if (!live.current) return;
      const available = new Set(columns);
      const missing = [...clauses.filters, ...clauses.sort].find(item => !available.has(item.column));
      if (missing) throw new Error(`현재 객체에 ${missing.column} 열이 없습니다.`);
      onApply(clauses);
    });
  }

  function save(write: Write) {
    return run(async () => {
      await invoke("write_table_query_preset", { target, write });
      if (!live.current) return;
      setConfirm(null);
      if (write.kind === "create") setName("");
      if (write.kind === "delete") setSelectedId("");
      setNotice(write.kind === "delete" ? "저장된 조건을 삭제했습니다." : "조회 조건을 저장했습니다.");
      reload();
    });
  }

  return <Dialog title="저장된 조회 조건" busy={busy} onClose={onClose}>
    <p className="form-note">{target.engine === "postgres" ? target.schema + "." : ""}{target.object}</p>
    {error && <p className="form-error" id={errorId} role="alert">{error}</p>}
    {catalogError && <p className="form-error" role="alert">{catalogError}</p>}
    {notice && <p className="form-note" role="status">{notice}</p>}
    {!items && !catalogError && <p className="form-note" role="status">저장된 조건을 불러오는 중…</p>}
    {items?.length === 0 && <p className="result-empty">저장된 조건이 없습니다.</p>}
    {items && items.length > 0 && <div className="query-preset-section">
      <label className="field">조회 조건
        <select value={selected?.id ?? ""} disabled={busy} onChange={event => {
          setSelectedId(event.target.value); setConfirm(null); setError(""); setNotice("");
        }}>
          <option value="">조건 선택</option>
          {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {selected && !confirm && <div className="table-query-actions">
        <button type="button" className="secondary small" disabled={busy} onClick={() => setConfirm("delete")}>삭제</button>
        <button type="button" className="secondary small" disabled={busy || !canSave} aria-describedby={helpId}
          onClick={() => setConfirm("replace")}>현재 조건으로 바꾸기</button>
        <button type="button" className="primary small" disabled={busy} onClick={() => void apply(selected)}>적용</button>
      </div>}
      {selected && confirm && <div className="query-preset-confirm">
        <p className="form-note">{confirm === "delete" ? `‘${selected.name}’ 조건을 삭제할까요?` : `‘${selected.name}’에 현재 필터와 정렬을 저장할까요?`}</p>
        <div className="table-query-actions">
          <button type="button" className="secondary small" autoFocus disabled={busy} onClick={() => setConfirm(null)}>취소</button>
          <button type="button" className="primary small" disabled={busy || (confirm === "replace" && !canSave)}
            onClick={() => void save(confirm === "delete"
              ? { kind: "delete", id: selected.id, revision: selected.revision }
              : { kind: "replace", id: selected.id, revision: selected.revision, clauses: draft })}>
            {confirm === "delete" ? "조건 삭제" : "조건 바꾸기"}
          </button>
        </div>
      </div>}
    </div>}
    <form className="query-preset-section" aria-describedby={error ? errorId : undefined} aria-busy={busy} onSubmit={event => {
      event.preventDefault();
      if (items && canSave && !confirm && name.trim()) void save({ kind: "create", name, clauses: draft });
    }}>
      <label className="field">새 조건 이름<input value={name} required maxLength={80}
        disabled={busy || !items || !canSave || confirm !== null} aria-describedby={helpId}
        onChange={event => setName(event.target.value)} /></label>
      <p id={helpId} className="form-note">
        {draftEmpty ? "필터 또는 정렬을 추가하면 현재 조건을 저장할 수 있습니다." : !valid ?
          "현재 필터의 필수 값을 채우면 조건을 저장할 수 있습니다." : "필터 입력값도 이 컴퓨터의 작업 공간에 저장됩니다."}
      </p>
      <div className="table-query-actions">
        <button type="button" className="secondary small" disabled={busy} onClick={() => {
          setConfirm(null); setError(""); setNotice(""); reload();
        }}>새로 고침</button>
        <button type="submit" className="primary small" disabled={busy || !items || !canSave || confirm !== null || !name.trim()}
          aria-describedby={helpId}>조건 저장</button>
      </div>
    </form>
  </Dialog>;
}
