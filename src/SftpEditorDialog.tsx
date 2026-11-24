import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
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

type CloseScope = "editor" | "window";

export function SftpEditorDialog({ id, target, selection, onClose, onSaved, onDraftSaved, onExitGuard, onRequestExit }: {
  id: string;
  target: string;
  selection: SftpEditorSelection;
  onClose: () => void;
  onSaved: (result: TransferResult) => void;
  onDraftSaved: (path: string) => void;
  onExitGuard: (guard: (() => void) | null) => void;
  onRequestExit: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<Awaited<SftpEditorSelection["result"]> | null>(null);
  const [text, setText] = useState("");
  const [saveAs, setSaveAs] = useState(false);
  const [name, setName] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [closeScope, setCloseScope] = useState<CloseScope | null>(null);
  const [exitDuringSave, setExitDuringSave] = useState(false);
  const [draftMode, setDraftMode] = useState<"keep" | CloseScope | null>(null);
  const [draftPath, setDraftPath] = useState("");
  const [savedDraftPath, setSavedDraftPath] = useState("");
  const [draftError, setDraftError] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [exitDuringDraft, setExitDuringDraft] = useState(false);
  const draftPending = useRef(false);
  const transfer = useSftpTransfer(id, "저장");
  const doc = result && "document" in result ? result.document : null;
  const copy = saveAs || !doc?.replace_supported;
  const dirty = !!doc && text !== doc.text;
  const editingLocked = transfer.running || closeScope !== null || draftMode !== null;
  const bytes = utf8.encode(text).length + (doc?.bom ? 3 : 0) +
    (doc?.line_ending === "crlf" ? (text.match(/\n/g)?.length ?? 0) : 0);
  const oversized = !!doc && bytes > doc.max_bytes;
  const canSave = doc && !oversized && (copy ? name.length > 0 && name !== selection.name
    : dirty && (!doc.production || confirmation === "PROD"));

  useEffect(() => { dialog.current?.showModal(); }, []);
  useLayoutEffect(() => {
    if (!dirty && !transfer.running && !draftBusy) return;
    onExitGuard(() => {
      if (transfer.running) setExitDuringSave(true);
      else if (draftPending.current) setExitDuringDraft(true);
      else {
        setDraftMode(null);
        setCloseScope("window");
      }
    });
    return () => onExitGuard(null);
  }, [dirty, transfer.running, draftBusy, onExitGuard]);
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
    if (transfer.running || draftPending.current) return;
    if (draftMode) {
      setDraftMode(null);
      return;
    }
    if (closeScope) {
      setCloseScope(null);
      return;
    }
    if (dirty) setCloseScope("editor");
    else dialog.current?.close();
  }

  function finishClose(scope: CloseScope) {
    onExitGuard(null);
    dialog.current?.close();
    if (scope === "window") onRequestExit();
  }

  async function saveRemote() {
    if (!doc || !canSave || editingLocked) return;
    setExitDuringSave(false);
    const report = await transfer.run("save_sftp_editor", {
      input: { token: doc.token, text, copy_name: copy ? name : null, confirmation },
    });
    if (!report) return;
    const path = copy ? `${selection.parentPath.replace(/\/$/, "")}/${name}` : doc.path;
    onSaved({ kind: "edit", path, bytes: report.bytes, sha256: report.sha256, auditWarning: report.audit_warning });
    dialog.current?.close();
  }

  function openDraft(mode: "keep" | CloseScope) {
    setDraftPath("");
    setDraftError("");
    setDraftMode(mode);
  }

  async function chooseDraftPath() {
    if (draftPending.current) return;
    draftPending.current = true;
    setDraftBusy(true);
    setExitDuringDraft(false);
    setDraftError("");
    try {
      const path = await invoke<string | null>("choose_local_text_draft_path");
      if (path) setDraftPath(path);
    } catch (error) {
      setDraftError(String(error));
    } finally {
      draftPending.current = false;
      setDraftBusy(false);
    }
  }

  async function saveDraft() {
    const destination = draftPath.trim();
    if (!doc || !dirty || !draftMode || !destination || draftPending.current) return;
    draftPending.current = true;
    setDraftBusy(true);
    setExitDuringDraft(false);
    setDraftError("");
    try {
      await invoke("save_local_text_draft", { destination, text, lineEnding: doc.line_ending, bom: doc.bom });
      if (draftMode === "keep") {
        setSavedDraftPath(destination);
        setDraftMode(null);
      } else {
        onDraftSaved(destination);
        finishClose(draftMode);
      }
    } catch (error) {
      setDraftError(String(error));
    } finally {
      draftPending.current = false;
      setDraftBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draftMode) void saveDraft();
    else void saveRemote();
  }

  return <dialog ref={dialog} className="dialog sftp-editor" aria-labelledby="sftp-editor-title" onClose={onClose}
    onCancel={event => {
      event.preventDefault();
      requestClose();
    }}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (canSave && !editingLocked) form.current?.requestSubmit();
      }
    }}>
    <div className="dialog-heading">
      <h2 id="sftp-editor-title">원격 텍스트 편집</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={transfer.running || draftBusy} onClick={requestClose}><X size={18} /></button>
    </div>
    <form ref={form} onSubmit={submit} aria-busy={transfer.running || draftBusy}>
      <p className="confirm-copy files-download-source"><strong>{target}</strong><br />{doc?.path ?? selection.name}</p>
      {!result && <p className="form-note" role="status">원격 파일을 읽는 중…</p>}
      {result && "error" in result && <p role="alert" className="form-error">{result.error}</p>}
      {doc && <>
        <label className="field">파일 내용<textarea className="sftp-editor-text" value={text} spellCheck={false} readOnly={editingLocked}
          onChange={event => setText(event.target.value)} /></label>
        <p className="form-note">UTF-8{doc.bom && " BOM"} · {doc.line_ending.toUpperCase()} · {numbers.format(bytes)} B</p>
        {!draftMode && <>
          {oversized && <p role="alert" className="form-error">파일이 512 KiB를 초과했습니다.</p>}
          {doc.replace_supported ? <label className="field">저장 위치
            <select value={copy ? "copy" : "original"} disabled={editingLocked}
              onChange={event => setSaveAs(event.target.value === "copy")}>
              <option value="original">원래 경로</option>
              <option value="copy">같은 폴더의 새 파일</option>
            </select>
          </label> : <p className="form-note">이 파일의 편집 내용은 같은 폴더에 새 이름으로 저장할 수 있습니다.</p>}
          {copy ? <label className="field">새 파일 이름<input required maxLength={255} value={name} disabled={editingLocked}
            onChange={event => setName(event.target.value)} /></label>
            : doc.production && <label className="field">운영 환경 저장 확인<input required maxLength={4} placeholder="PROD" autoComplete="off"
              value={confirmation} disabled={editingLocked} onChange={event => setConfirmation(event.target.value)} /></label>}
        </>}
      </>}
      {!draftMode && <SftpTransferStatus transfer={transfer} />}
      {exitDuringSave && transfer.running && <p className="form-note" role="status">원격 파일 저장을 끝내거나 중단한 뒤 앱을 닫을 수 있습니다.</p>}
      {exitDuringDraft && draftBusy && <p className="form-note" role="status">로컬 초안 작업을 마친 뒤 앱을 닫을 수 있습니다.</p>}
      {savedDraftPath && !draftMode && !closeScope && <p className="form-note" role="status">로컬 초안 저장 완료 · {savedDraftPath}</p>}
      {draftMode && <div className="field">
        <label htmlFor="sftp-draft-path">새 로컬 초안 파일 경로</label>
        <div className="file-input">
          <input id="sftp-draft-path" autoFocus required value={draftPath} disabled={draftBusy}
            onChange={event => { setDraftPath(event.target.value); setDraftError(""); }} />
          <button type="button" className="secondary" disabled={draftBusy} onClick={() => void chooseDraftPath()}>파일 선택</button>
        </div>
        <p className="form-note">변경 내용을 새 .txt 파일에 저장합니다.</p>
        {draftError && <p className="form-error" role="alert">{draftError}</p>}
      </div>}
      {closeScope && !draftMode && <p className="form-note" role="status">{closeScope === "window"
        ? "원격 파일에 저장하지 않은 변경이 있습니다. 앱을 닫기 전에 처리 방법을 선택하세요."
        : "원격 파일에 저장하지 않은 변경이 있습니다. 편집기를 닫기 전에 처리 방법을 선택하세요."}</p>}
      <div className="dialog-actions">
        {transfer.running ? <button type="button" className="secondary" disabled={!transfer.canCancel}
          onClick={() => void transfer.cancel()}>저장 중단</button> : draftMode ? <>
          <button type="button" className="secondary" disabled={draftBusy} onClick={() => setDraftMode(null)}>뒤로</button>
          <button type="submit" className="primary" disabled={draftBusy || !draftPath.trim()}>
            {draftMode === "window" ? "초안 저장 후 앱 종료" : draftMode === "editor" ? "초안 저장 후 닫기" : "초안 저장"}
          </button>
        </> : closeScope ? <>
          <button type="button" className="secondary" onClick={() => setCloseScope(null)}>계속 편집</button>
          <button type="button" className="secondary" onClick={() => openDraft(closeScope)}>로컬에 초안 저장</button>
          <button type="button" className="danger" onClick={() => finishClose(closeScope)}>{closeScope === "window" ? "변경 버리고 앱 종료" : "변경 버리기"}</button>
        </> : <>
          <button type="button" className="secondary" onClick={requestClose}>닫기</button>
          {dirty && <button type="button" className="secondary" onClick={() => openDraft("keep")}>로컬에 초안 저장</button>}
          {doc && <button type="submit" className="primary" disabled={!canSave}>{copy ? "새 이름으로 저장" : "저장"}</button>}
        </>}
      </div>
    </form>
  </dialog>;
}
