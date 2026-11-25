import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { SqlDocument } from "./SqlTabs";

export function SqlFileDialog({ mode, target, document, onClose, onBusy, onDone }: {
  mode: "open" | "save";
  target: string;
  document: SqlDocument;
  onClose: () => void;
  onBusy?: (busy: boolean) => void;
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
    onBusy?.(true);
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
      onBusy?.(false);
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
        : "선택한 UTF-8 .sql 파일을 새 탭에서 엽니다."}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className="primary" disabled={busy || !path.trim()}>
          {busy ? "처리 중…" : save ? "새 파일에 저장" : "새 탭에서 열기"}
        </button>
      </div>
    </form>
  </dialog>;
}
