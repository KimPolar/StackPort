import { useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

type Saved = { status: "saved"; bytes: string; sha256: string; audit_warning: string | null };
type Outcome = Saved | { status: "cancelled"; cleanup_warning: string | null; audit_warning: string | null };
type Progress = { transfer_id: string; transferred: string; total: string | null; elapsed_ms: number; verifying: boolean };
const integer = new Intl.NumberFormat("ko-KR");

export function useSftpTransfer(id: string, action: string) {
  const submitting = useRef(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function clearFeedback() {
    setNotice("");
    setError("");
  }

  async function run(command: string, args: Record<string, unknown>) {
    if (submitting.current) return;
    submitting.current = true;
    setRunning(true);
    setProgress(null);
    clearFeedback();
    const channel = new Channel<Progress>(setProgress);
    try {
      const outcome = await invoke<Outcome>(command, { ...args, id, progress: channel });
      if (outcome.status === "saved") return outcome;
      setNotice(`${action}가 중단되었습니다.`);
      setError([outcome.cleanup_warning, outcome.audit_warning].filter(Boolean).join(" "));
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

  return { action, running, progress, notice, error, canCancel: !!progress && !stopping, run, cancel, clearFeedback };
}

export function SftpTransferStatus({ transfer }: { transfer: ReturnType<typeof useSftpTransfer> }) {
  const { action, running, progress, notice, error } = transfer;
  const received = Number(progress?.transferred ?? 0);
  const total = progress?.total == null ? null : Number(progress.total);
  const elapsed = (progress?.elapsed_ms ?? 0) / 1000;
  const speed = elapsed > 0 ? received / elapsed : 0;
  const remaining = total !== null && total > received && speed > 0 ? Math.ceil((total - received) / speed) : null;
  const percentage = total === null ? undefined : total === 0 ? 100 : Math.min(100, received / total * 100);

  return <>
    {running && <div className="files-transfer" role="status">
      <progress aria-label={`${action} 진행률`} max={100} value={percentage} />
      <span>{notice || (progress ? `${progress.verifying ? "SHA-256 확인 · " : ""}${integer.format(BigInt(progress.transferred))} B${progress.total !== null ? ` / ${integer.format(BigInt(progress.total))} B` : ""}` : "파일을 준비하는 중…")}</span>
      {!notice && !progress?.verifying && speed > 0 && <span>{integer.format(speed / 1024)} KiB/s{remaining !== null && ` · 약 ${integer.format(remaining)}초 남음`}</span>}
    </div>}
    {!running && notice && <p className="form-note" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </>;
}
