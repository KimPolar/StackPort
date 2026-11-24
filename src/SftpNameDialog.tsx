import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

export type SftpListedItem = { name: string; location: string; kind: "file" | "directory"; size: string | null; modified: number | null };
type Parent = { path: string; location: string };
export type SftpNameAction = { kind: "create"; parent: Parent } | { kind: "rename"; parent: Parent; item: SftpListedItem };

export function SftpNameDialog({ id, target, action, onClose, onSaved }: {
  id: string;
  target: string;
  action: SftpNameAction;
  onClose: () => void;
  onSaved: (name: string, auditWarning: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const renaming = action.kind === "rename";

  useEffect(() => { dialog.current?.showModal(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const args = { id, parent: action.parent.location, name };
      const command = renaming ? "rename_sftp_entry" : "create_sftp_folder";
      const renameArgs = renaming ? {
        ...args,
        source: listedItemSnapshot(action.item),
      } : args;
      const report = await invoke<{ audit_warning: string | null }>(command, renameArgs);
      onSaved(name, report.audit_warning);
      dialog.current?.close();
    } catch (error) {
      setError(String(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <dialog className="dialog" ref={dialog} aria-labelledby="sftp-name-title" onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sftp-name-title">{renaming ? "원격 이름 변경" : "원격 새 폴더"}</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} /></button>
    </div>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <p className="confirm-copy files-download-source"><strong>{target}</strong><br />{action.parent.path}
        {renaming && <><br /><strong>{action.item.name}</strong></>}</p>
      <label className="field">{renaming ? "새 이름" : "폴더 이름"}<input autoFocus required maxLength={255} value={name} disabled={busy}
        onChange={event => setName(event.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>취소</button>
        <button type="submit" className="primary" disabled={busy}>
          {renaming ? (busy ? "변경 중…" : "이름 변경") : (busy ? "만드는 중…" : "만들기")}
        </button>
      </div>
    </form>
  </dialog>;
}

export function listedItemSnapshot({ location, kind, size, modified }: SftpListedItem) {
  return { location, kind, size, modified };
}
