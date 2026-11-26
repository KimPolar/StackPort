import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import type { PostgresProfile } from "./PostgresWorkspace";

type Profile = { id: string; name: string; path: string; environment: string };
type Plan = {
  revision: number; directory: string; prefix: string; interval_minutes: number | null;
  retention_days: number; retry_once: boolean; next_at: number | null; retry_at: number | null; requires_review: boolean;
};
type Run = {
  id: string; status: "running" | "succeeded" | "failed" | "interrupted"; trigger_kind: "scheduled" | "retry" | "manual";
  started_at: number; finished_at: number | null; expires_at: number | null; path: string; size_bytes: number | null; message: string | null;
  artifact: {
    sha256: string; engine_version: string; verified_at: number | null; removal_started_at: number | null;
    removed_at: number | null; owned_here: boolean; removal_supported: boolean;
  } | null;
};
type Snapshot = { plan: Plan | null; runs: Run[] };
type ExpiredPage = { runs: Run[]; next_before: number | null };
type Capacity = { directory: string; estimated_bytes: number; available_bytes: number | null };
type RemovalPreview = { token: string; path: string; size_bytes: number; sha256: string; expires_at: number };
type CredentialStatus = { supported: boolean; usable: boolean };
type Draft = {
  revision: number | null; directory: string; prefix: string; scheduled: boolean; next: string;
  periodic: boolean; minutes: string; retention: string; retry: boolean;
};
const runStatus = { running: "실행 중", succeeded: "무결성 검사 통과", failed: "실패", interrupted: "완료 확인 필요" };
const trigger = { scheduled: "예약 실행", retry: "자동 재시도", manual: "수동 실행" };
const date = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium" });
const bytes = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const dateText = (seconds: number) => date.format(seconds * 1000);
const size = (amount: number) => bytes.format(amount / 1_048_576) + " MiB";

