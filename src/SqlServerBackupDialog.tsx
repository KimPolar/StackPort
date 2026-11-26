import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Capabilities = { database: string; directory: string | null; disk_supported: boolean; can_backup: boolean; compression_supported: boolean };
type Preview = { token: string; database: string; path: string; compression: boolean; expires_seconds: number };
type BackupSet = { id: string; database: string; name: string | null; position: number; backup_type: number;
  source_version: string; has_checksums: boolean; copy_only: boolean };
type Outcome = {
  path: string; backup_name: string | null; status: "succeeded" | "failed" | "cancelled" | "timed_out" | "unconfirmed";
  set: BackupSet | null; message: string | null; error_code: number | null; attention_confirmed: boolean | null; audit_warning: boolean;
};
type Progress = { phase: "preparing" | "writing" | "reading" | "verifying"; percent: number | null };
const phases: Record<Progress["phase"], string> = {
  preparing: "서버 경로와 권한을 확인하는 중…",
  writing: "서버 디스크에 백업을 쓰는 중…",
  reading: "백업 세트의 머리글을 읽는 중…",
  verifying: "SQL Server가 백업 파일을 확인하는 중…",
};
const failures: Record<Exclude<Outcome["status"], "succeeded">, string> = {
  failed: "작업이 실패했습니다.",
  cancelled: "작업 중단을 요청했습니다.",
  timed_out: "작업 시간이 초과되었습니다.",
  unconfirmed: "서버에서 백업 완료 여부를 확인해야 합니다.",
};
const backupTypes: Record<number, string> = { 1: "전체 DB", 2: "트랜잭션 로그", 4: "파일", 5: "차등 DB", 6: "차등 파일", 7: "부분", 8: "차등 부분" };

