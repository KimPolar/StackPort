import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Directory = { name: string; path: string; readable: boolean; writable: boolean };
type Capabilities = { schema: string; create_table: boolean; directories: Directory[] };
type Content = "all" | "metadata" | "data";
type Preview = {
  token: string; schema: string; directory: Directory; filename: string; job: string; content: Content; expires_seconds: number;
};
type Outcome = {
  status: "succeeded" | "completed_with_errors" | "failed" | "cancelled" | "timed_out" | "unconfirmed";
  directory: Directory; filename: string; job: string;
  error_code: number | null; error_count: number; message: string | null; audit_warning: boolean;
};
type Header = {
  directory: Directory; filename: string; size_bytes: string; guid: string;
  dump_version: string | null; source_version: string | null; job: string | null; created: string | null; master_pieces: string | null;
};
const contentNames: Record<Content, string> = { all: "구조와 데이터", metadata: "구조만", data: "데이터만" };
const outcomeText: Record<Outcome["status"], string> = {
  succeeded: "Oracle 서버에 덤프를 저장했습니다.",
  completed_with_errors: "일부 오류와 함께 내보내기가 끝났습니다.",
  failed: "Oracle Data Pump 내보내기에 실패했습니다.",
  cancelled: "Oracle 서버가 중단 요청을 처리했습니다.",
  timed_out: "제한 시간이 초과되어 Oracle 작업을 중단했습니다.",
  unconfirmed: "Oracle 서버에서 내보내기 결과를 확인해야 합니다.",
};
const bytes = new Intl.NumberFormat("ko-KR");

