import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

export type SftpDeletePreview = {
  token: string;
  path: string;
  directory: boolean;
  bytes: string | null;
  production: boolean;
  expires_seconds: number;
};
export type SftpDeleteSelection = { name: string; result: Promise<{ preview: SftpDeletePreview } | { error: string }> };
const numbers = new Intl.NumberFormat("ko-KR");

export function SftpDeleteDialog({ id, target, selection, onClose, onDeleted }: {
  id: string;
  target: string;
  selection: SftpDeleteSelection;
  onClose: () => void;
  onDeleted: (path: string, auditWarning: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [result, setResult] = useState<Awaited<SftpDeleteSelection["result"]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const preview = result && "preview" in result ? result.preview : null;
  const canDelete = preview && !attempted && (!preview.production || confirmation === "PROD");

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let mounted = true;
    void selection.result.then(value => { if (mounted) setResult(value); });
    return () => { mounted = false; };
  }, [selection.result]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview || !canDelete || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setAttempted(true);
    try {
      const report = await invoke<{ audit_warning: string | null }>("delete_sftp_entry", { id, token: preview.token, confirmation });
      onDeleted(preview.path, report.audit_warning);
      dialog.current?.close();
    } catch (error) {
      setError(String(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <dialog className="dialog" ref={dialog} role="alertdialog" aria-labelledby="sftp-delete-title"
    aria-describedby="sftp-delete-impact" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sftp-delete-title">원격 항목 삭제</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} /></button>
    </div>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <p className="confirm-copy files-download-source"><strong>{target}</strong><br />{preview?.path ?? selection.name}</p>
      <p id="sftp-delete-impact" className="form-note">
        {preview ? `${preview.directory ? "빈 폴더" : "파일"} 1개를 영구 삭제합니다.` : "선택한 원격 항목 1개의 삭제 범위를 확인합니다."}
        {preview?.bytes != null && ` 크기 ${numbers.format(BigInt(preview.bytes))} B.`}
      </p>
      {preview?.production && <label className="field">운영 환경 삭제 확인
        <input required value={confirmation} disabled={busy || attempted} maxLength={4} placeholder="PROD"
          autoComplete="off" onChange={event => setConfirmation(event.target.value)} />
      </label>}
      {preview && <p className="form-note">이 확인은 {preview.expires_seconds / 60}분 동안 유효합니다.</p>}
      {!result && <p className="form-note" role="status">서버에서 항목을 확인하는 중…</p>}
      {(error || (result && "error" in result && result.error)) &&
        <p className="form-error" role="alert">{error || (result && "error" in result && result.error)}</p>}
      <div className="dialog-actions">
        <button type="button" autoFocus className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>취소</button>
        <button type="submit" className="danger" disabled={busy || !canDelete}>{busy ? "삭제 중…" : "영구 삭제"}</button>
      </div>
    </form>
  </dialog>;
}
