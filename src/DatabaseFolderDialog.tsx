import { useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

export const folderEngines = {
  sqlite: "sqlite", postgres: "postgres", mysql: "mysql", redis: "redis",
  mongo: "mongodb", sqlServer: "sql_server", oracle: "oracle", snowflake: "snowflake",
} as const;

export type FolderEngine = typeof folderEngines[keyof typeof folderEngines];
export type DatabaseFolder = { id: string; parent_id: string | null; name: string; revision: number };
export type DatabaseFolderState = {
  folders: DatabaseFolder[];
  placements: { engine: FolderEngine; profile_id: string; folder_id: string }[];
};
export type FolderAction =
  | { kind: "create"; parentId: string | null }
  | { kind: "edit"; folder: DatabaseFolder }
  | { kind: "place"; engine: FolderEngine; id: string; name: string; folderId: string | null };

export function databaseFolderPaths(folders: DatabaseFolder[]) {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const paths = new Map<string, string>();
  function path(folder: DatabaseFolder): string {
    const existing = paths.get(folder.id);
    if (existing !== undefined) return existing;
    const parent = folder.parent_id ? byId.get(folder.parent_id) : undefined;
    const result = parent ? `${path(parent)} / ${folder.name}` : folder.name;
    paths.set(folder.id, result);
    return result;
  }
  for (const folder of folders) path(folder);
  return paths;
}

const rootName = "데이터베이스 최상위";

export function DatabaseFolderDialog({ projectId, action, paths, onClose, onChanged, onSubfolder }: {
  projectId: string; action: FolderAction; paths: Map<string, string>; onClose: () => void;
  onChanged: (folderId: string | null) => void; onSubfolder: (parentId: string) => void;
}) {
  const originalParent = action.kind === "create" ? action.parentId : action.kind === "edit" ? action.folder.parent_id : action.folderId;
  const [parentId, setParentId] = useState(originalParent ?? "");
  const [name, setName] = useState(action.kind === "edit" ? action.folder.name : "");
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const edited = action.kind === "edit" ? action.folder : undefined;
  const editedPath = edited ? paths.get(edited.id) : undefined;
  const choices = [...paths].filter(([id, path]) => !edited || (id !== edited.id && !path.startsWith(`${editedPath} / `)))
    .sort((left, right) => left[1].localeCompare(right[1], "ko", { numeric: true }));
  const title = removing ? "연결 폴더 삭제" : action.kind === "create" ? "연결 폴더 만들기" :
    action.kind === "edit" ? "연결 폴더 설정" : "연결을 폴더로 이동";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    const parent = parentId || null;
    try {
      if (action.kind === "place") {
        await invoke("move_database_connection", { projectId, engine: action.engine, profileId: action.id,
          previousFolderId: action.folderId, folderId: parent });
        onChanged(parent);
      } else if (action.kind === "create") {
        const folder = await invoke<DatabaseFolder>("create_database_folder", { projectId, parentId: parent, name });
        onChanged(folder.parent_id);
      } else if (removing) {
        await invoke("delete_database_folder", { projectId, id: action.folder.id, revision: action.folder.revision });
        onChanged(action.folder.parent_id);
      } else {
        const folder = await invoke<DatabaseFolder>("update_database_folder", { projectId, id: action.folder.id,
          revision: action.folder.revision, parentId: parent, name });
        onChanged(folder.parent_id);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return <Dialog title={title} busy={pending} onClose={onClose} role={removing ? "alertdialog" : undefined}
    describedBy={removing ? descriptionId : undefined} initialFocus={removing ? cancel : undefined}>
    <form onSubmit={event => void submit(event)} aria-busy={pending}>
      {removing && edited ? <p className="confirm-copy" id={descriptionId}>
        <strong>{edited.name}</strong> 폴더와 하위 폴더를 삭제합니다. 그 안의 연결은 <strong>{originalParent ? paths.get(originalParent) : rootName}</strong> 위치로 옮깁니다.
      </p> : <>
        {action.kind === "place" ? <p className="confirm-copy"><strong>{action.name}</strong></p> :
          <label className="field">폴더 이름<input required maxLength={100} autoFocus value={name}
            disabled={pending} onChange={event => setName(event.target.value)} /></label>}
        <label className="field">{action.kind === "place" ? "이동할 폴더" : "상위 폴더"}
          <select value={parentId} autoFocus={action.kind === "place"} disabled={pending} onChange={event => setParentId(event.target.value)}>
            <option value="">{rootName}</option>
            {choices.map(([id, path]) => <option key={id} value={id}>{path}</option>)}
          </select>
        </label>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions database-folder-dialog-actions">
        {edited && !removing && <>
          <button type="button" className="secondary" disabled={pending} onClick={() => onSubfolder(edited.id)}>하위 폴더 만들기</button>
          <button type="button" className="secondary" disabled={pending} onClick={() => { setError(""); setRemoving(true); }}>폴더 삭제…</button>
        </>}
        {removing && <button ref={cancel} type="button" className="secondary" disabled={pending}
          onClick={() => { setError(""); setRemoving(false); }}>취소</button>}
        <button type="submit" className={removing ? "danger" : "primary"} disabled={pending ||
          (action.kind === "place" && (parentId || null) === originalParent) || (action.kind !== "place" && !removing && !name.trim())}>
          {removing ? "폴더 삭제" : action.kind === "place" ? "연결 이동" : action.kind === "create" ? "폴더 만들기" : "저장"}
        </button>
      </div>
    </form>
  </Dialog>;
}
