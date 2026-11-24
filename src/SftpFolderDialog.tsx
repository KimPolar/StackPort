import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

export function SftpFolderDialog({ id, target, parent, onClose, onCreated }: {
  id: string;
  target: string;
  parent: { path: string; location: string };
  onClose: () => void;
  onCreated: (name: string, auditWarning: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const creating = useRef(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { dialog.current?.showModal(); }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setError("");
    try {
      const report = await invoke<{ audit_warning: string | null }>("create_sftp_folder", { id, parent: parent.location, name });
      onCreated(name, report.audit_warning);
      dialog.current?.close();
    } catch (error) {
      setError(String(error));
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }

  return <dialog className="dialog" ref={dialog} aria-labelledby="sftp-folder-title" onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sftp-folder-title">원격 새 폴더</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} /></button>
    </div>
    <form onSubmit={event => void create(event)} aria-busy={busy}>
      <p className="confirm-copy files-download-source"><strong>{target}</strong><br />{parent.path}</p>
      <label className="field">폴더 이름<input required maxLength={255} value={name} disabled={busy}
        onChange={event => setName(event.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>취소</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? "만드는 중…" : "만들기"}</button>
      </div>
    </form>
  </dialog>;
}
