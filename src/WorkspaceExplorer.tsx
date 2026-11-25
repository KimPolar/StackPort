import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive, ChevronDown, ChevronRight, Copy, Database, Ellipsis, FileDown, FileUp, FolderOpen,
  KeyRound, Pencil, Plus, RefreshCw, RotateCcw, Search, Star, Table2, TerminalSquare, Trash2, X, type LucideIcon,
} from "lucide-react";
import type { DatabaseObject } from "./SqlSchemaDetails";
import type { PostgresProfile, PostgresProfileAction, PostgresConnection } from "./PostgresWorkspace";
import type { RedisProfile, RedisProfileAction } from "./RedisProfileDialog";
import type { PostgresSearchPage } from "./PostgresSearchDialog";
import { postgresObjectLabels } from "./PostgresObjectStructure";
import type { MysqlProfile, MysqlProfileAction } from "./MysqlProfileDialog";
import { PostgresPager } from "./PostgresPager";
import { usePostgresRead } from "./usePostgresRead";
import type { SshProfile } from "./ssh-profile-types";
import { networkAddressText } from "./quickConnect";
import { matchesWorkspaceSearch, workspaceSearchTerms } from "./workspaceSearch";
import { favoriteKey, favoriteScopeNames as scopeNames, type FavoriteScope, type FavoriteTarget, type PostgresFavorite, type WorkspaceFavorites } from "./workspaceFavorites";
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
  favorites: WorkspaceFavorites;
  favoriteScope: FavoriteScope;
  onFavoriteScope: (scope: FavoriteScope) => void;
  sqlite: {
    profiles: SqliteProfile[]; loadedId: string; active: boolean; objects: DatabaseObject[];
    selected: string | undefined; loading: boolean; displayPath: (path: string) => string;
    open: (id: string) => void; openObject: (item: DatabaseObject) => void; openPinnedObject: (id: string, name: string) => void; refresh: () => void;
    restore: () => void;
  };
  postgres: {
    profiles: PostgresProfile[]; activeId: string; connection: PostgresConnection | null;
    open: (id: string) => void; openObject: (object: PostgresFavorite) => void; action: (action: PostgresProfileAction) => void;
  };
  redis: { profiles: RedisProfile[]; activeId: string; open: (id: string) => void; action: (action: RedisProfileAction) => void };
  mysql: { profiles: MysqlProfile[]; activeId: string; open: (id: string) => void; action: (action: MysqlProfileAction) => void };
  ssh: { profiles: SshProfile[]; open: (item: SshProfile) => void; action: (mode: ExplorerSshAction, item?: SshProfile) => void };
  onProjectSelect: (id: string) => void;
  onProjectAction: (action: ExplorerProjectAction) => void;
  onAddDatabase: () => void;
};

const projectActions = [
  { id: "rename", label: "이름 변경", Icon: Pencil },
  { id: "duplicate", label: "복제", Icon: Copy },
  { id: "archive", label: "보관", Icon: Archive },
  { id: "delete", label: "삭제", Icon: Trash2 },
  { id: "archived", label: "보관된 프로젝트", Icon: Archive },
  { id: "copy", label: "데이터 복사", Icon: FileDown },
] as const;

function ExplorerButton({ label, Icon, onClick, disabled, pressed, busy }: {
  label: string; Icon: LucideIcon; onClick: () => void; disabled?: boolean; pressed?: boolean; busy?: boolean;
}) {
  return <button type="button" className="icon-button" aria-label={label} title={label} onClick={busy ? undefined : onClick}
    disabled={disabled} aria-disabled={busy || undefined} aria-pressed={pressed}>
    <Icon size={15} aria-hidden />
  </button>;
}