export function OracleDataPumpDialog({ id, server, database, environment, onClose }: {
  id: string; server: string; database: string; environment: string; onClose: () => void;
}) {
  const [mode, setMode] = useState<"export" | "inspect">("export");
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [directory, setDirectory] = useState("");
  const [content, setContent] = useState<Content>("all");
  const [filename, setFilename] = useState("");
  const [expectedJob, setExpectedJob] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const [approved, setApproved] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<string>();
  const [started, setStarted] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [report, setReport] = useState<Outcome>();
  const [file, setFile] = useState<Header>();
  const [error, setError] = useState("");
  const [loadingError, setLoadingError] = useState("");
  const submitting = useRef(false);
  const production = environment === "PROD";
  const eligible = capabilities?.directories.filter(item => mode === "export" ? item.writable : item.readable) ?? [];
  const selected = eligible.find(item => item.name === directory);
  const ready = mode === "inspect" ? selected && filename.trim()
    : capabilities?.create_table && selected && (!preview || (approved && (!production || confirmation === "PROD")));

  useEffect(() => {
    let active = true;
    void invoke<Capabilities>("oracle_pump_capabilities", { id }).then(value => {
      if (active) {
        setCapabilities(value);
        setDirectory(value.directories.find(item => item.writable)?.name ?? "");
      }
    }).catch(cause => { if (active) setLoadingError(String(cause)); });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!request) return;
    let active = true;
    let timer: number | undefined;
    async function poll() {
      try {
        const state = await invoke<{ started: boolean; percent: number | null } | null>("oracle_pump_progress", { id, requestId: request });
        if (active && state) { setStarted(state.started); setPercent(state.percent); }
      } catch { /* The worker returns its own result. */ }
      if (active) timer = window.setTimeout(() => void poll(), 800);
    }
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [id, request]);

  function discard() {
    if (preview) void invoke("discard_oracle_pump_export", { id, token: preview.token }).catch(() => {});
    setPreview(undefined); setApproved(false); setConfirmation("");
  }

  function switchMode(next: typeof mode) {
    const choices = capabilities?.directories.filter(item => next === "export" ? item.writable : item.readable) ?? [];
    if (!choices.some(item => item.name === directory)) setDirectory(choices[0]?.name ?? "");
    discard(); setMode(next); setError(""); setReport(undefined); setFile(undefined); setExpectedJob(undefined);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !ready) return;
    submitting.current = true; setBusy(true); setError(""); setReport(undefined); setFile(undefined); setStarted(false); setPercent(null);
    try {
      if (mode === "inspect") {
        setFile(await invoke<Header>("inspect_oracle_pump_dump", { id, directory, filename: filename.trim(), expectedJob }));
      } else if (!preview) {
        setPreview(await invoke<Preview>("preview_oracle_pump_export", { id, options: { directory, content } }));
      } else {
        const requestId = crypto.randomUUID();
        setRequest(requestId);
        const result = await invoke<Outcome>("run_oracle_pump_export", { id, requestId, token: preview.token, approved, confirmation });
        discard(); setReport(result);
      }
    } catch (cause) {
      discard(); setError(String(cause));
    } finally {
      submitting.current = false; setBusy(false); setRequest(undefined); setCancelling(false);
    }
  }

  async function cancel() {
    if (!request || cancelling) return;
    setCancelling(true);
    try {
      if (!await invoke<boolean>("cancel_oracle_pump", { id, requestId: request })) setCancelling(false);
    } catch (cause) { setError(String(cause)); setCancelling(false); }
  }

  function inspectGenerated(result: Outcome) {
    switchMode("inspect");
    setDirectory(result.directory.name); setFilename(result.filename); setExpectedJob(result.job);
  }

  function close() { discard(); onClose(); }

  return <Dialog title="Oracle Data Pump" className="restore-dialog" busy={busy} onClose={close}>
    <div className="mysql-views" role="group" aria-label="Data Pump 작업">
      <button type="button" className="secondary small" aria-pressed={mode === "export"} disabled={busy} onClick={() => switchMode("export")}>스키마 백업</button>
      <button type="button" className="secondary small" aria-pressed={mode === "inspect"} disabled={busy} onClick={() => switchMode("inspect")}>덤프 헤더 확인</button>
    </div>
    <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{server} · {environment}</strong><br />{database}</p>
      {preview ? <>
        <dl className="restore-summary">
          <dt>원본 스키마</dt><dd>{preview.schema}</dd>
          <dt>Oracle 디렉터리</dt><dd>{preview.directory.name} · {preview.directory.path}</dd>
          <dt>서버 파일</dt><dd>{preview.filename}</dd>
          <dt>백업 내용</dt><dd>{contentNames[preview.content]}</dd>
          <dt>서버 작업</dt><dd>{preview.job}</dd>
        </dl>
        <p className="form-note">미리보기는 {preview.expires_seconds / 60}분간 유효합니다.</p>
        <label className="restore-trust"><input type="checkbox" disabled={busy} checked={approved}
          onChange={event => setApproved(event.target.checked)} /> 스키마와 서버 파일 경로를 확인했습니다.</label>
        {production && <label className="field">운영 확인 문구 PROD<input autoComplete="off" required disabled={busy} value={confirmation}
          onChange={event => setConfirmation(event.target.value)} /></label>}
      </> : <>
        {mode === "export" && capabilities && <dl className="restore-summary"><dt>원본 스키마</dt><dd>{capabilities.schema}</dd></dl>}
        <label className="field">Oracle 디렉터리<select required disabled={busy || !eligible.length} value={directory}
          onChange={event => { setDirectory(event.target.value); setFile(undefined); setExpectedJob(undefined); }}>
          <option value="">디렉터리 선택</option>
          {eligible.map(item => <option value={item.name} key={item.name}>{item.name}</option>)}
        </select></label>
        {selected && <p className="form-note">서버 경로 <code>{selected.path}</code></p>}
        {mode === "export"
          ? <label className="field">백업 내용<select disabled={busy} value={content} onChange={event => setContent(event.target.value as Content)}>
            {Object.entries(contentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          : <label className="field">덤프 파일 이름<input required disabled={busy} maxLength={255} value={filename}
            onChange={event => { setFilename(event.target.value); setExpectedJob(undefined); setFile(undefined); }} /></label>}
        <p className="form-note">{mode === "export"
          ? "Oracle 서버가 파일을 씁니다. 디렉터리 WRITE 권한과 CREATE TABLE 권한, 기본 테이블스페이스 할당량이 필요합니다."
          : "Oracle 서버에 있는 파일의 헤더를 읽습니다. 디렉터리 READ 권한이 필요합니다."}</p>
        {!capabilities && !loadingError && <p className="form-note" role="status">Oracle 디렉터리와 권한을 확인하는 중…</p>}
        {loadingError && <p className="form-error" role="alert">{loadingError}</p>}
        {capabilities && !eligible.length && <p className="form-error" role="alert">{mode === "export" ? "WRITE" : "READ"} 권한이 있는 Oracle 디렉터리가 없습니다.</p>}
        {mode === "export" && capabilities && !capabilities.create_table && <p className="form-error" role="alert">현재 계정에 CREATE TABLE 권한이 없습니다.</p>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p className="form-note" role="status">{cancelling ? "중단 요청 중…"
        : request && !started ? "Oracle Data Pump 작업을 준비하는 중…" : "Oracle 서버에서 작업 중…"}
        {percent != null && ` · 데이터 진행률 ${percent}%`}</p>}
      {report && <div className="form-note">
        <p className={report.status === "succeeded" ? "success-banner" : "form-error"} role={report.status === "succeeded" ? "status" : "alert"}>
          {outcomeText[report.status]}</p>
        <dl className="restore-summary">
          <dt>서버 파일</dt><dd>{report.directory.name} · {report.filename}</dd>
          <dt>서버 작업</dt><dd>{report.job}</dd>
        </dl>
        {report.message && <p>{report.message}</p>}
        {report.error_count > 0 && <p>서버 오류 {report.error_count}건</p>}
        {report.error_code != null && <p>Oracle 오류 {report.error_code}</p>}
        {report.audit_warning && <p className="form-error" role="alert">작업 결과를 감사 기록에 저장할 수 없습니다.</p>}
        {report.status === "succeeded" && report.directory.readable && <button type="button" className="secondary"
          onClick={() => inspectGenerated(report)}>이 덤프의 헤더 확인</button>}
      </div>}
      {file && <div className="form-note">
        <p className="success-banner" role="status">덤프 헤더를 확인했습니다.</p>
        <dl className="restore-summary">
          <dt>서버 파일</dt><dd>{file.directory.name} · {file.filename}</dd>
          <dt>파일 크기</dt><dd>{bytes.format(BigInt(file.size_bytes))} B</dd>
          <dt>덤프 세트 ID</dt><dd>{file.guid}</dd>
          {file.job && <><dt>내보내기 작업</dt><dd>{file.job}</dd></>}
          {file.source_version && <><dt>작업 버전</dt><dd>{file.source_version}</dd></>}
          {file.dump_version && <><dt>파일 형식 버전</dt><dd>{file.dump_version}</dd></>}
          {file.created && <><dt>생성 시간</dt><dd>{file.created}</dd></>}
          {file.master_pieces && Number(file.master_pieces) > 1 && <><dt>마스터 파일 조각</dt><dd>{file.master_pieces}</dd></>}
        </dl>
      </div>}
      <div className="dialog-actions">
        {preview && !busy && <button type="button" className="secondary" onClick={discard}>백업 설정 다시 선택</button>}
        <button type="button" className="secondary" disabled={busy && (!request || cancelling)} onClick={busy ? () => void cancel() : close}>
          {busy && request ? "작업 중단" : "닫기"}</button>
        <button type="submit" className="primary" disabled={busy || !ready}>
          {mode === "inspect" ? "헤더 읽기" : preview ? "백업 실행" : "백업 미리보기"}</button>
      </div>
    </form>
  </Dialog>;
}
