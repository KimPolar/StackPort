import { useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Archive = { path: string; server_version: string; size_bytes: number; sha256: string };
type Preview = {
  token: string; database: string; source_database: string; target_version: string; tool_version: string;
  archive: Archive; schema: Archive | null; tables: string[]; views: string[];
  table_count: number; view_count: number; data_only: boolean; expires_seconds: number;
};
type Report = {
  database: string; status: "verified" | "unverified" | "partial" | "unconfirmed";
  archive_sha256: string; schema_sha256: string | null;
  tables: number | null; views: number | null; rows: number | null; message: string | null; audit_warning: boolean;
};
const number = new Intl.NumberFormat("ko-KR");
const statusText: Record<Report["status"], string> = {
  verified: "복원과 검증을 완료했습니다.",
  unverified: "SQL 실행이 끝났습니다. 복원 결과 검증이 필요합니다.",
  partial: "복원 도중 작업이 멈췄습니다.",
  unconfirmed: "대상 DB의 상태를 확인해야 합니다.",
};

export function MysqlRestoreDialog({ id, engine, server, environment, onClose, onResult }: {
  id: string; engine: "MySQL" | "MariaDB"; server: string; environment: string;
  onClose: () => void; onResult: () => void;
}) {
  const [source, setSource] = useState("");
  const [schema, setSchema] = useState("");
  const [database, setDatabase] = useState("");
  const [directory, setDirectory] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [report, setReport] = useState<Report>();
  const [trusted, setTrusted] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"preview" | "restore">();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const request = useRef<string | null>(null);
  const fieldId = useId();
  const production = environment === "PROD";
  const tool = engine === "MariaDB" ? "mariadb" : "mysql";
  const ready = preview ? trusted && name === preview.database && (!production || confirmation === "PROD")
    : source.trim() && database.trim() && directory.trim();

  function reset() {
    if (preview) void invoke("discard_mysql_restore", { id, token: preview.token }).catch(() => {});
    setPreview(undefined); setTrusted(false); setName(""); setPassword(""); setConfirmation("");
  }

  function close() { reset(); onClose(); }

  async function choose(field: "source" | "schema" | "directory") {
    if (working.current) return;
    working.current = true;
    try {
      const path = await invoke<string | null>(field === "directory" ? "choose_mysql_backup_tools" : "choose_mysql_restore_sql");
      if (path) (field === "directory" ? setDirectory : field === "schema" ? setSchema : setSource)(path);
    } catch (reason) { setError(String(reason)); }
    finally { working.current = false; }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working.current || !ready) return;
    working.current = true; setBusy(preview ? "restore" : "preview"); setError("");
    if (preview) setPassword("");
    try {
      const token = await invoke<string>("prepare_query");
      request.current = token;
      if (preview) {
        setReport(await invoke<Report>("apply_mysql_restore", {
          id, request: token, token: preview.token, databaseConfirmation: name, trusted, password, confirmation,
        }));
        reset();
        onResult();
      } else {
        setPreview(await invoke<Preview>("preview_mysql_restore", {
          id, request: token, input: { source, schema: schema.trim() || null, database, directory },
        }));
      }
    } catch (reason) {
      if (preview) reset();
      setError(String(reason));
    } finally {
      working.current = false; request.current = null; setBusy(undefined); setCancelling(false);
    }
  }

  async function cancel() {
    if (!request.current || cancelling) return;
    setCancelling(true);
    try { if (!await invoke<boolean>("cancel_query", { token: request.current })) setCancelling(false); }
    catch (reason) { setError(String(reason)); setCancelling(false); }
  }

  return <Dialog title={`${engine} SQL 백업 복원`} className="restore-dialog" busy={Boolean(busy)} onClose={close}>
    {report ? <>
      <p className={report.status === "verified" ? "success-banner" : "form-error"} role={report.status === "verified" ? "status" : "alert"}>
        {statusText[report.status]} <strong>{report.database}</strong>
      </p>
      {report.rows !== null && <p className="form-note">테이블 {number.format(report.tables ?? 0)}개 · 뷰 {number.format(report.views ?? 0)}개 · 행 {number.format(report.rows)}개</p>}
      <dl className="restore-summary">
        <dt>SQL SHA-256</dt><dd><code>{report.archive_sha256}</code></dd>
        {report.schema_sha256 && <><dt>구조 SQL SHA-256</dt><dd><code>{report.schema_sha256}</code></dd></>}
      </dl>
      {report.message && <p className="form-note">{report.message}</p>}
      {report.audit_warning && <p className="form-error" role="alert">작업 결과를 감사 기록에 저장할 수 없습니다.</p>}
      <div className="dialog-actions"><button type="button" className="primary" onClick={close}>닫기</button></div>
    </> : <form onSubmit={submit} aria-busy={Boolean(busy)}>
      {!preview ? <>
        <p className="confirm-copy"><strong>{server} · {environment}</strong></p>
        <div className="field"><label htmlFor={`${fieldId}-source`}>SQL 백업 파일</label><span className="file-input">
          <input id={`${fieldId}-source`} required disabled={Boolean(busy)} value={source} onChange={event => setSource(event.target.value)} />
          <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void choose("source")}>파일 선택</button>
        </span></div>
        <label className="field">새 데이터베이스 이름<input required disabled={Boolean(busy)} value={database}
          onChange={event => setDatabase(event.target.value)} autoComplete="off" /></label>
        <div className="field"><label htmlFor={`${fieldId}-tools`}>복원 도구 폴더</label><span className="file-input">
          <input id={`${fieldId}-tools`} required disabled={Boolean(busy)} value={directory} onChange={event => setDirectory(event.target.value)} />
          <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void choose("directory")}>도구 폴더 선택</button>
        </span></div>
        <details>
          <summary>데이터 전용 백업의 구조 파일</summary>
          <div className="field"><label htmlFor={`${fieldId}-schema`}>구조 전용 SQL 파일</label><span className="file-input">
            <input id={`${fieldId}-schema`} disabled={Boolean(busy)} value={schema} onChange={event => setSchema(event.target.value)} />
            <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void choose("schema")}>구조 파일 선택</button>
          </span></div>
        </details>
        <p className="form-note">같은 제품·주 버전·부 버전의 {tool}가 필요합니다. 원본 이름이 포함된 전체 DB 백업은 그 이름으로 새 DB를 만듭니다.</p>
      </> : <>
        <dl className="restore-summary">
          <dt>대상</dt><dd>{server} / <strong>{preview.database}</strong> · {environment}</dd>
          <dt>원본 DB</dt><dd>{preview.source_database} · {engine} {preview.archive.server_version}</dd>
          <dt>서버와 도구</dt><dd>{preview.target_version} · {tool} {preview.tool_version}</dd>
          <ArchiveDetails label="SQL 백업" archive={preview.archive} />
          {preview.schema && <ArchiveDetails label="구조 파일" archive={preview.schema} />}
        </dl>
        <details>
          <summary>백업의 테이블 {number.format(preview.table_count)}개 · 뷰 {number.format(preview.view_count)}개</summary>
          {[...preview.tables, ...preview.views].length > 0 && <ul>
            {preview.tables.map(table => <li key={`table:${table}`}>{table}</li>)}
            {preview.views.map(view => <li key={`view:${view}`}>{view} · 뷰</li>)}
          </ul>}
          {(preview.table_count > preview.tables.length || preview.view_count > preview.views.length)
            && <p className="form-note">각 목록의 처음 100개를 표시합니다.</p>}
        </details>
        <p className="form-note">SQL은 지정한 서버에서 현재 계정 권한으로 실행됩니다. 참조 객체와 DEFINER 계정이 필요할 수 있고, 실패 시 새 DB에 일부 변경이 남을 수 있습니다. 미리보기는 {preview.expires_seconds / 60}분간 유효합니다.</p>
        <label className="restore-trust"><input type="checkbox" checked={trusted} disabled={Boolean(busy)}
          onChange={event => setTrusted(event.target.checked)} /> 백업 출처를 확인했고 이 서버에서 SQL 실행에 동의합니다.</label>
        <label className="field">새 DB 이름 확인<input required disabled={Boolean(busy)} value={name}
          onChange={event => setName(event.target.value)} autoComplete="off" /></label>
        <label className="field">{engine} 암호<input type="password" autoComplete="off" maxLength={4096} disabled={Boolean(busy)}
          value={password} onChange={event => setPassword(event.target.value)} /></label>
        {production && <label className="field">운영 확인 문구 PROD<input required autoComplete="off" disabled={Boolean(busy)}
          value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p className="form-note" role="status">{cancelling ? "중단 요청 중…" : busy === "preview" ? "SQL 사본과 백업 목록을 확인하는 중…" : "새 DB에 SQL을 읽고 결과를 검증하는 중…"}</p>}
      <div className="dialog-actions">
        {preview && !busy && <button type="button" className="secondary" onClick={reset}>대상 다시 선택</button>}
        <button type="button" className="secondary" disabled={cancelling} onClick={busy ? () => void cancel() : close}>
          {busy ? "작업 중단" : "닫기"}</button>
        <button type="submit" className="primary" disabled={Boolean(busy) || !ready}>{preview ? "새 DB에 복원" : "복원 미리보기"}</button>
      </div>
    </form>}
  </Dialog>;
}

function ArchiveDetails({ label, archive }: { label: string; archive: Archive }) {
  return <><dt>{label}</dt><dd>{archive.path} · {number.format(archive.size_bytes)} B</dd>
    <dt>SHA-256</dt><dd><code>{archive.sha256}</code></dd></>;
}
