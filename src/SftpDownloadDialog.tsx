import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

export type DownloadResult = { path: string; bytes: string; sha256: string };
export type RemoteDownload = { name: string; location: string };
type Outcome = { status: "saved"; bytes: string; sha256: string } | { status: "cancelled" };
type Progress = { transfer_id: string; received: string; total: string | null; elapsed_ms: number };
const integer = new Intl.NumberFormat("ko-KR");

function suggestedPath(folder: string, name: string) {
  if (!folder) return "";
  const safeName = !name || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[ .]$/.test(name) ? "다운로드" : name;
  const separator = /[/\\]$/.test(folder) ? "" : folder.includes("\\") ? "\\" : "/";
  return folder + separator + safeName;
}

export function SftpDownloadDialog({ id, target, file, folder, onClose, onSaved }: {
  id: string;
  target: string;
  file: RemoteDownload;
  folder: string;
  onClose: () => void;
  onSaved: (result: DownloadResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [destination, setDestination] = useState(() => suggestedPath(folder, file.name));
  const [running, setRunning] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
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
      const outcome = await invoke<Outcome>("download_sftp_file", {
        id, source: { kind: "token", value: file.location }, destination, progress: channel,
      });
      if (outcome.status === "saved") onSaved({ path: destination, bytes: outcome.bytes, sha256: outcome.sha256 });
      else setNotice("다운로드가 중단되었습니다.");
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
      const accepted = await invoke<boolean>("cancel_sftp_download", { id, transferId: progress.transfer_id });
      if (submitting.current) setNotice(accepted ? "다운로드 중단을 요청했습니다." : "파일 저장을 마무리하고 있습니다.");
    } catch (error) {
      if (submitting.current) { setError(String(error)); setStopping(false); }
    }
  }

  const received = Number(progress?.received ?? 0);
  const total = progress?.total == null ? null : Number(progress.total);
  const elapsed = (progress?.elapsed_ms ?? 0) / 1000;
  const speed = elapsed > 0 ? received / elapsed : 0;
  const remaining = total !== null && total > received && speed > 0 ? Math.ceil((total - received) / speed) : null;
  const percentage = total === null ? undefined : total === 0 ? 100 : Math.min(100, received / total * 100);

  return <dialog ref={dialog} className="dialog" aria-labelledby="sftp-download-title" onClose={onClose}
    onCancel={event => { if (running || choosing) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sftp-download-title">원격 파일 다운로드</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={running || choosing} onClick={onClose}><X size={18} /></button>
    </div>
    <form onSubmit={event => void start(event)}>
      <p className="confirm-copy files-download-source"><strong>{file.name}</strong><br />{target}</p>
      <label className="field">로컬 저장 경로<span className="file-input">
        <input required value={destination} disabled={running || choosing} onChange={event => setDestination(event.target.value)} placeholder="새 파일의 절대 경로" />
        <button type="button" className="secondary" disabled={running || choosing} onClick={() => void chooseFolder()}>폴더 선택</button>
      </span></label>
      {running && <div className="files-transfer" role="status">
        <progress aria-label="다운로드 진행률" max={100} value={percentage} />
        <span>{notice || (progress ? `${integer.format(BigInt(progress.received))} B${progress.total !== null ? ` / ${integer.format(BigInt(progress.total))} B` : ""}` : "파일을 준비하는 중…")}</span>
        {!notice && speed > 0 && <span>{integer.format(speed / 1024)} KiB/s{remaining !== null && ` · 약 ${integer.format(remaining)}초 남음`}</span>}
      </div>}
      {!running && notice && <p className="form-note" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running ? <button type="button" className="secondary" disabled={!progress || stopping} onClick={() => void cancel()}>다운로드 중단</button> : <>
          <button type="button" className="secondary" disabled={choosing} onClick={onClose}>닫기</button>
          <button type="submit" className="primary" disabled={choosing}>다운로드</button>
        </>}
      </div>
    </form>
  </dialog>;
}
