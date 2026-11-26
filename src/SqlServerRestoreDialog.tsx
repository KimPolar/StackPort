import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Preview = {
  token: string;
  path: string;
  database: string;
  staging_database: string;
  set: { id: string; database: string; source_version: string; has_checksums: boolean; position: number };
  files: { source: { logical_name: string; original_path: string; size_bytes: string }; destination: string }[];
  expires_seconds: number;
};
type Outcome = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out" | "unconfirmed";
  restore: { database: string; staging_database: string | null };
  set: Preview["set"] | null;
  message: string | null;
  error_code: number | null;
  attention_confirmed: boolean | null;
  audit_warning: boolean;
};
type Progress = { phase: "preparing" | "reading" | "verifying" | "restoring" | "publishing"; percent: number | null };
const phases: Record<Progress["phase"], string> = {
  preparing: "서버의 복원 권한과 경로를 확인하는 중…",
  reading: "백업 세트와 파일 목록을 확인하는 중…",
  verifying: "백업 파일과 복원 위치를 검증하는 중…",
  restoring: "SQL Server가 파일을 복원하는 중…",
  publishing: "검토한 이름으로 데이터베이스를 전환하는 중…",
};
const statusText: Record<Outcome["status"], string> = {
  succeeded: "새 데이터베이스에 복원했습니다.",
  failed: "데이터베이스 복원에 실패했습니다.",
  cancelled: "복원 중단을 요청했습니다.",
  timed_out: "복원 시간이 초과되었습니다.",
  unconfirmed: "SQL Server에서 복원 결과를 확인해야 합니다.",
};
const numberFormat = new Intl.NumberFormat("ko-KR");

