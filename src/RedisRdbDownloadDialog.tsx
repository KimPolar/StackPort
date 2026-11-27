import { useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DatabasePasswordField, useDatabaseCredentials } from "./DatabasePasswordField";
import { Dialog } from "./Dialog";
import type { RedisProfile } from "./RedisProfileDialog";
import { networkAddressText } from "./quickConnect";

type Report = {
  destination: string;
  engine: string;
  engine_version: string;
  checker_version: string;
  bytes: number;
  sha256: string;
  rdb: { format_version: number; checksum_verified: boolean; keys_read: number | null };
  audit_warning: boolean;
};

const numbers = new Intl.NumberFormat("ko-KR");

export function RedisRdbDownloadDialog({ profile, onBusy, onClose }: {
  profile: RedisProfile;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const [destination, setDestination] = useState("");
  const [toolsDirectory, setToolsDirectory] = useState("");
  const [includeAllDatabases, setIncludeAllDatabases] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [request, setRequest] = useState<string>();
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const pending = useRef(false);
  const credentials = useDatabaseCredentials("redis", profile);
  const production = profile.settings.environment === "PROD";

  function changePath(set: (path: string) => void, path: string) {
    set(path); setReport(undefined); setError("");
  }

  async function choose(tools: boolean) {
    if (pending.current) return;
    pending.current = true;
    try {
      const path = tools
        ? await invoke<string | null>("choose_redis_backup_input", { tools: true })
        : await invoke<string | null>("choose_redis_rdb_destination");
      if (path) changePath(tools ? setToolsDirectory : setDestination, path);
    } catch (reason) { setError(String(reason)); }
    finally { pending.current = false; }
  }

  async function download(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !includeAllDatabases || (production && confirmation !== "PROD")) return;
    pending.current = true; setBusy(true); onBusy(true); setReport(undefined); setError("");
    try {
      const authentication = credentials.take();
      const token = await invoke<string>("prepare_query");
      setRequest(token);
      setReport(await invoke<Report>("download_redis_rdb", {
        request: token, password: authentication.password, useSavedPassword: authentication.useSavedPassword,
        input: { profile_id: profile.id, revision: profile.revision, destination, tools_directory: toolsDirectory,
          include_all_databases: includeAllDatabases, confirmation },
      }));
    } catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setRequest(undefined); setBusy(false); setCancelling(false); onBusy(false); }
  }

  async function cancel() {
    if (!request || cancelling) return;
    setCancelling(true);
    try {
      if (!await invoke<boolean>("cancel_query", { token: request })) setCancelling(false);
    } catch (reason) { setError(String(reason)); setCancelling(false); }
  }

  return <Dialog title="Redis RDB 다운로드" className="redis-monitor" busy={busy} onClose={onClose}>
    <form onSubmit={event => void download(event)} aria-busy={busy}>
      <p className="confirm-copy"><strong>{profile.settings.name} · {profile.settings.environment}</strong><br />
        {networkAddressText(profile.settings)}</p>
      <label className="field">새 RDB 파일 경로<span className="file-input">
        <input required value={destination} disabled={busy} onChange={event => changePath(setDestination, event.target.value)} />
        <button type="button" className="secondary" disabled={busy} onClick={() => void choose(false)}>경로 선택</button>
      </span></label>
      <label className="field">Redis 검사 도구 폴더<span className="file-input">
        <input required value={toolsDirectory} disabled={busy} onChange={event => changePath(setToolsDirectory, event.target.value)} />
        <button type="button" className="secondary" disabled={busy} onClick={() => void choose(true)}>도구 폴더 선택</button>
      </span></label>
      <DatabasePasswordField credentials={credentials} disabled={busy} />
      <label className="files-check"><input type="checkbox" required checked={includeAllDatabases} disabled={busy}
        onChange={event => setIncludeAllDatabases(event.target.checked)} /> 서버의 모든 논리 DB를 백업합니다.</label>
      {production && <label className="field">운영 환경 확인<input required pattern="PROD" placeholder="PROD" autoComplete="off"
        value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      {busy && <p className="form-note" role="status">{cancelling ? "중단하는 중…" : "스냅샷을 받고 redis-check-rdb로 검증하는 중…"}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {report && <section className="redis-backup-result" aria-label="RDB 다운로드 결과">
        <p className="success-banner" role="status">RDB 저장 완료 · {numbers.format(report.bytes)} 바이트</p>
        <p className="path">{report.destination}</p>
        <p className="form-note">{report.engine} {report.engine_version} · RDB 형식 {report.rdb.format_version} · 검사 도구 {report.checker_version}</p>
        <p className="form-note">{report.rdb.checksum_verified ? "내장 체크섬 검증 완료" : "내장 체크섬 없음"}
          {report.rdb.keys_read !== null && ` · 키 ${numbers.format(report.rdb.keys_read)}개`}</p>
        <p className="form-note">SHA-256 <code>{report.sha256}</code></p>
        {report.audit_warning && <p className="form-note" role="status">작업 기록을 저장할 수 없습니다.</p>}
      </section>}
      <div className="dialog-actions">
        {busy && <button type="button" className="secondary" disabled={!request || cancelling} onClick={() => void cancel()}>작업 중단</button>}
        <button type="submit" className="primary" disabled={busy || !includeAllDatabases || (production && confirmation !== "PROD")}>다운로드</button>
      </div>
    </form>
  </Dialog>;
}
