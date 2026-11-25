import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import { MongoDocumentStructure, type MongoDraftChange, type MongoDraftStructure } from "./MongoDocumentStructure";

export type MongoDocumentChange = { kind: "insert" } | { kind: "replace" | "duplicate" | "delete"; document_id: string };
type Draft = { token: string; draft: string | null };
type Review = { token: string; before: string | null; after: string | null; expires_seconds: number };
type EditorMode = "json" | "tree" | "grid";
export type MongoEditReport = { affected_count: number; audit_warning: boolean };

const titles: Record<MongoDocumentChange["kind"], string> = {
  insert: "MongoDB 문서 삽입", replace: "MongoDB 문서 수정", duplicate: "MongoDB 문서 복제", delete: "MongoDB 문서 삭제",
};
const editorModes: { mode: EditorMode; name: string }[] = [
  { mode: "json", name: "JSON" }, { mode: "tree", name: "트리" }, { mode: "grid", name: "그리드" },
];

export function MongoDocumentEditDialog({ id, database, collection, environment, change, onBusy, onClose, onApplied }: {
  id: string; database: string; collection: string; environment: string; change: MongoDocumentChange;
  onBusy: (busy: boolean) => void; onClose: () => void; onApplied: (report: MongoEditReport) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("json");
  const [structure, setStructure] = useState<MongoDraftStructure | null>(null);
  const [fieldEditing, setFieldEditing] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [approval, setApproval] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const deleting = change.kind === "delete";
  const production = environment === "PROD";
  const missingApproval = !!review && ((deleting && approval !== "DELETE") || (production && confirmation !== "PROD"));

  useEffect(() => {
    let live = true;
    let token: string | undefined;
    function discard(token: string) {
      void invoke("discard_mongo_document_edit", { id, token }).catch(() => {});
    }
    void invoke<Draft>("begin_mongo_document_edit", { id, database, collection, change }).then(value => {
      token = value.token;
      if (!live) { discard(value.token); return; }
      setDraft(value);
      setText(value.draft ?? "");
      setLoading(false);
    }, reason => {
      if (live) { setError(String(reason)); setLoading(false); }
    });
    return () => {
      live = false;
      if (token) discard(token);
    };
  }, [id, database, collection, change]);

  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);

  function backToDraft() {
    if (review) void invoke("discard_mongo_document_edit", { id, token: review.token }).catch(() => {});
    setReview(null);
    setApproval("");
    setConfirmation("");
  }

  async function updateStructure(operation: MongoDraftChange | null) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await invoke<MongoDraftStructure>("edit_mongo_document_draft", { input: text, change: operation, keepId: change.kind === "replace" });
      if (operation) setText(result.text);
      setStructure(result);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function selectEditor(mode: EditorMode) {
    if (mode === editorMode || fieldEditing || pending.current) return;
    if (mode !== "json" && (editorMode === "json" || !structure) && !await updateStructure(null)) return;
    setError("");
    setEditorMode(mode);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending.current || missingApproval || fieldEditing) return;
    pending.current = true; setBusy(true); setError("");
    if (review) onBusy(true);
    try {
      if (review) {
        const report = await invoke<MongoEditReport>("apply_mongo_document_edit", { id, token: review.token, approval, confirmation });
        onApplied(report);
      } else {
        const next = await invoke<Review>("review_mongo_document_edit", { id, token: draft.token, input: text });
        setReview(next);
      }
    } catch (reason) {
      if (review) backToDraft();
      setError(String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
      if (review) onBusy(false);
    }
  }

  return <Dialog title={titles[change.kind]} onClose={onClose} busy={busy} className="mongo-edit-dialog">
    <form onSubmit={event => void submit(event)} aria-busy={busy || loading}>
      <p className="confirm-copy"><strong>{database}.{collection}</strong> · {environment}</p>
      {loading && <p className="form-note" role="status">편집할 문서를 읽는 중…</p>}
      {draft && (review ? <>
        <h3 ref={reviewHeading} tabIndex={-1} className="mongo-edit-review-heading">문서 변경 검토</h3>
        <div className="mongo-edit-compare">
          {review.before && <section aria-label="변경 전 문서"><strong>{change.kind === "duplicate" ? "복제 원본" : "변경 전"}</strong>
            <pre tabIndex={0}><code>{review.before}</code></pre></section>}
          {review.after && <section aria-label="변경 후 문서"><strong>변경 후</strong>
            <pre tabIndex={0}><code>{review.after}</code></pre></section>}
        </div>
        <p className="form-note">검토한 변경은 {Math.floor(review.expires_seconds / 60)}분 이내에 한 번 적용할 수 있습니다.</p>
        {deleting && <label className="field">삭제 확인<input autoComplete="off" placeholder="DELETE" value={approval} disabled={busy}
          onChange={event => setApproval(event.target.value)} /></label>}
        {production && <label className="field">운영 환경 확인<input autoComplete="off" placeholder="PROD" value={confirmation} disabled={busy}
          onChange={event => setConfirmation(event.target.value)} /></label>}
      </> : deleting ? <p className="form-note">삭제할 문서의 전체 내용을 확인하세요.</p> : <>
        <div className="mongo-structure-controls" role="group" aria-label="문서 편집 보기">
          {editorModes.map(({ mode, name }) => <button key={mode} type="button" className="secondary small" aria-pressed={editorMode === mode}
            disabled={busy || fieldEditing} onClick={() => void selectEditor(mode)}>{name}</button>)}
        </div>
        {editorMode === "json" ? <div className="field">
          <label htmlFor={inputId}>문서 Extended JSON</label>
          <textarea id={inputId} className="mongo-edit-input" rows={13} spellCheck={false} maxLength={65536}
            value={text} disabled={busy} onChange={event => setText(event.target.value)} />
        </div> : structure && <MongoDocumentStructure mode={editorMode} root={structure.root} keepId={change.kind === "replace"}
          busy={busy} onChange={updateStructure} onEditing={setFieldEditing} />}
        <p className="form-note">{change.kind === "replace" ? "기존 문서의 _id를 유지하세요." : "_id를 생략하면 새 ObjectId를 생성합니다."}</p>
      </>)}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {review && <button type="button" className="secondary" disabled={busy} onClick={() => { backToDraft(); setError(""); }}>편집으로 돌아가기</button>}
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        {draft && <button type="submit" className={deleting && review ? "danger" : "primary"}
          disabled={busy || fieldEditing || missingApproval || (!deleting && !text.trim())}>{review ? "검토한 변경 적용" : "변경 검토"}</button>}
      </div>
    </form>
  </Dialog>;
}
