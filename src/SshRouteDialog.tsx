import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { SshProfile } from "./ssh-profile-types";
import { tunnelPath, type SavedSshTunnel } from "./sshTunnel";

type Credentials = { method: "password" | "private_key"; path: string; secret: string };
type Hop = { profile: SshProfile; credentials: Credentials };
type TrustRequest = { status: "trust_required"; stage: string; host: {
  host: string; port: number; token: string; keys: { algorithm: string; fingerprint: string }[];
} };
type RouteResponse<Session> = { status: "open"; session: Session } | TrustRequest;

const maxHops = 3;
const emptyCredentials: Credentials = { method: "password", path: "", secret: "" };
const address = ({ host, port }: Pick<SshProfile, "host" | "port">) => `${host.includes(":") ? `[${host}]` : host}:${port}`;
const authentication = (credentials: Credentials) => credentials.method === "password"
  ? { kind: "password", password: credentials.secret }
  : { kind: "private_key", path: credentials.path, passphrase: credentials.secret };

export function SshRouteDialog<Session>({ tool, tunnel, target, profiles, initialHops = [], initialFiles = true, onBusy, onClose, onOpened }: ({
  tool: "sftp" | "terminal";
  tunnel?: never;
} | {
  tool: "tunnel";
  tunnel: SavedSshTunnel;
}) & {
  target: SshProfile;
  profiles: SshProfile[];
  initialHops?: string[];
  initialFiles?: boolean;
  onBusy: (value: boolean) => void;
  onClose: () => void;
  onOpened: (session: Session, route: SshProfile[], withFiles: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const trustHeading = useRef<HTMLLegendElement>(null);
  const pending = useRef(false);
  const options = profiles.filter(profile => address(profile) !== address(target));
  const [hops, setHops] = useState<Hop[]>(() => initialHops.flatMap(id => {
    const profile = options.find(item => item.id === id);
    return profile ? [{ profile, credentials: emptyCredentials }] : [];
  }));
  const [credentials, setCredentials] = useState(emptyCredentials);
  const [confirmation, setConfirmation] = useState("");
  const [withFiles, setWithFiles] = useState(initialFiles);
  const [scopeConfirmed, setScopeConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trust, setTrust] = useState<TrustRequest | null>(null);
  const [compared, setCompared] = useState(false);
  const [notice, setNotice] = useState("");
  const production = target.environment === "PROD" || hops.some(hop => hop.profile.environment === "PROD");
  const connectLabel = tool === "sftp" ? "SFTP 연결" : tool === "tunnel" ? "터널 시작" : "SSH 터미널 연결";
  const heading = tool === "sftp" ? "SSH 경유로 SFTP 연결" : tool === "tunnel" ? "SSH 터널 시작" : "경유 서버로 SSH 터미널 연결";
  const command = tool === "sftp" ? "open_routed_sftp" : tool === "tunnel" ? "start_ssh_tunnel" : "open_routed_ssh_terminal";
  const confirmScope = tunnel?.settings.kind === "dynamic" || tunnel?.settings.kind === "remote";

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (trust) trustHeading.current?.focus(); }, [trust]);

  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); onBusy(true); setError("");
    try { await action(); }
    catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); onBusy(false); }
  }

  function available(index: number) {
    return options.filter(profile => !hops.some((hop, position) => position !== index && address(hop.profile) === address(profile)));
  }

  function editHops(next: Hop[]) {
    setHops(next); setConfirmation(""); setScopeConfirmed(false); setNotice(""); setError("");
  }

  function move(index: number, direction: -1 | 1) {
    const next = hops.slice();
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    editHops(next);
  }

  async function chooseKey(update: (path: string) => void) {
    await perform(async () => {
      const path = await invoke<string | null>("choose_ssh_identity_file");
      if (path) update(path);
    });
  }

  function open(event: FormEvent) {
    event.preventDefault();
    if ((!tunnel && !hops.length) || (confirmScope && !scopeConfirmed)) return;
    void perform(async () => {
      const result = await invoke<RouteResponse<Session>>(command, {
        profile: target, confirmation, authentication: authentication(credentials),
        hops: hops.map(hop => ({ profile: hop.profile, authentication: authentication(hop.credentials) })),
        ...(tool === "terminal" ? { rows: 24, cols: 80 } : {}),
        ...(tunnel ? { tunnel, scopeConfirmed } : {}),
      });
      if (result.status === "open") onOpened(result.session, hops.map(hop => hop.profile), tool === "terminal" && withFiles);
      else { setNotice(""); setCompared(false); setTrust(result); }
    });
  }

  const next = available(-1)[0];
  return <dialog ref={dialog} className="dialog sftp-route-dialog" aria-labelledby={title}
    onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2 id={title}>{heading}</h2>
      <button type="button" className="icon-button" disabled={busy} aria-label="경유 연결 닫기" onClick={() => dialog.current?.close()}><X size={17} aria-hidden /></button>
    </div>
    <form onSubmit={open}>
      {trust ? <fieldset className="sftp-route-trust" disabled={busy}>
        <legend ref={trustHeading} tabIndex={-1}>{trust.stage}의 서버 지문 확인</legend>
        <p className="form-note">{trust.host.host}:{trust.host.port} · 서버 관리자에게 별도로 받은 지문과 대조하세요.</p>
        <p className="sftp-route-fingerprint"><strong>{trust.host.keys[0].algorithm}</strong><code>{trust.host.keys[0].fingerprint}</code></p>
        <label className="files-check"><input type="checkbox" checked={compared} onChange={event => setCompared(event.target.checked)} /> 별도로 받은 지문과 일치합니다</label>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => { setTrust(null); setError(""); }}>연결 설정으로 돌아가기</button>
          <button type="button" className="primary" disabled={!compared} onClick={() => void perform(async () => {
            await invoke("trust_ssh_host", { token: trust.host.token, fingerprint: trust.host.keys[0].fingerprint, confirmation: "" });
            setNotice(`${trust.stage}의 지문을 저장했습니다. ${connectLabel}을 눌러 계속하세요.`);
            setTrust(null);
          })}>확인한 키 신뢰</button>
        </div>
      </fieldset> : <fieldset className="sftp-route-settings" disabled={busy}>
        {tunnel && <p className="confirm-copy"><strong>{tunnel.settings.name}</strong> · {tunnelPath(tunnel.settings)}</p>}
        <p className="form-note">경유 서버는 위에서 아래로 연결합니다. 각 서버에 사용할 인증 정보를 입력하세요.</p>
        <ol className="sftp-route-list">
          {hops.map((hop, index) => <li key={hop.profile.id}>
            <fieldset className="sftp-route-stage">
              <legend>경유 {index + 1}</legend>
              <div className="sftp-route-select">
                <label className="field">경유 {index + 1} 서버<select value={hop.profile.id} onChange={event => {
                  const profile = available(index).find(item => item.id === event.target.value);
                  if (profile) editHops(hops.map((row, position) => position === index ? { profile, credentials: emptyCredentials } : row));
                }}>{available(index).map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.environment}</option>)}</select></label>
                <button type="button" className="icon-button" aria-label={`경유 ${index + 1} 위로 이동`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} aria-hidden /></button>
                <button type="button" className="icon-button" aria-label={`경유 ${index + 1} 아래로 이동`} disabled={index + 1 === hops.length} onClick={() => move(index, 1)}><ArrowDown size={15} aria-hidden /></button>
                <button type="button" className="icon-button" aria-label={`경유 ${index + 1} 삭제`} onClick={() => editHops(hops.filter((_, position) => index !== position))}><X size={15} aria-hidden /></button>
              </div>
              <p className={`files-target ${hop.profile.environment.toLowerCase()}`}>{hop.profile.username}@{address(hop.profile)} · {hop.profile.environment}</p>
              <CredentialFields value={hop.credentials} onChange={value => setHops(current => current.map(row =>
                row.profile.id === hop.profile.id ? { ...row, credentials: value } : row))} onChoose={chooseKey} />
            </fieldset>
          </li>)}
        </ol>
        {next && hops.length < maxHops && <button type="button" className="secondary small" onClick={() => editHops([...hops, { profile: next, credentials: emptyCredentials }])}>경유 서버 추가</button>}
        <fieldset className="sftp-route-stage">
          <legend>{tunnel ? "SSH 서버" : "대상"} · {target.name}</legend>
          <p className={`files-target ${target.environment.toLowerCase()}`}>{target.username}@{address(target)} · {target.environment}</p>
          <CredentialFields value={credentials} onChange={setCredentials} onChoose={chooseKey} />
        </fieldset>
        {production && <label className="field">운영 환경 확인<input required pattern="PROD" placeholder="PROD" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
        {tool === "terminal" && <label className="files-check"><input type="checkbox" checked={withFiles}
          onChange={event => setWithFiles(event.target.checked)} /> 파일 탐색 함께 열기</label>}
        {tunnel?.settings.kind === "remote" && <p className="form-note">SSH 서버에 루프백 수신을 요청합니다. 서버의 GatewayPorts 설정에 따라 실제 수신 범위가 달라질 수 있습니다.</p>}
        {confirmScope && <label className="files-check">
          <input type="checkbox" required checked={scopeConfirmed} onChange={event => setScopeConfirmed(event.target.checked)} />
          {tunnel.settings.kind === "remote" ? "SSH 서버가 루프백에서만 수신하도록 설정했음을 확인했습니다." : "이 PC의 앱이 SOCKS5 인증 없이 터널에 연결할 수 있음을 확인했습니다."}
        </label>}
        {notice && <p className="form-note" role="status">{notice}</p>}
        <div className="dialog-actions"><button type="submit" className="primary" disabled={(!tunnel && !hops.length) || (confirmScope && !scopeConfirmed)}>{connectLabel}</button></div>
      </fieldset>}
      {busy && <p className="form-note" role="status">요청을 처리하는 중…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </dialog>;
}

function CredentialFields({ value, onChange, onChoose }: {
  value: Credentials;
  onChange: (value: Credentials) => void;
  onChoose: (update: (path: string) => void) => Promise<void>;
}) {
  const pass = value.method === "password";
  return <div className="sftp-route-credentials">
    <label className="field">인증 방식<select value={value.method} onChange={event => onChange({ ...emptyCredentials, method: event.target.value as Credentials["method"] })}>
      <option value="password">SSH 암호</option><option value="private_key">개인 키 파일</option>
    </select></label>
    {!pass && <label className="field">개인 키 파일 경로<span className="file-input">
      <input required value={value.path} onChange={event => onChange({ ...value, path: event.target.value })} />
      <button type="button" className="secondary" onClick={() => void onChoose(path => onChange({ ...value, path }))}>키 선택</button>
    </span></label>}
    <label className="field">{pass ? "SSH 암호" : "개인 키 암호 (선택)"}
      <input required={pass} type="password" autoComplete="off" maxLength={4096} value={value.secret} onChange={event => onChange({ ...value, secret: event.target.value })} />
    </label>
  </div>;
}
