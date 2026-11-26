import { useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

export type MysqlBackupTarget = { database: string; table: string | null };
type BackupReport = { path: string; size_bytes: number; sha256: string; server_version: string; tool_version: string; audit_warning: boolean };
type Contents = "all" | "schema" | "data";

export function MysqlBackupDialog({ id, engine, target, connection, environment, onClose }: {
  id: string; engine: "MySQL" | "MariaDB"; target: MysqlBackupTarget;
  connection: string; environment: string; onClose: () => void;
}) {
  const [directory, setDirectory] = useState("");
  const [destination, setDestination] = useState("");
  const [contents, setContents] = useState<Contents>("all");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [report, setReport] = useState<BackupReport>();
  const [error, setError] = useState("");
  const working = useRef(false);
  const request = useRef<string | null>(null);
  const production = environment === "PROD";
  const tool = engine === "MariaDB" ? "mariadb-dump" : "mysqldump";
  const source = target.table === null ? target.database : `${target.database}.${target.table}`;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (working.current || !directory.trim() || !destination.trim() || (production && confirmation !== "PROD")) return;
    working.current = true; setRunning(true); setError(""); setPassword("");
    try {
      const token = await invoke<string>("prepare_query");
      request.current = token;
      setReport(await invoke<BackupReport>("create_mysql_backup", { id, request: token, input: {
        ...target, directory, destination, contents, password, confirmation,
      } }));
    } catch (reason) { setError(String(reason)); }
    finally { working.current = false; request.current = null; setRunning(false); setCancelling(false); }
  }

  async function cancel() {
    if (!request.current || cancelling) return;
    setCancelling(true);
    try { if (!await invoke<boolean>("cancel_query", { token: request.current })) setCancelling(false); }
    catch (reason) { setError(String(reason)); setCancelling(false); }
  }

  async function choose(tools: boolean) {
    if (working.current) return;
    working.current = true;
    try {
      const folder = await invoke<string | null>(tools ? "choose_mysql_backup_tools" : "choose_backup_directory");
      if (folder) {
        if (tools) setDirectory(folder);
        else setDestination(`${folder.replace(/[\\/]$/, "")}\\stackport-mysql.sql`);
      }
    } catch (reason) { setError(String(reason)); }
    finally { working.current = false; }
  }

  return <Dialog title={`${engine} 논리 백업`} busy={running} onClose={onClose}>
    {report ? <>
      <p role="status" className="success-banner">SQL 백업을 저장했습니다.</p>
      <dl className="form-note">
        <dt>파일</dt><dd className="path">{report.path}</dd>
        <dt>크기</dt><dd>{report.size_bytes.toLocaleString("ko-KR")} B</dd>
        <dt>서버 · 도구</dt><dd>{report.server_version} · {report.tool_version}</dd>
        <dt>SHA-256</dt><dd className="path"><code>{report.sha256}</code></dd>
      </dl>
      {report.audit_warning && <p className="form-error" role="alert">파일을 저장했지만 작업 기록을 남기지 못했습니다.</p>}
      <div className="dialog-actions"><button className="primary" type="button" onClick={onClose}>닫기</button></div>
    </> : <form onSubmit={save} aria-busy={running}>
      <p className="confirm-copy"><strong>{connection} · {environment}</strong><br />{source}</p>
      <label className="field">백업 내용<select disabled={running} value={contents} onChange={event => setContents(event.target.value as Contents)}>
        <option value="all">구조와 데이터</option><option value="schema">구조만</option><option value="data">데이터만</option>
      </select></label>
      <label className="field">백업 도구 폴더<span className="file-input">
        <input required disabled={running} value={directory} onChange={event => setDirectory(event.target.value)} />
        <button type="button" className="secondary" disabled={running} onClick={() => void choose(true)}>도구 폴더 선택</button>
      </span></label>
      <label className="field">새 SQL 파일 경로<span className="file-input">
        <input required disabled={running} value={destination} onChange={event => setDestination(event.target.value)} />
        <button type="button" className="secondary" disabled={running} onClick={() => void choose(false)}>저장 폴더 선택</button>
      </span></label>
      <label className="field">{engine} 암호<input type="password" autoComplete="off" maxLength={4096} disabled={running}
        value={password} onChange={event => setPassword(event.target.value)} /></label>
      {production && <label className="field">운영 확인 문구 PROD<input required autoComplete="off" disabled={running}
        value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      <p className="form-note">서버와 같은 주·부 버전의 {tool}가 필요합니다. SQL은 선택한 로컬 폴더에 저장됩니다.</p>
      {contents !== "schema" && <p className="form-note">데이터는 InnoDB 스냅샷으로 읽습니다. 백업 중 테이블 구조 변경을 피하세요.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {running && <p className="form-note" role="status">{cancelling ? "백업 중단 요청 중…" : "SQL 파일을 생성하고 SHA-256을 계산하는 중…"}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={cancelling} onClick={running ? () => void cancel() : onClose}>
          {running ? "백업 중단" : "닫기"}</button>
        <button type="submit" className="primary" disabled={running || (production && confirmation !== "PROD")}>백업 만들기</button>
      </div>
    </form>}
  </Dialog>;
}
