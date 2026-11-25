import { useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import { profileActionVerb, profileSubmitVerb, type ProfileAction } from "./profileActions";

export type RedisSettings = {
  name: string; host: string; port: number; database: number; username: string;
  environment: "DEV" | "STAGING" | "PROD"; tls: boolean; ca_path: string | null;
};
export type RedisProfile = { id: string; project_id: string; revision: number; settings: RedisSettings };
export type RedisProfileAction = ProfileAction<RedisProfile>;

const defaults: RedisSettings = { name: "", host: "", port: 6379, database: 0, username: "", environment: "DEV", tls: true, ca_path: null };

export function RedisProfileDialog({ action, projectId, onClose, onSaved }: {
  action: RedisProfileAction; projectId: string; onClose: () => void; onSaved: (profile: RedisProfile | null) => void;
}) {
  const [values, setValues] = useState("profile" in action ? action.profile.settings : { ...defaults, ...action.initial });
  const [port, setPort] = useState(String(values.port));
  const [database, setDatabase] = useState(String(values.database));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const deleting = action.kind === "delete";
  const title = "Redis 연결 " + profileActionVerb[action.kind];

  function update<K extends keyof RedisSettings>(key: K, value: RedisSettings[K]) {
    setValues(current => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const input = { ...values, port: Number(port), database: Number(database), ca_path: values.tls && values.ca_path ? values.ca_path : null };
      if (!("profile" in action)) onSaved(await invoke<RedisProfile>("create_redis_profile", { projectId, input }));
      else if (action.kind === "edit") onSaved(await invoke<RedisProfile>("update_redis_profile", { id: action.profile.id, revision: action.profile.revision, input }));
      else { await invoke("delete_redis_profile", { id: action.profile.id, revision: action.profile.revision }); onSaved(null); }
    } catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }

  async function chooseCertificate() {
    try {
      const path = await invoke<string | null>("choose_postgres_ca");
      if (path) update("ca_path", path);
    } catch (reason) { setError(String(reason)); }
  }

  return <Dialog title={title} busy={busy} onClose={onClose}>
    <form aria-busy={busy} onSubmit={event => void save(event)}>
      {deleting ? <p className="confirm-copy"><strong>{action.profile.settings.name}</strong>의 저장된 연결 설정을 삭제합니다.</p> :
        <fieldset className="postgres-profile-fields" disabled={busy}>
          <label className="field">연결 이름<input autoFocus required maxLength={80} value={values.name} onChange={event => update("name", event.target.value)} /></label>
          <div className="postgres-profile-address">
            <label className="field">호스트 이름 또는 IP<input required value={values.host} onChange={event => update("host", event.target.value)} /></label>
            <label className="field">포트<input type="number" min={1} max={65535} required value={port} onChange={event => setPort(event.target.value)} /></label>
          </div>
          <label className="field">DB 번호<input type="number" min={0} max={4294967295} required value={database} onChange={event => setDatabase(event.target.value)} /></label>
          <label className="field">ACL 사용자 이름<input maxLength={256} value={values.username} onChange={event => update("username", event.target.value)} /></label>
          <label className="field">환경<select value={values.environment} onChange={event => update("environment", event.target.value as RedisSettings["environment"])}>
            <option>DEV</option><option>STAGING</option><option>PROD</option></select></label>
          <label className="field">전송 방식<select value={values.tls ? "tls" : "tcp"} onChange={event => update("tls", event.target.value === "tls")}>
            <option value="tls">TLS · 인증서 검증</option><option value="tcp">일반 TCP</option></select></label>
          {values.tls && <label className="field">CA 인증서 경로 (선택)<span className="file-input">
            <input value={values.ca_path ?? ""} onChange={event => update("ca_path", event.target.value)} />
            <button type="button" className="secondary" onClick={() => void chooseCertificate()}>파일 선택</button>
          </span></label>}
          {!values.tls && <p className="form-note">일반 TCP는 암호와 데이터를 평문으로 전송합니다.</p>}
        </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className={deleting ? "danger" : "primary"} disabled={busy}>{profileSubmitVerb[action.kind]}</button></div>
    </form>
  </Dialog>;
}
