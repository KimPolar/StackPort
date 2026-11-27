import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Pencil, Play, Plus, Square, Trash2, X } from "lucide-react";
import type { SshProfile } from "./ssh-profile-types";
import { SshRouteDialog } from "./SshRouteDialog";
import { tunnelKindLabels, tunnelListenAddress, tunnelPath, tunnelTarget, type SavedSshTunnel, type TunnelKind, type TunnelSettings } from "./sshTunnel";

type TunnelStatus = { tunnel: SavedSshTunnel; listen_port: number; gateway: SshProfile; hops: string[];
  phase: "running" | "stopping" | "stopped" | "disconnected"; clients: number;
  sent_bytes: string; received_bytes: string; last_error: string | null; credential_warning?: string };
type DefinitionAction = { kind: "create" } | { kind: "edit" | "delete"; tunnel: SavedSshTunnel };
const phases: Record<TunnelStatus["phase"], string> = { running: "수신 중", stopping: "중단 중", stopped: "중단됨", disconnected: "연결 끊김" };
const running = (status: TunnelStatus) => status.phase === "running" || status.phase === "stopping";
const numbers = new Intl.NumberFormat("ko-KR");

export function SshTunnelPanel({ projectId, profiles, visible, onCountChange }: {
  projectId: string;
  profiles: SshProfile[];
  visible: boolean;
  onCountChange: (count: number) => void;
}) {
  const [definitions, setDefinitions] = useState<{ project: string; items: SavedSshTunnel[] } | null>(null);
  const [statuses, setStatuses] = useState<TunnelStatus[]>([]);
  const [action, setAction] = useState<DefinitionAction | null>(null);
  const [opening, setOpening] = useState<{ tunnel: SavedSshTunnel; profile: SshProfile } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [stopping, setStopping] = useState<string[]>([]);
  const [listError, setListError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const definitionRequest = useRef(0);
  const statusRequest = useRef(0);
  const items = definitions?.project === projectId ? definitions.items : [];
  const active = statuses.filter(running);
  const connectedCount = active.length;
  const loaded = definitions?.project === projectId;

  const refreshDefinitions = useCallback(async () => {
    const request = ++definitionRequest.current;
    if (!projectId) { setDefinitions(null); setListError(""); return; }
    try {
      const items = await invoke<SavedSshTunnel[]>("list_ssh_tunnels", { projectId });
      if (request === definitionRequest.current) { setDefinitions({ project: projectId, items }); setListError(""); }
    } catch (reason) { if (request === definitionRequest.current) setListError(String(reason)); }
  }, [projectId]);

  const refreshStatus = useCallback(async () => {
    const request = ++statusRequest.current;
    try {
      const statuses = await invoke<TunnelStatus[]>("ssh_tunnel_status");
      if (request === statusRequest.current) { setStatuses(statuses); setStatusError(""); }
    } catch (reason) { if (request === statusRequest.current) setStatusError(String(reason)); }
  }, []);

  useEffect(() => {
    setAction(null); setOpening(null); setError(""); setNotice("");
    void refreshDefinitions();
    return () => { definitionRequest.current++; };
  }, [projectId, refreshDefinitions]);
  useEffect(() => { if (visible) void refreshDefinitions(); }, [visible, profiles, refreshDefinitions]);
  useEffect(() => {
    if (!visible && !connectedCount) return;
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1_000);
    return () => { window.clearInterval(timer); statusRequest.current++; };
  }, [visible, connectedCount, refreshStatus]);
  useEffect(() => { onCountChange(connectedCount + (connecting ? 1 : 0)); }, [connectedCount, connecting, onCountChange]);

  function updateStatus(status: TunnelStatus) {
    statusRequest.current++;
    setStatuses(current => [status, ...current.filter(item => item.tunnel.id !== status.tunnel.id)]);
  }

  async function stop(id: string) {
    setStopping(current => [...current, id]);
    setError(""); setNotice("");
    try { updateStatus(await invoke<TunnelStatus>("stop_ssh_tunnel", { id })); }
    catch (reason) { setError(String(reason)); }
    finally { setStopping(current => current.filter(key => key !== id)); }
  }

  async function copy(port: number) {
    setError(""); setNotice("");
    try { await navigator.clipboard.writeText(tunnelListenAddress(port)); setNotice(`${tunnelListenAddress(port)} 주소를 복사했습니다.`); }
    catch (reason) { setError(`주소를 복사할 수 없습니다. ${String(reason)}`); }
  }

  return <section aria-label="SSH 터널">
    <div className="network-panel-heading">
      <h2>SSH 터널</h2>
      <button type="button" className="primary small" disabled={!projectId || !profiles.length} onClick={() => setAction({ kind: "create" })}><Plus size={15} aria-hidden /> 새 터널</button>
    </div>
    {(error || listError || statusError) && <p className="error-banner" role="alert">{error || listError || statusError}</p>}
    {notice && <p className="query-notice" role="status">{notice}</p>}
    <div className="results-card network-card ssh-tunnel-card">
      {items.length ? <div className="table-wrap"><table aria-label="저장된 SSH 터널">
        <thead><tr><th scope="col">이름</th><th scope="col">유형</th><th scope="col">SSH 연결</th><th scope="col">전달 경로</th><th scope="col">상태</th><th scope="col">작업</th></tr></thead>
        <tbody>{items.map(tunnel => {
          const profile = profiles.find(item => item.id === tunnel.settings.ssh_profile_id);
          const status = statuses.find(item => item.tunnel.id === tunnel.id);
          const isActive = status && running(status);
          return <tr key={tunnel.id}>
            <th scope="row">{tunnel.settings.name}</th><td>{tunnelKindLabels[tunnel.settings.kind]}</td><td>{profile?.name ?? "연결 확인 필요"}</td>
            <td><code>{tunnelPath(tunnel.settings)}</code></td>
            <td><span>{status ? phases[status.phase] : "중단됨"}</span>
              {!isActive && status?.last_error && <p className="form-error ssh-tunnel-error">{status.last_error}</p>}</td>
            <td><div className="ssh-tunnel-actions">
              <button type="button" className="secondary small" aria-label={`${tunnel.settings.name} 시작`} disabled={!profile || Boolean(isActive)}
                onClick={() => { if (profile) setOpening({ tunnel, profile }); }}><Play size={14} aria-hidden /> 시작</button>
              <button type="button" className="icon-button" aria-label={`${tunnel.settings.name} 수정`} disabled={Boolean(isActive)} onClick={() => setAction({ kind: "edit", tunnel })}><Pencil size={15} aria-hidden /></button>
              <button type="button" className="icon-button" aria-label={`${tunnel.settings.name} 삭제`} disabled={Boolean(isActive)} onClick={() => setAction({ kind: "delete", tunnel })}><Trash2 size={15} aria-hidden /></button>
            </div></td>
          </tr>;
        })}</tbody>
      </table></div> : <p className="result-empty">{!projectId ? "프로젝트를 먼저 선택하세요." : !profiles.length ? "탐색기에서 SSH 연결을 추가하면 터널을 등록할 수 있습니다."
        : !loaded ? "저장된 터널을 읽는 중입니다." : "이 프로젝트에 저장된 터널이 없습니다."}</p>}
    </div>
    {!!active.length && <div className="results-card network-card ssh-tunnel-card">
      <h3>실행 중인 터널</h3>
      <div className="table-wrap"><table aria-label="실행 중인 SSH 터널">
        <thead><tr><th scope="col">수신 주소</th><th scope="col">경로</th><th scope="col">트래픽</th><th scope="col">상태</th><th scope="col">작업</th></tr></thead>
        <tbody>{active.map(status => <tr key={status.tunnel.id}>
          <th scope="row"><span>{status.tunnel.settings.name}</span><br />
            {status.tunnel.settings.kind === "remote" && <span>SSH 서버의 </span>}<code>{tunnelListenAddress(status.listen_port)}</code></th>
          <td>{[...status.hops, status.gateway.name, tunnelTarget(status.tunnel.settings)].join(" → ")}</td>
          <td><span>연결 {status.clients}개</span><br />
            <span>보냄 {numbers.format(BigInt(status.sent_bytes))} B · 받음 {numbers.format(BigInt(status.received_bytes))} B</span></td>
          <td>{phases[status.phase]}{status.last_error && <p className="form-error ssh-tunnel-error">{status.last_error}</p>}</td>
          <td><div className="ssh-tunnel-actions">
            <button type="button" className="icon-button" title="수신 주소 복사" aria-label={`${status.tunnel.settings.name} 수신 주소 복사`} onClick={() => void copy(status.listen_port)}><Copy size={15} aria-hidden /></button>
            <button type="button" className="secondary small" aria-label={`${status.tunnel.settings.name} 중단`} disabled={status.phase === "stopping" || stopping.includes(status.tunnel.id)}
              onClick={() => void stop(status.tunnel.id)}><Square size={14} aria-hidden /> 중단</button>
          </div></td>
        </tr>)}</tbody>
      </table></div>
    </div>}
    {action && <TunnelDefinitionDialog projectId={projectId} action={action} profiles={profiles}
      onClose={() => setAction(null)} onSaved={() => { setAction(null); void refreshDefinitions(); }} />}
    {opening && <SshRouteDialog<TunnelStatus> tool="tunnel" target={opening.profile} tunnel={opening.tunnel} profiles={profiles}
      onBusy={setConnecting} onClose={() => setOpening(null)} onOpened={status => {
        updateStatus(status); setNotice(status.credential_warning ?? ""); setOpening(null);
      }} />}
  </section>;
}

