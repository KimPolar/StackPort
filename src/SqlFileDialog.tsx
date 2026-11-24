import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

export type SqlDocument = { text: string; line_ending: "lf" | "crlf"; bom: boolean };
export const emptySqlDocument: SqlDocument = { text: "", line_ending: "lf", bom: false };

export type SqlDraft = {
  profileId: string;
  projectId: string;
  projectName: string;
  profileName: string;
  document: SqlDocument;
  savedText: string;
  savedPath: string;
};

export function isSqlDraftDirty(draft: SqlDraft) {
  return draft.document.text !== draft.savedText;
}

export function SqlFileDialog({ mode, target, document, replacesDraft, onClose, onBusy, onDone }: {
  mode: "open" | "save";
  target: string;
  document: SqlDocument;
  replacesDraft: boolean;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onDone: (document: SqlDocument, path: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = mode === "save";
  const title = save ? "SQL 파일로 저장" : "SQL 파일 열기";

  useEffect(() => { dialog.current?.showModal(); }, []);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    onBusy(true);
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const destination = path.trim();
    if (!destination) return;
    void run(async () => {
      if (save) {
        await invoke("write_sql_document", { destination, document });
        onDone(document, destination);
      } else {
        const loaded = await invoke<SqlDocument>("read_sql_document", { source: destination });
        onDone(loaded, destination);
      }
    });
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby="sql-file-title" onClose={onClose}
    onCancel={event => { if (pending.current) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sql-file-title">{title}</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button>
    </div>
    <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{target}</strong></p>
      <div className="field">
        <label htmlFor="sql-file-path">{save ? "새 SQL 파일 경로" : "SQL 파일 경로"}</label>
        <div className="file-input">
          <input id="sql-file-path" autoFocus required disabled={busy} value={path}
            onChange={event => { setPath(event.target.value); setError(""); }} />
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
            const selected = await invoke<string | null>("choose_sql_document_path", { save });
            if (selected) setPath(selected);
          })}>찾아보기</button>
        </div>
      </div>
      <p className="form-note">{save ? "선택한 경로에 새 UTF-8 .sql 파일을 저장합니다."
        : replacesDraft ? "열면 이 연결의 미저장 SQL 초안이 파일 내용으로 바뀝니다."
          : "선택한 UTF-8 .sql 파일의 내용을 편집기에 표시합니다."}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className="primary" disabled={busy || !path.trim()}>
          {busy ? "처리 중…" : save ? "새 파일에 저장" : replacesDraft ? "열고 초안 교체" : "편집기에서 열기"}
        </button>
      </div>
    </form>
  </dialog>;
}
