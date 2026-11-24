import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Preview = {
  token: string; source: string; database: string; archive_database: string; source_version: string; dump_version: string;
  target_version: string; tool_version: string; entries: number; toc: string; toc_truncated: boolean;
  size_bytes: number; sha256: string; expires_seconds: number;
};
export type PostgresRestoreReport = { database: string; sha256: string; tables: number | null; audit_warning: boolean };

const number = new Intl.NumberFormat("ko-KR");

export function PostgresRestoreDialog({ id, server, environment, unavailable, onBusy, onClose, onRestored }: {
  id: string; server: string; environment: string; unavailable: string; onBusy: (busy: boolean) => void;
  onClose: () => void; onRestored: (report: PostgresRestoreReport) => void;
}) {
  const [source, setSource] = useState("");
  const [database, setDatabase] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState<"preview" | "restore" | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [error, setError] = useState("");
  const review = useRef<HTMLDListElement>(null);
  const request = useRef<string | null>(null);
  const blocked = Boolean(busy || unavailable);
  const production = environment === "PROD";
  const canRestore = Boolean(preview && trusted && name === preview.database && (!production || confirmation === "PROD"));
  useEffect(() => { if (preview) review.current?.focus(); }, [preview]);

  function resetPreview() {
    if (preview) void invoke("discard_postgres_restore", { id, token: preview.token }).catch(() => {});
    setPreview(null); setName(""); setTrusted(false); setConfirmation(""); setPassword("");
  }

  function close() {
    resetPreview();
    onClose();
  }

  async function chooseArchive() {
    setError("");
    try {
      const path = await invoke<string | null>("choose_postgres_restore_archive");
      if (path) setSource(path);
    } catch (reason) { setError(String(reason)); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (request.current || unavailable || (preview && !canRestore)) return;
    const token = crypto.randomUUID();
    request.current = token;
    setBusy(preview ? "restore" : "preview"); setCancelRequested(false); setError(""); onBusy(true);
    try {
      if (preview) {
        setPassword("");
        onRestored(await invoke<PostgresRestoreReport>("apply_postgres_restore", {
          id, request: token, token: preview.token, databaseConfirmation: name, trusted, password, confirmation,
        }));
      } else {
        setPreview(await invoke<Preview>("preview_postgres_restore", {
          id, request: token, database: database.trim(), source: source.trim(),
        }));
      }
    } catch (reason) {
      if (preview) resetPreview();
      setError(String(reason));
    } finally { request.current = null; setBusy(null); setCancelRequested(false); onBusy(false); }
  }

  async function cancel() {
    if (!request.current || cancelRequested) return;
    setCancelRequested(true);
    try {
      if (!await invoke<boolean>("cancel_postgres_restore", { id, request: request.current })) setCancelRequested(false);
    } catch (reason) { setError(String(reason)); setCancelRequested(false); }
  }

  return <Dialog title="PostgreSQL 백업 복원" className="restore-dialog" onClose={close} busy={Boolean(busy)}>
    <form onSubmit={submit} aria-busy={Boolean(busy)}>
      {!preview ? <>
        <p className="confirm-copy"><strong>{server} · {environment}</strong></p>
        <label className="field">백업 파일<span className="file-input">
          <input required disabled={blocked} value={source} onChange={event => setSource(event.target.value)} placeholder="커스텀 아카이브 절대 경로" />
          <button type="button" className="secondary" disabled={blocked} onClick={() => void chooseArchive()}>파일 선택</button>
        </span></label>
        <label className="field">새 데이터베이스 이름<input required maxLength={1024} disabled={blocked}
          value={database} onChange={event => setDatabase(event.target.value)} autoComplete="off" /></label>
        <p className="form-note">현재 서버의 임시 DB에 복원한 뒤 입력한 이름을 부여합니다. 새 DB를 만들 수 있는 역할과 커스텀 아카이브가 필요합니다.</p>
      </> : <>
        <dl className="restore-summary" ref={review} tabIndex={-1}>
          <dt>대상</dt><dd>{server} / <strong>{preview.database}</strong> · {environment}</dd>
          <dt>서버와 도구</dt><dd>PostgreSQL {preview.target_version} · pg_restore {preview.tool_version}</dd>
          <dt>백업 출처</dt><dd>{preview.archive_database} · PostgreSQL {preview.source_version} · pg_dump {preview.dump_version}</dd>
          <dt>백업 파일</dt><dd>{preview.source} · {number.format(preview.size_bytes)} B</dd>
          <dt>SHA-256</dt><dd><code>{preview.sha256}</code></dd>
        </dl>
        <details><summary>아카이브 목차 · {number.format(preview.entries)}개 항목</summary>
          <pre className="restore-toc" tabIndex={0} aria-label="PostgreSQL 아카이브 목차">{preview.toc}</pre>
          {preview.toc_truncated && <p className="form-note">목차 앞부분을 표시합니다.</p>}
        </details>
        <p className="form-note">아카이브의 SQL은 현재 역할의 권한으로 실행됩니다. 일부 테이블만 백업했다면 참조 객체나 확장이 필요할 수 있습니다. 확인한 사본은 {preview.expires_seconds / 60}분 동안 사용할 수 있습니다.</p>
        <label className="restore-trust"><input type="checkbox" checked={trusted} disabled={blocked}
          onChange={event => setTrusted(event.target.checked)} /> 백업 출처를 확인했고 복원 실행에 동의합니다.</label>
        <label className="field">새 DB 이름 확인<input required disabled={blocked} value={name} autoComplete="off"
          onChange={event => setName(event.target.value)} /></label>
        <label className="field">PostgreSQL 암호<input type="password" autoComplete="off" maxLength={4096} disabled={blocked}
          value={password} onChange={event => setPassword(event.target.value)} /></label>
        {production && <label className="field">운영 확인 문구 PROD<input required autoComplete="off" disabled={blocked}
          value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      </>}
      {unavailable && <p className="form-error" role="alert">{unavailable}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p className="form-note" role="status">{cancelRequested ? "중단 요청 중…" : busy === "preview" ? "백업 사본과 목차 확인 중…" : "새 DB 생성 및 복원 중…"}</p>}
      <div className="dialog-actions">
        {preview && !busy && <button type="button" className="secondary" onClick={resetPreview}>대상 다시 선택</button>}
        <button type="button" className="secondary" disabled={cancelRequested || Boolean(unavailable && busy)}
          onClick={busy ? () => void cancel() : close}>{busy ? "작업 중단" : "닫기"}</button>
        <button type="submit" className="primary" disabled={blocked || (preview ? !canRestore : !source.trim() || !database.trim())}>
          {preview ? "새 DB에 복원" : "복원 미리보기"}
        </button>
      </div>
    </form>
  </Dialog>;
}
