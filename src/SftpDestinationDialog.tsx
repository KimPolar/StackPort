import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, X } from "lucide-react";
import { listedItemSnapshot, type SftpListedItem } from "./SftpNameDialog";
import type { TransferResult } from "./SftpTransferDialog";
import { SftpTransferStatus, useSftpTransfer } from "./SftpTransferStatus";

type Folder = {
  path: string;
  location: string;
  parent: string | null;
  entries: { name: string; kind: string; location: string | null }[];
  truncated: boolean;
};
export type SftpDestinationSelection = { kind: "move" | "copy"; parent: Folder; item: SftpListedItem };

function itemPath(folder: string, name: string) {
  return `${folder.endsWith("/") ? folder : `${folder}/`}${name}`;
}

export function SftpDestinationDialog({ id, target, selection, onClose, onMoved, onCopied }: {
  id: string;
  target: string;
  selection: SftpDestinationSelection;
  onClose: () => void;
  onMoved: (path: string, auditWarning: string | null) => void;
  onCopied: (result: TransferResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [input, setInput] = useState(selection.parent.path);
  const [folder, setFolder] = useState<Folder | null>(selection.parent);
  const [busy, setBusy] = useState<"checking" | "moving" | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState(selection.item.name);
  const transfer = useSftpTransfer(id, "복사");
  const copying = selection.kind === "copy";
  const disabled = !!busy || transfer.running;
  const subfolders = folder?.entries.filter(entry => entry.kind === "directory" && entry.location) ?? [];
  const canSubmit = folder && (copying
    ? !!name && (name !== selection.item.name || folder.location !== selection.parent.location)
    : folder.location !== selection.parent.location);

  useEffect(() => { dialog.current?.showModal(); }, []);

  async function browse(kind: "text" | "token", value: string) {
    if (!value || pending.current || transfer.running) return;
    pending.current = true;
    setBusy("checking");
    setFolder(null);
    setError("");
    transfer.clearFeedback();
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !folder || !canSubmit) return;
    setError("");
    const args = { parent: selection.parent.location, source: listedItemSnapshot(selection.item) };
    if (copying) {
      const report = await transfer.run("copy_sftp_file", {
        ...args, directory: folder.location, name: name === selection.item.name ? null : name,
      });
      if (!report) return;
      onCopied({ kind: "copy", path: itemPath(folder.path, name), bytes: report.bytes, sha256: report.sha256, auditWarning: report.audit_warning });
      dialog.current?.close();
      return;
    }
    pending.current = true;
    setBusy("moving");
    try {
      const report = await invoke<{ audit_warning: string | null }>("move_sftp_entry", {
        ...args, id, destination: folder.location,
      });
      onMoved(itemPath(folder.path, selection.item.name), report.audit_warning);
      dialog.current?.close();
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  return <dialog className="dialog" ref={dialog} aria-labelledby="sftp-destination-title" onClose={onClose}
    onCancel={event => { if (disabled) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sftp-destination-title">{copying ? "원격 파일 복사" : "원격 이동"}</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={disabled} onClick={() => dialog.current?.close()}><X size={18} /></button>
    </div>
    <form onSubmit={event => void submit(event)} aria-busy={disabled}>
      <p className="confirm-copy files-download-source"><strong>{target}</strong><br />원본 · {itemPath(selection.parent.path, selection.item.name)}</p>
      <label className="field">대상 폴더 경로<span className="file-input">
        <input autoFocus required maxLength={4096} disabled={disabled} value={input} onChange={event => {
          setInput(event.target.value);
          setFolder(null);
          setError("");
          transfer.clearFeedback();
        }} />
        <button type="button" className="secondary" disabled={disabled || !input} onClick={() => void browse("text", input)}>경로 확인</button>
      </span></label>
      {folder && <div className="field">
        <div className="file-input">
          <button type="button" className="secondary small" disabled={!folder.parent || disabled}
            onClick={() => folder.parent && void browse("token", folder.parent)}><ArrowUp size={14} /> 상위 폴더</button>
          {subfolders.length > 0 && <select aria-label="하위 대상 폴더" value="" disabled={disabled}
            onChange={event => void browse("token", event.target.value)}>
            <option value="">하위 폴더 선택</option>
            {subfolders.map(entry => <option key={entry.location} value={entry.location ?? ""}>{entry.name}</option>)}
          </select>}
        </div>
        {folder.truncated && <span className="form-note">처음 2,000개 항목에서 폴더를 표시합니다.</span>}
      </div>}
      {copying && <label className="field">복사본 이름<input required maxLength={255} disabled={disabled} value={name}
        onChange={event => { setName(event.target.value); setError(""); transfer.clearFeedback(); }} /></label>}
      {canSubmit && <p className="form-note files-download-source">
        {copying ? "복사할 경로" : "이동할 경로"}<br />
        <output aria-label={copying ? "확인한 복사 경로" : "확인한 이동 경로"}>{itemPath(folder.path, copying ? name : selection.item.name)}</output>
      </p>}
      {busy === "checking" && <p className="form-note" role="status">대상 폴더를 읽는 중…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {copying && <SftpTransferStatus transfer={transfer} />}
      <div className="dialog-actions">
        {transfer.running ? <button type="button" className="secondary" disabled={!transfer.canCancel}
          onClick={() => void transfer.cancel()}>복사 중단</button> : <>
          <button type="button" className="secondary" disabled={disabled} onClick={() => dialog.current?.close()}>취소</button>
          <button type="submit" className="primary" disabled={disabled || !canSubmit}>{copying ? "복사" : busy === "moving" ? "이동 중…" : "이동"}</button>
        </>}
      </div>
    </form>
  </dialog>;
}