export function SqlServerBackupDialog({ id, server, database, environment, onClose }: {
  id: string; server: string; database: string; environment: string; onClose: () => void;
}) {
  const [mode, setMode] = useState<"backup" | "verify">("backup");
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [capabilityError, setCapabilityError] = useState("");
  const [directory, setDirectory] = useState("");
  const [compression, setCompression] = useState(false);
  const [archive, setArchive] = useState("");
  const [position, setPosition] = useState("1");
  const [expectedName, setExpectedName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview>();
  const [approved, setApproved] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<string>();
  const [progress, setProgress] = useState<Progress>();
  const [cancelling, setCancelling] = useState(false);
  const [report, setReport] = useState<Outcome>();
  const [error, setError] = useState("");
  const working = useRef(false);
  const production = environment === "PROD";
  const backupBlocked = !capabilities?.disk_supported || !capabilities.can_backup;
  const positionNumber = Number(position);
  const ready = mode === "verify" ? archive.trim() && Number.isInteger(positionNumber) && positionNumber >= 1 && positionNumber <= 32767
    : !backupBlocked && (preview ? approved && (!production || confirmation === "PROD") : directory.trim());

  useEffect(() => {
    let live = true;
    void invoke<Capabilities>("sql_server_backup_capabilities", { id }).then(value => {
      if (live) { setCapabilities(value); setDirectory(value.directory ?? ""); }
    }).catch(reason => { if (live) setCapabilityError(String(reason)); });
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    if (!job) return;
    let live = true;
    let timer: number | undefined;
    async function update() {
      try {
        const value = await invoke<Progress | null>("sql_server_backup_progress", { id, requestId: job });
        if (live && value) setProgress(value);
      } catch { /* The operation reports its own result. */ }
      if (live) timer = window.setTimeout(() => void update(), 800);
    }
    void update();
    return () => { live = false; window.clearTimeout(timer); };
  }, [id, job]);

  function discard() {
    if (preview) void invoke("discard_sql_server_backup", { id, token: preview.token }).catch(() => {});
    setPreview(undefined); setApproved(false); setConfirmation("");
  }

  function chooseMode(next: "backup" | "verify") {
    discard(); setMode(next); setError(""); setReport(undefined);
  }

  function inspectGenerated(outcome: Outcome) {
    chooseMode("verify"); setArchive(outcome.path); setPosition("1"); setExpectedName(outcome.backup_name);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working.current || !ready) return;
    working.current = true; setBusy(true); setError(""); setReport(undefined); setProgress(undefined);
    try {
      if (mode === "backup" && !preview) {
        setPreview(await invoke<Preview>("preview_sql_server_backup", { id, options: { directory, compression } }));
      } else {
        const requestId = crypto.randomUUID();
        setJob(requestId);
        const outcome = mode === "verify"
          ? await invoke<Outcome>("verify_sql_server_backup", { id, requestId, input: { path: archive, position: positionNumber, expected_name: expectedName } })
          : await invoke<Outcome>("run_sql_server_backup", { id, requestId, token: preview!.token, approved, confirmation });
        discard(); setReport(outcome);
      }
    } catch (reason) {
      if (preview) discard();
      setError(String(reason));
    } finally {
      working.current = false; setJob(undefined); setBusy(false); setCancelling(false);
    }
  }

  async function cancel() {
    if (!job || cancelling) return;
    setCancelling(true);
    try { if (!await invoke<boolean>("cancel_sql_server_backup", { id, requestId: job })) setCancelling(false); }
    catch (reason) { setError(String(reason)); setCancelling(false); }
  }

  return <Dialog title="SQL Server 백업 관리" className="restore-dialog" busy={busy} onClose={() => { discard(); onClose(); }}>
    <div className="mysql-views" role="group" aria-label="백업 작업">
      <button type="button" className="secondary small" aria-pressed={mode === "backup"} disabled={busy} onClick={() => chooseMode("backup")}>백업 만들기</button>
      <button type="button" className="secondary small" aria-pressed={mode === "verify"} disabled={busy} onClick={() => chooseMode("verify")}>백업 파일 검증</button>
    </div>
    <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{server} · {environment}</strong><br />{database}</p>
      {mode === "verify" ? <>
        <label className="field">서버의 백업 파일 경로<input required disabled={busy} value={archive}
          onChange={event => { setArchive(event.target.value); setExpectedName(null); setReport(undefined); }} /></label>
        <label className="field">백업 세트 위치<input required type="number" min="1" max="32767" step="1" disabled={busy}
          value={position} onChange={event => { setPosition(event.target.value); setExpectedName(null); setReport(undefined); }} /></label>
        <p className="form-note">SQL Server 서비스 계정의 파일 읽기 권한과 SQL 계정의 CREATE DATABASE 권한이 필요합니다.</p>
      </> : preview ? <>
        <dl className="restore-summary">
          <dt>원본 DB</dt><dd>{preview.database}</dd>
          <dt>서버 파일</dt><dd>{preview.path}</dd>
          <dt>백업 방식</dt><dd>전체 DB · COPY_ONLY · 체크섬{preview.compression ? " · 압축" : ""}</dd>
        </dl>
        <p className="form-note">SQL Server가 이 경로에 새 파일을 만듭니다. 미리보기는 {preview.expires_seconds / 60}분간 유효합니다.</p>
        <label className="restore-trust"><input type="checkbox" disabled={busy} checked={approved}
          onChange={event => setApproved(event.target.checked)} /> 백업할 DB와 서버 파일 경로를 확인했습니다.</label>
        {production && <label className="field">운영 확인 문구 PROD<input required disabled={busy} autoComplete="off"
          value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      </> : <>
        <label className="field">서버의 백업 폴더<input required disabled={busy || backupBlocked} value={directory}
          onChange={event => { setDirectory(event.target.value); setReport(undefined); }} /></label>
        {capabilities?.compression_supported && <label className="restore-trust"><input type="checkbox" disabled={busy || backupBlocked}
          checked={compression} onChange={event => setCompression(event.target.checked)} /> 백업 압축</label>}
        <p className="form-note">SQL Server가 서비스 계정으로 서버의 로컬 디스크에 .bak 파일을 만듭니다.</p>
        {capabilityError && <p className="form-error" role="alert">{capabilityError}</p>}
        {!capabilities && !capabilityError && <p className="form-note" role="status">백업 권한과 기본 서버 경로를 확인하는 중…</p>}
        {capabilities && backupBlocked && <p className="form-error" role="alert">{capabilities.disk_supported
          ? "현재 계정에 BACKUP DATABASE 권한이 없습니다." : "이 연결에서 사용자 DB의 서버 디스크 백업을 사용할 수 없습니다."}</p>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p className="form-note" role="status">{cancelling ? "중단 요청 중…" : progress ? phases[progress.phase] : "서버 응답을 기다리는 중…"}
        {progress?.percent != null && ` · ${Math.round(progress.percent)}%`}</p>}
      {report && <div className="form-note">
        <p className={report.status === "succeeded" ? "success-banner" : "form-error"} role={report.status === "succeeded" ? "status" : "alert"}>
          {report.status === "succeeded" ? (report.set ? (report.set.has_checksums ? "백업 체크섬 검증 완료" : "백업 판독 검증 완료") : "서버에 백업을 저장했습니다.") : failures[report.status]}
        </p>
        {report.message && <p>{report.message}{report.error_code != null && ` (SQL Server ${report.error_code})`}</p>}
        {report.attention_confirmed === true && <p>서버가 중단 요청에 응답했습니다.</p>}
        <dl className="restore-summary"><dt>서버 파일</dt><dd>{report.path}</dd>
          {report.set && <><dt>백업 원본</dt><dd>{report.set.database} · {report.set.source_version}</dd>
            <dt>백업 세트</dt><dd>{report.set.position} · {backupTypes[report.set.backup_type] ?? report.set.backup_type}
              {report.set.copy_only && " · COPY_ONLY"}</dd><dt>세트 ID</dt><dd><code>{report.set.id}</code></dd></>}
        </dl>
        {report.status === "succeeded" && report.backup_name && <button type="button" className="secondary"
          onClick={() => inspectGenerated(report)}>이 백업 검증</button>}
        {report.audit_warning && <p className="form-error" role="alert">작업 결과를 감사 기록에 저장할 수 없습니다.</p>}
      </div>}
      <div className="dialog-actions">
        {preview && !busy && <button type="button" className="secondary" onClick={discard}>경로 다시 선택</button>}
        <button type="button" className="secondary" disabled={busy && (!job || cancelling)} onClick={busy ? () => void cancel() : () => { discard(); onClose(); }}>
          {busy ? "작업 중단" : "닫기"}</button>
        <button type="submit" className="primary" disabled={busy || !ready}>
          {mode === "verify" ? "파일 검증" : preview ? "백업 실행" : "백업 미리보기"}</button>
      </div>
    </form>
  </Dialog>;
}
