import { useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

export type MysqlSettings = { name: string; host: string; port: number; username: string; database: string | null;
  environment: "DEV" | "STAGING" | "PROD"; tls: boolean; ca_path: string | null };
export type MysqlProfile = { id: string; project_id: string; revision: number; settings: MysqlSettings };
export type MysqlProfileAction = { kind: "create" } | { kind: "edit" | "delete"; profile: MysqlProfile };

const defaults: MysqlSettings = { name: "", host: "", port: 3306, username: "", database: null, environment: "DEV", tls: true, ca_path: null };

export function MysqlProfileDialog({ action, projectId, onSaved, onClose }: {
  action: MysqlProfileAction; projectId: string; onSaved: (profile: MysqlProfile | null) => void; onClose: () => void;
}) {
  const [settings, setSettings] = useState(action.kind === "create" ? defaults : action.profile.settings);
  const [port, setPort] = useState(String(settings.port));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const deleting = action.kind === "delete";
  const title = `MySQL 계열 연결 ${deleting ? "삭제" : action.kind === "edit" ? "수정" : "추가"}`;

  function update<K extends keyof MysqlSettings>(key: K, value: MysqlSettings[K]) {
    setSettings(current => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const input = { ...settings, port: Number(port), database: settings.database || null,
        ca_path: settings.tls ? settings.ca_path || null : null };
      if (action.kind === "create") onSaved(await invoke<MysqlProfile>("create_mysql_profile", { projectId, input }));
      else {
        const target = { id: action.profile.id, revision: action.profile.revision };
        if (action.kind === "edit") onSaved(await invoke<MysqlProfile>("update_mysql_profile", { ...target, input }));
        else { await invoke("delete_mysql_profile", target); onSaved(null); }
      }
    } catch (cause) { setError(String(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  async function chooseCertificate() {
    try {
      const path = await invoke<string | null>("choose_postgres_ca");
      if (path) update("ca_path", path);
    } catch (cause) { setError(String(cause)); }
  }

  return <Dialog title={title} busy={busy} onClose={onClose}>
    <form aria-busy={busy} onSubmit={event => void save(event)}>
      {deleting ? <p className="confirm-copy"><strong>{action.profile.settings.name}</strong>의 저장된 연결 설정을 삭제합니다.</p> :
        <fieldset className="postgres-profile-fields" disabled={busy}>
          <label className="field">연결 이름<input required maxLength={80} value={settings.name} onChange={event => update("name", event.target.value)} /></label>
          <div className="postgres-profile-address">
            <label className="field">호스트 이름 또는 IP<input required value={settings.host} onChange={event => update("host", event.target.value)} /></label>
            <label className="field">포트<input type="number" min={1} max={65535} required value={port} onChange={event => setPort(event.target.value)} /></label>
          </div>
          <label className="field">사용자 이름<input required maxLength={128} value={settings.username} onChange={event => update("username", event.target.value)} /></label>
          <label className="field">시작 데이터베이스 (선택)<input maxLength={64} value={settings.database ?? ""} onChange={event => update("database", event.target.value)} /></label>
          <label className="field">환경<select value={settings.environment} onChange={event => update("environment", event.target.value as MysqlSettings["environment"])}>
            <option>DEV</option><option>STAGING</option><option>PROD</option></select></label>
          <label className="field">전송 방식<select value={settings.tls ? "tls" : "tcp"} onChange={event => update("tls", event.target.value === "tls")}>
            <option value="tls">TLS · 인증서 검증</option><option value="tcp">일반 TCP</option></select></label>
          {settings.tls ? <label className="field">CA 인증서 경로 (선택)<span className="file-input">
            <input value={settings.ca_path ?? ""} onChange={event => update("ca_path", event.target.value)} />
            <button type="button" className="secondary" onClick={() => void chooseCertificate()}>파일 선택</button>
          </span></label> : <p className="form-note">일반 TCP 연결에는 TLS 전송 보호가 적용되지 않습니다.</p>}
        </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className={deleting ? "danger" : "primary"} disabled={busy}>{deleting ? "삭제" : "저장"}</button></div>
    </form>
  </Dialog>;
}
