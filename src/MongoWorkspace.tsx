import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Database, Download, Plug, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { Dialog } from "./Dialog";
import { mongoAddress, type MongoProfile } from "./MongoProfileDialog";
import { DatabasePasswordField, useDatabaseCredentials } from "./DatabasePasswordField";
import { MongoSchemaAnalysis } from "./MongoSchemaAnalysis";
import { MongoDocumentList, type MongoDocumentPage } from "./MongoDocumentList";
import { MongoDocumentExportDialog, type MongoDocumentQuery } from "./MongoDocumentExportDialog";
import { MongoDocumentImportDialog, MongoDocumentImportReport, type MongoImportReport } from "./MongoDocumentImportDialog";
import { MongoDocumentEditDialog, type MongoDocumentChange } from "./MongoDocumentEditDialog";
import { MongoFindBuilder, type MongoFindState } from "./MongoFindBuilder";
import { MongoIndexDialog, mongoIndexActionLabels, type MongoIndexAction } from "./MongoIndexDialog";
import { MongoNamespaceDialog, type MongoNamespaceReport, type MongoValidationSettings, type MongoViewSettings } from "./MongoNamespaceDialog";
import { MongoCollectionActionDialog, type MongoCollectionAction } from "./MongoCollectionActionDialog";
import { MongoPipeline } from "./MongoPipeline";
import { MongoArchiveDialog, MongoArchiveReport, type MongoArchiveResult } from "./MongoArchiveDialog";
import { ResultFileReport, type ExportReport } from "./ResultExportDialog";
import { useNativeRead } from "./usePostgresRead";
import "./mongoWorkspace.css";

type Session = { id: string; database: string | null; allow_edits: boolean; allow_indexes: boolean; allow_namespaces: boolean;
  credential_warning: string | null };
type Page<T> = { items: T[]; has_next: boolean };
type Collection = { name: string; kind: string };
type Index = { name: string; keys: string; unique: boolean; ttl_seconds: number | null; ttl_eligible: boolean; hidden: boolean };
const defaultQuery: MongoDocumentQuery = { filter: "", projection: "", sort_field: "_id", descending: false, page: 0 };
const displayNumber = new Intl.NumberFormat("ko-KR");

