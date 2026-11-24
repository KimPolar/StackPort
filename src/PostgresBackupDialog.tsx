import { useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Selection = { kind: "database" } | { kind: "schema"; schema: number } | { kind: "table"; object: number };
export type PostgresBackupTarget = { selection: Selection; label: string };
export type PostgresBackupReport = { path: string; size_bytes: number; sha256: string; tool_version: string; audit_warning: boolean };
type Contents = "all" | "schema" | "data";

export function PostgresBackupDialog({ id, target, connection, source, environment, unavailable, onBusy, onClose, onDone }: {
  id: string;
  target: PostgresBackupTarget;
  connection: string;
  source: string;
  environment: string;
  unavailable: string;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onDone: (report: PostgresBackupReport) => void;
}) {
  const [destination, setDestination] = useState("");
  const [contents, setContents] = useState<Contents>("all");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<string | null>(null);
  const production = environment === "PROD";
  const blocked = running || Boolean(unavailable);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (request.current || unavailable || !destination.trim() || (production && confirmation !== "PROD")) return;
    const token = crypto.randomUUID();
    request.current = token;
    setRunning(true); setCancelling(false); setError(""); setPassword("");
    onBusy(true);
    try {
      const report = await invoke<PostgresBackupReport>("create_postgres_backup", {
        id, request: token, target: target.selection, contents, password, confirmation, destination: destination.trim(),
      });
      onDone(report);
    } catch (reason) { setError(String(reason)); }
    finally { request.current = null; setRunning(false); setCancelling(false); onBusy(false); }
  }

  async function cancel() {
    if (!request.current || cancelling) return;
    setCancelling(true);
    try {
      if (!await invoke<boolean>("cancel_postgres_backup", { id, request: request.current })) setCancelling(false);
    } catch (reason) { setError(String(reason)); setCancelling(false); }
  }

  async function chooseDirectory() {
    try {
      const folder = await invoke<string | null>("choose_backup_directory");
      if (folder) setDestination(`${folder.replace(/[\\/]$/, "")}\\stackport-postgres.backup`);
    } catch (reason) { setError(String(reason)); }
  }

  return <Dialog title="PostgreSQL 백업" onClose={onClose} busy={running}>
    <form onSubmit={save} aria-busy={running}>
      <p className="confirm-copy"><strong>{connection} · {environment}</strong><br />{source}<br />{target.label}</p>
      <label className="field">백업 내용<select value={contents} disabled={blocked} onChange={event => setContents(event.target.value as Contents)}>
        <option value="all">구조와 데이터</option><option value="schema">구조만</option><option value="data">데이터만</option>
      </select></label>
      <label className="field">새 백업 파일 경로<span className="file-input">
        <input required disabled={blocked} value={destination} onChange={event => setDestination(event.target.value)} placeholder="절대 경로 (.backup)" />
        <button type="button" className="secondary" disabled={blocked} onClick={() => void chooseDirectory()}>폴더 선택</button>
      </span></label>
      <label className="field">PostgreSQL 암호<input type="password" autoComplete="off" maxLength={4096} disabled={blocked}
        value={password} onChange={event => setPassword(event.target.value)} /></label>
      {production && <label className="field">운영 확인 문구 PROD<input required autoComplete="off" disabled={blocked}
        value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      <p className="form-note">설치된 PostgreSQL의 pg_dump와 pg_restore로 압축 아카이브를 로컬에 저장합니다. 저장 폴더의 접근 권한을 확인하세요.</p>
      {(target.selection.kind !== "database" || contents === "data") && <p className="form-note">선택 범위의 백업을 복원하려면 대상에 필요한 스키마와 참조 객체를 준비하세요.</p>}
      {unavailable && <p className="form-error" role="alert">{unavailable}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {running && <p className="form-note" role="status">{cancelling ? "백업 취소 요청 중…" : "백업 생성 및 아카이브 검사 중…"}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={cancelling || Boolean(unavailable && running)}
          onClick={running ? () => void cancel() : onClose}>{running ? "백업 중단" : "닫기"}</button>
        <button type="submit" className="primary" disabled={blocked || (production && confirmation !== "PROD")}>백업 만들기</button>
      </div>
    </form>
  </Dialog>;
}