function ExplorerGroup({ id, name, Icon, count, filtering, actions, children, unit = "연결" }: {
  id: string; name: string; Icon: LucideIcon; count: number; filtering: boolean; actions: ReactNode; children: ReactNode; unit?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const open = filtering || expanded;
  return <section className="explorer-group" hidden={filtering && !count}>
    <div className="explorer-group-heading">
      {filtering ? <div className="explorer-group-title"><Icon size={14} aria-hidden /><strong>{name}</strong><span>{count}</span></div> :
        <button type="button" className="explorer-group-title" aria-label={name}
          aria-description={`${unit} ${count}개`} aria-expanded={open} aria-controls={id} onClick={() => setExpanded(!expanded)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <strong>{name}</strong><span aria-hidden>{count}</span>
        </button>}
      <div className="explorer-group-actions">{actions}</div>
    </div>
    <div className="explorer-group-content" hidden={!open} id={id}>{children}</div>
  </section>;
}

function ExplorerProfile({ name, environment, detail, engine, label, selected, Icon, onOpen, children }: {
  name: string; environment: string; detail: string; label?: string; selected?: boolean; Icon: LucideIcon;
  engine?: string;
  onOpen: () => void; children?: ReactNode;
}) {
  return <div className="explorer-profile">
    <button type="button" className="profile-row" aria-current={selected ? "true" : undefined}
      aria-label={label ?? `${name} ${environment}`} aria-description={[engine, detail, label && environment].filter(Boolean).join(" · ")}
      title={detail} onClick={onOpen}>
      <Icon size={15} aria-hidden />
      <span className="explorer-profile-text"><strong>{name}</strong><small>
        {engine && <span className="explorer-profile-engine">{engine}</span>}<span>{detail}</span>
      </small></span>
      <span className={`environment ${environment.toLowerCase()}`}>{environment}</span>
    </button>
    {children && <span className="explorer-profile-actions">{children}</span>}
  </div>;
}

function ObjectGroup({ name, items, selected, onOpen, favoriteAction }: {
  name: string; items: DatabaseObject[]; selected: string | undefined; onOpen: (item: DatabaseObject) => void;
  favoriteAction: (item: DatabaseObject) => ReactNode;
}) {
  return items.length > 0 && <div className="object-group">
    <div className="group-title">{name} <span>{items.length}</span></div>
    {items.map(item => <div className="explorer-object" key={item.name}>
      <button type="button" className="object-row" title={item.name}
        aria-current={item.name === selected ? "true" : undefined} onClick={() => onOpen(item)}>
        <Table2 size={13} aria-hidden /><span>{item.name}</span>
      </button>
      {favoriteAction(item)}
    </div>)}
  </div>;
}

export function WorkspaceExplorer({ desktop, hidden, projectId, projects, favorites, favoriteScope, onFavoriteScope,
  sqlite, postgres, redis, mysql, ssh, onProjectSelect, onProjectAction, onAddDatabase }: ExplorerProps) {
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [remoteSearch, setRemoteSearch] = useState<{ id: string; term: string; page: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const scopeButtons = useRef<HTMLDivElement>(null);
  const project = projects.find(item => item.id === projectId);
  const terms = useMemo(() => workspaceSearchTerms(query), [query]);
  const filtering = terms.length > 0;

  useEffect(() => { setQuery(""); setMenuOpen(false); setRemoteSearch(null); }, [projectId]);

  const sqliteProfiles = sqlite.profiles.filter(item => item.project_id === projectId);
  const postgresProfiles = postgres.profiles.filter(item => item.project_id === projectId);
  const pg = postgres.connection;
  const activePostgres = pg && postgresProfiles.find(item => item.id === postgres.activeId && item.id === pg.profileId && item.revision === pg.revision);
  const term = query.trim();
  const submitted = activePostgres && remoteSearch?.id === pg?.id && remoteSearch?.term === term ? remoteSearch : null;
  const remoteArgs = useMemo(() => submitted && ({ id: submitted.id,
    input: { schema: null, kind: null, field: "name", term: submitted.term, page: submitted.page } }), [submitted]);
  const pgSearch = usePostgresRead<PostgresSearchPage>("search_postgres_objects", remoteArgs);
  const sshProfiles = ssh.profiles.filter(item => item.project_id === projectId);
  const loaded = sqliteProfiles.find(item => item.id === sqlite.loadedId);
  const sqliteFields = (item: SqliteProfile) => [item.name, item.environment, sqlite.displayPath(item.path), "SQLite 데이터베이스"];
  const sqliteMatches = sqliteProfiles.filter(item => matchesWorkspaceSearch(terms, ...sqliteFields(item)));
  const sqliteContext = loaded ? sqliteFields(loaded) : [];
  const objects = loaded && !sqlite.loading ? sqlite.objects.filter(item => matchesWorkspaceSearch(terms,
    item.name, item.kind === "table" ? "테이블 table" : "뷰 view", ...sqliteContext)) : [];
  const visibleSqlite = objects.length && loaded && !sqliteMatches.includes(loaded)
    ? sqliteProfiles.filter(item => item === loaded || sqliteMatches.includes(item)) : sqliteMatches;
  const postgresMatches = postgresProfiles.filter(item => matchesWorkspaceSearch(terms,
    item.settings.name, item.settings.host, item.settings.port, item.settings.database, item.settings.environment, "PostgreSQL 데이터베이스"));
  const visiblePostgres = submitted && activePostgres && !postgresMatches.includes(activePostgres)
    ? postgresProfiles.filter(item => item === activePostgres || postgresMatches.includes(item)) : postgresMatches;
  const sshMatches = sshProfiles.filter(item => matchesWorkspaceSearch(terms,
    item.name, item.host, item.port, item.environment, "SSH 서버"));
  const redisMatches = redis.profiles.filter(item => item.project_id === projectId && matchesWorkspaceSearch(terms,
    item.settings.name, item.settings.host, item.settings.port, item.settings.database, item.settings.environment, "Redis 데이터베이스"));
  const mysqlMatches = mysql.profiles.filter(item => item.project_id === projectId && matchesWorkspaceSearch(terms,
    item.settings.name, item.settings.host, item.settings.port, item.settings.database ?? undefined, item.settings.environment, "MySQL MariaDB 데이터베이스"));
  const databaseItems = [
    ...visibleSqlite.map(item => ({ engine: "sqlite" as const, name: item.name, item })),
    ...visiblePostgres.map(item => ({ engine: "postgres" as const, name: item.settings.name, item })),
    ...(desktop ? mysqlMatches.map(item => ({ engine: "mysql" as const, name: item.settings.name, item })) : []),
    ...(desktop ? redisMatches.map(item => ({ engine: "redis" as const, name: item.settings.name, item })) : []),
  ].sort((left, right) => left.name.localeCompare(right.name, "ko", { numeric: true }));
  const connections = sqliteMatches.length + postgresMatches.length + redisMatches.length + mysqlMatches.length + sshMatches.length;
  const pinned = new Set(favorites.items.filter(item => item.scope === favoriteScope).map(item => favoriteKey(item.target)));

  function favoriteEntry(target: FavoriteTarget) {
    if (target.kind === "ssh") {
      const profile = sshProfiles.find(item => item.id === target.profile_id);
      return profile && { name: profile.name, detail: `SSH · ${networkAddressText(profile)}`, environment: profile.environment,
        Icon: TerminalSquare, open: () => ssh.open(profile) };
    }
    if (target.kind === "postgres" || target.kind === "postgres_object") {
      const profile = postgresProfiles.find(item => item.id === target.profile_id);
      if (target.kind === "postgres_object") return profile && { name: `${target.schema_name}.${target.object_name}`,
        detail: `PostgreSQL · ${profile.settings.name}`, environment: profile.settings.environment,
        Icon: Table2, open: () => postgres.openObject(target) };
      return profile && { name: profile.settings.name, detail: `PostgreSQL · ${networkAddressText(profile.settings)} / ${profile.settings.database}`, environment: profile.settings.environment,
        Icon: Database, open: () => postgres.open(profile.id) };
    }
    const profile = sqliteProfiles.find(item => item.id === target.profile_id);
    if (!profile) return undefined;
    if (target.kind === "sqlite_object") return { name: target.object_name, detail: `SQLite · ${profile.name}`, environment: profile.environment,
      Icon: Table2, open: () => sqlite.openPinnedObject(profile.id, target.object_name) };
    return { name: profile.name, detail: `SQLite · ${sqlite.displayPath(profile.path)}`, environment: profile.environment,
      Icon: Database, open: () => sqlite.open(profile.id) };
  }

  const visibleFavorites = favorites.items.flatMap(item => {
    if (!filtering && item.scope !== favoriteScope) return [];
    const entry = favoriteEntry(item.target);
    return entry && matchesWorkspaceSearch(terms, entry.name, entry.detail, entry.environment, scopeNames[item.scope], "즐겨찾기")
      ? [{ ...item, ...entry, id: `${item.scope}:${favoriteKey(item.target)}` }] : [];
  });

  function favoriteButton(target: FavoriteTarget, name: string, sessionId?: string) {
    const current = pinned.has(favoriteKey(target));
    return desktop && <ExplorerButton Icon={Star} label={`${name} ${scopeNames[favoriteScope]} 즐겨찾기`} pressed={current}
      disabled={!favorites.ready} busy={favorites.busy} onClick={() => void favorites.change(favoriteScope, target, !current, sessionId)} />;
  }

  function clearSearch() {
    setQuery("");
    setRemoteSearch(null);
    input.current?.focus();
  }

  function databaseEntry(entry: (typeof databaseItems)[number]) {
    if (entry.engine === "sqlite") {
      const item = entry.item;
      return <div key={`sqlite:${item.id}`}>
        <ExplorerProfile name={item.name} environment={item.environment} detail={sqlite.displayPath(item.path)} engine="SQLite"
          Icon={Database} selected={sqlite.active && item === loaded} onOpen={() => sqlite.open(item.id)}>
          {favoriteButton({ kind: "sqlite", profile_id: item.id }, item.name)}
        </ExplorerProfile>
        {item === loaded && (sqlite.active || filtering) && <div className="object-list">
          <div className="object-toolbar"><span>객체</span>
            <ExplorerButton label="객체 새로고침" Icon={RefreshCw} onClick={sqlite.refresh} disabled={sqlite.loading} />
          </div>
          {sqlite.loading ? <p className="sidebar-empty" role="status">불러오는 중…</p> :
            !objects.length ? <p className="sidebar-empty">{filtering ? "일치하는 객체가 없습니다." : "테이블이나 뷰가 없습니다."}</p> : <>
              <ObjectGroup name="테이블" items={objects.filter(item => item.kind === "table")} selected={sqlite.selected} onOpen={sqlite.openObject}
                favoriteAction={object => favoriteButton({ kind: "sqlite_object", profile_id: item.id, object_name: object.name }, object.name)} />
              <ObjectGroup name="뷰" items={objects.filter(item => item.kind === "view")} selected={sqlite.selected} onOpen={sqlite.openObject}
                favoriteAction={object => favoriteButton({ kind: "sqlite_object", profile_id: item.id, object_name: object.name }, object.name)} />
            </>}
        </div>}
      </div>;
    }
    if (entry.engine === "postgres") {
      const item = entry.item;
      return <div key={`postgres:${item.id}`}>
        <ExplorerProfile name={item.settings.name} environment={item.settings.environment}
          detail={`${networkAddressText(item.settings)} / ${item.settings.database}`} engine="PostgreSQL" label={`PostgreSQL ${item.settings.name} 열기`}
          Icon={Database} selected={item.id === postgres.activeId} onOpen={() => postgres.open(item.id)}>
          {favoriteButton({ kind: "postgres", profile_id: item.id }, item.settings.name)}
          <ExplorerButton label={`${item.settings.name} PostgreSQL 연결 수정`} Icon={Pencil} onClick={() => postgres.action({ kind: "edit", profile: item })} />
          <ExplorerButton label={`${item.settings.name} PostgreSQL 연결 삭제`} Icon={Trash2} onClick={() => postgres.action({ kind: "delete", profile: item })} />
        </ExplorerProfile>
        {item === activePostgres && submitted && <div className="object-list explorer-postgres-results" role="group" aria-label="PostgreSQL 서버 검색 결과">
          {pgSearch.loading && <p className="sidebar-empty" role="status">PostgreSQL 객체를 검색하는 중…</p>}
          {pgSearch.error && <p className="sidebar-empty" role="alert">{pgSearch.error}</p>}
          {pgSearch.data && <>
            {pgSearch.data.hits.length ? <p className="group-title">객체 {pgSearch.data.hits.length}개</p> :
              <p className="sidebar-empty" role="status">일치하는 PostgreSQL 객체가 없습니다.</p>}
            {pgSearch.data.hits.map(hit => {
              const target: PostgresFavorite = { kind: "postgres_object", profile_id: item.id, schema_name: hit.schema, object_name: hit.name };
              const qualified = `${hit.schema}.${hit.name}`;
              return <div className="explorer-object" key={hit.id}>
                <button type="button" className="object-row explorer-postgres-object" title={qualified}
                  aria-label={`PostgreSQL 객체 ${qualified} 열기`} onClick={() => postgres.openObject(target)}>
                  <Table2 size={13} aria-hidden />
                  <span><strong>{hit.name}</strong><small>{hit.schema} · {postgresObjectLabels[hit.kind]}</small></span>
                </button>
                {favoriteButton(target, `검색 결과 ${qualified}`, submitted.id)}
              </div>;
            })}
            <PostgresPager label="PostgreSQL 객체" page={submitted.page} next={pgSearch.data.has_next}
              change={page => setRemoteSearch({ ...submitted, page })} />
          </>}
        </div>}
      </div>;
    }
    if (entry.engine === "mysql") {
      const item = entry.item;
      return <ExplorerProfile key={`mysql:${item.id}`} name={item.settings.name} environment={item.settings.environment}
        detail={networkAddressText(item.settings)} engine="MySQL · MariaDB" label={`MySQL ${item.settings.name} 열기`}
        Icon={Database} selected={item.id === mysql.activeId} onOpen={() => mysql.open(item.id)}>
        <ExplorerButton label={`${item.settings.name} MySQL 연결 수정`} Icon={Pencil} onClick={() => mysql.action({ kind: "edit", profile: item })} />
        <ExplorerButton label={`${item.settings.name} MySQL 연결 삭제`} Icon={Trash2} onClick={() => mysql.action({ kind: "delete", profile: item })} />
      </ExplorerProfile>;
    }
    const item = entry.item;
    return <ExplorerProfile key={`redis:${item.id}`} name={item.settings.name} environment={item.settings.environment}
      detail={`${networkAddressText(item.settings)} / DB ${item.settings.database}`} engine="Redis" label={`Redis ${item.settings.name} 열기`}
      Icon={KeyRound} selected={item.id === redis.activeId} onOpen={() => redis.open(item.id)}>
      <ExplorerButton label={`${item.settings.name} Redis 연결 수정`} Icon={Pencil} onClick={() => redis.action({ kind: "edit", profile: item })} />
      <ExplorerButton label={`${item.settings.name} Redis 연결 삭제`} Icon={Trash2} onClick={() => redis.action({ kind: "delete", profile: item })} />
    </ExplorerProfile>;
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
        <input ref={input} type="search" aria-label="탐색기 검색" value={query} onChange={event => { setQuery(event.target.value); setRemoteSearch(null); }}
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
          {connections || objects.length || visibleFavorites.length ? `연결 ${connections}개 · 객체 ${objects.length}개${visibleFavorites.length ? ` · 즐겨찾기 ${visibleFavorites.length}개` : ""}` :
            sqlite.loading && loaded ? "SQLite 객체를 불러오는 중…" : submitted ? "로컬 탐색기 결과 0개" : "일치하는 연결이나 객체가 없습니다."}
        </p>}
        {filtering && activePostgres && pg && <button type="button" className="secondary small explorer-postgres-search"
          aria-label={`PostgreSQL ${activePostgres.settings.name}에서 객체 검색`} title={activePostgres.settings.database}
          onClick={() => setRemoteSearch({ id: pg.id, term, page: 0 })}>
          <Database size={14} aria-hidden /><span>{activePostgres.settings.name}에서 검색</span>
        </button>}
        {favorites.error && <div className="explorer-favorite-error">
          <p role="alert">{favorites.error}</p>
          <button type="button" className="secondary small" onClick={() => void favorites.refresh()}>즐겨찾기 다시 읽기</button>
        </div>}
        {desktop && <ExplorerGroup id="explorer-favorites" name="즐겨찾기" unit="즐겨찾기" Icon={Star}
          count={visibleFavorites.length} filtering={filtering} actions={<div ref={scopeButtons} className="explorer-favorite-scopes" role="group" aria-label="즐겨찾기 범위">
            {(Object.entries(scopeNames) as [FavoriteScope, string][]).map(([scope, label]) =>
              <button type="button" key={scope} aria-pressed={scope === favoriteScope} onClick={() => onFavoriteScope(scope)}>{label}</button>)}
          </div>}>
          {!visibleFavorites.length && <p className="sidebar-empty">
            {favorites.ready ? "연결이나 객체의 별을 눌러 추가하세요." : "즐겨찾기를 불러오는 중…"}
          </p>}
          {visibleFavorites.map(entry => <ExplorerProfile key={entry.id} name={entry.name} environment={entry.environment}
            detail={filtering ? `${scopeNames[entry.scope]} · ${entry.detail}` : entry.detail}
            label={`${scopeNames[entry.scope]} 즐겨찾기 ${entry.name} 열기`} Icon={entry.Icon} onOpen={entry.open}>
            <ExplorerButton Icon={Star} pressed={true} label={`${entry.name} ${scopeNames[entry.scope]} 즐겨찾기 해제`}
              busy={favorites.busy} onClick={() => {
                if (filtering) input.current?.focus();
                else scopeButtons.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
                void favorites.change(entry.scope, entry.target, false);
              }} />
          </ExplorerProfile>)}
        </ExplorerGroup>}
        <ExplorerGroup id="explorer-databases" name="데이터베이스" Icon={Database} count={databaseItems.length} filtering={filtering} actions={<>
          <ExplorerButton label="SQLite 백업 복원" Icon={RotateCcw} onClick={sqlite.restore} />
          <ExplorerButton label="데이터베이스 연결 추가" Icon={Plus} onClick={onAddDatabase} />
        </>}>
          {!databaseItems.length && <p className="sidebar-empty">저장된 데이터베이스 연결이 없습니다.</p>}
          {databaseItems.map(databaseEntry)}
        </ExplorerGroup>
        <ExplorerGroup id="explorer-ssh" name="SSH" Icon={TerminalSquare} count={sshMatches.length} filtering={filtering} actions={<>
          <ExplorerButton label="SSH 연결 가져오기" Icon={FileUp} onClick={() => ssh.action("import")} />
          <ExplorerButton label="SSH 연결 내보내기" Icon={FileDown} onClick={() => ssh.action("export")}
            disabled={!sshProfiles.length} />
          <ExplorerButton label="SSH 연결 새로고침" Icon={RefreshCw} onClick={() => ssh.action("refresh")} />
          <ExplorerButton label="SSH 연결 추가" Icon={Plus} onClick={() => ssh.action("create")} />
        </>}>
          {!sshMatches.length && <p className="sidebar-empty">저장된 SSH 연결이 없습니다.</p>}
          {sshMatches.map(item => <ExplorerProfile key={item.id} name={item.name} environment={item.environment}
            detail={`${item.username}@${networkAddressText(item)}`} label={`SSH ${item.name} 연결`} Icon={TerminalSquare} onOpen={() => ssh.open(item)}>
            {favoriteButton({ kind: "ssh", profile_id: item.id }, item.name)}
            <ExplorerButton label={`${item.name} SSH 연결 수정`} Icon={Pencil} onClick={() => ssh.action("edit", item)} />
            <ExplorerButton label={`${item.name} SSH 연결 삭제`} Icon={Trash2} onClick={() => ssh.action("delete", item)} />
          </ExplorerProfile>)}
        </ExplorerGroup>
      </>}
    </div>
  </aside>;
}
