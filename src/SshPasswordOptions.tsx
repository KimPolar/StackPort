import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SshProfile } from "./ssh-profile-types";

export type SshPasswordStatus = { supported: boolean; stored: boolean; usable: boolean };
export type SshPasswordChoice = { mode: "saved" | "remember"; fingerprint: string };

export function useSshPassword(profile: SshProfile | null, fingerprint: string | undefined) {
  const profileId = profile?.id;
  const revision = profile?.revision;
  const [status, setStatus] = useState<SshPasswordStatus | null>(null);
  const [saved, setSaved] = useState(false);
  const [remember, setRemember] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");
  const useSaved = Boolean(profileId && fingerprint && status?.usable && saved);

  useEffect(() => {
    setStatus(null);
    setSaved(false);
    setRemember(false);
    setMessage("");
    if (!profileId || revision === undefined || !fingerprint) return;
    let current = true;
    void invoke<SshPasswordStatus>("ssh_credential_status", { profileId, revision, fingerprint }).then(result => {
      if (current) setStatus(result);
    }, error => {
      if (current) setMessage(String(error));
    });
    return () => { current = false; };
  }, [profileId, revision, fingerprint]);

  function resetChoice() {
    setSaved(false);
    setRemember(false);
  }

  function argumentsFor(password: string) {
    if (useSaved && fingerprint) return { passwordChoice: { mode: "saved", fingerprint } };
    return {
      authentication: { kind: "password", password },
      ...(remember && status?.supported && profileId && fingerprint && password ? { passwordChoice: { mode: "remember", fingerprint } } : {}),
    };
  }

  async function forget() {
    if (!profileId || revision === undefined || clearing) return;
    setClearing(true);
    setMessage("");
    try {
      await invoke("forget_ssh_password", { profileId, revision });
      setStatus(current => current && { ...current, stored: false, usable: false });
      resetChoice();
      setMessage("저장한 암호를 삭제했습니다.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setClearing(false);
    }
  }

  function selectSaved(checked: boolean) {
    setSaved(checked);
    setRemember(false);
  }

  return { status, useSaved, setSaved: selectSaved, remember, setRemember, clearing, message, resetChoice, argumentsFor, forget };
}

export function SshPasswordOptions({ credentials, clearPassword }: {
  credentials: {
    status: SshPasswordStatus | null;
    useSaved: boolean;
    remember: boolean;
    setSaved: (checked: boolean) => void;
    setRemember: (checked: boolean) => void;
    clearing: boolean;
    message: string;
    forget: () => Promise<void>;
  };
  clearPassword?: () => void;
}) {
  const { status, useSaved, setSaved, remember, setRemember, clearing, message, forget } = credentials;
  return <>
    {status?.usable && <label className="files-check">
      <input type="checkbox" checked={useSaved} disabled={clearing} onChange={event => {
        setSaved(event.target.checked); clearPassword?.();
      }} /> 저장한 암호 사용
    </label>}
    {status?.supported && !useSaved && <label className="files-check">
      <input type="checkbox" checked={remember} disabled={clearing} onChange={event => setRemember(event.target.checked)} />
      연결 성공 후 Windows에 암호 저장
    </label>}
    {status?.stored && <>
      {!status.usable && <p className="form-note">현재 연결 설정이나 호스트 키에 저장된 암호가 없습니다.</p>}
      <button type="button" className="secondary small" disabled={clearing} onClick={() => void forget()}>저장한 암호 삭제</button>
    </>}
    {message && <p className="form-note" role="status">{message}</p>}
  </>;
}
