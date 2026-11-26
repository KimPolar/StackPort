import { useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Format = "rdb" | "aof_file" | "aof_manifest";
type FileInfo = { name: string; role: "rdb" | "aof" | "manifest" | "base" | "incremental"; bytes: number; sha256: string };
type Recovery = { server_version: string; loaded_keys: number; expired_on_load: number; live_keys: number;
  databases: { database: number; keys: number; expiring: number }[] };
type Report = { format: Format; checker_version: string; files: FileInfo[];
  rdb: { format_version: number; checksum_verified: boolean; keys_read: number | null; expired_keys: number | null } | null;
  recovery?: Recovery };

const kindLabels: Record<FileInfo["role"], string> = {
  rdb: "RDB", aof: "AOF", manifest: "매니페스트", base: "기본 파일", incremental: "증분 파일",
};
const numbers = new Intl.NumberFormat("ko-KR");

export function RedisBackupFileDialog({ onBusy, onClose }: {
  onBusy: (busy: boolean) => void; onClose: () => void;
}) {
  const [format, setFormat] = useState<Format>("rdb");
  const [source, setSource] = useState("");
  const [directory, setDirectory] = useState("");
  const [request, setRequest] = useState<string>();
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<"inspect" | "restore">();
  const [cancelling, setCancelling] = useState(false);
  const working = useRef(false);
  const busy = operation !== undefined;

  function clearResult() { setReport(undefined); setError(""); }

  async function choose(tools: boolean) {
    if (working.current) return;
    working.current = true;
    try {
      const path = await invoke<string | null>("choose_redis_backup_input", { tools });
      if (path) { (tools ? setDirectory : setSource)(path); clearResult(); }
    } catch (reason) { setError(String(reason)); }
    finally { working.current = false; }
  }

  async function run(mode: "inspect" | "restore") {
    if (working.current) return;
    const sha256 = report?.files[0]?.sha256;
    if (mode === "restore" && !sha256) return;
    working.current = true; setOperation(mode); setError(""); onBusy(true);
    if (mode === "inspect") setReport(undefined);
    else setReport(value => value && { ...value, recovery: undefined });
    try {
      const token = await invoke<string>("prepare_query");
      setRequest(token);
      const next = mode === "restore" ? invoke<Report>("verify_redis_rdb_restore", { request: token, source, directory, sha256 })
        : invoke<Report>("inspect_redis_backup_file", { request: token, format, source, directory });
      setReport(await next);
    } catch (reason) { setError(String(reason)); }
    finally {
      working.current = false; setRequest(undefined); setOperation(undefined); setCancelling(false); onBusy(false);
    }
  }

  function inspect(event: FormEvent) { event.preventDefault(); void run("inspect"); }

  async function cancel() {
    if (!request || cancelling) return;
    setCancelling(true);
    try { if (!await invoke<boolean>("cancel_query", { token: request })) setCancelling(false); }
    catch (reason) { setError(String(reason)); setCancelling(false); }
  }

  return <Dialog title="Redis 백업 파일 검사" className="redis-monitor" busy={busy} onClose={onClose}>
    <form onSubmit={event => void inspect(event)} aria-busy={busy}>
      <label className="field">백업 형식<select value={format} disabled={busy} onChange={event => {
        setFormat(event.target.value as Format); setSource(""); clearResult();
      }}>
        <option value="rdb">RDB 스냅샷</option><option value="aof_file">단일 AOF 파일</option>
        <option value="aof_manifest">다중 파일 AOF</option>
      </select></label>
      <label className="field">{format === "aof_manifest" ? "로컬 AOF 매니페스트 경로" : "로컬 백업 파일 경로"}<span className="file-input">
        <input value={source} required disabled={busy} onChange={event => { setSource(event.target.value); clearResult(); }} />
        <button type="button" className="secondary" disabled={busy} onClick={() => void choose(false)}>파일 선택</button>
      </span></label>
      <label className="field">Redis 검사 도구 폴더<span className="file-input">
        <input required value={directory} disabled={busy} onChange={event => { setDirectory(event.target.value); clearResult(); }} />
        <button type="button" className="secondary" disabled={busy} onClick={() => void choose(true)}>도구 폴더 선택</button>
      </span></label>
      <p className="form-note">{format === "rdb" ? "redis-check-rdb" : "redis-check-aof"}로 임시 사본의 형식을 검사합니다.
        {format === "aof_manifest" && " 매니페스트와 기본·증분 파일을 같은 폴더에 복사해 두세요."}</p>
      {busy && <p className="form-note" role="status">{cancelling ? "중단 요청 중…" : operation === "restore"
        ? "임시 Redis에서 사본을 복원하고 키 수를 확인하는 중…" : "사본을 준비하고 형식을 검사하는 중…"}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {report && <section className="redis-backup-result" aria-label="Redis 백업 검사 결과">
        <p className="success-banner" role="status">파일 검사 통과 · Redis 검사 도구 {report.checker_version}</p>
        {report.rdb && <p className="form-note">RDB 형식 {report.rdb.format_version} · {report.rdb.checksum_verified ? "내장 체크섬 검증 완료" : "내장 체크섬 미검증"}
          {report.rdb.keys_read !== null && ` · 키 ${numbers.format(report.rdb.keys_read)}개`}
          {report.rdb.expired_keys !== null && ` · 이미 만료된 키 ${numbers.format(report.rdb.expired_keys)}개`}</p>}
        <div className="redis-values" tabIndex={0} role="region" aria-label="검사한 파일 목록"><table>
          <thead><tr><th scope="col">파일</th><th scope="col">유형</th><th scope="col">바이트</th><th scope="col">SHA-256</th></tr></thead>
          <tbody>{report.files.map(file => <tr key={`${file.role}-${file.name}`}><th scope="row">{file.name}</th>
            <td>{kindLabels[file.role]}</td><td>{numbers.format(file.bytes)}</td><td><code>{file.sha256}</code></td>
          </tr>)}</tbody>
        </table></div>
        {report.recovery && <RecoveryResult result={report.recovery} />}
        {report.rdb ? <p className="form-note">격리 복원은 같은 도구 폴더의 Redis 7 이상을 임시로 실행해 검증합니다.</p>
          : <p className="form-note">AOF의 복원 호환성은 대상과 같은 버전·모듈을 사용한 격리 서버에서 확인합니다.</p>}
      </section>}
      <div className="dialog-actions">
        {busy && <button className="secondary" type="button" disabled={!request || cancelling} onClick={() => void cancel()}>작업 중단</button>}
        {report?.rdb && <button className="secondary" type="button" disabled={busy} onClick={() => void run("restore")}>격리 복원 검증</button>}
        <button className="primary" type="submit" disabled={busy}>백업 파일 검사</button>
      </div>
    </form>
  </Dialog>;
}

function RecoveryResult({ result }: { result: Recovery }) {
  return <section aria-label="RDB 격리 복원 결과">
    <p className="success-banner" role="status">격리 복원 검증 통과 · Redis {result.server_version}</p>
    <p className="form-note">로드 {numbers.format(result.loaded_keys)}개 · 로드 시 만료 {numbers.format(result.expired_on_load)}개 · 조회 시 키 {numbers.format(result.live_keys)}개</p>
    {result.databases.length > 0 && <div className="redis-values" role="region" aria-label="복원한 논리 DB" tabIndex={0}>
      <table><thead><tr><th scope="col">논리 DB</th><th scope="col">키</th><th scope="col">만료 설정</th></tr></thead>
        <tbody>{result.databases.map(database => <tr key={database.database}><th scope="row">DB {database.database}</th>
          <td>{numbers.format(database.keys)}</td><td>{numbers.format(database.expiring)}</td></tr>)}</tbody></table>
    </div>}
  </section>;
}
