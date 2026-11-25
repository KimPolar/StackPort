import { useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

export type MongoSettings = {
  name: string; uri: string; username: string | null; auth_database: string | null;
  environment: "DEV" | "STAGING" | "PROD"; tls: boolean; ca_path: string | null;
};
export type MongoProfile = { id: string; project_id: string; revision: number; settings: MongoSettings };
export type MongoProfileAction = { kind: "create" } | { kind: "edit" | "delete"; profile: MongoProfile };

const defaults: MongoSettings = {
  name: "", uri: "", username: null, auth_database: null, environment: "DEV", tls: true, ca_path: null,
};

export function mongoAddress(uri: string) {
  return uri.replace(/^mongodb(?:\+srv)?:\/\//, "").split(/[/?]/, 1)[0];
}

export function MongoProfileDialog({ action, projectId, onClose, onSaved }: {
  action: MongoProfileAction; projectId: string; onClose: () => void; onSaved: (profile: MongoProfile | null) => void;
}) {
  const [values, setValues] = useState(action.kind === "create" ? defaults : action.profile.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const deleting = action.kind === "delete";
  const title = `MongoDB 연결 ${deleting ? "삭제" : action.kind === "edit" ? "수정" : "추가"}`;

  function update<K extends keyof MongoSettings>(key: K, value: MongoSettings[K]) {
    setValues(current => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const input = { ...values, ca_path: values.tls ? values.ca_path || null : null,
        auth_database: values.username ? values.auth_database || null : null };
      if (action.kind === "create") onSaved(await invoke<MongoProfile>("create_mongo_profile", { projectId, input }));
      else {
        const target = { id: action.profile.id, revision: action.profile.revision };
        if (action.kind === "edit") onSaved(await invoke<MongoProfile>("update_mongo_profile", { ...target, input }));
        else { await invoke("delete_mongo_profile", target); onSaved(null); }
      }
    } catch (cause) { setError(String(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  async function chooseCa() {
    try {
      const path = await invoke<string | null>("choose_postgres_ca");
      if (path) update("ca_path", path);
    } catch (cause) { setError(String(cause)); }
  }

  return <Dialog title={title} busy={busy} onClose={onClose}>
    <form onSubmit={event => void save(event)} aria-busy={busy}>
      {deleting ? <p className="confirm-copy"><strong>{action.profile.settings.name}</strong>의 저장된 연결 설정을 삭제합니다.</p> :
        <fieldset className="postgres-profile-fields" disabled={busy}>
          <label className="field">연결 이름<input autoFocus required maxLength={80} value={values.name} onChange={event => update("name", event.target.value)} /></label>
          <label className="field">MongoDB 연결 주소<input required maxLength={4096} autoComplete="off" spellCheck={false}
            placeholder="mongodb://localhost:27017" value={values.uri} onChange={event => update("uri", event.target.value)} /></label>
          <label className="field">사용자 이름 (선택)<input maxLength={256} value={values.username ?? ""} onChange={event => update("username", event.target.value || null)} /></label>
          {values.username && <label className="field">인증 데이터베이스 (선택)<input maxLength={63} placeholder="admin"
            value={values.auth_database ?? ""} onChange={event => update("auth_database", event.target.value || null)} /></label>}
          <label className="field">환경<select value={values.environment} onChange={event => update("environment", event.target.value as MongoSettings["environment"])}>
            <option>DEV</option><option>STAGING</option><option>PROD</option></select></label>
          <label className="field">전송 방식<select value={values.tls ? "tls" : "tcp"} onChange={event => update("tls", event.target.value === "tls")}>
            <option value="tls">TLS · 인증서 검증</option><option value="tcp">일반 TCP</option></select></label>
          {values.tls ? <label className="field">CA 인증서 경로 (선택)<span className="file-input">
            <input value={values.ca_path ?? ""} onChange={event => update("ca_path", event.target.value)} />
            <button type="button" className="secondary" aria-label="CA 인증서 파일 선택" onClick={() => void chooseCa()}>파일 선택</button>
          </span></label> : <p className="form-note">일반 TCP는 암호와 데이터를 평문으로 전송합니다.</p>}
        </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className={deleting ? "danger" : "primary"} disabled={busy}>{deleting ? "삭제" : "저장"}</button>
      </div>
    </form>
  </Dialog>;
}
