import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

type Preview = { source: string; destination: string; include_trust: boolean };
type Report = { directory: string; files: { name: string; bytes: number; sha256: string }[]; audit_warning: string | null };

export function WorkspaceCopyDialog({ displayPath, onClose }: {
  displayPath: (path: string) => string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const review = useRef<HTMLDListElement>(null);
  const [destination, setDestination] = useState("");
  const [includeTrust, setIncludeTrust] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (preview) review.current?.focus(); }, [preview]);

  async function inspect() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      setPreview(await invoke<Preview>("preview_workspace_copy", { destination, includeTrust }));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!preview || busy) return;
    setBusy(true); setError("");
    try {
      setReport(await invoke<Report>("copy_workspace", {
        destination: preview.destination,
        includeTrust,
        reviewedTrust: preview.include_trust,
      }));
      setPreview(null);
    } catch (error) {
      setPreview(null);
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="dialog restore-dialog" aria-labelledby="copy-workspace-title" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="copy-workspace-title">작업 공간 데이터 복사</h2>
      <button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button>
    </div>
    <form aria-busy={busy} onSubmit={event => { event.preventDefault(); if (!preview && !report) void inspect(); }}>
      {report ? <>
        <div className="success-banner" role="status"><strong>작업 공간 복사 완료</strong><span>{displayPath(report.directory)}</span></div>
        <ul className="workspace-copy-files">{report.files.map(file => <li key={file.name}>
          <strong>{file.name} · {file.bytes.toLocaleString("ko-KR")} bytes</strong><code>SHA-256 {file.sha256}</code>
        </li>)}</ul>
        <p className="form-note">복사본으로 시작하려면 다음 실행에 STACKPORT_DATA_DIR를 이 폴더로 지정하세요. 휴대형 실행에서는 EXE 옆 StackPort-data 폴더를 사용합니다.</p>
        {report.audit_warning && <p className="form-note" role="alert">{report.audit_warning}</p>}
      </> : preview ? <>
        <dl className="restore-summary" ref={review} tabIndex={-1}>
          <dt>원본</dt><dd>{displayPath(preview.source)}</dd>
          <dt>새 폴더</dt><dd>{displayPath(preview.destination)}</dd>
          <dt>복사할 파일</dt><dd>workspace.sqlite{preview.include_trust && ", ssh-trust.sqlite"}</dd>
        </dl>
        <p className="form-note">프로젝트와 연결 정의는 복사합니다. 연결이 참조하는 SQLite 원본 파일은 각 연결 경로에 그대로 있습니다.</p>
      </> : <>
        <label className="field">새 데이터 폴더 경로
          <input required disabled={busy} value={destination} placeholder="새 폴더의 절대 경로" onChange={event => setDestination(event.target.value)} />
        </label>
        <fieldset className="csv-options" disabled={busy}>
          <legend className="sr-only">복사 옵션</legend>
          <label><input type="checkbox" checked={includeTrust} onChange={event => setIncludeTrust(event.target.checked)} /> SSH 호스트 신뢰 기록 포함</label>
        </fieldset>
        <p className="form-note">상위 폴더는 미리 만들어 두세요. 기존 폴더에는 쓰지 않으며 복사본을 만들고 검증합니다.</p>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {report ? <button type="button" className="primary" onClick={onClose}>완료</button> : <>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
          {preview
            ? <><button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>이전</button><button type="button" className="primary" disabled={busy} onClick={() => void copy()}>{busy ? "복사 및 검증 중…" : "복사 시작"}</button></>
            : <button type="submit" className="primary" disabled={busy}>{busy ? "경로 확인 중…" : "복사 미리보기"}</button>}
        </>}
      </div>
    </form>
  </dialog>;
}
