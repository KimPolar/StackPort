import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { DirectoryLocation, Entry } from "./fileBrowse";
import { listedItemSnapshot, type SftpListedItem } from "./SftpNameDialog";

type Permissions = Pick<Entry, "mode" | "uid" | "gid">;
export type PermissionSelection = { parent: DirectoryLocation; item: SftpListedItem & Permissions };
type Kind = "mode" | "owner";
const maxOwnerId = 4294967294;

export function SftpPermissionsDialog({ id, target, production, selection, onClose, onRefresh, onSaved }: {
  id: string;
  target: string;
  production: boolean;
  selection: PermissionSelection;
  onClose: () => void;
  onRefresh: () => void;
  onSaved: (name: string, auditWarning: string | null) => void;
}) {
  const { parent, item } = selection;
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const hasMode = item.mode !== null;
  const hasOwner = item.uid !== null && item.gid !== null;
  const originalMode = item.mode?.toString(8).padStart(4, "0") ?? "";
  const [kind, setKind] = useState<Kind>(hasMode ? "mode" : "owner");
  const [mode, setMode] = useState(originalMode);
  const [uid, setUid] = useState(item.uid?.toString() ?? "");
  const [gid, setGid] = useState(item.gid?.toString() ?? "");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parsedMode = Number.parseInt(mode, 8);
  const validMode = hasMode && /^[0-7]{3,4}$/.test(mode) && parsedMode !== item.mode;
  const validOwner = hasOwner && /^\d{1,10}$/.test(uid) && /^\d{1,10}$/.test(gid) &&
    Number(uid) <= maxOwnerId && Number(gid) <= maxOwnerId && (Number(uid) !== item.uid || Number(gid) !== item.gid);
  const canApply = (kind === "mode" ? validMode : validOwner) && (!production || confirmation === "PROD");

  useEffect(() => { dialog.current?.showModal(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canApply || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const input = {
        parent: parent.location,
        source: listedItemSnapshot(item),
        expected: { mode: item.mode, uid: item.uid, gid: item.gid },
        change: kind === "mode" ? { kind, mode: parsedMode } : { kind, uid: Number(uid), gid: Number(gid) },
        confirmation,
      };
      const result = await invoke<{ audit_warning: string | null }>("change_sftp_permissions", { id, input });
      onSaved(item.name, result.audit_warning);
      dialog.current?.close();
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <dialog className="dialog" ref={dialog} aria-labelledby="sftp-permissions-title" onClose={onClose}
    onCancel={event => { if (pending.current) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sftp-permissions-title">원격 권한·소유자 변경</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <p className="confirm-copy files-download-source"><strong>{target}</strong><br />{parent.path}<br /><strong>{item.name}</strong></p>
      <dl className="files-permission-current">
        <div><dt>현재 권한</dt><dd>{originalMode || "미확인"}</dd></div>
        <div><dt>현재 UID / GID</dt><dd>{item.uid ?? "—"} / {item.gid ?? "—"}</dd></div>
      </dl>
      <label className="field">변경할 속성
        <select autoFocus disabled={busy} value={kind} onChange={event => { setKind(event.target.value as Kind); setError(""); }}>
          <option value="mode" disabled={!hasMode}>Unix 권한{!hasMode && " · 서버 값 없음"}</option>
          <option value="owner" disabled={!hasOwner}>소유자·그룹{!hasOwner && " · UID 또는 GID 없음"}</option>
        </select>
      </label>
      {kind === "mode" ? <label className="field">새 Unix 권한
        <input value={mode} aria-label="새 Unix 권한" aria-describedby="sftp-mode-hint" inputMode="numeric" maxLength={4} pattern="[0-7]{3,4}" required disabled={busy}
          onChange={event => setMode(event.target.value)} />
        <span id="sftp-mode-hint" className="form-note">0000~7777 사이의 8진수</span>
      </label> : <>
        <div className="files-permission-current">
          <label className="field">새 UID<input value={uid} inputMode="numeric" maxLength={10} pattern="[0-9]{1,10}" required
            disabled={busy} onChange={event => setUid(event.target.value)} /></label>
          <label className="field">새 GID<input value={gid} inputMode="numeric" maxLength={10} pattern="[0-9]{1,10}" required
            disabled={busy} onChange={event => setGid(event.target.value)} /></label>
        </div>
        <p className="form-note">소유자·그룹 변경 시 서버 정책에 따라 일부 특수 권한 비트가 해제될 수 있습니다.</p>
      </>}
      {production && <label className="field">운영 환경 변경 확인
        <input value={confirmation} autoComplete="off" maxLength={4} placeholder="PROD" disabled={busy}
          onChange={event => setConfirmation(event.target.value)} />
      </label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {error && <button type="button" className="secondary" disabled={busy} onClick={() => { onRefresh(); dialog.current?.close(); }}>목록 새로고침</button>}
        <button type="button" className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>취소</button>
        <button type="submit" className="primary" disabled={busy || !canApply}>{busy ? "변경 중…" : "변경 적용"}</button>
      </div>
    </form>
  </dialog>;
}