function dateInput(seconds: number) {
  const value = new Date(seconds * 1000);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function form(plan: Plan | null, displayPath: (value: string) => string, engine: string): Draft {
  return {
    revision: plan?.revision ?? null,
    directory: plan ? displayPath(plan.directory) : "",
    prefix: plan?.prefix ?? `${engine}-backup`,
    scheduled: plan ? plan.next_at !== null : true,
    next: dateInput(plan?.next_at ?? Math.floor(Date.now() / 1000) + 600),
    periodic: plan ? plan.interval_minutes !== null : true,
    minutes: String(plan?.interval_minutes ?? 1440),
    retention: String(plan?.retention_days ?? 30),
    retry: plan?.retry_once ?? true,
  };
}

export function BackupPlanDialog({ profile, postgres, displayPath, onClose, onFileBusy }: {
  profile: Profile; postgres?: PostgresProfile; displayPath: (value: string) => string; onClose: () => void;
  onFileBusy?: (busy: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "run" | "folder" | "capacity" | "refresh" | "pause" | "file" | "history" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removal, setRemoval] = useState<{ run: Run; preview: RemovalPreview } | null>(null);
  const [fileFeedback, setFileFeedback] = useState<{ runId: string; text: string; error: boolean } | null>(null);
  const [expiredPage, setExpiredPage] = useState<ExpiredPage | null>(null);
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const profileId = profile.id;
  const engine = postgres ? "postgres" : "sqlite";
  const engineLabel = postgres ? "PostgreSQL" : "SQLite";
  const production = Boolean(postgres && profile.environment === "PROD");
  const needsCredential = Boolean(postgres && !credential?.usable);
  const approvalMissing = production && confirmation !== "PROD";

  useEffect(() => {
    let live = true;
    let loading = false;
    async function poll() {
      if (loading) return;
      loading = true;
      try {
        const [state, status] = await Promise.all([
          invoke<Snapshot>(`${engine}_backup_plan`, { profileId }),
          postgres ? invoke<CredentialStatus>("postgres_credential_status", { profile: postgres }) : null,
        ]);
        if (!live) return;
        setCredential(status);
        setSnapshot(current => (current?.plan?.revision ?? 0) > (state.plan?.revision ?? 0) ? current : state);
        setDraft(current => current ?? form(state.plan, displayPath, engine));
      } catch (cause) {
        if (live) setError(String(cause));
      } finally { loading = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { live = false; window.clearInterval(timer); };
  }, [profileId, displayPath, engine, postgres]);

  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(current => current && { ...current, [key]: value });
    setDirty(true);
    setError("");
    setNotice("");
    if (key === "directory") setCapacity(null);
  }

  async function perform(task: typeof busy, action: () => Promise<void>) {
    if (busy) return;
    setBusy(task);
    setError("");
    setNotice("");
    try { await action(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(""); }
  }

  function apply(state: Snapshot) {
    setSnapshot(state);
    setDraft(form(state.plan, displayPath, engine));
    setDirty(false);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || needsCredential || approvalMissing) return;
    const nextAt = draft.scheduled ? Date.parse(draft.next) / 1000 : null;
    if (nextAt !== null && (!Number.isSafeInteger(nextAt) || nextAt <= Date.now() / 1000)) {
      setError("첫 실행 시각을 현재보다 늦게 지정하세요.");
      return;
    }
    void perform("save", async () => {
      const target = postgres ? { profile: postgres, confirmation } : { profileId };
      apply(await invoke<Snapshot>(`save_${engine}_backup_plan`, { ...target, input: {
        revision: draft.revision, directory: draft.directory, prefix: draft.prefix,
        interval_minutes: draft.periodic ? Number(draft.minutes) : null,
        retention_days: Number(draft.retention), retry_once: draft.retry, next_at: nextAt,
      } }));
      setConfirmation("");
      setNotice("백업 계획을 저장했습니다.");
    });
  }

  function runNow() {
    const plan = snapshot?.plan;
    if (!plan || dirty || needsCredential || approvalMissing) return;
    void perform("run", async () => {
      const target = postgres ? { profile: postgres, confirmation } : { profileId };
      setConfirmation("");
      onFileBusy?.(true);
      try {
        const result = await invoke<Run>(`run_${engine}_backup_plan`, { ...target, revision: plan.revision });
        apply(await invoke<Snapshot>(`${engine}_backup_plan`, { profileId }));
        setNotice(result.status === "succeeded" ? "백업을 만들고 무결성을 확인했습니다." : "백업 결과를 아래 실행 이력에서 확인하세요.");
      } finally { onFileBusy?.(false); }
    });
  }

  async function performFile(run: Run, action: () => Promise<string>) {
    if (busy) return;
    setBusy("file");
    setFileFeedback(null);
    try {
      const text = await action();
      if (text) setFileFeedback({ runId: run.id, text, error: false });
    } catch (cause) {
      setFileFeedback({ runId: run.id, text: String(cause), error: true });
    } finally {
      setBusy("");
    }
  }

  function browseExpired(before: number | null) {
    void perform("history", async () => {
      const page = await invoke<ExpiredPage>("expired_sqlite_backups", { profileId, before });
      setExpiredPage(current => current && before !== null ? { ...page, runs: [...current.runs, ...page.runs] } : page);
    });
  }

  const plan = snapshot?.plan;
  const stale = draft && draft.revision !== (plan?.revision ?? null);
  const nextAt = plan?.next_at ? dateText(plan.next_at) : "예약 없음";
  const running = snapshot?.runs.some(run => run.status === "running");
  const runs = expiredPage?.runs ?? snapshot?.runs ?? [];

  return <Dialog title={`${engineLabel} 백업 계획`} className="sqlite-backup-plan" onClose={onClose} busy={Boolean(busy)}>
    {!draft ? <div className="backup-run-history">
      {error ? <p className="form-error" role="alert">{error}</p> : <p className="form-note" role="status">백업 계획을 읽는 중…</p>}
    </div> : <>
      <form onSubmit={save} aria-busy={Boolean(busy)}>
        <p className="confirm-copy"><strong>{profile.name}</strong> <span className={"environment " + profile.environment.toLowerCase()}>{profile.environment}</span><br />
          {displayPath(profile.path)}</p>
        {postgres && <p className="form-note">이 계획은 Windows에 저장한 암호와 직접 TLS 연결을 사용합니다. 전체 데이터베이스를 .backup 파일로 저장합니다.</p>}
        {postgres && credential && !credential.usable && <p className="form-note" role="status">{credential.supported
          ? "PostgreSQL에 연결할 때 Windows에 암호를 저장하면 이 계획을 사용할 수 있습니다."
          : "PostgreSQL 계획 백업에는 Windows 자격 증명 관리자가 필요합니다."}</p>}
        <label className="field">저장 폴더<span className="file-input">
          <input required value={draft.directory} disabled={Boolean(busy)} onChange={event => change("directory", event.target.value)} />
          <button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void perform("folder", async () => {
            const path = await invoke<string | null>("choose_backup_directory");
            if (path) change("directory", path);
          })}>폴더 선택</button>
        </span></label>
        <button type="button" className="secondary small" disabled={Boolean(busy) || !draft.directory.trim() || needsCredential}
          onClick={() => void perform("capacity", async () => setCapacity(await invoke<Capacity>(`${engine}_backup_capacity`,
            { ...(postgres ? { profile: postgres } : { profileId }), directory: draft.directory })))}>
          용량 확인
        </button>
        {capacity && <p className="form-note" role="status">{postgres ? "원본 크기" : "예상 크기"} {size(capacity.estimated_bytes)}
          {capacity.available_bytes !== null && " · 사용 가능 " + size(capacity.available_bytes)}
          {capacity.available_bytes !== null && capacity.available_bytes < capacity.estimated_bytes && (postgres ? " · 원본보다 여유 공간이 적습니다" : " · 공간 부족")}</p>}
        <div className="backup-plan-fields">
          <label className="field">파일 이름 접두어<input required maxLength={40} pattern="[A-Za-z0-9_\-]+" value={draft.prefix}
            disabled={Boolean(busy)} onChange={event => change("prefix", event.target.value)} /></label>
          <label className="field">보존 기간 (일)<input required type="number" min={1} max={3650} step={1} value={draft.retention}
            disabled={Boolean(busy)} onChange={event => change("retention", event.target.value)} /></label>
        </div>
        <p className="form-note">파일 이름에 UTC 실행 시각과 고유 ID가 붙습니다. 보존 기간이 지난 파일은 실행 이력에서 검토 후 삭제할 수 있습니다.</p>
        <label className="files-check"><input type="checkbox" checked={draft.scheduled} disabled={Boolean(busy)}
          onChange={event => change("scheduled", event.target.checked)} /> 예약 실행</label>
        {draft.scheduled && <div className="backup-plan-fields">
          <label className="field">첫 실행 (이 장치 시각)<input required type="datetime-local" step={1} value={draft.next}
            disabled={Boolean(busy)} onChange={event => change("next", event.target.value)} /></label>
          <label className="field">실행 주기<select value={draft.periodic ? "periodic" : "once"} disabled={Boolean(busy)}
            onChange={event => change("periodic", event.target.value === "periodic")}>
            <option value="once">한 번</option><option value="periodic">일정 간격으로 반복</option>
          </select></label>
          {draft.periodic && <label className="field">간격 (분)<input required type="number" min={1} max={43200} step={1}
            value={draft.minutes} disabled={Boolean(busy)} onChange={event => change("minutes", event.target.value)} /></label>}
        </div>}
        <label className="files-check"><input type="checkbox" checked={draft.retry} disabled={Boolean(busy)}
          onChange={event => change("retry", event.target.checked)} /> 예약 실패 시 1분 뒤 한 번 재시도</label>
        <p className="form-note">앱을 실행 중일 때 백업합니다. 앱이 닫혀 있는 동안 지난 예약은 다음 실행에서 한 번 처리합니다. {postgres ? "백업 파일은 암호화되지 않습니다." : "백업은 전체 SQLite 파일이며 암호화되지 않습니다."}</p>
        {production && <label className="field">운영 백업 확인 (PROD 입력)<input value={confirmation} autoComplete="off"
          disabled={Boolean(busy)} onChange={event => setConfirmation(event.target.value)} /></label>}
        {plan && <p className="form-note">다음 예약 {plan.requires_review ? "설정 검토 필요" : nextAt}
          {!plan.requires_review && plan.retry_at !== null && " · 재시도 " + dateText(plan.retry_at)}</p>}
        {plan?.requires_review && <p className="form-note" role="status">{postgres ? "현재 연결 설정, 백업 위치와 일정을 검토한 뒤 계획을 다시 저장하세요." : "이 작업 공간의 백업 위치와 일정을 검토한 뒤 계획을 저장하세요."}</p>}
        {stale && <p className="form-error" role="alert">다른 창에서 계획이 변경되었습니다. 설정을 새로고침하세요.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="form-note" role="status">{notice}</p>}
        <div className="dialog-actions">
          {stale && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void perform("refresh", async () => {
            apply(await invoke<Snapshot>(`${engine}_backup_plan`, { profileId }));
          })}>설정 새로고침</button>}
          {plan && (postgres || !plan.requires_review) && (plan.next_at !== null || plan.retry_at !== null) && <button type="button" className="secondary"
            disabled={Boolean(busy || dirty || stale)} onClick={() => void perform("pause", async () => {
              apply(await invoke<Snapshot>(`pause_${engine}_backup_plan`, { profileId, revision: plan.revision }));
              setNotice("예약 실행을 중지했습니다.");
            })}>예약 중지</button>}
          <button type="button" className="secondary" disabled={Boolean(busy || !plan || plan.requires_review || dirty || stale || running || needsCredential || approvalMissing)}
            onClick={runNow}>{busy === "run" ? "백업 중…" : "지금 백업"}</button>
          <button type="submit" className="primary" disabled={Boolean(busy || stale || needsCredential || approvalMissing)}>{busy === "save" ? "저장 중…" : "계획 저장"}</button>
        </div>
      </form>
      <section className="backup-run-history" aria-label="백업 실행 이력">
        <h3>실행 이력</h3>
        <div className="backup-file-actions" aria-label="백업 목록 보기" role="group">
          <button type="button" className="secondary small" aria-pressed={!expiredPage} disabled={Boolean(busy)}
            onClick={() => setExpiredPage(null)}>최근 실행</button>
          <button type="button" className="secondary small" aria-pressed={Boolean(expiredPage)} disabled={Boolean(busy)}
            onClick={() => browseExpired(null)}>만료 파일</button>
        </div>
        {fileFeedback && !fileFeedback.error && !runs.some(run => run.id === fileFeedback.runId) &&
          <p className="form-note" role="status">{fileFeedback.text}</p>}
        {runs.length ? runs.map(run => <details key={run.id}>
          <summary>{runStatus[run.status]} · {trigger[run.trigger_kind]} · {dateText(run.started_at)}</summary>
          <p>{displayPath(run.path)}</p>
          {run.size_bytes !== null && <p>백업 크기 {size(run.size_bytes)}
            {run.expires_at !== null && " · 보존 만료 " + dateText(run.expires_at)}</p>}
          {run.message && <p>{run.message}</p>}
          {run.artifact && <>
            <p>백업 엔진 {engineLabel} {run.artifact.engine_version}</p>
            <p>SHA-256 <code>{run.artifact.sha256}</code></p>
            {run.artifact.verified_at !== null && <p>마지막 지문 확인 {dateText(run.artifact.verified_at)}</p>}
            {run.artifact.removed_at !== null ? <p>파일 삭제 완료 {dateText(run.artifact.removed_at)}</p> : <>
              {run.artifact.removal_started_at !== null && <p>삭제 결과 확인 필요</p>}
              {run.artifact.owned_here && <div className="backup-file-actions">
                <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={() => void performFile(run, async () => {
                  const checked = await invoke<number>("verify_sqlite_backup_file", { profileId, runId: run.id });
                  setExpiredPage(current => current && { ...current, runs: current.runs.map(item =>
                    item.id === run.id && item.artifact ? { ...item, artifact: { ...item.artifact, verified_at: checked } } : item) });
                  return "파일 지문이 생성 당시 기록과 일치합니다.";
                })}>파일 지문 확인</button>
                {run.artifact.removal_supported && run.expires_at !== null && run.expires_at <= Date.now() / 1000 &&
                  <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={() => void performFile(run, async () => {
                    const preview = await invoke<RemovalPreview>("preview_sqlite_backup_removal", { profileId, runId: run.id });
                    setRemoval({ run, preview });
                    return "";
                  })}>만료 파일 삭제</button>}
              </div>}
            </>}
          </>}
          {run.status === "succeeded" && !run.artifact && <p>이 백업은 생성 시점의 파일 지문 기록이 없는 이전 형식입니다.</p>}
          {fileFeedback?.runId === run.id && <p className={fileFeedback.error ? "form-error" : "form-note"}
            role={fileFeedback.error ? "alert" : "status"}>{fileFeedback.text}</p>}
        </details>) : <p className="form-note">{expiredPage ? "정리할 만료 파일이 없습니다." : "실행 이력이 없습니다."}</p>}
        {expiredPage?.next_before != null && <button type="button" className="secondary small" disabled={Boolean(busy)}
          onClick={() => browseExpired(expiredPage.next_before)}>더 보기</button>}
      </section>
    </>}
    {removal && <Dialog title="만료 백업 영구 삭제" busy={Boolean(busy)} onClose={() => setRemoval(null)}>
      <form onSubmit={event => {
        event.preventDefault();
        void performFile(removal.run, async () => {
          try {
            const result = await invoke<{ removed_at: number; audit_warning: boolean }>("remove_sqlite_backup_file", {
              token: removal.preview.token, confirmed: true,
            });
            setExpiredPage(current => current && { ...current, runs: current.runs.filter(run => run.id !== removal.run.id) });
            return result.audit_warning ? "파일을 삭제했습니다. 완료 감사 기록을 저장하지 못했습니다." : "만료 백업 파일을 삭제했습니다.";
          } finally { setRemoval(null); }
        });
      }}>
        <p className="confirm-copy">다음 백업 파일 한 개를 디스크에서 영구 삭제합니다.</p>
        <div className="edit-current">
          <p><strong>{profile.name}</strong> <span className={"environment " + profile.environment.toLowerCase()}>{profile.environment}</span></p>
          <p>{displayPath(removal.preview.path)}</p>
          <p>{size(removal.preview.size_bytes)} · 보존 만료 {dateText(removal.preview.expires_at)}</p>
          <p>SHA-256 <code>{removal.preview.sha256}</code></p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setRemoval(null)}>취소</button>
          <button type="submit" className="danger" disabled={Boolean(busy)}>{busy ? "삭제 중…" : "영구 삭제"}</button>
        </div>
      </form>
    </Dialog>}
  </Dialog>;
}
