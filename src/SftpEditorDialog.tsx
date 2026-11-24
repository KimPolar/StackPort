import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { SftpTransferStatus, useSftpTransfer } from "./SftpTransferStatus";
import type { TransferResult } from "./SftpTransferDialog";

export type SftpEditDocument = {
  token: string;
  path: string;
  text: string;
  line_ending: "lf" | "crlf";
  bom: boolean;
  replace_supported: boolean;
  production: boolean;
  max_bytes: number;
};
export type SftpEditorSelection = {
  name: string;
  parentPath: string;
  result: Promise<{ document: SftpEditDocument } | { error: string }>;
};
const numbers = new Intl.NumberFormat("ko-KR");
const utf8 = new TextEncoder();

export function SftpEditorDialog({ id, target, selection, onClose, onSaved }: {
  id: string;
  target: string;
  selection: SftpEditorSelection;
  onClose: () => void;
  onSaved: (result: TransferResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<Awaited<SftpEditorSelection["result"]> | null>(null);
  const [text, setText] = useState("");
  const [saveAs, setSaveAs] = useState(false);
  const [name, setName] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const transfer = useSftpTransfer(id, "저장");
  const doc = result && "document" in result ? result.document : null;
  const copy = saveAs || !doc?.replace_supported;
  const dirty = doc && text !== doc.text;
  const bytes = utf8.encode(text).length + (doc?.bom ? 3 : 0) +
    (doc?.line_ending === "crlf" ? (text.match(/\n/g)?.length ?? 0) : 0);
  const oversized = !!doc && bytes > doc.max_bytes;
  const canSave = doc && !oversized && (copy ? name.length > 0 && name !== selection.name
    : dirty && (!doc.production || confirmation === "PROD"));

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let mounted = true;
    void selection.result.then(value => {
      if (!mounted) return;
      if ("document" in value) setText(value.document.text);
      setResult(value);
    });
    return () => { mounted = false; };
  }, [selection.result]);

  function requestClose() {
    if (transfer.running) return;
    if (dirty) setDiscarding(true);
    else dialog.current?.close();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!doc || !canSave || discarding) return;
    const report = await transfer.run("save_sftp_editor", {
      input: { token: doc.token, text, copy_name: copy ? name : null, confirmation },
    });
    if (!report) return;
    const path = copy ? `${selection.parentPath.replace(/\/$/, "")}/${name}` : doc.path;
    onSaved({ kind: "edit", path, bytes: report.bytes, sha256: report.sha256, auditWarning: report.audit_warning });
    dialog.current?.close();
  }

  return <dialog ref={dialog} className="dialog sftp-editor" aria-labelledby="sftp-editor-title" onClose={onClose}
    onCancel={event => { event.preventDefault(); requestClose(); }}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!transfer.running && canSave && !discarding) form.current?.requestSubmit();
      }
    }}>
    <div className="dialog-heading">
      <h2 id="sftp-editor-title">원격 텍스트 편집</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={transfer.running} onClick={requestClose}><X size={18} /></button>
    </div>
    <form ref={form} onSubmit={event => void save(event)} aria-busy={transfer.running}>
      <p className="confirm-copy files-download-source"><strong>{target}</strong><br />{doc?.path ?? selection.name}</p>
      {!result && <p className="form-note" role="status">원격 파일을 읽는 중…</p>}
      {result && "error" in result && <p role="alert" className="form-error">{result.error}</p>}
      {doc && <>
        <label className="field">파일 내용<textarea className="sftp-editor-text" value={text} spellCheck={false} readOnly={transfer.running || discarding}
          onChange={event => setText(event.target.value)} /></label>
        <p className="form-note">UTF-8{doc.bom && " BOM"} · {doc.line_ending.toUpperCase()} · {numbers.format(bytes)} B</p>
        {oversized && <p role="alert" className="form-error">파일이 512 KiB를 초과했습니다.</p>}
        {doc.replace_supported ? <label className="field">저장 위치
          <select value={copy ? "copy" : "original"} disabled={transfer.running || discarding}
            onChange={event => setSaveAs(event.target.value === "copy")}>
            <option value="original">원래 경로</option>
            <option value="copy">같은 폴더의 새 파일</option>
          </select>
        </label> : <p className="form-note">이 파일의 편집 내용은 같은 폴더에 새 이름으로 저장할 수 있습니다.</p>}
        {copy ? <label className="field">새 파일 이름<input required maxLength={255} value={name} disabled={transfer.running || discarding}
          onChange={event => setName(event.target.value)} /></label>
          : doc.production && <label className="field">운영 환경 저장 확인<input required maxLength={4} placeholder="PROD" autoComplete="off"
            value={confirmation} disabled={transfer.running || discarding} onChange={event => setConfirmation(event.target.value)} /></label>}
      </>}
      <SftpTransferStatus transfer={transfer} />
      {discarding && <p className="form-note" role="status">저장하지 않은 변경을 버리고 닫으시겠습니까?</p>}
      <div className="dialog-actions">
        {transfer.running ? <button type="button" className="secondary" disabled={!transfer.canCancel}
          onClick={() => void transfer.cancel()}>저장 중단</button> : discarding ? <>
          <button type="button" className="secondary" onClick={() => setDiscarding(false)}>계속 편집</button>
          <button type="button" className="danger" onClick={() => dialog.current?.close()}>변경 버리기</button>
        </> : <>
          <button type="button" className="secondary" onClick={requestClose}>닫기</button>
          {doc && <button type="submit" className="primary" disabled={!canSave}>{copy ? "새 이름으로 저장" : "저장"}</button>}
        </>}
      </div>
    </form>
  </dialog>;
}
