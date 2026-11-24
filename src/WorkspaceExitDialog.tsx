import { useEffect, useRef } from "react";
import { FileDown, X } from "lucide-react";
import { sqlTabTitle, type SqlDraft } from "./SqlTabs";

export function WorkspaceExitDialog({ drafts, terminals, rdpClients, busy, error, onSave, onClose, onExit }: {
  drafts: SqlDraft[];
  terminals: number;
  rdpClients: number;
  busy: boolean;
  error: string;
  onSave: (draft: SqlDraft) => void;
  onClose: () => void;
  onExit: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="dialog workspace-exit" aria-labelledby="workspace-exit-title" onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="workspace-exit-title">앱 종료</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button>
    </div>
    <div className="workspace-exit-body" aria-busy={busy}>
      <p className="confirm-copy" role="status">{drafts.length ? `저장하지 않은 SQL 초안 ${drafts.length}개` : "SQL 초안 저장 완료"}</p>
      {drafts.length > 0 && <ul aria-label="미저장 SQL 초안" className="workspace-exit-drafts">
        {drafts.map(draft => <li key={draft.id}>
          <div><strong>{sqlTabTitle(draft)}</strong><span>{draft.projectName} · {draft.profileName}</span></div>
          <button type="button" className="secondary small" disabled={busy} aria-label={`${draft.projectName} · ${draft.profileName} · ${sqlTabTitle(draft)} SQL 파일로 저장`}
            onClick={() => onSave(draft)}><FileDown size={14} aria-hidden /> 저장</button>
        </li>)}
      </ul>}
      {terminals > 0 && <p className="form-note">열린 터미널 {terminals}개와 연결된 작업이 종료됩니다.</p>}
      {rdpClients > 0 && <p className="form-note">열린 RDP 클라이언트 {rdpClients}개가 종료됩니다.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" autoFocus className="secondary" disabled={busy} onClick={onClose}>계속 작업</button>
        <button type="button" className={drafts.length ? "danger" : "primary"} disabled={busy} onClick={onExit}>
          {busy ? "종료 중…" : drafts.length ? "남은 초안 버리고 종료" : "앱 종료"}
        </button>
      </div>
    </div>
  </dialog>;
}
