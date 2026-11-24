import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

type RestoreVerification = {
  sha256: string;
  size_bytes: number;
  objects: number;
  tables: number;
  rows: number;
};
type Preview = RestoreVerification & {
  token: string;
  source: string;
  destination: string;
  user_version: number;
  expires_seconds: number;
};
export type RestoreReport = RestoreVerification & { path: string; integrity: "ok"; audit_warning: string | null };

const number = new Intl.NumberFormat("ko-KR");
export const restoreCounts = (value: RestoreVerification) =>
  `객체 ${number.format(value.objects)}개 · 일반 테이블 ${number.format(value.tables)}개 · ${number.format(value.rows)}행`;

export function SqliteRestoreDialog({ project, onClose, onRestored, displayPath }: {
  project: { id: string; name: string };
  onClose: () => void;
  onRestored: (report: RestoreReport) => void;
  displayPath: (path: string) => string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const review = useRef<HTMLDListElement>(null);
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (preview) review.current?.focus(); }, [preview]);

  async function pick(kind: "source" | "destination") {
    setBusy(true);
    setError("");
    try {
      if (kind === "source") {
        const path = await invoke<string | null>("choose_sqlite_file");
        if (path) setSource(path);
      } else {
        const path = await invoke<string | null>("choose_sqlite_restore_destination");
        if (path) setDestination(path);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function inspect() {
    setBusy(true);
    setError("");
    try {
      setPreview(await invoke<Preview>("preview_sqlite_restore", { projectId: project.id, source, destination }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      onRestored(await invoke<RestoreReport>("restore_sqlite", { token: preview.token, confirmed: true }));
    } catch (cause) {
      setPreview(null);
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="dialog restore-dialog" aria-labelledby="restore-title" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="restore-title">SQLite 백업 복원</h2>
      <button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button>
    </div>
    <form aria-busy={busy} onSubmit={event => {
      event.preventDefault();
      if (!busy && !preview) void inspect();
    }}>
      {preview ? <>
        <dl className="restore-summary" ref={review} tabIndex={-1}>
          <dt>작업 기록 프로젝트</dt><dd>{project.name}</dd>
          <dt>백업 파일</dt><dd>{displayPath(preview.source)}</dd>
          <dt>복원 위치</dt><dd>{displayPath(preview.destination)}</dd>
          <dt>백업 내용</dt><dd>{restoreCounts(preview)} · {number.format(preview.size_bytes)} bytes</dd>
          <dt>SQLite 사용자 버전</dt><dd>{preview.user_version}</dd>
          <dt>백업 SHA-256</dt><dd><code>{preview.sha256}</code></dd>
        </dl>
        <p className="form-note">백업의 무결성을 확인했습니다. 복원 파일을 다시 열어 확인한 뒤 새 경로에 저장합니다. 확인은 {preview.expires_seconds / 60}분 동안 유효합니다.</p>
      </> : <>
        <label className="field">백업 파일 경로<span className="file-input">
          <input required disabled={busy} value={source} onChange={event => setSource(event.target.value)} placeholder="백업 SQLite 파일 선택" />
          <button type="button" className="secondary" disabled={busy} onClick={() => void pick("source")}>백업 찾기</button>
        </span></label>
        <label className="field">새 복원 파일 경로<span className="file-input">
          <input required disabled={busy} value={destination} onChange={event => setDestination(event.target.value)} placeholder="새 파일의 절대 경로" />
          <button type="button" className="secondary" disabled={busy} onClick={() => void pick("destination")}>위치 선택</button>
        </span></label>
        <p className="form-note">저널이나 WAL 파일이 필요 없는 SQLite 백업을 선택하세요. 복원은 새 파일에만 가능합니다.</p>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        {preview && <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>경로 변경</button>}
        <button type={preview ? "button" : "submit"} className="primary" disabled={busy} onClick={preview ? () => void restore() : undefined}>
          {preview ? (busy ? "복원 파일 검증 중…" : "새 파일로 복원") : (busy ? "처리 중…" : "복원 미리보기")}
        </button>
      </div>
    </form>
  </dialog>;
}
