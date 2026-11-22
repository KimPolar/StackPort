import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  ArrowLeft, ArrowRight, Archive, Boxes, ChevronDown, ChevronRight, CircleHelp,
  Database, FileCode2, FolderOpen, HardDrive, History, Layers3,
  Plus, RefreshCw, Search, ShieldCheck, Table2, Trash2, X, Play,
} from "lucide-react";
import "./styles.css";

type Project = { id: string; name: string };
type Profile = { id: string; project_id: string; name: string; path: string; environment: "DEV" | "STAGING" | "PROD" };
type DatabaseObject = { name: string; kind: string; ddl: string | null };
type ColumnInfo = { position: number; name: string; declared_type: string; not_null: boolean; default_value: string | null; primary_key_position: number; hidden: number };
type IndexInfo = { name: string; unique: boolean; origin: string; partial: boolean; columns: { position: number; name: string | null; descending: boolean; collation: string | null }[] };
type ForeignKeyInfo = { id: number; sequence: number; target_table: string; from_column: string; to_column: string | null; on_update: string; on_delete: string };
type ObjectDetails = { object: DatabaseObject; columns: ColumnInfo[]; indexes: IndexInfo[]; foreign_keys: ForeignKeyInfo[] };
type Cell = { kind: string; display: string; truncated: boolean };
type QueryPage = { columns: string[]; rows: Cell[][]; page: number; has_more: boolean };
type BackupReport = { path: string; size_bytes: number; integrity: "ok"; audit_warning: string | null };
type AuditEvent = { sequence: number; id: string; correlation_id: string; occurred_at: string; actor: string; operation: string; project_id: string | null; profile_id: string | null; environment: string | null; object_name: string | null; outcome: string; policy: string; affected_count: number | null };
type AuditPage = { events: AuditEvent[]; next_cursor: number | null };
type Modal = "project" | "profile" | "rename" | "deleteProject" | "deleteProfile" | "backup" | null;

const desktop = isTauri();
const call = <T,>(command: string, args?: Record<string, unknown>): Promise<T> => invoke<T>(command, args);
const errorText = (error: unknown) => typeof error === "string" ? error : String(error);
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const displayPath = (path: string) => path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.startsWith("\\\\?\\") ? path.slice(4) : path;

