import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import { useNativeRead } from "./usePostgresRead";

type Kind = "rdb" | "aof";
type Report = { kind: Kind; status: "running" | "succeeded" | "failed" | "unconfirmed"; audit_warning: boolean };
type Info = {
  rdb_in_progress: boolean; last_rdb_save: number | null; last_rdb_ok: boolean | null;
  aof_enabled: boolean; aof_in_progress: boolean; aof_scheduled: boolean; last_aof_ok: boolean | null;
  directory: string | null; rdb_filename: string | null; aof_directory: string | null; aof_filename: string | null;
  job: Report | null;
};

const titles: Record<Kind, string> = { rdb: "RDB 스냅샷", aof: "AOF 재작성" };
const results: Record<Report["status"], string> = { running: "확인 중", succeeded: "서버 작업 완료", failed: "서버 작업 실패", unconfirmed: "결과 미확인" };
const dateFormat = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" });
const lastStatus = (ok: boolean | null) => ok == null ? "미확인" : ok ? "성공" : "실패";

function lastSave(seconds: number | null) {
  const date = new Date((seconds ?? 0) * 1000);
  return seconds && Number.isFinite(date.getTime()) ? dateFormat.format(date) : "미확인";
}

export function RedisPersistenceDialog({ id, target, environment, allowPersistence, onBusy, onClose, onFailure, onInspect }: {
  id: string; target: string; environment: string; allowPersistence: boolean;
  onBusy: (busy: boolean) => void; onClose: () => void; onFailure: (error: string) => boolean;
  onInspect: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const args = useMemo(() => ({ id }), [id]);
  const { data, error, loading } = useNativeRead<Info>("redis_persistence_info", args, revision, true);
  const [result, setResult] = useState<Report>();
  const [kind, setKind] = useState<Kind>("rdb");
  const [confirmed, setConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState("");
  const working = useRef(false);
  const job = result ?? data?.job;
  const watching = job?.status === "running";
  const blocked = !data || data.rdb_in_progress || data.aof_in_progress || data.aof_scheduled || (kind === "aof" && !data.aof_enabled);

  useEffect(() => { if (error) onFailure(error); }, [error, onFailure]);
  useEffect(() => {
    if (!watching) return;
    let current = true;
    let timer: number;
    async function poll() {
      try {
        const report = await invoke<Report>("redis_persistence_report", { id });
        if (!current) return;
        setResult(report);
        if (report.status === "running") timer = window.setTimeout(poll, 700);
        else setRevision(value => value + 1);
      } catch (reason) {
        if (current && !onFailure(String(reason))) setFailure(String(reason));
      }
    }
    timer = window.setTimeout(poll, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [watching, id, onFailure]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (working.current || watching || blocked || !confirmed || (environment === "PROD" && confirmation !== "PROD")) return;
    working.current = true; setStarting(true); onBusy(true); setFailure("");
    try {
      setResult(await invoke<Report>("redis_start_persistence", { id, kind, confirmed, confirmation }));
      setConfirmed(false); setConfirmation("");
    } catch (reason) {
      if (!onFailure(String(reason))) setFailure(String(reason));
    } finally {
      working.current = false; setStarting(false); onBusy(false);
    }
  }

  return <Dialog title="Redis 백업 관리" onClose={onClose} busy={starting} className="redis-monitor">
    <form onSubmit={event => void start(event)} aria-busy={loading || starting}>
      <div className="redis-monitor-toolbar"><p>{target} · 전체 논리 DB</p>
        <button type="button" className="secondary small" disabled={starting} onClick={onInspect}>로컬 백업 파일 검사</button>
        <button type="button" className="secondary small" disabled={loading || starting}
          onClick={() => setRevision(value => value + 1)}>저장 상태 새로 고침</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {loading && <p className="form-note" role="status">서버 저장 상태를 읽는 중…</p>}
      {data && <dl className="redis-key-meta">
        <div><dt>RDB</dt><dd>{data.rdb_in_progress ? "저장 중" : `최근 ${lastStatus(data.last_rdb_ok)}`} · {lastSave(data.last_rdb_save)}</dd></div>
        <div><dt>AOF</dt><dd>{!data.aof_enabled ? "꺼짐" : data.aof_in_progress ? "재작성 중" : data.aof_scheduled ? "예약됨" : `최근 ${lastStatus(data.last_aof_ok)}`}</dd></div>
        <div><dt>서버 데이터 폴더</dt><dd><code>{data.directory ?? "권한 또는 설정 확인 필요"}</code></dd></div>
        <div><dt>RDB 파일 이름</dt><dd><code>{data.rdb_filename ?? "경로 조회 권한 필요"}</code></dd></div>
        {data.aof_enabled && <div><dt>AOF 폴더·파일 이름</dt><dd><code>{[data.aof_directory, data.aof_filename].filter(Boolean).join(" · ") || "권한 또는 설정 확인 필요"}</code></dd></div>}
      </dl>}
      {job && <p className={job.status === "succeeded" ? "success-banner" : "form-note"} role="status">
        {titles[job.kind]} · {results[job.status]}{job.audit_warning && " · 작업 기록 저장 실패"}
      </p>}
      {allowPersistence && data && <>
        <label className="field">저장 작업<select value={kind} disabled={starting || watching} onChange={event => {
          setKind(event.target.value as Kind); setConfirmed(false); setConfirmation(""); setFailure("");
        }}><option value="rdb">{titles.rdb}</option><option value="aof" disabled={!data.aof_enabled}>{titles.aof}</option></select></label>
        <label className="redis-edit-permission"><input type="checkbox" checked={confirmed} disabled={starting || watching}
          onChange={event => setConfirmed(event.target.checked)} /> 서버 전체의 저장 작업과 디스크 사용을 확인했습니다.</label>
        {environment === "PROD" && <label className="field">운영 환경 확인<input value={confirmation} disabled={starting || watching}
          autoComplete="off" placeholder="PROD" onChange={event => setConfirmation(event.target.value)} /></label>}
        <div className="dialog-actions"><button className="primary" type="submit"
          disabled={starting || watching || loading || blocked || !confirmed || (environment === "PROD" && confirmation !== "PROD")}>
          {starting ? "요청 중…" : `${titles[kind]} 요청`}</button></div>
      </>}
      {!allowPersistence && <p className="form-note">저장 작업을 요청하려면 연결할 때 백업 관리를 허용하세요.</p>}
      {failure && <p className="form-error" role="alert">{failure}</p>}
      <details><summary>파일 확보 및 격리 복원</summary>
        <p className="form-note">작업은 Redis 서버의 데이터 폴더에 쓰며, 로컬로 복사하려면 해당 서버의 파일 읽기 권한과 SFTP 등 별도 전송 수단이 필요합니다.</p>
        <p className="form-note">RDB는 완료된 파일을 복사해 호환 버전의 정지된 검증 서버에서 데이터 폴더와 파일 이름을 맞춘 뒤 시작합니다. AOF를 끈 검증 서버에서 키와 만료를 확인합니다.</p>
        <p className="form-note">AOF 재작성은 서버의 로그를 정리합니다. Redis 7 이상은 쓰기와 재작성이 없는 일관된 시점의 AOF 폴더 전체를 확보하고, 일치하는 설정과 호환 버전의 검증 서버에서 AOF를 켜고 시작합니다.</p>
      </details>
    </form>
  </Dialog>;
}
