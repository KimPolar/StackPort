import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

type DocumentFormat = "markdown" | "html";
type DocumentScope = "all" | "selected";
type DocumentReport = { objects: number; size_bytes: number; audit_warning: string | null };
const number = new Intl.NumberFormat("ko-KR");

export function SchemaDocumentDialog({ profile, object, onClose, onBusy }: {
  profile: { id: string; name: string; environment: string };
  object: string | null;
  onClose: () => void;
  onBusy: (value: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [scope, setScope] = useState<DocumentScope>(object === null ? "all" : "selected");
  const [format, setFormat] = useState<DocumentFormat>("markdown");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<DocumentReport | null>(null);
  const fileLabel = format === "markdown" ? "Markdown" : "HTML";
  useEffect(() => { dialog.current?.showModal(); }, []);

  function clearResult() {
    setReport(null);
    setError("");
  }

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    onBusy(true);
    setBusy(true);
    clearResult();
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby="sqlite-schema-document-title" onClose={onClose}
    onCancel={event => { if (pending.current) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sqlite-schema-document-title">SQLite 데이터 사전</h2>
      <button className="icon-button" type="button" aria-label="데이터 사전 닫기" disabled={busy} onClick={() => dialog.current?.close()}>
        <X size={17} aria-hidden />
      </button>
    </div>
    <form aria-busy={busy} onSubmit={event => {
      event.preventDefault();
      if (destination.trim()) void run(async () => setReport(await invoke<DocumentReport>("export_sqlite_schema_document", {
        profileId: profile.id, object: scope === "selected" ? object : null, format, destination: destination.trim(),
      })));
    }}>
      <p className="confirm-copy"><strong>{profile.name}</strong> · {profile.environment}</p>
      <label className="field">문서 범위
        <select value={scope} disabled={busy || object === null} onChange={event => { setScope(event.target.value as DocumentScope); clearResult(); }}>
          <option value="all">전체 테이블과 뷰</option>
          {object !== null && <option value="selected">선택한 객체 · {object || "(빈 이름)"}</option>}
        </select>
      </label>
      <label className="field">파일 형식
        <select value={format} disabled={busy} onChange={event => {
          const next = event.target.value as DocumentFormat;
          setFormat(next);
          const suffix = next === "markdown" ? ".md" : ".html";
          setDestination(value => value.replace(/\.(md|html)$/i, suffix));
          clearResult();
        }}>
          <option value="markdown">Markdown (.md)</option>
          <option value="html">HTML (.html)</option>
        </select>
      </label>
      <div className="field">
        <label htmlFor="schema-document-path">새 {fileLabel} 파일 경로</label>
        <div className="file-input">
          <input id="schema-document-path" required value={destination} disabled={busy}
            placeholder="새 파일의 절대 경로" onChange={event => { setDestination(event.target.value); clearResult(); }} />
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
            const target = await invoke<string | null>("choose_sqlite_schema_document_path", { format });
            if (target !== null) setDestination(target);
          })}>찾아보기</button>
        </div>
      </div>
      <p className="form-note">열과 키, 인덱스, 트리거와 생성 SQL이 포함됩니다.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {report && <div className="success-banner" role="status">
        <strong>데이터 사전을 저장했습니다.</strong>
        <span>객체 {number.format(report.objects)}개 · {number.format(report.size_bytes)} bytes</span>
        <span>{destination.trim()}</span>
        {report.audit_warning && <span className="audit-warning">{report.audit_warning}</span>}
      </div>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>닫기</button>
        <button type="submit" className="primary" disabled={busy || !destination.trim()}>{busy ? "처리 중…" : "새 파일에 저장"}</button>
      </div>
    </form>
  </dialog>;
}
