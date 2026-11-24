import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

export type TransferResult = { kind: TransferSelection["kind"]; path: string; bytes: string; sha256: string };
export type FileSelection = { name: string; location: string };
export type TransferSelection = FileSelection & (
  | { kind: "download"; folder: string }
  | { kind: "upload"; remotePath: string; remoteDirectory: string }
);
type Outcome = { status: "saved"; bytes: string; sha256: string } | { status: "cancelled"; cleanup_warning: string | null };
type Progress = { transfer_id: string; transferred: string; total: string | null; elapsed_ms: number; verifying: boolean };
const integer = new Intl.NumberFormat("ko-KR");

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
  const submitting = useRef(false);
  const [destination, setDestination] = useState(() => file.kind === "download" ? suggestedPath(file.folder, file.name) : file.name);
  const [running, setRunning] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const action = file.kind === "download" ? "다운로드" : "업로드";
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function chooseFolder() {
    setChoosing(true);
    setError("");
    try {
      const folder = await invoke<string | null>("choose_local_browse_directory");
      if (folder) setDestination(suggestedPath(folder, file.name));
    } catch (error) { setError(String(error)); }
    finally { setChoosing(false); }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setRunning(true);
    setProgress(null);
    setNotice("");
    setError("");
    const channel = new Channel<Progress>(setProgress);
    try {
      const outcome = file.kind === "download"
        ? await invoke<Outcome>("download_sftp_file", { id, source: { kind: "token", value: file.location }, destination, progress: channel })
        : await invoke<Outcome>("upload_sftp_file", {
          id, source: file.location, directory: { kind: "token", value: file.remoteDirectory }, filename: destination, progress: channel,
        });
      if (outcome.status === "saved") {
        const path = file.kind === "download" ? destination : `${file.remotePath.replace(/\/$/, "")}/${destination}`;
        onSaved({ kind: file.kind, path, bytes: outcome.bytes, sha256: outcome.sha256 });
      } else {
        setNotice(`${action}가 중단되었습니다.`);
        if (outcome.cleanup_warning) setError(outcome.cleanup_warning);
      }
    } catch (error) { setError(String(error)); }
    finally {
      channel.onmessage = () => {};
      submitting.current = false;
      setRunning(false);
      setStopping(false);
    }
  }

  async function cancel() {
    if (!progress || stopping) return;
    setStopping(true);
    setError("");
    try {
      const accepted = await invoke<boolean>("cancel_sftp_transfer", { id, transferId: progress.transfer_id });
      if (submitting.current) setNotice(accepted ? `${action} 중단을 요청했습니다.` : "파일 저장을 마무리하고 있습니다.");
    } catch (error) {
      if (submitting.current) { setError(String(error)); setStopping(false); }
    }
  }

  const received = Number(progress?.transferred ?? 0);
  const total = progress?.total == null ? null : Number(progress.total);
  const elapsed = (progress?.elapsed_ms ?? 0) / 1000;
  const speed = elapsed > 0 ? received / elapsed : 0;
  const remaining = total !== null && total > received && speed > 0 ? Math.ceil((total - received) / speed) : null;
  const percentage = total === null ? undefined : total === 0 ? 100 : Math.min(100, received / total * 100);

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
      {running && <div className="files-transfer" role="status">
        <progress aria-label={`${action} 진행률`} max={100} value={percentage} />
        <span>{notice || (progress ? `${progress.verifying ? "SHA-256 확인 · " : ""}${integer.format(BigInt(progress.transferred))} B${progress.total !== null ? ` / ${integer.format(BigInt(progress.total))} B` : ""}` : "파일을 준비하는 중…")}</span>
        {!notice && !progress?.verifying && speed > 0 && <span>{integer.format(speed / 1024)} KiB/s{remaining !== null && ` · 약 ${integer.format(remaining)}초 남음`}</span>}
      </div>}
      {!running && notice && <p className="form-note" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running ? <button type="button" className="secondary" disabled={!progress || stopping} onClick={() => void cancel()}>{action} 중단</button> : <>
          <button type="button" className="secondary" disabled={choosing} onClick={onClose}>닫기</button>
          <button type="submit" className="primary" disabled={choosing}>{action}</button>
        </>}
      </div>
    </form>
  </dialog>;
}