function Dialog({ title, children, onClose, busy }: { title: string; children: React.ReactNode; onClose: () => void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="dialog" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    {children}
  </dialog>;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [objects, setObjects] = useState<DatabaseObject[]>([]);
  const [selectedObject, setSelectedObject] = useState<DatabaseObject | null>(null);
  const [objectDetails, setObjectDetails] = useState<ObjectDetails | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [sql, setSql] = useState("");
  const [executedSql, setExecutedSql] = useState("");
  const [result, setResult] = useState<QueryPage | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [environment, setEnvironment] = useState<Profile["environment"]>("DEV");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [backupReport, setBackupReport] = useState<BackupReport | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const queryGeneration = useRef(0);
  const objectGeneration = useRef(0);
  const detailsGeneration = useRef(0);
  // Drafts stay in memory: SQL can contain sensitive literals, so the editor
  // must not silently write them to browser storage or workspace metadata.
  const drafts = useRef<Record<string, string>>({});
  const project = projects.find(item => item.id === projectId);
  const profile = profiles.find(item => item.id === profileId);

  const reloadProjects = useCallback(async (select?: string) => {
    const next = await call<Project[]>("list_projects");
    setProjects(next);
    setProjectId(current => select ?? (next.some(item => item.id === current) ? current : next[0]?.id ?? ""));
  }, []);

  const reloadProfiles = useCallback(async (id: string, select?: string) => {
    const next = await call<Profile[]>("list_profiles", { projectId: id });
    setProfiles(next);
    setProfileId(current => select ?? (next.some(item => item.id === current) ? current : ""));
  }, []);

  useEffect(() => {
    if (desktop) reloadProjects().catch(e => setError(errorText(e)));
  }, [reloadProjects]);

  useEffect(() => {
    let live = true;
    objectGeneration.current++;
    setProfiles([]); setProfileId(""); setObjects([]); setResult(null); setSql(""); setExecutedSql("");
    queryGeneration.current++;
    if (projectId) {
      call<Profile[]>("list_profiles", { projectId }).then(items => { if (live) setProfiles(items); }).catch(e => { if (live) setError(errorText(e)); });
    }
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    let live = true;
    const generation = ++objectGeneration.current;
    setObjects([]); setResult(null); setSql(drafts.current[profileId] ?? ""); setExecutedSql(""); setError("");
    detailsGeneration.current++; setSelectedObject(null); setObjectDetails(null); setDetailsError(""); setDetailsLoading(false);
    setBackupReport(null);
    queryGeneration.current++;
    setQuerying(false);
    if (profileId) {
      setLoading(true);
      call<DatabaseObject[]>("list_objects", { profileId })
        .then(items => { if (live && objectGeneration.current === generation) setObjects(items); })
        .catch(e => { if (live && objectGeneration.current === generation) setError(errorText(e)); })
        .finally(() => { if (live && objectGeneration.current === generation) setLoading(false); });
    } else setLoading(false);
    return () => { live = false; };
  }, [profileId]);

  useEffect(() => {
    function warnBeforeClose(event: BeforeUnloadEvent) {
      if (Object.values(drafts.current).some(draft => draft.trim())) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, []);

  function changeSql(value: string) {
    setSql(value);
    if (profileId) drafts.current[profileId] = value;
  }

  function openObject(object: DatabaseObject) {
    const query = `SELECT *\nFROM ${quoteIdentifier(object.name)};`;
    if (sql.trim() && sql !== query && !window.confirm("현재 편집 중인 SQL을 선택한 객체의 조회문으로 바꾸시겠습니까?")) return;
    const generation = ++detailsGeneration.current;
    setSelectedObject(object); setObjectDetails(null); setDetailsError(""); setDetailsLoading(true);
    call<ObjectDetails>("describe_object", { profileId, name: object.name })
      .then(details => { if (detailsGeneration.current === generation) setObjectDetails(details); })
      .catch(e => { if (detailsGeneration.current === generation) setDetailsError(errorText(e)); })
      .finally(() => { if (detailsGeneration.current === generation) setDetailsLoading(false); });
    changeSql(query);
    void runQuery(query);
  }

  async function refreshObjects() {
    if (!profileId) return;
    const generation = ++objectGeneration.current;
    detailsGeneration.current++; setSelectedObject(null); setObjectDetails(null); setDetailsError(""); setDetailsLoading(false);
    setLoading(true); setError("");
    try {
      const items = await call<DatabaseObject[]>("list_objects", { profileId });
      if (objectGeneration.current === generation) setObjects(items);
    } catch (e) { if (objectGeneration.current === generation) setError(errorText(e)); }
    finally { if (objectGeneration.current === generation) setLoading(false); }
  }

  async function runQuery(query: string, page = 0) {
    if (!profileId || !query.trim()) return;
    const generation = ++queryGeneration.current;
    setQuerying(true); setError("");
    if (query !== executedSql) setResult(null);
    try {
      const response = await call<QueryPage>("run_query", { profileId, sql: query, page });
      if (queryGeneration.current === generation) { setResult(response); setExecutedSql(query); }
    } catch (e) { if (queryGeneration.current === generation) setError(errorText(e)); }
    finally { if (queryGeneration.current === generation) setQuerying(false); }
  }

  function openModal(next: Modal) {
    setFormError(""); setName(next === "rename" ? project?.name ?? "" : "");
    setPath(""); setEnvironment("DEV"); setModal(next);
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setFormError("");
    try {
      if (modal === "project") {
        const created = await call<Project>("create_project", { name });
        await reloadProjects(created.id);
      } else if (modal === "rename" && project) {
        await call("rename_project", { id: project.id, name });
        await reloadProjects(project.id);
      } else if (modal === "profile" && project) {
        const created = await call<Profile>("create_sqlite_profile", { projectId: project.id, name, path, environment });
        await reloadProfiles(project.id, created.id);
      } else if (modal === "deleteProject" && project) {
        await call("delete_project", { id: project.id });
        for (const item of profiles) delete drafts.current[item.id];
        await reloadProjects();
      } else if (modal === "deleteProfile" && project && profile) {
        await call("delete_profile", { id: profile.id });
        delete drafts.current[profile.id];
        await reloadProfiles(project.id, "");
      } else if (modal === "backup" && profile) {
        const report = await call<BackupReport>("backup_sqlite", { profileId: profile.id, destination: path });
        setBackupReport(report);
      }
      setModal(null);
    } catch (e) { setFormError(errorText(e)); }
    finally { setSaving(false); }
  }

  const filtered = objects.filter(item => item.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const tables = filtered.filter(item => item.kind === "table");
  const views = filtered.filter(item => item.kind === "view");

  return <div className="app-shell">
    <aside className="rail" aria-label="기본 탐색">
      <div className="brand-mark" aria-label="StackPort"><Layers3 size={22} strokeWidth={2.2} /></div>
      <div className="rail-active" title="작업 공간"><Boxes size={20} /><span>워크스페이스</span></div>
      <div className="rail-bottom"><CircleHelp size={19} /><span>로컬 우선</span></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="brand-name">StackPort <span className="brand-divider">/</span> <span className="brand-section">워크스페이스</span></div>
        <div className="top-right"><button className="history-button" disabled={!desktop} onClick={() => setHistoryOpen(current => !current)} aria-pressed={historyOpen}><History size={15} /> 작업 기록</button><span className="offline-indicator"><span /> 로컬 작업 공간</span><span className="version">EARLY ACCESS</span></div>
      </header>
      <div className="body-layout">
        <aside className="explorer" aria-label="작업 공간 탐색기">
          <div className="explorer-top"><span>탐색기</span><button className="icon-button" onClick={() => openModal("project")} disabled={!desktop} aria-label="새 프로젝트"><Plus size={17} /></button></div>
          <label className="select-label" htmlFor="project-select">프로젝트</label>
          <div className="project-selector"><FolderOpen size={16} /><select id="project-select" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={!projects.length}>
            {!projects.length && <option value="">프로젝트 없음</option>}
            {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select><ChevronDown size={15} /></div>
          {project && <div className="project-actions"><button onClick={() => openModal("rename")}>이름 변경</button><button onClick={() => openModal("deleteProject")}>삭제</button></div>}
          <div className="section-heading"><span>데이터베이스</span><button className="icon-button" onClick={() => openModal("profile")} disabled={!project} aria-label="SQLite 연결 추가"><Plus size={16} /></button></div>
          {!profiles.length && <p className="sidebar-empty">{project ? "저장된 연결이 없습니다." : "프로젝트를 먼저 만드세요."}</p>}
          <div className="profile-list">{profiles.map(item => <button key={item.id} className={`profile-row ${item.id === profileId ? "selected" : ""}`} onClick={() => setProfileId(item.id)}>
            {item.id === profileId ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Database size={15} /><span>{item.name}</span><small>{item.environment}</small>
          </button>)}</div>
          {profile && <div className="object-list">
            <div className="object-toolbar"><span>객체</span><button className="icon-button" onClick={refreshObjects} disabled={loading} aria-label="객체 새로고침"><RefreshCw size={14} /></button></div>
            <div className="object-search"><Search size={14} /><input aria-label="객체 검색" value={filter} onChange={e => setFilter(e.target.value)} placeholder="이름으로 찾기" /></div>
            {loading ? <p className="sidebar-empty">불러오는 중…</p> : <>
              <ObjectGroup name="테이블" items={tables} onSelect={openObject} />
              <ObjectGroup name="뷰" items={views} onSelect={openObject} />
            </>}
          </div>}
          <div className="explorer-foot"><ShieldCheck size={15} /><span>연결 정보는 이 장치에 저장됩니다.</span></div>
        </aside>
        <main className="main-content">
          {historyOpen ? <AuditPanel onBack={() => setHistoryOpen(false)} /> : !desktop ? <EmptyState title="데스크톱 앱에서 시작하세요" text="브라우저에서 로컬 파일에 직접 연결할 수 없습니다. 브라우저용 게이트웨이는 아직 제공되지 않습니다." /> :
          !project ? <EmptyState title="작업을 시작해 보세요" text="프로젝트를 만들고 SQLite 데이터베이스를 연결하세요." action="프로젝트 만들기" onAction={() => openModal("project")} /> :
          !profile ? <EmptyState title="데이터베이스를 연결하세요" text="기존 SQLite 파일을 읽기 전용으로 열어 테이블을 살펴볼 수 있습니다." action="SQLite 연결 추가" onAction={() => openModal("profile")} /> : <>
            <div className="content-header"><div><div className="breadcrumbs">{project.name} <ChevronRight size={14} /> 데이터베이스</div><h1><Database size={21} /> {profile.name} <span className={`environment ${profile.environment.toLowerCase()}`}>{profile.environment}</span></h1><p className="path"><HardDrive size={13} /> {displayPath(profile.path)}</p></div>
              <div className="header-actions"><span className="readonly"><ShieldCheck size={15} /> 읽기 전용</span><button className="secondary" onClick={() => openModal("backup")}><Archive size={14} /> 백업</button><button className="icon-button" aria-label="연결 삭제" onClick={() => openModal("deleteProfile")}><Trash2 size={16} /></button></div>
            </div>
            {backupReport && <div className="success-banner" role="status"><strong>백업 생성 완료 · 무결성 검사 통과</strong><span>{displayPath(backupReport.path)} · {new Intl.NumberFormat("ko-KR").format(backupReport.size_bytes)} bytes</span><span>격리된 환경에서의 복원 테스트는 수행하지 않았습니다.</span>{backupReport.audit_warning && <strong className="audit-warning">{backupReport.audit_warning}</strong>}</div>}
            <div className="editor-card"><div className="panel-heading"><div><FileCode2 size={16} /><strong>SQL 편집기</strong><span className="subtle">SQLite</span></div><button className="primary small" disabled={querying || !sql.trim()} onClick={() => void runQuery(sql)}><Play size={14} fill="currentColor" /> {querying ? "실행 중…" : "쿼리 실행"}</button></div>
              <label className="sr-only" htmlFor="sql-editor">SQL 쿼리</label><textarea id="sql-editor" spellCheck={false} value={sql} onChange={e => changeSql(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void runQuery(sql); } }} placeholder={'SELECT *\nFROM 테이블_이름;'} />
              <div className="editor-footer"><span>읽기 전용 SQL · 초안은 현재 실행 중에만 보관됩니다</span><span>Ctrl + Enter 실행</span></div>
            </div>
            {error && <div className="error-banner" role="alert"><strong>작업을 완료하지 못했습니다.</strong> {error}</div>}
            {selectedObject && <SchemaDetails object={selectedObject} details={objectDetails} loading={detailsLoading} error={detailsError} />}
            <div className="results-card"><div className="panel-heading"><div><Table2 size={16} /><strong>쿼리 결과</strong>{result && <span className="result-count">{result.rows.length}개 행</span>}</div><span className="subtle">페이지당 최대 100개 행</span></div>
              {result ? <><div className="table-wrap"><table><thead><tr><th scope="col" className="row-number">#</th>{result.columns.map((column, i) => <th scope="col" key={i}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex}><td className="row-number">{result.page * 100 + rowIndex + 1}</td>{row.map((cell, index) => <td key={index} className={cell.kind === "null" ? "null-cell" : ""} title={cell.truncated ? "표시 길이를 초과하여 일부만 표시됩니다." : undefined}>{cell.display}{cell.truncated ? "…" : ""}</td>)}</tr>)}</tbody></table>{result.rows.length === 0 && <p className="result-empty">조회된 행이 없습니다.</p>}</div>
                <div className="pagination"><span>페이지 {result.page + 1}{result.has_more ? " · 다음 페이지 있음" : " · 마지막 페이지"}</span><div><button className="icon-button" disabled={!result.page || querying} onClick={() => void runQuery(executedSql, result.page - 1)} aria-label="이전 페이지"><ArrowLeft size={16} /></button><button className="icon-button" disabled={!result.has_more || querying} onClick={() => void runQuery(executedSql, result.page + 1)} aria-label="다음 페이지"><ArrowRight size={16} /></button></div></div></> : <div className="result-placeholder"><Table2 size={24} /><strong>아직 조회 결과가 없습니다</strong><span>테이블을 선택하거나 SQL을 실행해 보세요.</span></div>}
            </div>
          </>}
          {!profile && error && <div className="error-banner" role="alert">{error}</div>}
        </main>
      </div>
      <footer className="statusbar"><span><span className="status-dot" /> {desktop ? "데스크톱 · 로컬 모드" : "브라우저 · 게이트웨이 미연결"}</span><span>SQLite 읽기 전용 <span className="status-separator">|</span> SSH 및 기타 DB 준비 중</span></footer>
    </div>
    {modal && <Dialog title={{ project: "새 프로젝트", profile: "SQLite 연결 추가", rename: "프로젝트 이름 변경", deleteProject: "프로젝트 삭제", deleteProfile: "연결 삭제", backup: "SQLite 백업" }[modal]} onClose={() => setModal(null)} busy={saving}><form onSubmit={submitForm} aria-busy={saving}>
      {(modal === "project" || modal === "rename" || modal === "profile") && <label className="field">이름<input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder={modal === "profile" ? "예: 로컬 데이터베이스" : "프로젝트 이름"} /></label>}
      {modal === "profile" && <><label className="field">SQLite 파일 경로<span className="file-input"><input required value={path} onChange={e => setPath(e.target.value)} placeholder="기존 데이터베이스 파일 선택" /><button type="button" className="secondary" onClick={async () => { try { const chosen = await call<string | null>("choose_sqlite_file"); if (chosen) setPath(chosen); } catch (e) { setFormError(errorText(e)); } }}>찾아보기</button></span></label><label className="field">환경<select value={environment} onChange={e => setEnvironment(e.target.value as Profile["environment"])}><option>DEV</option><option>STAGING</option><option>PROD</option></select></label><p className="form-note">기존 파일만 열 수 있으며, 이 연결은 읽기 전용입니다.</p></>}
      {modal === "backup" && <><p className="confirm-copy">원본: <strong>{profile?.name}</strong><br />{profile && displayPath(profile.path)}</p><label className="field">새 백업 파일 경로<span className="file-input"><input required disabled={saving} value={path} onChange={e => setPath(e.target.value)} placeholder="절대 경로를 입력하세요" /><button type="button" className="secondary" disabled={saving} onClick={async () => { try { const folder = await call<string | null>("choose_backup_directory"); if (folder) setPath(`${folder}${folder.endsWith("\\") || folder.endsWith("/") ? "" : folder.includes("\\") ? "\\" : "/"}stackport-backup.sqlite`); } catch (e) { setFormError(errorText(e)); } }}>폴더 선택</button></span></label><p className="form-note">전체 데이터베이스를 백업하고 무결성을 검사합니다. 기존 파일은 덮어쓰지 않습니다. 백업은 암호화되지 않으므로 저장 폴더의 접근 권한을 확인하세요.</p></>}
      {modal === "deleteProject" && <p className="confirm-copy"><strong>{project?.name}</strong> 프로젝트와 연결 정의 {profiles.length}개, 해당 연결의 SQL 초안을 삭제합니다. 원본 데이터베이스 파일은 삭제되지 않습니다.</p>}
      {modal === "deleteProfile" && <p className="confirm-copy"><strong>{profile?.name}</strong> 연결 정의와 SQL 초안을 삭제합니다. 원본 데이터베이스 파일은 삭제되지 않습니다.</p>}
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={saving} onClick={() => setModal(null)}>취소</button><button type="submit" disabled={saving} className={modal.startsWith("delete") ? "danger" : "primary"}>{saving ? "처리 중…" : modal.startsWith("delete") ? "삭제" : modal === "backup" ? "백업 만들기" : "저장"}</button></div>
    </form></Dialog>}
  </div>;
}

const auditOperationNames: Record<string, string> = {
  "project.create": "프로젝트 생성", "project.rename": "프로젝트 이름 변경", "project.delete": "프로젝트 삭제",
  "sqlite_profile.create": "SQLite 연결 추가", "sqlite_profile.delete": "SQLite 연결 삭제", "sqlite.backup": "SQLite 백업",
};
const auditOutcomeNames: Record<string, string> = { started: "시작", succeeded: "완료", failed: "실패" };

function AuditPanel({ onBack }: { onBack: () => void }) {
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    call<AuditPage>("list_audit_events", { before: cursor })
      .then(result => { if (live) setPage(result); })
      .catch(e => { if (live) setError(errorText(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [cursor, refresh]);

  return <section className="audit-panel" aria-labelledby="audit-title">
    <div className="audit-header"><div><button className="back-button" onClick={onBack}><ArrowLeft size={15} /> 작업 공간으로</button><h1 id="audit-title">작업 기록</h1><p>이 장치의 프로젝트·연결 변경과 SQLite 백업을 기록합니다.</p></div><button className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /> 새로고침</button></div>
    <p className="audit-note">SQL, 행 데이터, 암호와 파일 경로는 기록하지 않습니다. 실행자는 로컬 사용자로만 표시되며 개인 계정 식별과 변조 방지는 아직 제공되지 않습니다.</p>
    {error && <div className="error-banner" role="alert">기록을 불러오지 못했습니다: {error}</div>}
    <div className="audit-card" aria-busy={loading}>
      {loading ? <p className="audit-empty">기록을 불러오는 중…</p> : page?.events.length ? <ul className="audit-list">{page.events.map(event => <li key={event.id}>
        <div className="audit-row"><div><strong>{auditOperationNames[event.operation] ?? event.operation}</strong> <span className={`audit-outcome ${event.outcome}`}>{auditOutcomeNames[event.outcome] ?? event.outcome}</span><p>{new Date(event.occurred_at).toLocaleString("ko-KR")} · 로컬 사용자{event.environment ? ` · ${event.environment}` : ""}{event.affected_count !== null ? ` · ${event.affected_count}개 항목` : ""}</p></div><details><summary>상세</summary><dl><dt>이벤트 ID</dt><dd>{event.id}</dd><dt>작업 ID</dt><dd>{event.correlation_id}</dd>{event.project_id && <><dt>프로젝트 ID</dt><dd>{event.project_id}</dd></>}{event.profile_id && <><dt>연결 ID</dt><dd>{event.profile_id}</dd></>}{event.object_name && <><dt>객체</dt><dd>{event.object_name}</dd></>}<dt>정책</dt><dd>{event.policy}</dd></dl></details></div>
      </li>)}</ul> : <p className="audit-empty">아직 기록된 작업이 없습니다.</p>}
      <div className="pagination"><span>최대 100개씩 표시</span><div><button className="secondary" disabled={loading || cursors.length === 1} onClick={() => setCursors(items => items.slice(0, -1))}>이전</button><button className="secondary" disabled={loading || !page?.next_cursor} onClick={() => { if (page?.next_cursor) setCursors(items => [...items, page.next_cursor]); }}>이전 기록 더 보기</button></div></div>
    </div>
  </section>;
}

function SchemaDetails({ object, details, loading, error }: { object: DatabaseObject; details: ObjectDetails | null; loading: boolean; error: string }) {
  return <details className="schema-card"><summary><span><Table2 size={15} /> <strong>{object.name}</strong> 구조</span><span className="subtle">{loading ? "불러오는 중…" : details ? `열 ${details.columns.length} · 인덱스 ${details.indexes.length} · 외래 키 ${details.foreign_keys.length}` : "상세 보기"}</span></summary>
    <div className="schema-content" aria-busy={loading}>
      {error && <p className="form-error" role="alert">구조를 불러오지 못했습니다: {error}</p>}
      {details && <><p className="form-note">조회 시점의 구조입니다. 데이터 수정은 아직 지원하지 않습니다.</p>
        <h2>열</h2><div className="table-wrap"><table aria-label={`${object.name} 열 구조`}><thead><tr><th scope="col">이름</th><th scope="col">형식</th><th scope="col">NULL 허용</th><th scope="col">기본값</th><th scope="col">키 / 특성</th></tr></thead><tbody>{details.columns.map(column => <tr key={column.position}><td>{column.name}</td><td>{column.declared_type || "지정 없음"}</td><td>{column.not_null ? "아니요" : "명시 안 됨"}</td><td>{column.default_value ?? "없음"}</td><td>{column.primary_key_position ? `PK ${column.primary_key_position}` : column.hidden === 2 ? "가상 생성 열" : column.hidden === 3 ? "저장 생성 열" : column.hidden ? "숨김 열" : "—"}</td></tr>)}</tbody></table></div>
        <h2>인덱스</h2>{details.indexes.length ? <ul className="schema-list">{details.indexes.map(index => <li key={index.name}><strong>{index.name}</strong><span>{index.unique ? "UNIQUE · " : ""}{index.partial ? "부분 인덱스 · " : ""}{index.columns.map(column => `${column.name ?? "(표현식)"}${column.descending ? " DESC" : ""}${column.collation ? ` COLLATE ${column.collation}` : ""}`).join(", ")}</span></li>)}</ul> : <p className="form-note">인덱스가 없습니다.</p>}
        <h2>외래 키</h2>{details.foreign_keys.length ? <ul className="schema-list">{details.foreign_keys.map(key => <li key={`${key.id}-${key.sequence}`}><strong>{key.from_column} → {key.target_table}.{key.to_column ?? "(기본 키)"}</strong><span>그룹 {key.id} · 순서 {key.sequence + 1} · 삭제 {key.on_delete} · 수정 {key.on_update}</span></li>)}</ul> : <p className="form-note">외래 키가 없습니다.</p>}
        <h2>생성 SQL</h2><pre className="schema-ddl">{details.object.ddl ?? "생성 SQL을 사용할 수 없습니다."}</pre>
      </>}
    </div>
  </details>;
}

function ObjectGroup({ name, items, onSelect }: { name: string; items: DatabaseObject[]; onSelect: (object: DatabaseObject) => void }) {
  return <section className="object-group"><div className="group-title"><ChevronDown size={13} /> {name} <span>{items.length}</span></div>{items.map(object => <button key={object.name} className="object-row" onClick={() => onSelect(object)}><Table2 size={14} /><span>{object.name}</span></button>)}</section>;
}

function EmptyState({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><div className="empty-icon"><Layers3 size={27} /></div><h1>{title}</h1><p>{text}</p>{action && <button className="primary" onClick={onAction}><Plus size={16} /> {action}</button>}<div className="capability-note"><ShieldCheck size={16} /><span>현재 SQLite 읽기 전용 탐색을 지원합니다.<br />다른 프로토콜과 데이터베이스는 준비 중입니다.</span></div></div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
