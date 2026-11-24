import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Star, X } from "lucide-react";
import { sqliteNameKey } from "./sqlCompletion";

type Summary = { id: string; name: string; folder: string; favorite: boolean; revision: number };
type Template = Summary & { sql: string };
type Input = Pick<Template, "name" | "folder" | "favorite" | "sql">;
type Mode = { kind: "browse" } | { kind: "edit"; original: Summary | null; input: Input } | { kind: "delete"; original: Summary };
type Write = { kind: "create"; template: Input }
  | { kind: "update"; id: string; revision: number; template: Input }
  | { kind: "favorite"; id: string; revision: number; favorite: boolean };
const browse = { kind: "browse" } as const;

function summaryOf({ sql: _sql, ...summary }: Template): Summary { return summary; }

export function SqlTemplateLibrary({ projectId, projectName, source, selection, canOpen, onOpen, onClose }: {
  projectId: string;
  projectName: string;
  source: string;
  selection: boolean;
  canOpen: boolean;
  onOpen: (template: { name: string; sql: string }) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const [catalog, setCatalog] = useState<Summary[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("all");
  const [favorites, setFavorites] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<Template | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>(browse);
  const folders = new Map((catalog ?? []).map(item => [`folder:${sqliteNameKey(item.folder)}`, item.folder]));
  const activeFolder = folders.has(folder) ? folder : "all";
  const query = search.trim().toLocaleLowerCase();
  const visible = (catalog ?? []).filter(item => (!favorites || item.favorite)
    && (activeFolder === "all" || activeFolder === `folder:${sqliteNameKey(item.folder)}`)
    && (!query || `${item.name} ${item.folder}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  const selected = visible.find(item => item.id === selectedId) ?? visible[0];
  const selectedKey = selected?.id;
  const selectedRevision = selected?.revision;
  const current = preview && preview.id === selectedKey && preview.revision === selectedRevision ? preview : null;
  const editing = mode.kind === "edit" ? mode : null;

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    const request = generation.current;
    invoke<Summary[]>("list_sql_templates", { projectId }).then(items => {
      if (live && request === generation.current) setCatalog(items);
    }, reason => {
      if (live && request === generation.current) setError(String(reason));
    });
    return () => { live = false; };
  }, [projectId, refresh]);

  useEffect(() => {
    setPreviewError("");
    if (!selectedKey) { setPreview(null); return; }
    let live = true;
    const request = generation.current;
    invoke<Template>("read_sql_template", { projectId, id: selectedKey }).then(template => {
      if (!live || request !== generation.current) return;
      setPreview(template);
      if (template.revision !== selectedRevision) {
        setCatalog(items => items?.map(item => item.id === template.id ? summaryOf(template) : item) ?? null);
      }
    }, reason => {
      if (live && request === generation.current) setPreviewError(String(reason));
    });
    return () => { live = false; };
  }, [projectId, selectedKey, selectedRevision, refresh]);

  function changeMode(next: Mode) {
    setMode(next);
    setError("");
  }

  function reload() {
    setError("");
    setPreviewError("");
    setRefresh(value => value + 1);
  }

  async function mutate(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    generation.current++;
    setBusy(true);
    setError("");
    try { await action(); }
    catch (reason) { setError(String(reason)); }
    finally {
      pending.current = false;
      setBusy(false);
      setRefresh(value => value + 1);
    }
  }

  async function save(write: Write) {
    const saved = await invoke<Template>("save_sql_template", { projectId, write });
    setCatalog(items => [...(items ?? []).filter(item => item.id !== saved.id), summaryOf(saved)]);
    setSelectedId(saved.id);
    setPreview(saved);
    if (write.kind !== "favorite") {
      setSearch("");
      setFolder("all");
      setFavorites(false);
    }
    changeMode(browse);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const { input, original } = editing;
    if (new TextEncoder().encode(input.sql).length > 256 * 1024) {
      setError("UTF-8로 256 KiB 이하의 SQL을 입력하세요.");
      return;
    }
    void mutate(() => save(original ? { kind: "update", id: original.id, revision: original.revision, template: input }
      : { kind: "create", template: input }));
  }

  function create(sql: string) {
    changeMode({ kind: "edit", original: null, input: { name: "", folder: "", favorite: false, sql } });
  }

  return <dialog ref={dialog} className="dialog sql-template-library" aria-labelledby="sql-template-title"
    role={mode.kind === "delete" ? "alertdialog" : undefined}
    aria-describedby={mode.kind === "delete" ? "sql-template-delete-description" : undefined}
    onClose={onClose} onCancel={event => { if (pending.current) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sql-template-title">SQL 템플릿</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    {editing ? <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{projectName}</strong> · {editing.original ? "템플릿 편집" : "새 템플릿"}</p>
      <fieldset className="sql-template-fields" disabled={busy}>
        <label className="field">템플릿 이름<input autoFocus required maxLength={100} value={editing.input.name}
          onChange={event => setMode({ ...editing, input: { ...editing.input, name: event.target.value } })} /></label>
        <label className="field">폴더<input maxLength={100} list="sql-template-existing-folders" value={editing.input.folder}
          onChange={event => setMode({ ...editing, input: { ...editing.input, folder: event.target.value } })} /></label>
        <datalist id="sql-template-existing-folders">{[...folders.values()].filter(Boolean).map(name => <option key={name} value={name} />)}</datalist>
        <div className="field sql-template-editor-field">
          <label htmlFor="sql-template-content">템플릿 SQL</label>
          <textarea id="sql-template-content" required rows={8} spellCheck={false}
            value={editing.input.sql} onChange={event => setMode({ ...editing, input: { ...editing.input, sql: event.target.value } })} />
        </div>
        <label><input type="checkbox" checked={editing.input.favorite}
          onChange={event => setMode({ ...editing, input: { ...editing.input, favorite: event.target.checked } })} /> 즐겨찾기</label>
      </fieldset>
      <p className="form-note">SQL 본문을 로컬 프로젝트에 저장합니다. 실행할 때 입력할 값은 <code>:value</code> 같은 매개변수로 작성하세요.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => changeMode(browse)}>목록으로</button>
        <button type="submit" className="primary" disabled={busy || !editing.input.name.trim() || !editing.input.sql.trim()}>템플릿 저장</button></div>
    </form> : <div className="sql-template-library-body" aria-busy={busy}>
      {mode.kind === "delete" ? <>
        <p className="confirm-copy" id="sql-template-delete-description"><strong>{mode.original.name}</strong> 템플릿을 이 프로젝트에서 삭제합니다.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => changeMode(browse)}>취소</button>
          <button type="button" className="danger" disabled={busy} onClick={() => void mutate(async () => {
            await invoke("delete_sql_template", { projectId, id: mode.original.id, revision: mode.original.revision });
            setCatalog(items => items?.filter(item => item.id !== mode.original.id) ?? null);
            changeMode(browse);
          })}>템플릿 삭제 확인</button></div>
      </> : <>
        <div className="sql-template-controls">
          <strong>{projectName}</strong>
          <button type="button" className="secondary small" disabled={busy} onClick={reload}>새로 고침</button>
          <button type="button" className="secondary small" disabled={busy} onClick={() => create("")}>새 템플릿</button>
          {source.trim() && <button type="button" className="primary small" disabled={busy} onClick={() => create(source)}>
            {selection ? "선택 영역으로 만들기" : "현재 SQL로 만들기"}</button>}
        </div>
        <div className="sql-template-filters">
          <input type="search" aria-label="템플릿 검색" placeholder="이름 또는 폴더 검색" value={search} onChange={event => setSearch(event.target.value)} />
          <select aria-label="템플릿 폴더" value={activeFolder} onChange={event => setFolder(event.target.value)}>
            <option value="all">모든 폴더</option>
            {[...folders].sort(([, a], [, b]) => a.localeCompare(b)).map(([key, name]) =>
              <option key={key} value={key}>{name || "폴더 없음"}</option>)}
          </select>
          <label><input type="checkbox" checked={favorites} onChange={event => setFavorites(event.target.checked)} /> 즐겨찾기만</label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!catalog && !error && <p role="status" className="form-note">템플릿을 불러오는 중…</p>}
        {catalog && !visible.length && <p role="status" className="form-note">{catalog.length ? "조건에 맞는 템플릿이 없습니다." : "저장된 템플릿이 없습니다."}</p>}
        {!!visible.length && <div className="sql-template-browser">
          <ul className="sql-template-list" aria-label="템플릿 목록">{visible.map(item => <li key={item.id}>
            <button type="button" aria-pressed={item.id === selectedKey} disabled={busy} onClick={() => setSelectedId(item.id)}>
              <strong>{item.name}</strong>
              {item.favorite && <Star size={13} fill="currentColor" aria-label="즐겨찾기" />}
              {item.folder && <small>{item.folder}</small>}
            </button>
          </li>)}</ul>
          <div className="sql-template-preview">
            {previewError ? <p className="form-error" role="alert">{previewError}</p>
              : current ? <>
                <strong>{current.name}</strong>
                <pre aria-label="저장된 템플릿 SQL" tabIndex={0}>{current.sql}</pre>
                {!canOpen && <p className="form-note">SQLite 연결을 선택하면 새 탭에서 열 수 있습니다.</p>}
                <div className="sql-template-controls">
                  <button type="button" className="primary small" disabled={busy || !canOpen} onClick={() => onOpen(current)}>새 탭에서 열기</button>
                  <button type="button" className="secondary small" disabled={busy} aria-pressed={current.favorite} onClick={() => void mutate(() =>
                    save({ kind: "favorite", id: current.id, revision: current.revision, favorite: !current.favorite }))}>즐겨찾기</button>
                  <button type="button" className="secondary small" disabled={busy} onClick={() => changeMode({
                    kind: "edit", original: current, input: { name: current.name, folder: current.folder, favorite: current.favorite, sql: current.sql },
                  })}>템플릿 편집</button>
                  <button type="button" className="secondary small" disabled={busy} onClick={() =>
                    changeMode({ kind: "delete", original: current })}>템플릿 삭제</button>
                </div>
              </> : <p role="status" className="form-note">SQL 본문을 불러오는 중…</p>}
          </div>
        </div>}
      </>}
    </div>}
  </dialog>;
}
