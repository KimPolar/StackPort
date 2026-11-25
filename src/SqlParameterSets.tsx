import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type ParameterSetScope = { project_id: string; engine: "sqlite" | "postgres" | "postgres_script"; key: string };
export type ParameterInput<Kind extends string> = { kind: Kind; value: string; masked: boolean; needsValue?: boolean };
type Summary = { id: string; name: string; is_default: boolean; revision: number };
type SavedValue<Kind extends string> = { kind: "secret"; value_kind: Kind } |
  { kind: "value"; value: { kind: Kind; value?: string } };
type SavedSet<Kind extends string> = Summary & { values: SavedValue<Kind>[] };

export function SqlParameterSets<Kind extends string>({ scope, fields, allowedKinds, disabled, apply, onReady }: {
  scope: ParameterSetScope;
  fields: ParameterInput<Kind>[];
  allowedKinds: readonly Kind[];
  disabled?: boolean;
  apply: (fields: ParameterInput<Kind>[]) => void;
  onReady: () => void;
}) {
  const [sets, setSets] = useState<Summary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [preferred, setPreferred] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef({ fields, apply, allowedKinds, disabled, onReady });
  current.current = { fields, apply, allowedKinds, disabled, onReady };
  const selected = sets.find(item => item.id === selectedId);
  const { project_id, engine, key } = scope;

  function select(set: Summary | undefined) {
    setSelectedId(set?.id ?? "");
    setName(set?.name ?? "");
    setPreferred(set?.is_default ?? false);
  }

  function loadValues(set: SavedSet<Kind>) {
    const { fields, allowedKinds, apply } = current.current;
    if (set.values.length !== fields.length || set.values.some(item =>
      !allowedKinds.includes(item.kind === "secret" ? item.value_kind : item.value.kind))) {
      throw new Error("현재 SQL의 매개변수 형식과 저장된 세트가 다릅니다.");
    }
    apply(set.values.map(item => item.kind === "secret"
      ? { kind: item.value_kind, value: "", masked: true, needsValue: true }
      : { kind: item.value.kind, value: item.value.value ?? "", masked: false }));
    setNotice(set.values.some(item => item.kind === "secret") ? "숨김 값은 다시 입력하세요." : "매개변수 세트를 불러왔습니다.");
  }

  useEffect(() => {
    let live = true;
    const initial = current.current.fields;
    const scope = { project_id, engine, key };
    setBusy(true);
    setError("");
    setNotice("");
    void (async () => {
      try {
        const items = await invoke<Summary[]>("list_sql_parameter_sets", { scope });
        if (!live) return;
        setSets(items);
        const defaultSet = items.find(item => item.is_default);
        select(defaultSet);
        if (!defaultSet || current.current.fields !== initial || current.current.disabled) return;
        const saved = await invoke<SavedSet<Kind>>("read_sql_parameter_set", {
          scope, id: defaultSet.id, revision: defaultSet.revision,
        });
        if (live && current.current.fields === initial && !current.current.disabled) loadValues(saved);
      } catch (error) { if (live) setError(String(error)); }
      finally {
        if (live) {
          setBusy(false);
          current.current.onReady();
        }
      }
    })();
    return () => { live = false; };
  }, [project_id, engine, key]);

  async function manage(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  async function refresh(keep?: string) {
    const items = await invoke<Summary[]>("list_sql_parameter_sets", { scope });
    setSets(items);
    select(items.find(item => item.id === keep));
  }

  function load() {
    if (!selected) return;
    const initial = fields;
    void manage(async () => {
      const saved = await invoke<SavedSet<Kind>>("read_sql_parameter_set", { scope, id: selected.id, revision: selected.revision });
      if (current.current.disabled || current.current.fields !== initial) {
        setNotice("입력한 값을 유지했습니다. 세트를 적용하려면 다시 불러오세요.");
        return;
      }
      loadValues(saved);
    });
  }

  function save(existing?: Summary) {
    const values = fields.map(field => {
      if (field.kind === "null") return { kind: "value", value: { kind: "null" } };
      if (field.masked || field.needsValue) return { kind: "secret", value_kind: field.kind };
      return { kind: "value", value: { kind: field.kind, value: field.value } };
    });
    const input = { name, is_default: preferred, values };
    const write = existing ? { kind: "update", id: existing.id, revision: existing.revision, input } : { kind: "create", input };
    void manage(async () => {
      const saved = await invoke<Summary>("save_sql_parameter_set", { scope, write });
      await refresh(saved.id);
      setNotice("매개변수 세트를 저장했습니다.");
    });
  }

  function remove() {
    if (!selected) return;
    void manage(async () => {
      await invoke("delete_sql_parameter_set", { scope, id: selected.id, revision: selected.revision });
      await refresh();
      setNotice("매개변수 세트를 삭제했습니다.");
    });
  }

  return <fieldset className="sql-parameter-sets" disabled={disabled || busy}>
    <legend>매개변수 세트</legend>
    <div className="sql-parameter-set-actions">
      <label className="field">저장된 세트
        <select value={selectedId} onChange={event => { setNotice(""); select(sets.find(item => item.id === event.target.value)); }}>
          <option value="">{sets.length ? "세트 선택" : "저장된 세트 없음"}</option>
          {sets.map(set => <option key={set.id} value={set.id}>{set.name}{set.is_default ? " · 기본" : ""}</option>)}
        </select>
      </label>
      <button type="button" className="secondary small" disabled={!selected} onClick={load}>불러오기</button>
      <button type="button" className="secondary small" disabled={!selected} onClick={remove}>세트 삭제</button>
      <button type="button" className="secondary small" onClick={() => void manage(() => refresh(selectedId))}>새로 고침</button>
    </div>
    <details>
      <summary>세트 저장</summary>
      <div className="sql-parameter-set-actions">
        <label className="field">세트 이름<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
        <label className="files-check"><input type="checkbox" checked={preferred} onChange={event => setPreferred(event.target.checked)} /> 기본 세트</label>
        <button type="button" className="secondary small" disabled={!name.trim()} onClick={() => save()}>새 세트로 저장</button>
        <button type="button" className="secondary small" disabled={!selected || !name.trim()} onClick={() => save(selected)}>선택 세트 갱신</button>
      </div>
      <p className="form-note">숨김 값은 재입력 항목으로 저장됩니다.</p>
    </details>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="form-note" role="status">{notice}</p>}
  </fieldset>;
}
