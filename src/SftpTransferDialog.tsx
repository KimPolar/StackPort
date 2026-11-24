import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { SftpTransferStatus, useSftpTransfer } from "./SftpTransferStatus";

export type TransferResult = { kind: TransferSelection["kind"] | "copy"; path: string; bytes: string; sha256: string; auditWarning: string | null };
export type FileSelection = { name: string; location: string };
export type TransferSelection = FileSelection & (
  | { kind: "download"; folder: string }
  | { kind: "upload"; remotePath: string; remoteDirectory: string }
);

function suggestedPath(folder: string, name: string) {
  if (!folder) return "";
  const safeName = !name || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[ .]$/.test(name) ? "다운로드" : name;
  const separator = /[/\\]$/.test(folder) ? "" : folder.includes("\\") ? "\\" : "/";
  return folder + separator + safeName;
}

export function SftpTransferDialog({ id, target, file, onClose, onSaved }: {
  id: string;
  target: string;
  file: TransferSelection;
  onClose: () => void;
  onSaved: (result: TransferResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [destination, setDestination] = useState(() => file.kind === "download" ? suggestedPath(file.folder, file.name) : file.name);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const action = file.kind === "download" ? "다운로드" : "업로드";
  const transfer = useSftpTransfer(id, action);
  const { running } = transfer;
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function chooseFolder() {
    setChoosing(true);
    setError("");
    transfer.clearFeedback();
    try {
      const folder = await invoke<string | null>("choose_local_browse_directory");
      if (folder) setDestination(suggestedPath(folder, file.name));
    } catch (error) { setError(String(error)); }
    finally { setChoosing(false); }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    setError("");
    const outcome = file.kind === "download"
      ? await transfer.run("download_sftp_file", { source: { kind: "token", value: file.location }, destination })
      : await transfer.run("upload_sftp_file", {
        source: file.location, directory: { kind: "token", value: file.remoteDirectory }, filename: destination,
      });
    if (!outcome) return;
    const path = file.kind === "download" ? destination : `${file.remotePath.replace(/\/$/, "")}/${destination}`;
    onSaved({ kind: file.kind, path, bytes: outcome.bytes, sha256: outcome.sha256, auditWarning: outcome.audit_warning });
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby="sftp-transfer-title" onClose={onClose}
    onCancel={event => { if (running || choosing) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sftp-transfer-title">{file.kind === "download" ? "원격 파일 다운로드" : "로컬 파일 업로드"}</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={running || choosing} onClick={onClose}><X size={18} /></button>
    </div>
    <form onSubmit={event => void start(event)}>
      <p className="confirm-copy files-download-source"><strong>{file.name}</strong><br />{target}{file.kind === "upload" && <><br />{file.remotePath}</>}</p>
      {file.kind === "download" ? <label className="field">로컬 저장 경로<span className="file-input">
        <input required value={destination} disabled={running || choosing} onChange={event => setDestination(event.target.value)} placeholder="새 파일의 절대 경로" />
        <button type="button" className="secondary" disabled={running || choosing} onClick={() => void chooseFolder()}>폴더 선택</button>
      </span></label> : <label className="field">원격 파일 이름<input required value={destination} disabled={running}
        onChange={event => setDestination(event.target.value)} /></label>}
      <SftpTransferStatus transfer={transfer} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running ? <button type="button" className="secondary" disabled={!transfer.canCancel} onClick={() => void transfer.cancel()}>{action} 중단</button> : <>
          <button type="button" className="secondary" disabled={choosing} onClick={onClose}>닫기</button>
          <button type="submit" className="primary" disabled={choosing}>{action}</button>
        </>}
      </div>
    </form>
  </dialog>;
}