export function MongoWorkspace({ profile, onBusy }: { profile: MongoProfile; onBusy: (busy: boolean) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const credentials = useDatabaseCredentials("mongo", login ? profile : null);
  const [confirmation, setConfirmation] = useState("");
  const [allowEdits, setAllowEdits] = useState(false);
  const [allowIndexes, setAllowIndexes] = useState(false);
  const [allowNamespaces, setAllowNamespaces] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const { settings } = profile;
  const production = settings.environment === "PROD";
  const permission = [session?.allow_edits && "문서 편집", session?.allow_indexes && "인덱스 관리",
    session?.allow_namespaces && "컬렉션·뷰 관리"].filter(Boolean).join(" · ");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void invoke("close_mongo", { id: active.current }).catch(() => {});
    };
  }, []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (pending.current || credentials.clearing) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const next = await invoke<Session>("open_mongo", {
        profileId: profile.id, revision: profile.revision, ...credentials.take(), confirmation, allowEdits, allowIndexes, allowNamespaces,
      });
      if (!mounted.current) { await invoke("close_mongo", { id: next.id }); return; }
      active.current = next.id; setSession(next); setLogin(false);
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  function disconnect() {
    const id = active.current;
    if (!id) return;
    active.current = null; setSession(null); setError("");
    void invoke("close_mongo", { id }).catch(cause => { if (mounted.current) setError(String(cause)); });
  }

  return <section className="mongo-workspace" aria-label="MongoDB 작업 공간">
    <div className="content-header">
      <div className="database-target">
        <h1><Database size={21} aria-hidden /><span>{settings.name}</span><span className={`environment ${settings.environment.toLowerCase()}`}>{settings.environment}</span></h1>
        <p className="path">MongoDB · {mongoAddress(settings.uri)}</p>
      </div>
      <div className="header-actions">
        <span className="readonly"><ShieldCheck size={14} aria-hidden /> {permission ? `${permission} 허용` : "읽기 전용"}</span>
        {session ? <button type="button" className="secondary" onClick={disconnect}>MongoDB 연결 끊기</button> :
          <button type="button" className="primary" onClick={() => {
            setError(""); setConfirmation(""); setAllowEdits(false); setAllowIndexes(false); setAllowNamespaces(false); setLogin(true);
          }}><Plug size={15} aria-hidden /> MongoDB 연결</button>}
      </div>
    </div>
    {error && !login && <p className="error-banner" role="alert">{error}</p>}
    {session?.credential_warning && <p className="form-note" role="status">{session.credential_warning}</p>}
    {session && <Browse key={session.id} session={session} profile={profile} onBusy={onBusy} />}
    {login && <Dialog title="MongoDB 연결" busy={busy || credentials.clearing} onClose={() => { setLogin(false); setError(""); }}>
      <form onSubmit={event => void connect(event)} aria-busy={busy}>
        <p className="confirm-copy"><strong>{settings.name} · {settings.environment}</strong><br />{mongoAddress(settings.uri)}</p>
        <DatabasePasswordField credentials={credentials} disabled={busy} acceptsPassword={Boolean(settings.username)} allowRemember autoFocus />
        {production && <label className="field">운영 환경 확인<input required placeholder="PROD" autoComplete="off"
          value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
        <label className="mongo-edit-permission"><input type="checkbox" checked={allowEdits} disabled={busy}
          onChange={event => setAllowEdits(event.target.checked)} /> 이 연결에서 문서 편집 허용</label>
        <label className="mongo-edit-permission"><input type="checkbox" checked={allowIndexes} disabled={busy}
          onChange={event => setAllowIndexes(event.target.checked)} /> 이 연결에서 인덱스 관리 허용</label>
        <label className="mongo-edit-permission"><input type="checkbox" checked={allowNamespaces} disabled={busy}
          onChange={event => setAllowNamespaces(event.target.checked)} /> 이 연결에서 컬렉션·뷰 관리 허용</label>
        {!settings.tls && <p className="form-note">일반 TCP는 암호와 데이터를 평문으로 전송합니다.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="submit" className="primary" disabled={busy || credentials.clearing || (production && confirmation !== "PROD")}>{busy ? "연결 중…" : "연결"}</button></div>
      </form>
    </Dialog>}
  </section>;
}

function Browse({ session, profile, onBusy }: {
  session: Session; profile: MongoProfile; onBusy: (busy: boolean) => void;
}) {
  const projectId = profile.project_id;
  const { name: profileName, environment } = profile.settings;
  const [database, setDatabase] = useState(session.database);
  const [collection, setCollection] = useState<Collection | null>(null);
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [collectionAction, setCollectionAction] = useState<{ database: string; name: string; action: MongoCollectionAction } | null>(null);
  const [namespaceNotice, setNamespaceNotice] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveResult, setArchiveResult] = useState<MongoArchiveResult | null>(null);
  const databaseArgs = useMemo(() => ({ id: session.id }), [session.id]);
  const collectionArgs = useMemo(() => ({ id: session.id, database }), [session.id, database]);
  const mutableCollection = collection?.kind === "collection" && !collection.name.startsWith("system.");
  const manageCollection = session.allow_namespaces && mutableCollection
    && database !== null && !["admin", "config", "local"].includes(database);
  const archiveDatabase = database && !["admin", "config", "local"].includes(database) ? database : null;

  function created(result: MongoNamespaceReport) {
    setCreating(false);
    setDatabase(result.database);
    setCollection({ name: result.name, kind: result.kind });
    setRevision(value => value + 1);
    setNamespaceNotice(result.database + "." + result.name + (result.kind === "view" ? " 뷰" : " 컬렉션") + " 생성 완료."
      + (result.audit_warning ? " 완료 감사 기록을 저장하지 못했습니다." : ""));
  }

  function collectionActionDone(result: MongoNamespaceReport) {
    if (!collectionAction) return;
    const renaming = collectionAction.action === "rename";
    setCollectionAction(null);
    setCollection(renaming ? { name: result.name, kind: result.kind } : null);
    setRevision(value => value + 1);
    const outcome = renaming ? collectionAction.name + " → " + result.name + " 이름 변경 완료."
      : result.name + " 컬렉션 삭제 완료.";
    setNamespaceNotice(result.database + "." + outcome
      + (result.audit_warning ? " 완료 감사 기록을 저장하지 못했습니다." : ""));
  }

  return <div className="mongo-layout">
    <div className="mongo-catalog">
      <Catalog<string> title="데이터베이스" command="mongo_databases" args={databaseArgs} revision={revision}
        name={item => item} selected={database} onOpen={item => { setDatabase(item); setCollection(null); }}
        action={(archiveDatabase || session.allow_namespaces) && <div className="mongo-actions">
          {(archiveDatabase || session.allow_namespaces) && <button type="button" className="secondary small" onClick={() => { setArchiveResult(null); setArchiveOpen(true); }}>
            {!archiveDatabase ? "복원" : session.allow_namespaces ? "백업·복원" : "백업"}
          </button>}
          {session.allow_namespaces && <button type="button" className="secondary small"
            onClick={() => { setNamespaceNotice(""); setCreating(true); }}>컬렉션·뷰 만들기</button>}
        </div>} />
      {database && <Catalog<Collection> key={database} title="컬렉션과 뷰" command="mongo_collections" args={collectionArgs} revision={revision}
        name={item => item.name} detail={item => item.kind === "view" ? "뷰" : item.kind === "timeseries" ? "시계열" : "컬렉션"}
        selected={collection?.name ?? null} onOpen={setCollection} />}
      {namespaceNotice && <p className="form-note mongo-note" role="status">{namespaceNotice}</p>}
      {archiveResult && <MongoArchiveReport result={archiveResult} />}
    </div>
    {database && collection
      ? <CollectionContent key={JSON.stringify([database, collection.name])} id={session.id} database={database} collection={collection}
        projectId={projectId} revision={revision} refresh={() => setRevision(value => value + 1)}
        allowEdits={session.allow_edits && mutableCollection} allowIndexes={session.allow_indexes && mutableCollection}
        allowDefinitionEdits={manageCollection || (session.allow_namespaces && collection.kind === "view")}
        onCollectionAction={manageCollection
          ? action => { setNamespaceNotice(""); setCollectionAction({ database, name: collection.name, action }); } : undefined}
        profileName={profileName} environment={environment} onBusy={onBusy} />
      : <section className="results-card"><p className="result-empty">데이터베이스와 컬렉션을 선택하세요.</p></section>}
    {creating && <MongoNamespaceDialog id={session.id} initialDatabase={database ?? ""} initialSource={collection?.name ?? ""}
      environment={environment} onBusy={onBusy} onClose={() => setCreating(false)} onDone={created} />}
    {collectionAction && <MongoCollectionActionDialog id={session.id} {...collectionAction} environment={environment}
      onBusy={onBusy} onClose={() => setCollectionAction(null)} onDone={collectionActionDone} />}
    {archiveOpen && <MongoArchiveDialog id={session.id} database={archiveDatabase} profile={profile}
      currentCollection={mutableCollection ? collection?.name : undefined} environment={environment}
      allowRestore={session.allow_namespaces} onBusy={onBusy} onClose={() => setArchiveOpen(false)}
      onDone={result => {
        setArchiveOpen(false); setArchiveResult(result);
        if (result.kind === "restore") {
          setDatabase(result.report.database);
          setCollection(result.report.collection ? { name: result.report.collection, kind: "collection" } : null);
          setRevision(value => value + 1);
        }
      }} />}
  </div>;
}

