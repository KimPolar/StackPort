import { useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import { profileActionVerb, profileSubmitVerb, type ProfileAction } from "./profileActions";

type SqlServerSettings = {
  name: string; host: string; port: number; database: string;
  authentication: "sql_login" | "windows"; username: string | null;
  encryption: "required" | "strict"; ca_path: string | null;
  environment: "DEV" | "STAGING" | "PROD";
};
export type SqlServerProfile = { id: string; project_id: string; revision: number; settings: SqlServerSettings };
export type SqlServerProfileAction = ProfileAction<SqlServerProfile>;

const defaults: SqlServerSettings = {
  name: "", host: "", port: 1433, database: "master", authentication: "sql_login", username: null,
  encryption: "required", ca_path: null, environment: "DEV",
};

export function SqlServerProfileDialog({ projectId, action, onClose, onSaved }: {
  projectId: string; action: SqlServerProfileAction; onClose: () => void; onSaved: (profile: SqlServerProfile | null) => void;
}) {
  const [values, setValues] = useState("profile" in action ? action.profile.settings : { ...defaults, ...action.initial });
  const [port, setPort] = useState(String(values.port));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const authHint = useId();
  const title = "SQL Server 연결 " + profileActionVerb[action.kind];

  function change<K extends keyof SqlServerSettings>(key: K, value: SqlServerSettings[K]) {
    setValues(current => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const input = {
        ...values, port: Number(port), ca_path: values.ca_path || null,
        username: values.authentication === "sql_login" ? values.username : null,
      };
      if (!("profile" in action)) onSaved(await invoke<SqlServerProfile>("create_sql_server_profile", { projectId, input }));
      else {
        const target = { id: action.profile.id, revision: action.profile.revision };
        if (action.kind === "edit") onSaved(await invoke<SqlServerProfile>("update_sql_server_profile", { ...target, input }));
        else { await invoke("delete_sql_server_profile", target); onSaved(null); }
      }
    } catch (cause) { setError(String(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  async function chooseCa() {
    try {
      const path = await invoke<string | null>("choose_postgres_ca");
      if (path) change("ca_path", path);
    } catch (cause) { setError(String(cause)); }
  }

  return <Dialog title={title} busy={busy} onClose={onClose}>
    <form onSubmit={event => void save(event)} aria-busy={busy}>
      {action.kind === "delete" ? <p className="confirm-copy"><strong>{action.profile.settings.name}</strong>의 저장된 연결 설정을 삭제합니다.</p> :
        <fieldset className="postgres-profile-fields" disabled={busy}>
          <label className="field">연결 이름<input autoFocus required maxLength={80} value={values.name} onChange={event => change("name", event.target.value)} /></label>
          <label className="field">호스트 이름 또는 IP<input required maxLength={253} value={values.host} onChange={event => change("host", event.target.value)} placeholder="localhost" /></label>
          <label className="field">포트<input required type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} /></label>
          <label className="field">데이터베이스 이름<input required maxLength={128} value={values.database} onChange={event => change("database", event.target.value)} /></label>
          <label className="field">인증 방식<select value={values.authentication}
            aria-describedby={values.authentication === "windows" ? authHint : undefined}
            onChange={event => change("authentication", event.target.value as SqlServerSettings["authentication"])}>
            <option value="sql_login">SQL Server 로그인</option>
            <option value="windows">Windows 통합 인증</option>
          </select></label>
          {values.authentication === "sql_login"
            ? <label className="field">로그인 이름<input required maxLength={128} value={values.username ?? ""} onChange={event => change("username", event.target.value)} /></label>
            : <p className="form-note" id={authHint}>현재 로그인한 Windows 계정으로 연결합니다.</p>}
          <label className="field">환경<select value={values.environment} onChange={event => change("environment", event.target.value as SqlServerSettings["environment"])}>
            <option>DEV</option><option>STAGING</option><option>PROD</option>
          </select></label>
          <label className="field">전송 암호화<select value={values.encryption} onChange={event => change("encryption", event.target.value as SqlServerSettings["encryption"])}>
            <option value="required">TLS 필수</option><option value="strict">엄격한 TLS (TDS 8.0)</option>
          </select></label>
          <label className="field">CA 인증서 경로 (선택)<span className="file-input">
            <input value={values.ca_path ?? ""} onChange={event => change("ca_path", event.target.value)} />
            <button type="button" className="secondary" aria-label="CA 인증서 파일 선택" onClick={() => void chooseCa()}>파일 선택</button>
          </span></label>
        </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className={action.kind === "delete" ? "danger" : "primary"} disabled={busy}>{profileSubmitVerb[action.kind]}</button>
      </div>
    </form>
  </Dialog>;
}