export function SqlServerRestoreDialog({ id, server, environment, onClose }: {
  id: string; server: string; environment: string; onClose: () => void;
}) {
  const [archive, setArchive] = useState("");
  const [position, setPosition] = useState("1");
  const [database, setDatabase] = useState("");
  const [dataDirectory, setDataDirectory] = useState("");
  const [logDirectory, setLogDirectory] = useState("");
  const [review, setReview] = useState<Preview>();
  const [approved, setApproved] = useState(false);
  const [confirmedName, setConfirmedName] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<string>();
  const [progress, setProgress] = useState<Progress>();
  const [cancelling, setCancelling] = useState(false);
  const [report, setReport] = useState<Outcome>();
  const [error, setError] = useState("");
  const working = useRef(false);
  const production = environment === "PROD";
  const setPositionNumber = Number(position);
  const ready = review ? approved && confirmedName === review.database && (!production || confirmation === "PROD")
    : archive.trim() && database.trim() && Number.isInteger(setPositionNumber) && setPositionNumber >= 1 && setPositionNumber <= 32767;

  useEffect(() => {
    if (!job) return;
    let live = true;
    let timer: number | undefined;
    async function poll() {
      try {
        const value = await invoke<Progress | null>("sql_server_backup_progress", { id, requestId: job });
        if (live && value) setProgress(value);
      } catch { /* The restore command reports its result. */ }
      if (live) timer = window.setTimeout(() => void poll(), 800);
    }
    void poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [id, job]);

  function resetReview() {
    if (review) void invoke("discard_sql_server_restore", { id, token: review.token }).catch(() => {});
    setReview(undefined); setApproved(false); setConfirmedName(""); setConfirmation("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working.current || !ready) return;
    working.current = true; setBusy(true); setError(""); setReport(undefined); setProgress(undefined);
    try {
      if (review) {
        const requestId = crypto.randomUUID();
        setJob(requestId);
        const result = await invoke<Outcome>("run_sql_server_restore", {
          id, requestId, token: review.token, database: confirmedName, approved, confirmation,
        });
        resetReview(); setReport(result);
      } else {
        setReview(await invoke<Preview>("preview_sql_server_restore", {
          id,
          options: { path: archive, position: setPositionNumber, database, data_directory: dataDirectory, log_directory: logDirectory },
        }));
      }
    } catch (cause) {
      resetReview(); setError(String(cause));
    } finally {
      working.current = false; setBusy(false); setJob(undefined); setCancelling(false);
    }
  }

  async function cancel() {
    if (!job || cancelling) return;
    setCancelling(true);
    try {
      if (!await invoke<boolean>("cancel_sql_server_backup", { id, requestId: job })) setCancelling(false);
    } catch (cause) { setError(String(cause)); setCancelling(false); }
  }

  function close() { resetReview(); onClose(); }

  return <Dialog title="SQL Server DB 복원" className="restore-dialog" busy={busy} onClose={close}>
    <form aria-busy={busy} onSubmit={submit}>
      <p className="confirm-copy"><strong>{server} · {environment}</strong></p>
      {review ? <>
        <dl className="restore-summary">
          <dt>원본 DB</dt><dd>{review.set.database} · SQL Server {review.set.source_version}</dd>
          <dt>백업 파일</dt><dd>{review.path}</dd>
          <dt>백업 세트</dt><dd>{review.set.position} · 전체 DB · {review.set.has_checksums ? "체크섬 있음" : "체크섬 없음"}</dd>
          <dt>새 DB</dt><dd>{review.database}</dd>
        </dl>
        <details open>
          <summary>서버의 복원 파일 {review.files.length}개</summary>
          <dl className="restore-summary">
            {review.files.map(({ source, destination }) => <RestoreFile key={destination} source={source} destination={destination} />)}
          </dl>
        </details>
        <p className="form-note">SQL Server가 검토한 파일 경로에 복원한 뒤 새 DB 이름을 적용합니다. 실패 시 확인할 임시 DB <code>{review.staging_database}</code></p>
        <p className="form-note">원본 DB가 사용하던 서버 로그인과 SQL Server Agent 작업은 대상 서버에서 별도로 준비하세요.</p>
        <p className="form-note">미리보기는 {review.expires_seconds / 60}분간 유효합니다.</p>
        <label className="restore-trust"><input type="checkbox" disabled={busy} checked={approved}
          onChange={event => setApproved(event.target.checked)} /> 원본 백업과 새 DB의 파일 위치를 확인했습니다.</label>
        <label className="field">새 DB 이름 확인<input required autoComplete="off" disabled={busy} value={confirmedName}
          onChange={event => setConfirmedName(event.target.value)} /></label>
        {production && <label className="field">운영 확인 문구 PROD<input required autoComplete="off" disabled={busy} value={confirmation}
          onChange={event => setConfirmation(event.target.value)} /></label>}
      </> : <>
        <label className="field">서버의 백업 파일 경로<input required disabled={busy} maxLength={260}
          value={archive} onChange={event => setArchive(event.target.value)} /></label>
        <label className="field">백업 세트 위치<input required disabled={busy} type="number" min="1" max="32767" step="1"
          value={position} onChange={event => setPosition(event.target.value)} /></label>
        <label className="field">새 데이터베이스 이름<input required disabled={busy} maxLength={128}
          value={database} onChange={event => setDatabase(event.target.value)} /></label>
        <details>
          <summary>복원 파일 폴더 지정</summary>
          <label className="field">서버의 데이터 파일 폴더<input disabled={busy} maxLength={260} placeholder="서버 기본 폴더"
            value={dataDirectory} onChange={event => setDataDirectory(event.target.value)} /></label>
          <label className="field">서버의 로그 파일 폴더<input disabled={busy} maxLength={260} placeholder="서버 기본 폴더"
            value={logDirectory} onChange={event => setLogDirectory(event.target.value)} /></label>
        </details>
        <p className="form-note">SQL 계정의 복원 권한과 서비스 계정의 파일 읽기 및 폴더 쓰기 권한이 필요합니다.</p>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p className="form-note" role="status">{cancelling ? "중단 요청 중…" : progress ? phases[progress.phase] : "복원 서버 응답을 기다리는 중…"}
        {progress?.percent != null && ` · ${Math.round(progress.percent)}%`}</p>}
      {report && <div className="form-note">
        <p className={report.status === "succeeded" ? "success-banner" : "form-error"} role={report.status === "succeeded" ? "status" : "alert"}>
          {statusText[report.status]}
        </p>
        <dl className="restore-summary">
          <dt>대상 DB</dt><dd>{report.restore.database}</dd>
          {report.set && <><dt>검증</dt><dd>{report.set.has_checksums ? "백업 체크섬 확인" : "백업 판독 확인"} · DB 온라인 및 파일 위치 확인</dd></>}
          {report.status !== "succeeded" && report.restore.staging_database && <>
            <dt>확인할 임시 DB</dt><dd>{report.restore.staging_database}</dd>
          </>}
        </dl>
        {report.message && <p>{report.message}{report.error_code != null && ` (SQL Server ${report.error_code})`}</p>}
        {report.attention_confirmed && <p>서버가 중단 요청에 응답했습니다.</p>}
        {report.audit_warning && <p className="form-error" role="alert">작업 결과를 감사 기록에 저장할 수 없습니다.</p>}
      </div>}
      <div className="dialog-actions">
        {review && !busy && <button type="button" className="secondary" onClick={resetReview}>원본과 대상 다시 선택</button>}
        <button type="button" className="secondary" disabled={busy && (!job || cancelling)} onClick={busy ? () => void cancel() : close}>
          {busy && job ? "작업 중단" : "닫기"}</button>
        <button type="submit" className="primary" disabled={busy || !ready}>{review ? "복원 실행" : "복원 미리보기"}</button>
      </div>
    </form>
  </Dialog>;
}

function RestoreFile({ source, destination }: { source: Preview["files"][number]["source"]; destination: string }) {
  return <><dt>{source.logical_name}</dt><dd>{destination}<br />
    <span className="muted">{source.original_path} · {numberFormat.format(BigInt(source.size_bytes))} B</span></dd></>;
}