function Catalog<T>({ title, command, args, revision, name, detail, selected, onOpen, action }: {
  title: string; command: string; args: Record<string, unknown>; revision: number;
  name: (item: T) => string; detail?: (item: T) => string; selected: string | null; onOpen: (item: T) => void; action?: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const input = useMemo(() => ({ ...args, search, page }), [args, search, page]);
  const result = useNativeRead<Page<T>>(command, input, revision);

  return <section className="results-card" aria-label={`MongoDB ${title} 목록`}>
    <div className="panel-heading"><h2>{title}</h2>{action}</div>
    <form className="mongo-search" onSubmit={event => { event.preventDefault(); setSearch(draft); setPage(0); }}>
      <input type="search" aria-label={`${title} 검색`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={128} />
      <button type="submit" className="secondary small">검색</button>
    </form>
    <ReadStatus {...result} />
    <ul className="mongo-catalog-list">{result.data?.items.map(item => <li key={name(item)}>
      <button type="button" className="object-row" aria-current={selected === name(item) ? "true" : undefined} onClick={() => onOpen(item)}>
        <span>{name(item)}</span>{detail && <small>{detail(item)}</small>}
      </button>
    </li>)}</ul>
    <Pager label={`${title} 페이지`} page={page} next={result.data?.has_next === true} loading={result.loading} change={setPage} />
  </section>;
}

function CollectionContent({ id, database, collection, projectId, revision, refresh, allowEdits, allowIndexes, allowDefinitionEdits, onCollectionAction, profileName, environment, onBusy }: {
  id: string; database: string; collection: Collection; projectId: string; revision: number; refresh: () => void;
  allowEdits: boolean; allowIndexes: boolean; allowDefinitionEdits: boolean; profileName: string; environment: string; onBusy: (busy: boolean) => void;
  onCollectionAction?: (action: MongoCollectionAction) => void;
}) {
  const [view, setView] = useState<"documents" | "indexes" | "schema" | "pipeline" | "definition">("documents");
  const [draft, setDraft] = useState(defaultQuery);
  const [query, setQuery] = useState(defaultQuery);
  const [findOpen, setFindOpen] = useState(false);
  const [findState, setFindState] = useState<MongoFindState>();
  const [countRequest, setCountRequest] = useState<{ filter: string } | null>(null);
  const [documentEdit, setDocumentEdit] = useState<MongoDocumentChange | null>(null);
  const [documentNotice, setDocumentNotice] = useState("");
  const [indexAction, setIndexAction] = useState<MongoIndexAction | null>(null);
  const [indexNotice, setIndexNotice] = useState("");
  const [definitionRequest, setDefinitionRequest] = useState<{ id: string; database: string; name: string } | null>(null);
  const [definitionNotice, setDefinitionNotice] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importReport, setImportReport] = useState<MongoImportReport | null>(null);
  const args = useMemo(() => ({ id, database, collection: collection.name }), [id, database, collection.name]);
  const docArgs = useMemo(() => view === "documents" ? { ...args, query } : null, [args, query, view]);
  const countArgs = useMemo(() => view === "documents" && countRequest?.filter === query.filter
    ? { ...args, filter: query.filter } : null, [args, countRequest, query.filter, view]);
  const documents = useNativeRead<MongoDocumentPage>("mongo_documents", docArgs, revision);
  const count = useNativeRead<string>("count_mongo_documents", countArgs, revision);
  const indexes = useNativeRead<Page<Index>>("mongo_indexes", view === "indexes" ? args : null, revision);
  const definition = useNativeRead<string>("mongo_namespace_definition", view === "definition" ? args : null, revision);
  const isView = collection.kind === "view";
  const editLabel = isView ? "뷰 정의" : "유효성 규칙";
  const editSettings = useNativeRead<MongoValidationSettings | MongoViewSettings>(
    isView ? "mongo_namespace_view_settings" : "mongo_namespace_validation_settings", definitionRequest);
  const update = (change: Partial<MongoDocumentQuery>) => setDraft(value => ({ ...value, ...change }));
  const narrowDocument = () => { update({ projection: '{"_id": 1}' }); setQuery({ ...query, projection: '{"_id": 1}', page: 0 }); };
  function applyQuery(next: MongoDocumentQuery) {
    if (next.filter !== query.filter) setCountRequest(null);
    setQuery({ ...next, page: 0 });
  }

  return <section className="results-card mongo-content" aria-label="MongoDB 컬렉션 상세">
    <div className="panel-heading"><h2>{collection.name}</h2><span>{database}</span>
      <button type="button" className="secondary small" onClick={refresh}><RefreshCw size={14} aria-hidden /> 새로 고침</button></div>
    <div className="mongo-actions" role="group" aria-label="컬렉션 보기">
      <button type="button" className="secondary small" aria-pressed={view === "documents"} onClick={() => setView("documents")}>문서</button>
      {collection.kind !== "view" && <button type="button" className="secondary small" aria-pressed={view === "indexes"} onClick={() => setView("indexes")}>인덱스</button>}
      <button type="button" className="secondary small" aria-pressed={view === "schema"} onClick={() => setView("schema")}>스키마 분석</button>
      <button type="button" className="secondary small" aria-pressed={view === "pipeline"} onClick={() => setView("pipeline")}>집계 파이프라인</button>
      <button type="button" className="secondary small" aria-pressed={view === "definition"} onClick={() => setView("definition")}>정의</button>
    </div>
    <div hidden={view !== "schema"}><MongoSchemaAnalysis target={args} revision={revision} /></div>
    <div hidden={view !== "pipeline"}><MongoPipeline target={args} projectId={projectId} /></div>
    {view === "definition" && <>
      {((allowDefinitionEdits && definition.data !== null) || onCollectionAction) && <div className="mongo-actions">
        {allowDefinitionEdits && definition.data !== null && <button type="button" className="secondary small" disabled={editSettings.loading}
          onClick={() => { setDefinitionNotice(""); setDefinitionRequest({ id, database, name: collection.name }); }}>
          {editSettings.loading ? "편집 설정 조회 중…" : editLabel + " 편집"}
        </button>}
        {onCollectionAction && <>
          <button type="button" className="secondary small" onClick={() => onCollectionAction("rename")}>컬렉션 이름 변경</button>
          <button type="button" className="danger small" onClick={() => onCollectionAction("drop")}>컬렉션 삭제</button>
        </>}
      </div>}
      {editSettings.error && <p className="error-banner" role="alert">{editSettings.error}</p>}
      {definitionNotice && <p className="form-note mongo-note" role="status">{definitionNotice}</p>}
      {definition.loading && <p className="result-empty" role="status">정의 조회 중…</p>}
      {definition.error && <p className="error-banner" role="alert">{definition.error}</p>}
      {definition.data !== null && <pre className="mongo-command-definition mongo-note"
        aria-label={collection.kind === "view" ? "뷰 정의" : "컬렉션 정의"} tabIndex={0}><code>{definition.data}</code></pre>}
    </>}
    {view === "indexes" && <>
      {allowIndexes && <div className="mongo-actions"><button type="button" className="secondary small"
        onClick={() => setIndexAction({ kind: "create" })}>인덱스 생성</button></div>}
      {indexNotice && <p className="form-note mongo-note" role="status">{indexNotice}</p>}
      <ReadStatus {...indexes} />
      {indexes.data && <div className="table-wrap"><table aria-label="MongoDB 인덱스"><thead><tr>
        <th scope="col">이름</th><th scope="col">필드</th><th scope="col">고유</th><th scope="col">TTL</th>
        {allowIndexes && <th scope="col">작업</th>}
      </tr></thead><tbody>{indexes.data.items.map(index => <tr key={index.name}>
        <th scope="row">{index.name}{index.hidden && <small> · 숨김</small>}</th><td><code>{index.keys}</code></td><td>{index.unique ? "예" : "—"}</td>
        <td>{index.ttl_seconds === null ? "—" : `${displayNumber.format(index.ttl_seconds)}초`}</td>
        {allowIndexes && <td>{index.name !== "_id_" && index.name !== "*" && <div className="mongo-index-actions">
          <button type="button" className="secondary small" aria-label={`${index.name} 인덱스 옵션 변경`} onClick={() => setIndexAction({
            kind: "modify", name: index.name, hidden: index.hidden, ttlSeconds: index.ttl_seconds, ttlEligible: index.ttl_eligible,
          })}>옵션 변경</button>
          <button type="button" className="secondary small" aria-label={`${index.name} 인덱스 삭제`}
            onClick={() => setIndexAction({ kind: "drop", name: index.name })}>삭제</button>
        </div>}</td>}
      </tr>)}</tbody></table></div>}
      {indexes.data?.has_next && <p className="form-note mongo-note">앞 64개 인덱스를 표시합니다.</p>}
    </>}
    {view === "documents" && <>
      <div className="mongo-actions" role="group" aria-label="문서 작업">
        {allowEdits && <button type="button" className="secondary small" onClick={() => setDocumentEdit({ kind: "insert" })}>문서 삽입</button>}
        <button type="button" className="secondary small" onClick={() => setFindOpen(true)}>찾기 빌더</button>
        <button type="button" className="secondary small" onClick={() => setExportOpen(true)}>
          <Download size={14} aria-hidden /> 문서 내보내기
        </button>
        {allowEdits && <button type="button" className="secondary small" onClick={() => { setImportReport(null); setImportOpen(true); }}>
          <Upload size={14} aria-hidden /> 문서 가져오기
        </button>}
        <button type="button" className="secondary small" disabled={documents.loading || count.loading}
          onClick={() => setCountRequest({ filter: query.filter })}>일치 건수 조회</button>
        {count.loading && <span className="mongo-count" role="status">건수 조회 중…</span>}
        {count.data !== null && <span className="mongo-count" role="status">일치 문서 {displayNumber.format(BigInt(count.data))}개</span>}
      </div>
      {count.error && <p className="error-banner" role="alert">{count.error}</p>}
      {documentNotice && <p className="form-note mongo-note" role="status">{documentNotice}</p>}
      {exportReport && <ResultFileReport report={exportReport} onDismiss={() => setExportReport(null)} />}
      {importReport && <MongoDocumentImportReport report={importReport} />}
      <details className="mongo-query">
        <summary>필터 및 정렬</summary>
        <form onSubmit={event => { event.preventDefault(); applyQuery(draft); }}>
          <label className="field">필터 JSON<textarea className="edit-value" placeholder='{"active": true}'
            value={draft.filter} onChange={event => update({ filter: event.target.value })} maxLength={32768} /></label>
          <label className="field">표시 필드 JSON<textarea className="edit-value" placeholder='{"name": 1}'
            value={draft.projection} onChange={event => update({ projection: event.target.value })} maxLength={32768} /></label>
          <div className="mongo-sort">
            <label className="field">정렬 필드<input value={draft.sort_field} maxLength={256} onChange={event => update({ sort_field: event.target.value })} /></label>
            <label className="field">정렬 방향<select value={draft.descending ? "desc" : "asc"} onChange={event => update({ descending: event.target.value === "desc" })}>
              <option value="asc">오름차순</option><option value="desc">내림차순</option>
            </select></label>
          </div>
          <div className="mongo-actions">
            <button type="submit" className="primary small" disabled={documents.loading}>조회 적용</button>
            <button type="button" className="secondary small" onClick={() => { setDraft(defaultQuery); setFindState(undefined); applyQuery(defaultQuery); }}>초기화</button>
          </div>
        </form>
      </details>
      <ReadStatus {...documents} />
      {documents.data?.items.length ? <MongoDocumentList items={documents.data.items} offset={query.page * 20} heading="MongoDB 문서"
        limitMessage="미리보기 한도를 초과했습니다. 표시 필드를 지정해 다시 조회하세요."
        actions={allowEdits ? (documentId, row) => <div className="mongo-actions">
          <button type="button" className="secondary small" aria-label={`${row}행 문서 수정`} onClick={() => setDocumentEdit({ kind: "replace", document_id: documentId })}>수정</button>
          <button type="button" className="secondary small" aria-label={`${row}행 문서 복제`} onClick={() => setDocumentEdit({ kind: "duplicate", document_id: documentId })}>복제</button>
          <button type="button" className="secondary small" aria-label={`${row}행 문서 삭제`} onClick={() => setDocumentEdit({ kind: "delete", document_id: documentId })}>삭제</button>
        </div> : undefined} /> : null}
      {documents.data?.items.some(item => item.json === null) && <div className="mongo-actions">
        <button type="button" className="secondary small" onClick={narrowDocument}>문서 ID만 보기</button>
      </div>}
      <Pager label="MongoDB 문서 페이지" page={query.page} next={documents.data?.has_next === true} loading={documents.loading}
        change={page => setQuery(value => ({ ...value, page }))} />
    </>}
    {findOpen && <MongoFindBuilder filter={draft.filter} saved={findState} onClose={() => setFindOpen(false)} onApply={built => {
      const next = { ...draft, filter: built.compiled };
      setFindState(built); setDraft(next); applyQuery(next); setFindOpen(false);
    }} />}
    {indexAction && <MongoIndexDialog target={args} action={indexAction} environment={environment} onBusy={onBusy}
      onClose={() => setIndexAction(null)} onDone={warning => {
        setIndexNotice(`인덱스 ${mongoIndexActionLabels[indexAction.kind]} 완료${warning ? " · 완료 감사 기록 저장 실패" : ""}`);
        setIndexAction(null);
        refresh();
      }} />}
    {editSettings.data && <MongoNamespaceDialog id={id} initialDatabase={database} initialSource=""
      editable={"validator" in editSettings.data
        ? { kind: "validation", name: collection.name, settings: editSettings.data }
        : { kind: "view", name: collection.name, settings: editSettings.data }}
      environment={environment} onBusy={onBusy}
      onClose={() => setDefinitionRequest(null)} onDone={report => {
        setDefinitionRequest(null);
        setDefinitionNotice(editLabel + (report.audit_warning ? " 변경 완료 · 감사 기록 저장 실패" : " 변경 완료"));
        refresh();
      }} />}
    {documentEdit && <MongoDocumentEditDialog id={id} database={database} collection={collection.name} change={documentEdit}
      environment={environment} onBusy={onBusy} onClose={() => setDocumentEdit(null)} onApplied={report => {
        setDocumentEdit(null);
        setDocumentNotice(`문서 ${report.affected_count}개 변경 완료${report.audit_warning ? " · 완료 감사 기록 저장 실패" : ""}`);
        refresh();
      }} />}
    {exportOpen && <MongoDocumentExportDialog profile={{ name: profileName, environment }} target={args} query={query}
      onBusy={onBusy} onClose={() => setExportOpen(false)} onExported={report => {
        setExportOpen(false);
        setExportReport(report);
      }} />}
    {importOpen && <MongoDocumentImportDialog {...args} environment={environment} onBusy={onBusy}
      onClose={() => setImportOpen(false)} onDone={report => { setImportOpen(false); setImportReport(report); refresh(); }} />}
  </section>;
}

function ReadStatus({ loading, error, data }: { loading: boolean; error: string; data: { items: unknown[] } | null }) {
  if (error) return <p className="error-banner" role="alert">{error}</p>;
  if (loading) return <p className="result-empty" role="status">조회 중…</p>;
  return data?.items.length === 0 ? <p className="result-empty">조회할 항목이 없습니다.</p> : null;
}

function Pager({ label, page, loading, next, change }: { label: string; page: number; loading: boolean; next: boolean; change: (page: number) => void }) {
  if (!page && !next) return null;
  return <div className="mongo-actions mongo-pages" role="group" aria-label={label}>
    <button type="button" className="secondary small" disabled={!page || loading} onClick={() => change(page - 1)}>이전</button>
    <span>{page + 1} 페이지</span>
    <button type="button" className="secondary small" disabled={!next || loading} onClick={() => change(page + 1)}>다음</button>
  </div>;
}
