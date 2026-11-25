import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { SqlDocument } from "./SqlTabs";
import { fileEncodings, type FileEncoding } from "./structuredFilePreview";

type SqlFileOptions = {
  target: string;
  onClose: () => void;
  onBusy?: (busy: boolean) => void;
} & (
  | { mode: "open" | "save"; document: SqlDocument; onDone: (document: SqlDocument, path: string) => void }
  | { mode: "save_definition"; definition: string; onDone: (path: string) => void }
);

export function SqlFileDialog(options: SqlFileOptions) {
  const { mode, target, onClose, onBusy } = options;
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [encoding, setEncoding] = useState<FileEncoding | "auto">(mode === "save" ? options.document.encoding : "auto");
  const [bom, setBom] = useState(mode === "save" && options.document.bom);
  const id = useId();
  const noteId = id + "-note";
  const errorId = id + "-error";
  const supportsBom = encoding === "utf-8" || encoding === "utf-16le" || encoding === "utf-16be";
  const save = mode !== "open";
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
      if (options.mode === "save_definition") {
        await invoke("write_sql_definition", { destination, definition: options.definition });
        options.onDone(destination);
      } else if (options.mode === "save") {
        const document = {
          ...options.document, encoding: encoding === "auto" ? options.document.encoding : encoding, bom: supportsBom && bom,
        };
        await invoke("write_sql_document", { destination, document });
        options.onDone(document, destination);
      } else {
        const loaded = await invoke<SqlDocument>("read_sql_document", { source: destination, encoding: encoding === "auto" ? null : encoding });
        options.onDone(loaded, destination);
      }
    });
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby={id + "-title"} onClose={onClose}
    onCancel={event => { if (pending.current) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id={id + "-title"}>{title}</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button>
    </div>
    <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{target}</strong></p>
      <div className="field">
        <label htmlFor={id + "-path"}>{save ? "새 SQL 파일 경로" : "SQL 파일 경로"}</label>
        <div className="file-input">
          <input id={id + "-path"} autoFocus required disabled={busy} value={path} aria-describedby={error ? errorId : undefined}
            onChange={event => { setPath(event.target.value); setError(""); }} />
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
            const selected = await invoke<string | null>("choose_sql_document_path", { save });
            if (selected) setPath(selected);
          })}>찾아보기</button>
        </div>
      </div>
      {mode !== "save_definition" && <label className="field">파일 인코딩
        <select value={encoding} disabled={busy} aria-describedby={[noteId, error && errorId].filter(Boolean).join(" ")}
          onChange={event => {
            const next = event.target.value as FileEncoding | "auto";
            setEncoding(next);
            setBom(mode === "save" && (next === options.document.encoding ? options.document.bom : next.startsWith("utf-16")));
            setError("");
          }}>
          {mode === "open" && <option value="auto">자동 (BOM 또는 UTF-8)</option>}
          {Object.entries(fileEncodings).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>}
      {mode === "save" && supportsBom && <label className="files-check">
        <input type="checkbox" checked={bom} disabled={busy} onChange={event => { setBom(event.target.checked); setError(""); }} /> BOM 포함
      </label>}
      <p id={noteId} className="form-note">{mode === "open" ? "BOM이 없는 UTF-16이나 기존 인코딩의 파일은 형식을 직접 선택하세요."
        : mode === "save" ? "새 파일에 저장하며 현재 줄바꿈 형식을 유지합니다." : "선택한 경로에 새 UTF-8 .sql 파일을 저장합니다."}</p>
      {error && <p id={errorId} className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className="primary" disabled={busy || !path.trim()}>
          {busy ? "처리 중…" : save ? "새 파일에 저장" : "새 탭에서 열기"}
        </button>
      </div>
    </form>
  </dialog>;
}
