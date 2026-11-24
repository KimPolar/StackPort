import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive, ChevronDown, ChevronRight, Copy, Database, Ellipsis, FileDown, FileUp, FolderOpen,
  Pencil, Plus, RefreshCw, RotateCcw, Search, Table2, TerminalSquare, Trash2, X, type LucideIcon,
} from "lucide-react";
import type { DatabaseObject } from "./SqlSchemaDetails";
import type { PostgresProfile, PostgresProfileAction } from "./PostgresWorkspace";
import type { SshProfile } from "./ssh-profile-types";
import { networkAddressText } from "./quickConnect";
import { matchesWorkspaceSearch, workspaceSearchTerms } from "./workspaceSearch";
import "./workspaceExplorer.css";

type Project = { id: string; name: string };
type SqliteProfile = { id: string; project_id: string; name: string; path: string; environment: string };
export type ExplorerProjectAction = "create" | "rename" | "duplicate" | "archive" | "delete" | "archived" | "copy";
export type ExplorerSshAction = "create" | "edit" | "delete" | "refresh" | "import" | "export";

type ExplorerProps = {
  desktop: boolean;
  hidden: boolean;
  projectId: string;
  projects: Project[];
  sqlite: {
    profiles: SqliteProfile[]; loadedId: string; active: boolean; objects: DatabaseObject[];
    selected: string | undefined; loading: boolean; displayPath: (path: string) => string;
    open: (id: string) => void; openObject: (item: DatabaseObject) => void; refresh: () => void;
    add: () => void; restore: () => void;
  };
  postgres: { profiles: PostgresProfile[]; activeId: string; open: (id: string) => void; action: (action: PostgresProfileAction) => void };
  ssh: { profiles: SshProfile[]; open: (item: SshProfile) => void; action: (mode: ExplorerSshAction, item?: SshProfile) => void };
  onProjectSelect: (id: string) => void;
  onProjectAction: (action: ExplorerProjectAction) => void;
};

const projectActions = [
  { id: "rename", label: "이름 변경", Icon: Pencil },
  { id: "duplicate", label: "복제", Icon: Copy },
  { id: "archive", label: "보관", Icon: Archive },
  { id: "delete", label: "삭제", Icon: Trash2 },
  { id: "archived", label: "보관된 프로젝트", Icon: Archive },
  { id: "copy", label: "데이터 복사", Icon: FileDown },
] as const;

function ExplorerButton({ label, Icon, onClick, disabled }: {
  label: string; Icon: LucideIcon; onClick: () => void; disabled?: boolean;
}) {
  return <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
    <Icon size={15} aria-hidden />
  </button>;
}

