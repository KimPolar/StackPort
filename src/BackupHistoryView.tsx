import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import {
  BackupPlanDialog, backupRunStatus, backupRunTrigger, formatBackupSize, formatBackupTime, type BackupRun,
} from "./BackupPlanDialog";
import type { PostgresProfile } from "./PostgresWorkspace";
import { networkAddressText } from "./quickConnect";

type HistoryEntry = BackupRun & {
  engine: "SQLite" | "PostgreSQL";
  project_id: string; project_name: string; profile_id: string; profile_name: string; archived: boolean;
};
type HistoryProject = { id: string; name: string; archived: boolean };
type Cursor = { started_at: number; rowid: number };
type HistoryPage = { entries: HistoryEntry[]; projects: HistoryProject[]; next_before: Cursor | null };
type SQLiteProfile = { id: string; name: string; path: string; environment: string };
type PlanTarget = { projectId: string; profile: SQLiteProfile; postgres?: PostgresProfile };

export type BackupHistoryViewProps = {
  displayPath: (path: string) => string;
  onFileBusy: (busy: boolean) => void;
  onOpenTunnels: (projectId: string) => void;
};

export function BackupHistoryView({ displayPath, onFileBusy, onOpenTunnels }: BackupHistoryViewProps) {
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [trigger, setTrigger] = useState("");
  const [projects, setProjects] = useState<HistoryProject[]>([]);
  const [cursors, setCursors] = useState<(Cursor | null)[]>([null]);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const [target, setTarget] = useState<PlanTarget | null>(null);
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    let live = true;
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const result = await invoke<HistoryPage>("list_backup_history", {
          filter: { project_id: project || null, status: status || null, trigger_kind: trigger || null }, before: cursor,
        });
        if (!live) return;
        setProjects(result.projects);
        if (project && !result.projects.some(item => item.id === project)) {
          setProject("");
          setCursors([null]);
          return;
        }
        setError("");
        setPage(result);
      } catch (cause) {
        if (live) setError(String(cause));
      } finally {
        pending = false;
        if (live) setLoading(false);
      }
    }
    setPage(null);
    setLoading(true);
    setError("");
    void load();
    const timer = cursor === null ? window.setInterval(() => void load(), 3000) : undefined;
    return () => { live = false; window.clearInterval(timer); };
  }, [project, status, trigger, cursor, refresh]);

  async function openPlan(entry: HistoryEntry) {
    if (opening || entry.archived) return;
    setOpening(true);
    setOpenError("");
    const projectId = entry.project_id;
    try {
      if (entry.engine === "PostgreSQL") {
        const profiles = await invoke<PostgresProfile[]>("list_postgres_profiles", { projectId });
        const postgres = profiles.find(profile => profile.id === entry.profile_id);
        if (!postgres) throw new Error("백업 계획의 연결을 찾을 수 없습니다.");
        const { id, settings } = postgres;
        const { name, environment, database } = settings;
        setTarget({ projectId, postgres, profile: { id, name, environment, path: networkAddressText(settings) + " / " + database } });
      } else {
        const profiles = await invoke<SQLiteProfile[]>("list_profiles", { projectId });
        const profile = profiles.find(item => item.id === entry.profile_id);
        if (!profile) throw new Error("백업 계획의 연결을 찾을 수 없습니다.");
        setTarget({ projectId, profile });
      }
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  }

  return <section aria-label="백업 실행 기록">
    <div className="backup-history-filters">
      <label className="field">프로젝트<select value={project} disabled={projects.length === 0}
        onChange={event => { setProject(event.target.value); setCursors([null]); }}>
        <option value="">전체 프로젝트</option>
        {projects.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? " (보관됨)" : ""}</option>)}
      </select></label>
      <label className="field">실행 상태<select value={status} onChange={event => { setStatus(event.target.value); setCursors([null]); }}>
        <option value="">전체 상태</option>
        {Object.entries(backupRunStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="field">실행 방식<select value={trigger} onChange={event => { setTrigger(event.target.value); setCursors([null]); }}>
        <option value="">전체 방식</option>
        {Object.entries(backupRunTrigger).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <button type="button" className="secondary" disabled={loading}
        onClick={() => { setCursors([null]); setRefresh(value => value + 1); }}><RefreshCw size={14} aria-hidden /> 새로고침</button>
    </div>
    {(error || openError) && <p className="form-error" role="alert">{openError || error}</p>}
    <div className="audit-card" aria-busy={loading}>
      {loading ? <p className="audit-empty" role="status">백업 기록을 불러오는 중…</p> : page?.entries.length ? <ul className="audit-list">
        {page.entries.map(entry => <li key={entry.id} className="backup-history-entry">
          <div className="backup-history-row">
            <div>
              <strong>{entry.profile_name}</strong>
              <span className={`audit-outcome ${entry.status === "timed_out" ? "failed" : entry.status}`}>{backupRunStatus[entry.status]}</span>
              <p>{entry.project_name}{entry.archived && " (보관됨)"} · {entry.engine} · {backupRunTrigger[entry.trigger_kind]}
                {entry.retry_attempt !== null && ` (${entry.retry_attempt}차)`} · {formatBackupTime(entry.started_at)}</p>
            </div>
            {!entry.archived && <button type="button" className="secondary small" disabled={opening}
              onClick={() => void openPlan(entry)}>백업 계획 열기</button>}
          </div>
          {entry.message && <p className="backup-history-message">{entry.message}</p>}
          {(entry.scheduled_at !== null || entry.path || entry.size_bytes !== null) && <details className="backup-history-detail">
            <summary>상세</summary>
            <dl>
              {entry.scheduled_at !== null && <><dt>예정 시각</dt><dd>{formatBackupTime(entry.scheduled_at)}</dd></>}
              {entry.status !== "skipped" && entry.finished_at !== null && <><dt>실행 시간</dt>
                <dd>{(entry.finished_at - entry.started_at).toLocaleString("ko-KR")}초</dd></>}
              {entry.size_bytes !== null && <><dt>백업 크기</dt><dd>{formatBackupSize(entry.size_bytes)}</dd></>}
              {entry.path && <><dt>파일 경로</dt><dd>{displayPath(entry.path)}</dd></>}
              {entry.artifact?.removed_at != null && <><dt>파일 삭제 완료</dt><dd>{formatBackupTime(entry.artifact.removed_at)}</dd></>}
            </dl>
          </details>}
        </li>)}
      </ul> : !error && <p className="audit-empty">선택한 조건의 백업 기록이 없습니다.</p>}
      <div className="pagination"><span>{cursors.length}페이지</span><div>
        <button type="button" className="secondary" disabled={loading || cursors.length === 1}
          onClick={() => setCursors(items => items.slice(0, -1))}>이전 페이지</button>
        <button type="button" className="secondary" disabled={loading || !page?.next_before} onClick={() => {
          if (page?.next_before) setCursors(items => [...items, page.next_before]);
        }}>이전 기록 더 보기</button>
      </div></div>
    </div>
    {target && <BackupPlanDialog key={target.profile.id} profile={target.profile} postgres={target.postgres}
      displayPath={displayPath} onClose={() => setTarget(null)} onFileBusy={onFileBusy}
      onOpenTunnels={() => onOpenTunnels(target.projectId)} />}
  </section>;
}