function TunnelDefinitionDialog({ projectId, action, profiles, onClose, onSaved }: {
  projectId: string; action: DefinitionAction; profiles: SshProfile[]; onClose: () => void; onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const saved = action.kind !== "create" ? action.tunnel : null;
  const [name, setName] = useState(saved?.settings.name ?? "");
  const [profileId, setProfileId] = useState(saved?.settings.ssh_profile_id ?? profiles[0]?.id ?? "");
  const [kind, setKind] = useState<TunnelKind>(saved?.settings.kind ?? "local");
  const [listenPort, setListenPort] = useState(String(saved?.settings.listen_port ?? 0));
  const [host, setHost] = useState(saved?.settings.target_host ?? "127.0.0.1");
  const [port, setPort] = useState(String(saved?.settings.target_port ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const title = action.kind === "create" ? "SSH 터널 등록" : action.kind === "edit" ? "SSH 터널 수정" : "SSH 터널 삭제";
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    const input: TunnelSettings = { name, ssh_profile_id: profileId, kind, listen_port: Number(listenPort),
      target_host: kind === "dynamic" ? null : host, target_port: kind === "dynamic" ? null : Number(port) };
    try {
      if (action.kind === "delete") await invoke("delete_ssh_tunnel", { id: action.tunnel.id, revision: action.tunnel.revision });
      else if (action.kind === "edit") await invoke("update_ssh_tunnel", { id: action.tunnel.id, revision: action.tunnel.revision, input });
      else await invoke("create_ssh_tunnel", { projectId, input });
      onSaved();
    } catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby={id} onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2 id={id}>{title}</h2>
      <button type="button" className="icon-button" aria-label="터널 설정 닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={17} aria-hidden /></button></div>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      {action.kind === "delete" ? <p className="confirm-copy"><strong>{action.tunnel.settings.name}</strong>의 저장된 설정을 삭제합니다.</p> :
        <fieldset className="ssh-tunnel-fields" disabled={busy}>
          <label className="field">터널 이름<input autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
          <label className="field">전달 유형<select value={kind} onChange={event => setKind(event.target.value as TunnelKind)}>
            {Object.entries(tunnelKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field">SSH 연결<select required value={profileId} onChange={event => setProfileId(event.target.value)}>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.environment}</option>)}</select></label>
          <div className="field">
            <label htmlFor={`${id}-port`}>{kind === "remote" ? "원격 포트" : "로컬 포트"}</label>
            <input id={`${id}-port`} aria-describedby={`${id}-port-hint`} type="number" required min="0" max="65535" value={listenPort} onChange={event => setListenPort(event.target.value)} />
            <span id={`${id}-port-hint`} className="form-note">{kind === "remote" ? "SSH 서버" : "이 PC"}의 127.0.0.1에서 수신합니다. 0은 자동 할당입니다.</span>
          </div>
          {kind !== "dynamic" && <><label className="field">대상 호스트<input required value={host} onChange={event => setHost(event.target.value)} /></label>
            <label className="field">대상 포트<input type="number" required min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label></>}
        </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>취소</button>
        <button type="submit" className={action.kind === "delete" ? "danger" : "primary"} disabled={busy}>{action.kind === "delete" ? "삭제" : "저장"}</button></div>
    </form>
  </dialog>;
}