function ExplorerGroup({ id, name, Icon, count, filtering, actions, children }: {
  id: string; name: string; Icon: LucideIcon; count: number; filtering: boolean; actions: ReactNode; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const open = filtering || expanded;
  return <section className="explorer-group" hidden={filtering && !count}>
    <div className="explorer-group-heading">
      {filtering ? <div className="explorer-group-title"><Icon size={14} aria-hidden /><strong>{name}</strong><span>{count}</span></div> :
        <button type="button" className="explorer-group-title" aria-label={name}
          aria-description={`연결 ${count}개`} aria-expanded={open} aria-controls={id} onClick={() => setExpanded(!expanded)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <strong>{name}</strong><span aria-hidden>{count}</span>
        </button>}
      <div className="explorer-group-actions">{actions}</div>
    </div>
    <div className="explorer-group-content" hidden={!open} id={id}>{children}</div>
  </section>;
}

function ExplorerProfile({ name, environment, detail, label, selected, Icon, onOpen, children }: {
  name: string; environment: string; detail: string; label?: string; selected?: boolean; Icon: LucideIcon;
  onOpen: () => void; children?: ReactNode;
}) {
  return <div className="explorer-profile">
    <button type="button" className="profile-row" aria-current={selected ? "true" : undefined}
      aria-label={label ?? `${name} ${environment}`} aria-description={label ? `${detail} · ${environment}` : detail}
      title={detail} onClick={onOpen}>
      <Icon size={15} aria-hidden />
      <span className="explorer-profile-text"><strong>{name}</strong><small>{detail}</small></span>
      <span className={`environment ${environment.toLowerCase()}`}>{environment}</span>
    </button>
    {children && <span className="explorer-profile-actions">{children}</span>}
  </div>;
}

function ObjectGroup({ name, items, selected, onOpen }: {
  name: string; items: DatabaseObject[]; selected: string | undefined; onOpen: (item: DatabaseObject) => void;
}) {
  return items.length > 0 && <div className="object-group">
    <div className="group-title">{name} <span>{items.length}</span></div>
    {items.map(item => <button type="button" key={item.name} className="object-row" title={item.name}
      aria-current={item.name === selected ? "true" : undefined} onClick={() => onOpen(item)}>
      <Table2 size={13} aria-hidden /><span>{item.name}</span>
    </button>)}
  </div>;
}

export function WorkspaceExplorer({ desktop, hidden, projectId, projects, sqlite, postgres, ssh, onProjectSelect, onProjectAction }: ExplorerProps) {
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const project = projects.find(item => item.id === projectId);
  const terms = useMemo(() => workspaceSearchTerms(query), [query]);
  const filtering = terms.length > 0;

  useEffect(() => { setQuery(""); setMenuOpen(false); }, [projectId]);

  const sqliteProfiles = sqlite.profiles.filter(item => item.project_id === projectId);
  const loaded = sqliteProfiles.find(item => item.id === sqlite.loadedId);
  const sqliteFields = (item: SqliteProfile) => [item.name, item.environment, sqlite.displayPath(item.path), "SQLite 데이터베이스"];
  const sqliteMatches = sqliteProfiles.filter(item => matchesWorkspaceSearch(terms, ...sqliteFields(item)));
  const sqliteContext = loaded ? sqliteFields(loaded) : [];
  const objects = loaded && !sqlite.loading ? sqlite.objects.filter(item => matchesWorkspaceSearch(terms,
    item.name, item.kind === "table" ? "테이블 table" : "뷰 view", ...sqliteContext)) : [];
  const visibleSqlite = objects.length && loaded && !sqliteMatches.includes(loaded)
    ? sqliteProfiles.filter(item => item === loaded || sqliteMatches.includes(item)) : sqliteMatches;
  const postgresMatches = postgres.profiles.filter(item => item.project_id === projectId && matchesWorkspaceSearch(terms,
    item.settings.name, item.settings.host, item.settings.port, item.settings.database, item.settings.environment, "PostgreSQL 데이터베이스"));
  const sshMatches = ssh.profiles.filter(item => item.project_id === projectId && matchesWorkspaceSearch(terms,
    item.name, item.host, item.port, item.environment, "SSH 서버"));
  const connections = sqliteMatches.length + postgresMatches.length + sshMatches.length;

  function clearSearch() {
    setQuery("");
    input.current?.focus();
  }

  return <aside className="explorer" id="workspace-explorer" aria-label="작업 공간 탐색기" hidden={hidden}>
    <div className="explorer-fixed">
      <div className="explorer-top">
        <label className="select-label" htmlFor="project-select">프로젝트</label>
        <div className="explorer-header-actions">
          <ExplorerButton label="새 프로젝트" Icon={Plus} onClick={() => onProjectAction("create")} disabled={!desktop} />
          <div className="explorer-project-menu" onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
          }} onKeyDown={event => {
            if (event.key !== "Escape" || !menuOpen) return;
            event.stopPropagation(); setMenuOpen(false); menuButton.current?.focus();
          }}>
            <button type="button" ref={menuButton} className="icon-button" aria-label="프로젝트 관리" title="프로젝트 관리"
              aria-expanded={menuOpen} aria-controls="explorer-project-actions" disabled={!desktop} onClick={() => setMenuOpen(open => !open)}>
              <Ellipsis size={16} aria-hidden />
            </button>
            <div className="explorer-project-actions" id="explorer-project-actions" hidden={!menuOpen}>
              {projectActions.filter(action => project || action.id === "archived" || action.id === "copy").map(({ id, label, Icon }) =>
                <button type="button" className={id === "delete" ? "explorer-delete" : ""} key={id} onClick={() => {
                  setMenuOpen(false); menuButton.current?.focus(); onProjectAction(id);
                }}><Icon size={14} aria-hidden />{label}</button>)}
            </div>
          </div>
        </div>
      </div>
      <div className="project-selector">
        <FolderOpen size={16} aria-hidden />
        <select id="project-select" value={projectId} onChange={event => onProjectSelect(event.target.value)} disabled={!projects.length}>
          {!projects.length && <option value="">프로젝트 없음</option>}
          {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden />
      </div>
      {project && <div className="object-search explorer-search" role="search" aria-label="프로젝트 탐색기 필터">
        <Search size={15} aria-hidden />
        <input ref={input} type="search" aria-label="탐색기 검색" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="연결, 주소, 테이블 찾기" autoComplete="off" spellCheck={false}
          onKeyDown={event => {
            if (event.key !== "Escape" || !query || event.nativeEvent.isComposing) return;
            event.preventDefault(); event.stopPropagation(); clearSearch();
          }} />
        {query && <ExplorerButton label="탐색기 검색 지우기" Icon={X} onClick={clearSearch} />}
      </div>}
    </div>
    <div className="explorer-scroll">
      {!project ? <p className="sidebar-empty">프로젝트를 선택하거나 새 프로젝트를 만드세요.</p> : <>
        {filtering && <p className="explorer-search-status" role="status">
          {connections || objects.length ? `연결 ${connections}개 · 객체 ${objects.length}개` :
            sqlite.loading && loaded ? "SQLite 객체를 불러오는 중…" : "일치하는 연결이나 객체가 없습니다."}
        </p>}
        <ExplorerGroup id="explorer-sqlite" name="SQLite" Icon={Database} count={visibleSqlite.length} filtering={filtering} actions={<>
          <ExplorerButton label="SQLite 백업 복원" Icon={RotateCcw} onClick={sqlite.restore} />
          <ExplorerButton label="SQLite 연결 추가" Icon={Plus} onClick={sqlite.add} />
        </>}>
          {!visibleSqlite.length && <p className="sidebar-empty">저장된 SQLite 연결이 없습니다.</p>}
          {visibleSqlite.map(item => <div key={item.id}>
            <ExplorerProfile name={item.name} environment={item.environment} detail={sqlite.displayPath(item.path)}
              Icon={Database} selected={sqlite.active && item === loaded} onOpen={() => sqlite.open(item.id)} />
            {item === loaded && (sqlite.active || filtering) && <div className="object-list">
              <div className="object-toolbar"><span>객체</span>
                <ExplorerButton label="객체 새로고침" Icon={RefreshCw} onClick={sqlite.refresh} disabled={sqlite.loading} />
              </div>
              {sqlite.loading ? <p className="sidebar-empty" role="status">불러오는 중…</p> :
                !objects.length ? <p className="sidebar-empty">{filtering ? "일치하는 객체가 없습니다." : "테이블이나 뷰가 없습니다."}</p> : <>
                  <ObjectGroup name="테이블" items={objects.filter(item => item.kind === "table")} selected={sqlite.selected} onOpen={sqlite.openObject} />
                  <ObjectGroup name="뷰" items={objects.filter(item => item.kind === "view")} selected={sqlite.selected} onOpen={sqlite.openObject} />
                </>}
            </div>}
          </div>)}
        </ExplorerGroup>
        <ExplorerGroup id="explorer-postgres" name="PostgreSQL" Icon={Database} count={postgresMatches.length} filtering={filtering}
          actions={<ExplorerButton label="PostgreSQL 연결 추가" Icon={Plus} onClick={() => postgres.action({ kind: "create" })} />}>
          {!postgresMatches.length && <p className="sidebar-empty">저장된 PostgreSQL 연결이 없습니다.</p>}
          {postgresMatches.map(item => <ExplorerProfile key={item.id} name={item.settings.name} environment={item.settings.environment}
            detail={`${networkAddressText(item.settings)} / ${item.settings.database}`} label={`PostgreSQL ${item.settings.name} 열기`}
            Icon={Database} selected={item.id === postgres.activeId} onOpen={() => postgres.open(item.id)}>
            <ExplorerButton label={`${item.settings.name} PostgreSQL 연결 수정`} Icon={Pencil} onClick={() => postgres.action({ kind: "edit", profile: item })} />
            <ExplorerButton label={`${item.settings.name} PostgreSQL 연결 삭제`} Icon={Trash2} onClick={() => postgres.action({ kind: "delete", profile: item })} />
          </ExplorerProfile>)}
        </ExplorerGroup>
        <ExplorerGroup id="explorer-ssh" name="SSH" Icon={TerminalSquare} count={sshMatches.length} filtering={filtering} actions={<>
          <ExplorerButton label="SSH 연결 가져오기" Icon={FileUp} onClick={() => ssh.action("import")} />
          <ExplorerButton label="SSH 연결 내보내기" Icon={FileDown} onClick={() => ssh.action("export")}
            disabled={!ssh.profiles.some(item => item.project_id === projectId)} />
          <ExplorerButton label="SSH 연결 새로고침" Icon={RefreshCw} onClick={() => ssh.action("refresh")} />
          <ExplorerButton label="SSH 연결 추가" Icon={Plus} onClick={() => ssh.action("create")} />
        </>}>
          {!sshMatches.length && <p className="sidebar-empty">저장된 SSH 연결이 없습니다.</p>}
          {sshMatches.map(item => <ExplorerProfile key={item.id} name={item.name} environment={item.environment}
            detail={`${item.username}@${networkAddressText(item)}`} label={`SSH ${item.name} 연결`} Icon={TerminalSquare} onOpen={() => ssh.open(item)}>
            <ExplorerButton label={`${item.name} SSH 연결 수정`} Icon={Pencil} onClick={() => ssh.action("edit", item)} />
            <ExplorerButton label={`${item.name} SSH 연결 삭제`} Icon={Trash2} onClick={() => ssh.action("delete", item)} />
          </ExplorerProfile>)}
        </ExplorerGroup>
      </>}
    </div>
  </aside>;
}
