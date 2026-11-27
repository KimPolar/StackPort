import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PostgresProfile } from "./PostgresWorkspace";

type Status = { supported: boolean; stored: boolean; usable: boolean };
type Engine = "postgres" | "mysql" | "redis" | "mongo" | "sql_server" | "oracle" | "snowflake";
type Profile = Pick<PostgresProfile, "id" | "revision">;
const passwordLabels: Record<Engine, string> = {
  postgres: "PostgreSQL 암호", mysql: "MySQL 암호", redis: "Redis 암호", mongo: "MongoDB 암호",
  sql_server: "SQL Server 암호", oracle: "Oracle Database 암호", snowflake: "Snowflake 액세스 토큰",
};

function credentialArgs(engine: Engine, profile: Profile) {
  return engine === "postgres" ? { profile } : { profileId: profile.id, revision: profile.revision };
}

export function useDatabaseCredentials<E extends Engine>(engine: E, profile: (E extends "postgres" ? PostgresProfile : Profile) | null) {
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [useSaved, setUseSaved] = useState(false);
  const [remember, setRemember] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");
  const token = engine === "snowflake";
  const credentialName = token ? "토큰" : "암호";
  const credentialObject = token ? "토큰을" : "암호를";

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
      await invoke(`forget_${engine}_${token ? "token" : "password"}`, credentialArgs(engine, profile));
      setStatus(current => current && { ...current, stored: false, usable: false });
      setUseSaved(false);
      setMessage(`저장한 ${credentialObject} 삭제했습니다.`);
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setClearing(false);
    }
  }

  return { label: passwordLabels[engine], credentialName, credentialObject, status, password, setPassword, useSaved, setUseSaved, remember, setRemember, clearing, message, take, forget };
}

export function DatabasePasswordField({ credentials, disabled, allowRemember = false, autoFocus = false, passwordLabel, acceptsPassword = true, maxLength = 4096, required = false }: {
  credentials: ReturnType<typeof useDatabaseCredentials>; disabled: boolean; allowRemember?: boolean; autoFocus?: boolean;
  passwordLabel?: string;
  acceptsPassword?: boolean;
  maxLength?: number;
  required?: boolean;
}) {
  const { label, credentialName, credentialObject, status, password, setPassword, useSaved, setUseSaved, remember, setRemember, clearing, message, forget } = credentials;
  const blocked = disabled || clearing;
  return <>
    {acceptsPassword && status?.usable && <label className="postgres-edit-opt-in"><input type="checkbox" checked={useSaved} disabled={blocked}
      onChange={event => { setUseSaved(event.target.checked); setPassword(""); setRemember(false); }} /> 저장한 {credentialName} 사용</label>}
    {acceptsPassword && !(status?.usable && useSaved) && <label className="field">{passwordLabel ?? label}<input type="password" autoComplete="off"
      autoFocus={autoFocus} maxLength={maxLength} required={required} disabled={blocked} value={password} onChange={event => setPassword(event.target.value)} /></label>}
    {acceptsPassword && allowRemember && status?.supported && !useSaved && <label className="postgres-edit-opt-in">
      <input type="checkbox" checked={remember} disabled={blocked} onChange={event => setRemember(event.target.checked)} />
      연결 성공 후 Windows에 {credentialName} 저장
    </label>}
    {allowRemember && status?.stored && <>
      {acceptsPassword && !status.usable && <p className="form-note">연결 설정이 바뀌었습니다. 현재 설정의 {credentialObject} 입력하세요.</p>}
      <button type="button" className="secondary small" disabled={blocked} onClick={() => void forget()}>저장한 {credentialName} 삭제</button>
    </>}
    {message && <p className="form-note" role="status">{message}</p>}
  </>;
}
