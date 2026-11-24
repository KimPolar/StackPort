import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, X } from "lucide-react";
import { listedItemSnapshot, type SftpListedItem } from "./SftpNameDialog";

type Folder = {
  path: string;
  location: string;
  parent: string | null;
  entries: { name: string; kind: string; location: string | null }[];
  truncated: boolean;
};
export type SftpMoveSelection = { parent: Folder; item: SftpListedItem };

function itemPath(folder: string, name: string) {
  return `${folder.endsWith("/") ? folder : `${folder}/`}${name}`;
}

export function SftpMoveDialog({ id, target, selection, onClose, onSaved }: {
  id: string;
  target: string;
  selection: SftpMoveSelection;
  onClose: () => void;
  onSaved: (path: string, auditWarning: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [input, setInput] = useState(selection.parent.path);
  const [folder, setFolder] = useState<Folder | null>(selection.parent);
  const [busy, setBusy] = useState<"checking" | "moving" | null>(null);
  const [error, setError] = useState("");
  const subfolders = folder?.entries.filter(entry => entry.kind === "directory" && entry.location) ?? [];
  const canMove = folder && folder.location !== selection.parent.location;

  useEffect(() => { dialog.current?.showModal(); }, []);

  async function browse(kind: "text" | "token", value: string) {
    if (!value || pending.current) return;
    pending.current = true;
    setBusy("checking");
    setFolder(null);
    setError("");
    try {
      const resolved = await invoke<Folder>("list_sftp_directory", { id, path: { kind, value } });
      setFolder(resolved);
      setInput(resolved.path);
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  async function move(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !folder || !canMove) return;
    pending.current = true;
    setBusy("moving");
    setError("");
    try {
      const report = await invoke<{ audit_warning: string | null }>("move_sftp_entry", {
        id, parent: selection.parent.location, source: listedItemSnapshot(selection.item), destination: folder.location,
      });
      onSaved(itemPath(folder.path, selection.item.name), report.audit_warning);
      dialog.current?.close();
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  return <dialog className="dialog" ref={dialog} aria-labelledby="sftp-move-title" onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sftp-move-title">원격 이동</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={!!busy} onClick={() => dialog.current?.close()}><X size={18} /></button>
    </div>
    <form onSubmit={event => void move(event)} aria-busy={!!busy}>
      <p className="confirm-copy files-download-source"><strong>{target}</strong><br />원본 · {itemPath(selection.parent.path, selection.item.name)}</p>
      <label className="field">대상 폴더 경로<span className="file-input">
        <input autoFocus required maxLength={4096} disabled={!!busy} value={input} onChange={event => {
          setInput(event.target.value);
          setFolder(null);
          setError("");
        }} />
        <button type="button" className="secondary" disabled={!!busy || !input} onClick={() => void browse("text", input)}>경로 확인</button>
      </span></label>
      {folder && <div className="field">
        <div className="file-input">
          <button type="button" className="secondary small" disabled={!folder.parent || !!busy}
            onClick={() => folder.parent && void browse("token", folder.parent)}><ArrowUp size={14} /> 상위 폴더</button>
          {subfolders.length > 0 && <select aria-label="하위 대상 폴더" value="" disabled={!!busy}
            onChange={event => void browse("token", event.target.value)}>
            <option value="">하위 폴더 선택</option>
            {subfolders.map(entry => <option key={entry.location} value={entry.location ?? ""}>{entry.name}</option>)}
          </select>}
        </div>
        {folder.truncated && <span className="form-note">처음 2,000개 항목에서 폴더를 표시합니다.</span>}
        {canMove && <div className="form-note files-download-source">
          이동할 경로<br /><output aria-label="확인한 이동 경로">{itemPath(folder.path, selection.item.name)}</output>
        </div>}
      </div>}
      {busy === "checking" && <p className="form-note" role="status">대상 폴더를 읽는 중…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={!!busy} onClick={() => dialog.current?.close()}>취소</button>
        <button type="submit" className="primary" disabled={!!busy || !canMove}>{busy === "moving" ? "이동 중…" : "이동"}</button>
      </div>
    </form>
  </dialog>;
}
