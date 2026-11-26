import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MysqlProfile } from "./MysqlProfileDialog";
import type { PostgresProfile } from "./PostgresWorkspace";

type Status = { supported: boolean; stored: boolean; usable: boolean };
type Engine = "postgres" | "mysql";
type Profile = PostgresProfile | MysqlProfile;

function credentialArgs(engine: Engine, profile: Profile) {
  return engine === "postgres" ? { profile } : { profileId: profile.id, revision: profile.revision };
}

export function useDatabaseCredentials(engine: Engine, profile: Profile | null) {
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [useSaved, setUseSaved] = useState(false);
  const [remember, setRemember] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setStatus(null);
    setPassword("");
    setUseSaved(false);
    setRemember(false);
    setMessage("");
    if (!profile) return;
    let live = true;
    void invoke<Status>(`${engine}_credential_status`, credentialArgs(engine, profile)).then(result => {
      if (live) setStatus(result);
    }, error => {
      if (live) setMessage(String(error));
    });
    return () => { live = false; };
  }, [engine, profile]);

  function take() {
    const saved = Boolean(status?.usable && useSaved);
    const input = { password: saved ? null : password, useSavedPassword: saved,
      rememberPassword: Boolean(!saved && status?.supported && remember && password) };
    setPassword("");
    return input;
  }

  async function forget() {
    if (clearing || !profile) return;
    setClearing(true);
    setMessage("");
    try {
      await invoke(`forget_${engine}_password`, credentialArgs(engine, profile));
      setStatus(current => current && { ...current, stored: false, usable: false });
      setUseSaved(false);
      setMessage("저장한 암호를 삭제했습니다.");
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setClearing(false);
    }
  }

  const label = engine === "postgres" ? "PostgreSQL 암호" : "MySQL 암호";
  return { label, status, password, setPassword, useSaved, setUseSaved, remember, setRemember, clearing, message, take, forget };
}

export function DatabasePasswordField({ credentials, disabled, allowRemember = false, autoFocus = false }: {
  credentials: ReturnType<typeof useDatabaseCredentials>; disabled: boolean; allowRemember?: boolean; autoFocus?: boolean;
}) {
  const { label, status, password, setPassword, useSaved, setUseSaved, remember, setRemember, clearing, message, forget } = credentials;
  const blocked = disabled || clearing;
  return <>
    {status?.usable && <label className="postgres-edit-opt-in"><input type="checkbox" checked={useSaved} disabled={blocked}
      onChange={event => { setUseSaved(event.target.checked); setPassword(""); setRemember(false); }} /> 저장한 암호 사용</label>}
    {!(status?.usable && useSaved) && <label className="field">{label}<input type="password" autoComplete="off"
      autoFocus={autoFocus} maxLength={4096} disabled={blocked} value={password} onChange={event => setPassword(event.target.value)} /></label>}
    {allowRemember && status?.supported && !useSaved && <label className="postgres-edit-opt-in">
      <input type="checkbox" checked={remember} disabled={blocked} onChange={event => setRemember(event.target.checked)} />
      연결 성공 후 Windows에 암호 저장
    </label>}
    {allowRemember && status?.stored && <>
      {!status.usable && <p className="form-note">연결 설정이 바뀌었습니다. 현재 설정의 암호를 입력하세요.</p>}
      <button type="button" className="secondary small" disabled={blocked} onClick={() => void forget()}>저장한 암호 삭제</button>
    </>}
    {message && <p className="form-note" role="status">{message}</p>}
  </>;
}
