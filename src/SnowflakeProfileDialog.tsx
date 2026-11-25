import { useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import { profileActionVerb, profileSubmitVerb, type ProfileAction } from "./profileActions";

type Settings = {
  name: string; host: string; database: string; warehouse: string | null; role: string | null;
  auth: "pat" | "oauth"; environment: "DEV" | "STAGING" | "PROD";
};
export type SnowflakeProfile = { id: string; project_id: string; revision: number; settings: Settings };
export type SnowflakeProfileAction = ProfileAction<SnowflakeProfile>;

const defaults: Settings = {
  name: "", host: "", database: "", warehouse: null, role: null, auth: "pat", environment: "DEV",
};

export function SnowflakeProfileDialog({ projectId, action, onClose, onSaved }: {
  projectId: string; action: SnowflakeProfileAction; onClose: () => void; onSaved: (profile: SnowflakeProfile | null) => void;
}) {
  const [values, setValues] = useState("profile" in action ? action.profile.settings : { ...defaults, ...action.initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const databaseHint = useId();
  const authLabel = useId();
  const verb = profileActionVerb[action.kind];

  function change<K extends keyof Settings>(key: K, value: Settings[K]) {
    setValues(current => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!("profile" in action)) onSaved(await invoke<SnowflakeProfile>("create_snowflake_profile", { projectId, input: values }));
      else {
        const target = { id: action.profile.id, revision: action.profile.revision };
        if (action.kind === "edit") onSaved(await invoke<SnowflakeProfile>("update_snowflake_profile", { ...target, input: values }));
        else {
          await invoke("delete_snowflake_profile", target);
          onSaved(null);
        }
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <Dialog title={"Snowflake 연결 " + verb} busy={busy} onClose={onClose}>
    <form onSubmit={event => void save(event)} aria-busy={busy}>
      {action.kind === "delete" ? <p className="confirm-copy"><strong>{action.profile.settings.name}</strong>의 저장된 연결 설정을 삭제합니다.</p> :
        <fieldset className="postgres-profile-fields" disabled={busy}>
          <label className="field">연결 이름<input autoFocus required maxLength={80} value={values.name} onChange={event => change("name", event.target.value)} /></label>
          <label className="field">계정 식별자 또는 호스트<input required maxLength={253} value={values.host} onChange={event => change("host", event.target.value)}
            placeholder="organization-account" autoCapitalize="none" spellCheck={false} /></label>
          <label className="field">데이터베이스 이름<input required maxLength={255} value={values.database} onChange={event => change("database", event.target.value)}
            aria-describedby={databaseHint} spellCheck={false} /></label>
          <p className="form-note" id={databaseHint}>Snowflake에 표시된 이름을 대소문자까지 그대로 입력하세요.</p>
          <label className="field">웨어하우스 (선택)<input maxLength={255} value={values.warehouse ?? ""}
            onChange={event => change("warehouse", event.target.value || null)} placeholder="사용자 기본값" aria-describedby={databaseHint} spellCheck={false} /></label>
          <label className="field">역할 (선택)<input maxLength={255} value={values.role ?? ""}
            onChange={event => change("role", event.target.value || null)} placeholder="사용자 기본값" aria-describedby={databaseHint} spellCheck={false} /></label>
          <label className="field"><span id={authLabel}>인증 방식</span><select aria-labelledby={authLabel}
            value={values.auth} onChange={event => change("auth", event.target.value as Settings["auth"])}>
            <option value="pat">프로그래밍 방식 액세스 토큰 (PAT)</option><option value="oauth">OAuth 액세스 토큰</option>
          </select></label>
          <label className="field">환경<select value={values.environment} onChange={event => change("environment", event.target.value as Settings["environment"])}>
            <option>DEV</option><option>STAGING</option><option>PROD</option>
          </select></label>
        </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className={action.kind === "delete" ? "danger" : "primary"} disabled={busy}>{profileSubmitVerb[action.kind]}</button>
      </div>
    </form>
  </Dialog>;
}
