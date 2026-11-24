import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { PostgresProfile, PostgresProfileAction, PostgresSettings } from "./PostgresWorkspace";

const initial: PostgresSettings = { name: "", host: "", port: 5432, database: "", username: "", environment: "DEV", ca_path: null };

export function PostgresProfileDialog({ action, projectId, onClose, onSaved }: {
  action: PostgresProfileAction;
  projectId: string;
  onClose: () => void;
  onSaved: (profile: PostgresProfile | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const caInput = useId();
  const [values, setValues] = useState(action.kind === "create" ? initial : action.profile.settings);
  const [port, setPort] = useState(String(values.port));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const heading = action.kind === "create" ? "PostgreSQL 연결 추가" : action.kind === "edit" ? "PostgreSQL 연결 수정" : "PostgreSQL 연결 삭제";
  useEffect(() => { dialog.current?.showModal(); }, []);

  function update<K extends keyof PostgresSettings>(key: K, value: PostgresSettings[K]) {
    setValues(current => ({ ...current, [key]: value }));
  }

  async function perform(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await work(); }
    catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void perform(async () => {
      const input = { ...values, port: Number(port), ca_path: values.ca_path || null };
      if (action.kind === "create") onSaved(await invoke<PostgresProfile>("create_postgres_profile", { projectId, input }));
      else {
        const { id, revision } = action.profile;
        if (action.kind === "edit") onSaved(await invoke<PostgresProfile>("update_postgres_profile", { id, revision, input }));
        else { await invoke("delete_postgres_profile", { id, revision }); onSaved(null); }
      }
    });
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby={title} onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2 id={title}>{heading}</h2><button type="button" className="icon-button" aria-label="PostgreSQL 설정 닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={17} aria-hidden /></button></div>
    <form onSubmit={save} aria-busy={busy}>
      {action.kind === "delete" ? <p className="confirm-copy"><strong>{action.profile.settings.name}</strong>의 저장된 연결을 삭제하고 열린 SQL 탭을 닫습니다.</p> :
        <fieldset className="postgres-profile-fields" disabled={busy}>
          <label className="field">연결 이름<input value={values.name} autoFocus required maxLength={80} onChange={event => update("name", event.target.value)} /></label>
          <div className="postgres-profile-address"><label className="field">호스트 이름 또는 IP<input value={values.host} required onChange={event => update("host", event.target.value)} /></label>
            <label className="field">포트<input type="number" min="1" max="65535" value={port} required onChange={event => setPort(event.target.value)} /></label></div>
          <label className="field">데이터베이스 이름<input value={values.database} required maxLength={256} onChange={event => update("database", event.target.value)} /></label>
          <label className="field">사용자 이름<input value={values.username} required maxLength={256} onChange={event => update("username", event.target.value)} /></label>
          <label className="field">환경<select value={values.environment} onChange={event => update("environment", event.target.value as PostgresSettings["environment"])}>
            <option>DEV</option><option>STAGING</option><option>PROD</option></select></label>
          <div className="field"><label htmlFor={caInput}>CA 인증서 경로 (선택)</label><span className="file-input">
            <input id={caInput} value={values.ca_path ?? ""} onChange={event => update("ca_path", event.target.value || null)} />
            <button type="button" className="secondary" onClick={() => void perform(async () => {
              const path = await invoke<string | null>("choose_postgres_ca"); if (path) update("ca_path", path);
            })}>파일 선택</button>
          </span></div>
        </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>취소</button>
        <button type="submit" className={action.kind === "delete" ? "danger" : "primary"} disabled={busy}>{action.kind === "delete" ? "삭제" : "저장"}</button></div>
    </form>
  </dialog>;
}
