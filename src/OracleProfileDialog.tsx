import { useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import { profileActionVerb, profileSubmitVerb, type ProfileAction } from "./profileActions";

type OracleSettings = {
  name: string; host: string; port: number; target: "service_name" | "sid";
  service: string; username: string; transport: "tcps" | "tcp"; ca_path: string | null;
  environment: "DEV" | "STAGING" | "PROD";
};
export type OracleProfile = { id: string; project_id: string; revision: number; settings: OracleSettings };
export type OracleProfileAction = ProfileAction<OracleProfile>;
export const ORACLE_TCP_NOTE = "일반 TCP에서는 전송 데이터를 TLS로 보호하지 않습니다.";

const defaults: OracleSettings = {
  name: "", host: "", port: 2484, target: "service_name", service: "", username: "",
  transport: "tcps", ca_path: null, environment: "DEV",
};

export function OracleProfileDialog({ projectId, action, onClose, onSaved }: {
  projectId: string; action: OracleProfileAction; onClose: () => void; onSaved: (profile: OracleProfile | null) => void;
}) {
  const [values, setValues] = useState("profile" in action ? action.profile.settings : { ...defaults, ...action.initial });
  const [port, setPort] = useState(String(values.port));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const transportHint = useId();
  const verb = profileActionVerb[action.kind];

  function change<K extends keyof OracleSettings>(key: K, value: OracleSettings[K]) {
    setValues(current => ({ ...current, [key]: value }));
  }

  function chooseTransport(transport: OracleSettings["transport"]) {
    if (transport === "tcp" && port === "2484") setPort("1521");
    if (transport === "tcps" && port === "1521") setPort("2484");
    change("transport", transport);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const input = { ...values, port: Number(port), ca_path: values.transport === "tcps" ? values.ca_path || null : null };
      if (!("profile" in action)) onSaved(await invoke<OracleProfile>("create_oracle_profile", { projectId, input }));
      else {
        const target = { id: action.profile.id, revision: action.profile.revision };
        if (action.kind === "edit") onSaved(await invoke<OracleProfile>("update_oracle_profile", { ...target, input }));
        else { await invoke("delete_oracle_profile", target); onSaved(null); }
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

  return <Dialog title={"Oracle Database 연결 " + verb} busy={busy} onClose={onClose}>
    <form onSubmit={event => void save(event)} aria-busy={busy}>
      {action.kind === "delete" ? <p className="confirm-copy"><strong>{action.profile.settings.name}</strong>의 저장된 연결 설정을 삭제합니다.</p> :
        <fieldset className="postgres-profile-fields" disabled={busy}>
          <label className="field">연결 이름<input autoFocus required maxLength={80} value={values.name} onChange={event => change("name", event.target.value)} /></label>
          <label className="field">호스트 이름 또는 IP<input required maxLength={253} value={values.host} onChange={event => change("host", event.target.value)} placeholder="localhost" /></label>
          <label className="field">전송 방식<select value={values.transport} aria-describedby={values.transport === "tcp" ? transportHint : undefined}
            onChange={event => chooseTransport(event.target.value as OracleSettings["transport"])}>
            <option value="tcps">TCPS · 인증서 검증</option><option value="tcp">일반 TCP</option>
          </select></label>
          {values.transport === "tcp" && <p className="form-note" id={transportHint}>{ORACLE_TCP_NOTE}</p>}
          <label className="field">포트<input required type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} /></label>
          <label className="field">접속 대상 종류<select value={values.target} onChange={event => change("target", event.target.value as OracleSettings["target"])}>
            <option value="service_name">서비스 이름</option><option value="sid">SID</option>
          </select></label>
          <label className="field">{values.target === "sid" ? "SID" : "서비스 이름"}
            <input required maxLength={255} value={values.service} onChange={event => change("service", event.target.value)}
              placeholder={values.target === "sid" ? "FREE" : "FREEPDB1"} /></label>
          <label className="field">사용자 이름<input required maxLength={128} value={values.username} onChange={event => change("username", event.target.value)} /></label>
          <label className="field">환경<select value={values.environment} onChange={event => change("environment", event.target.value as OracleSettings["environment"])}>
            <option>DEV</option><option>STAGING</option><option>PROD</option>
          </select></label>
          {values.transport === "tcps" && <label className="field">CA 인증서 경로 (선택)<span className="file-input">
            <input value={values.ca_path ?? ""} onChange={event => change("ca_path", event.target.value)} />
            <button type="button" className="secondary" aria-label="CA 인증서 파일 선택" onClick={() => void chooseCa()}>파일 선택</button>
          </span></label>}
        </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className={action.kind === "delete" ? "danger" : "primary"} disabled={busy}>{profileSubmitVerb[action.kind]}</button>
      </div>
    </form>
  </Dialog>;
}
