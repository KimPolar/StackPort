import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Namespace = { database: string; collection: string; kind: string; documents: number; restore_supported: boolean; view_on?: string };
type Archive = { size_bytes: number; sha256: string; server_version: string; tool_version: string; namespaces: Namespace[] };
type RestoreDatabase = { name: string; collections: number; views: number; documents: number; buckets: number };
type Review = Archive & { token: string; target_version: string; restore_tool_version: string; expires_seconds: number;
  target_database?: string; database_sources?: RestoreDatabase[] };
type BackupReport = Archive & { path: string; audit_warning: boolean };
type RestoreReport = { database: string; collection?: string; documents: number; sha256: string; audit_warning: boolean;
  restored_database?: RestoreDatabase };
export type MongoArchiveResult = { kind: "backup"; report: BackupReport } | { kind: "restore"; report: RestoreReport };

const format = new Intl.NumberFormat("ko-KR");

export function MongoArchiveDialog({ id, database, currentCollection, environment, allowRestore, needsPassword, onBusy, onClose, onDone }: {
  id: string; database: string | null; currentCollection?: string; environment: string; allowRestore: boolean; needsPassword: boolean;
  onBusy: (busy: boolean) => void; onClose: () => void; onDone: (result: MongoArchiveResult) => void;
}) {
  const [mode, setMode] = useState<"backup" | "restore">(database ? "backup" : "restore");
  const [scope, setScope] = useState(currentCollection ? "collection" : "database");
  const [restoreScope, setRestoreScope] = useState(database ? "collection" : "database");
  const [directory, setDirectory] = useState("");
  const [path, setPath] = useState("");
  const [target, setTarget] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [request, setRequest] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const working = useRef(false);
  const reviewToken = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restore = mode === "restore";
  const restoreDatabase = restore && restoreScope === "database";
  const submitting = !restore || Boolean(review);
  const production = environment === "PROD";
  const sources = review?.namespaces.filter(item => item.restore_supported) ?? [];
  const source = sources[selected];
  const databaseSource = review?.database_sources?.[selected];
  const sourceDatabase = restoreDatabase ? databaseSource?.name : source?.database;

  useEffect(() => () => {
    if (reviewToken.current) void invoke("discard_mongo_restore", { id, token: reviewToken.current }).catch(() => {});
  }, [id]);
  useEffect(() => { if (review) heading.current?.focus(); }, [review]);

  function discard() {
    if (reviewToken.current) void invoke("discard_mongo_restore", { id, token: reviewToken.current }).catch(() => {});
    reviewToken.current = null;
    setReview(null);
    setSelected(0);
    setConfirmation("");
    setPassword("");
  }

  async function choose(field: "path" | "directory") {
    if (working.current) return;
    working.current = true;
    setError("");
    try {
      const value = field === "path" ? await invoke<string | null>("choose_mongo_archive_path", { restore })
        : await invoke<string | null>("choose_mongo_tools_directory");
      if (value) (field === "path" ? setPath : setDirectory)(value);
    } catch (cause) { setError(String(cause)); }
    finally { working.current = false; }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working.current || (submitting && production && confirmation !== "PROD")) return;
    working.current = true;
    setBusy(true); setCancelling(false); setError(""); setPassword("");
    onBusy(true);
    try {
      const request = await invoke<string>("prepare_query");
      setRequest(request);
      if (!restore) {
        const report = await invoke<BackupReport>("create_mongo_backup", { id, request, input: {
          database, collection: scope === "collection" ? currentCollection ?? null : null,
          directory, destination: path, password, confirmation,
        } });
        onDone({ kind: "backup", report });
      } else if (review && sourceDatabase) {
        const report = await invoke<RestoreReport>("apply_mongo_restore", { id, request, token: review.token,
          sourceDatabase, sourceCollection: restoreDatabase ? null : source?.collection, password, confirmation,
        });
        reviewToken.current = null;
        onDone({ kind: "restore", report });
      } else {
        const result = await invoke<Review>("preview_mongo_restore", { id, request, input: { source: path, directory,
          database: restoreDatabase ? target : database, collection: restoreDatabase ? null : target,
        } });
        reviewToken.current = result.token;
        setReview(result);
      }
    } catch (cause) {
      if (review) discard();
      setError(String(cause));
    } finally {
      working.current = false; setRequest(null); setBusy(false); setCancelling(false); onBusy(false);
    }
  }

  async function cancel() {
    if (!request || cancelling) return;
    setCancelling(true);
    try { if (!await invoke<boolean>("cancel_query", { token: request })) setCancelling(false); }
    catch (cause) { setError(String(cause)); setCancelling(false); }
  }

  return <Dialog title={!database ? "MongoDB 복원" : allowRestore ? "MongoDB 백업·복원" : "MongoDB 백업"}
    busy={busy} onClose={onClose} className="restore-dialog mongo-namespace-dialog">
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <p className="confirm-copy"><strong>{environment}</strong>{restoreDatabase
        ? review?.target_database && <> · {review.target_database}</>
        : <> · {database}{restore && target ? `.${target}` : !restore && scope === "collection" && currentCollection ? `.${currentCollection}` : ""}</>}
      </p>
      {allowRestore && database && <label className="field">작업<select value={mode} disabled={busy || Boolean(review)} onChange={event => {
        setMode(event.target.value as typeof mode); setPath(""); setError(""); setConfirmation(""); setPassword("");
      }}><option value="backup">백업</option><option value="restore">복원</option></select></label>}
      {!restore && currentCollection && <label className="field">백업 범위<select value={scope} disabled={busy}
        onChange={event => setScope(event.target.value)}><option value="collection">현재 컬렉션</option><option value="database">데이터베이스</option>
      </select></label>}
      {restore && database && <label className="field">복원 범위<select value={restoreScope} disabled={busy || Boolean(review)}
        onChange={event => { setRestoreScope(event.target.value); setTarget(""); setError(""); }}>
        <option value="collection">컬렉션 하나</option><option value="database">전체 데이터베이스</option>
      </select></label>}
      <label className="field">MongoDB Database Tools 폴더<span className="file-input">
        <input required value={directory} readOnly={Boolean(review)} disabled={busy} onChange={event => setDirectory(event.target.value)} placeholder="mongodump.exe와 mongorestore.exe가 있는 bin 폴더" />
        {!review && <button type="button" className="secondary" disabled={busy} onClick={() => void choose("directory")}>도구 폴더 선택</button>}
      </span></label>
      <label className="field">{restore ? "복원 아카이브 경로" : "새 백업 파일 경로"}<span className="file-input">
        <input required value={path} readOnly={Boolean(review)} disabled={busy} onChange={event => setPath(event.target.value)}
          placeholder={restore ? "아카이브의 절대 경로" : "새 .archive.gz 파일의 절대 경로"} />
        {!review && <button type="button" className="secondary" disabled={busy} onClick={() => void choose("path")}>파일 선택</button>}
      </span></label>
      {restore && <label className="field">{restoreDatabase ? "새 데이터베이스 이름 앞부분" : "새 컬렉션 이름"}
        <input required maxLength={restoreDatabase ? 30 : 120} value={target} readOnly={Boolean(review)} disabled={busy}
        onChange={event => setTarget(event.target.value)} /></label>}
      {!restore && <p className="form-note">현재 계정으로 읽을 수 있는 데이터를 로컬에 압축 아카이브로 저장합니다. 파일을 암호화하지 않습니다.</p>}
      {restore && !review && <p className="form-note">아카이브 형식과 체크섬, 서버·도구 버전, 대상 이름을 확인합니다. 복원에는 출처를 확인한 백업을 사용하세요.</p>}
      {restoreDatabase && !review && <p className="form-note">입력한 이름에 고유한 접미사를 붙이고, 복원 전에 서버에 생성할 데이터베이스 이름을 표시합니다.</p>}
      {review && <>
        <h3 className="mongo-edit-review-heading" tabIndex={-1} ref={heading}>복원 아카이브 검토</h3>
        <p className="form-note">원본 서버 {review.server_version} · 대상 서버 {review.target_version} · mongorestore {review.restore_tool_version}</p>
        <p className="form-note">{format.format(review.size_bytes)} B · 검토는 {review.expires_seconds / 60}분 동안 유효합니다.</p>
        <details><summary>SHA-256</summary><code>{review.sha256}</code></details>
        <label className="field">{restoreDatabase ? "복원할 원본 데이터베이스" : "복원할 원본 컬렉션"}
          <select value={selected} disabled={busy} onChange={event => { setSelected(Number(event.target.value)); setConfirmation(""); }}>
            {restoreDatabase ? review.database_sources?.map((item, index) => <option key={item.name} value={index}>
              {item.name} · 컬렉션 {format.format(item.collections)}개 · 뷰 {format.format(item.views)}개
            </option>) : sources.map((item, index) => <option key={`${item.database}.${item.collection}`} value={index}>
              {item.database}.{item.collection} · 문서 {format.format(item.documents)}개
            </option>)}
          </select>
        </label>
        {databaseSource ? <>
          <p className="form-note"><DatabaseCounts database={databaseSource} /></p>
          <details><summary>복원할 객체</summary><ul>
            {review.namespaces.filter(item => item.database === databaseSource.name).map(item => <li key={item.collection}>
              {item.collection}{item.view_on && ` · 뷰 원본 ${item.view_on}`}{item.kind === "timeseries" && " · 시계열"}
            </li>)}
          </ul></details>
          <p className="form-note">복원이 중단되면 새 데이터베이스에 일부 객체가 남을 수 있습니다.</p>
        </> : <p className="form-note">임시 컬렉션에 복원하고 문서 수를 확인한 뒤 새 이름으로 게시합니다.</p>}
      </>}
      {submitting && needsPassword && <label className="field">MongoDB 암호<input type="password" autoComplete="off" maxLength={4096} value={password}
        disabled={busy} onChange={event => setPassword(event.target.value)} /></label>}
      {submitting && production && <label className="field">운영 환경 확인<input required autoComplete="off" placeholder="PROD" disabled={busy}
        value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      {busy && <p className="form-note" role="status">{cancelling ? "중단 요청 중…" : submitting ? "아카이브 작업을 처리하는 중…" : "아카이브를 검토하는 중…"}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {review && !busy && <button type="button" className="secondary" onClick={() => { discard(); setError(""); }}>입력 수정</button>}
        {busy && <button type="button" className="secondary" disabled={!request || cancelling} onClick={() => void cancel()}>작업 중단</button>}
        <button type="submit" className="primary" disabled={busy || (submitting && production && confirmation !== "PROD") || Boolean(review && !sourceDatabase)}>
          {restore ? review ? restoreDatabase ? "검토한 데이터베이스 복원" : "검토한 컬렉션 복원" : "아카이브 검토" : "백업 만들기"}
        </button>
      </div>
    </form>
  </Dialog>;
}

function DatabaseCounts({ database }: { database: RestoreDatabase }) {
  return <>컬렉션 {format.format(database.collections)}개 · 뷰 {format.format(database.views)}개 · 문서 {format.format(database.documents)}개
    {database.buckets > 0 && ` · 시계열 버킷 ${format.format(database.buckets)}개`}</>;
}

export function MongoArchiveReport({ result }: { result: MongoArchiveResult }) {
  const { report } = result;
  return <div className="form-note mongo-note mongo-archive-report" role="status">
    {result.kind === "backup" ? <>
      <strong>MongoDB 백업 완료</strong> · {format.format(result.report.namespaces.length)}개 객체 · {format.format(result.report.size_bytes)} B
      <p>{result.report.path}</p><span>서버 {result.report.server_version} · mongodump {result.report.tool_version}</span>
    </> : <><strong>MongoDB 복원 완료</strong> · {result.report.database}{result.report.collection && `.${result.report.collection}`} · {result.report.restored_database
      ? <DatabaseCounts database={result.report.restored_database} /> : <>문서 {format.format(result.report.documents)}개</>}</>}
    <details><summary>SHA-256</summary><code>{report.sha256}</code></details>
    {report.audit_warning && <p>완료 작업 기록을 저장하지 못했습니다.</p>}
  </div>;
}
