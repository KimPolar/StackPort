import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, Copy, Download, Eye, File, FilePenLine, FolderInput, FolderOpen, FolderPlus, HardDrive, Link, Pencil, RefreshCw, Server, Trash2, Upload } from "lucide-react";
import { FilePreviewDialog, type FilePreview, type PreviewSelection } from "./FilePreviewDialog";
import type { SshProfile } from "./ssh-profile-types";
import { SftpDeleteDialog, type SftpDeletePreview, type SftpDeleteSelection } from "./SftpDeleteDialog";
import { SftpDestinationDialog, type SftpDestinationSelection } from "./SftpDestinationDialog";
import { SftpEditorDialog, type SftpEditDocument, type SftpEditorSelection } from "./SftpEditorDialog";
import { listedItemSnapshot, SftpNameDialog, type SftpListedItem, type SftpNameAction } from "./SftpNameDialog";
import { SftpTransferDialog, type FileSelection, type TransferResult, type TransferSelection } from "./SftpTransferDialog";

type Entry = { name: string; kind: "directory" | "file" | "symlink" | "other"; location: string | null; size: string | null; modified: number | null; mode: number | null; uid: number | null; gid: number | null; hidden: boolean };
type Directory = { path: string; location: string; parent: string | null; entries: Entry[]; truncated: boolean };
type Session = { id: string; directory: Directory };
type Host = { status: string; token: string | null; keys: { algorithm: string; fingerprint: string }[] };
type BrowsePath = { kind: "text" | "token"; value: string };
const numbers = new Intl.NumberFormat("ko-KR");
const dates = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" });
const mutationTitles = { create: "원격 폴더 생성 완료", rename: "원격 이름 변경 완료", move: "원격 이동 완료", delete: "원격 삭제 완료" };
const transferTitles = { download: "다운로드 완료", upload: "업로드 완료", copy: "원격 복사 완료", edit: "원격 파일 저장 완료" };

export function SftpWorkspace({ projectName, profiles, onExitGuard, onRequestExit }: {
  projectName: string;
  profiles: SshProfile[];
  onExitGuard: (guard: (() => void) | null) => void;
  onRequestExit: () => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [activePane, setActivePane] = useState<"local" | "remote">("local");
  const [remote, setRemote] = useState<{ id: string; profile: SshProfile; directory: Directory; projectName: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [localFolder, setLocalFolder] = useState("");
  const [transfer, setTransfer] = useState<TransferSelection | null>(null);
  const [finished, setFinished] = useState<TransferResult | null>(null);
  const [nameAction, setNameAction] = useState<SftpNameAction | null>(null);
  const [destinationSelection, setDestinationSelection] = useState<SftpDestinationSelection | null>(null);
  const [deleteSelection, setDeleteSelection] = useState<SftpDeleteSelection | null>(null);
  const [editorSelection, setEditorSelection] = useState<SftpEditorSelection | null>(null);
  const [savedDraftPath, setSavedDraftPath] = useState("");
  const [nameResult, setNameResult] = useState<{ kind: keyof typeof mutationTitles; name: string; auditWarning: string | null } | null>(null);
  const [preview, setPreview] = useState<PreviewSelection | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [remoteRefresh, setRemoteRefresh] = useState(0);
  const [error, setError] = useState("");
  const selected = profiles.find(profile => profile.id === selectedId) ?? profiles[0];

  async function disconnect() {
    if (!remote || closing) return;
    setClosing(true);
    setError("");
    try {
      await invoke("close_sftp", { id: remote.id });
      setRemote(null);
      setTransfer(null);
      setFinished(null);
      setNameAction(null);
      setDestinationSelection(null);
      setDeleteSelection(null);
      setEditorSelection(null);
      setSavedDraftPath("");
      setNameResult(null);
      setRemoteRefresh(0);
    } catch (error) {
      setError(String(error));
    } finally {
      setClosing(false);
    }
  }

  function chooseTransfer(selection: TransferSelection) {
    setFinished(null);
    setNameResult(null);
    setTransfer(selection);
  }

  function transferSaved(result: TransferResult) {
    setFinished(result);
    setTransfer(null);
    if (result.kind === "download") setLocalRefresh(value => value + 1);
    else setRemoteRefresh(value => value + 1);
  }

  function choosePreview(name: string, source: string, result: Promise<FilePreview>) {
    setPreview({
      name,
      source,
      result: result.then(preview => ({ preview }), error => ({ error: String(error) })),
    });
  }

  function chooseNameAction(action: SftpNameAction) {
    setFinished(null);
    setNameResult(null);
    setNameAction(action);
  }

  function chooseDestination(selection: SftpDestinationSelection) {
    setFinished(null);
    setNameResult(null);
    setDestinationSelection(selection);
  }

  function chooseDelete(parent: Directory, item: SftpListedItem) {
    if (!remote) return;
    setFinished(null);
    setNameResult(null);
    const result = invoke<SftpDeletePreview>("preview_sftp_delete", { id: remote.id, parent: parent.location, source: listedItemSnapshot(item) });
    setDeleteSelection({ name: item.name, result: result.then(preview => ({ preview }), error => ({ error: String(error) })) });
  }

  function closeDelete() {
    if (remote && deleteSelection) {
      void deleteSelection.result.then(result => {
        if ("preview" in result) return invoke("discard_sftp_delete", { id: remote.id, token: result.preview.token });
      }).catch(() => {});
    }
    setDeleteSelection(null);
  }

  function chooseEditor(parent: Directory, item: SftpListedItem) {
    if (!remote) return;
    setFinished(null);
    setNameResult(null);
    setSavedDraftPath("");
    const result = invoke<SftpEditDocument>("open_sftp_editor", { id: remote.id, parent: parent.location, source: listedItemSnapshot(item) });
    setEditorSelection({
      name: item.name,
      parentPath: parent.path,
      result: result.then(document => ({ document }), error => ({ error: String(error) })),
    });
  }

  function closeEditor() {
    if (remote && editorSelection) {
      void editorSelection.result.then(result => {
        if ("document" in result) return invoke("discard_sftp_editor", { id: remote.id, token: result.document.token });
      }).catch(() => {});
    }
    setEditorSelection(null);
  }

  function mutationSaved(kind: keyof typeof mutationTitles, name: string, auditWarning: string | null) {
    setNameResult({ kind, name, auditWarning });
    setRemoteRefresh(value => value + 1);
  }

  return <section className="network-workspace files-workspace" aria-label="파일 탐색">
    <header className="files-header">
      <div className="files-title">
        <h1><FolderOpen size={20} aria-hidden /> 파일 탐색</h1>
        {remote && <div className="files-connection" aria-label="SFTP 연결 대상">
          <span className={`environment ${remote.profile.environment.toLowerCase()}`}>{remote.profile.environment}</span>
          <strong>{remote.profile.name}</strong>
          <span>{[remote.projectName, `${remote.profile.username}@${remote.profile.host}:${remote.profile.port}`].filter(Boolean).join(" · ")}</span>
        </div>}
      </div>
      {remote && <button className="secondary small" disabled={closing} onClick={() => void disconnect()}>SFTP 연결 끊기</button>}
    </header>
    {!remote && <div className="results-card files-setup">
      <label className="field">{projectName ? `${projectName}의 SSH 연결` : "SSH 연결"}
        <select aria-label="SSH 연결 선택" value={selected?.id ?? ""} disabled={!profiles.length || connecting} onChange={event => setSelectedId(event.target.value)}>
          {!profiles.length && <option value="">저장된 SSH 연결 없음</option>}
          {profiles.map(profile => <option value={profile.id} key={profile.id}>{profile.name} · {profile.environment}</option>)}
        </select>
      </label>
      {selected && <SftpConnect key={`${selected.id}:${selected.revision}`} profile={selected} onConnecting={setConnecting}
        onOpened={session => {
          setRemote({ ...session, profile: selected, projectName });
          setActivePane("remote");
        }} />}
    </div>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {finished && <div className="success-banner files-download-result" role="status">
      <strong>{transferTitles[finished.kind]}</strong><span>{displayPath(finished.path)} · {numbers.format(BigInt(finished.bytes))} B</span>
      <details><summary>SHA-256</summary><code>{finished.sha256}</code></details>
      {finished.auditWarning && <strong className="audit-warning">{finished.auditWarning}</strong>}
    </div>}
    {nameResult && <div className="success-banner" role="status">
      <strong>{mutationTitles[nameResult.kind]}</strong><span>{nameResult.name}</span>
      {nameResult.auditWarning && <strong className="audit-warning">{nameResult.auditWarning}</strong>}
    </div>}
    {savedDraftPath && <div className="success-banner files-download-result" role="status">
      <strong>로컬 초안 저장 완료</strong><span>{savedDraftPath}</span>
    </div>}
    <div className="files-pane-switch" role="group" aria-label="파일 창 선택">
      <button type="button" className="secondary small" aria-pressed={activePane === "local"} aria-controls="local-files"
        onClick={() => setActivePane("local")}><HardDrive size={14} aria-hidden /> 로컬 파일 보기</button>
      <button type="button" className="secondary small" aria-pressed={activePane === "remote"} aria-controls="remote-files"
        onClick={() => setActivePane("remote")}><Server size={14} aria-hidden /> 원격 파일 보기</button>
    </div>
    <div className="files-panes">
      <DirectoryPane id="local-files" active={activePane === "local"} title="로컬 파일"
        load={path => invoke("browse_local_directory", { path: path.value })} chooseFolder
        onFolder={directory => setLocalFolder(displayPath(directory.path))} refresh={localRefresh}
        onPreview={file => choosePreview(file.name, "로컬 파일", invoke("preview_local_browse_file", { path: file.location }))}
        action={remote ? { kind: "upload", run: file => chooseTransfer({ ...file, kind: "upload", remotePath: remote.directory.path, remoteDirectory: remote.directory.location }) } : undefined} />
      {remote ? <DirectoryPane id="remote-files" active={activePane === "remote"} key={remote.id} title="원격 파일" initial={remote.directory}
        load={path => invoke("list_sftp_directory", { id: remote.id, path })}
        onFolder={directory => setRemote(current => current?.id === remote.id ? { ...current, directory } : current)} refresh={remoteRefresh}
        onNameAction={chooseNameAction}
        onDestination={chooseDestination}
        onDelete={chooseDelete}
        onEdit={chooseEditor}
        onPreview={file => choosePreview(file.name, `${remote.profile.name} · ${remote.profile.environment}`,
          invoke("preview_sftp_file", { id: remote.id, location: file.location }))}
        action={{ kind: "download", run: file => chooseTransfer({ ...file, kind: "download", folder: localFolder }) }} />
        : <section className="results-card files-pane" id="remote-files" data-active={activePane === "remote"} aria-label="원격 파일">
          <div className="panel-heading"><div><Server size={15} aria-hidden /><strong>원격 파일</strong></div></div>
          <div className="files-empty"><p>{profiles.length ? "위에서 SSH 연결을 확인한 뒤 원격 폴더를 엽니다." : "탐색기에서 SSH 연결을 추가하면 원격 폴더를 열 수 있습니다."}</p></div>
        </section>}
    </div>
    {remote && transfer && <SftpTransferDialog id={remote.id} target={`${remote.profile.name} · ${remote.profile.host}:${remote.profile.port} · ${remote.profile.environment}`}
      file={transfer} onClose={() => setTransfer(null)} onSaved={transferSaved} />}
    {remote && nameAction && <SftpNameDialog id={remote.id} target={`${remote.profile.name} · ${remote.profile.host}:${remote.profile.port} · ${remote.profile.environment}`}
      action={nameAction} onClose={() => setNameAction(null)} onSaved={(name, warning) => mutationSaved(nameAction.kind, name, warning)} />}
    {remote && destinationSelection && <SftpDestinationDialog id={remote.id} target={`${remote.profile.name} · ${remote.profile.host}:${remote.profile.port} · ${remote.profile.environment}`}
      selection={destinationSelection} onClose={() => setDestinationSelection(null)}
      onMoved={(path, warning) => mutationSaved("move", path, warning)} onCopied={transferSaved} />}
    {remote && deleteSelection && <SftpDeleteDialog id={remote.id} target={`${remote.profile.name} · ${remote.profile.host}:${remote.profile.port} · ${remote.profile.environment}`}
      selection={deleteSelection} onClose={closeDelete} onDeleted={(path, warning) => mutationSaved("delete", path, warning)} />}
    {remote && editorSelection && <SftpEditorDialog id={remote.id} target={`${remote.profile.name} · ${remote.profile.host}:${remote.profile.port} · ${remote.profile.environment}`}
      selection={editorSelection} onClose={closeEditor} onSaved={transferSaved} onDraftSaved={setSavedDraftPath}
      onExitGuard={onExitGuard} onRequestExit={onRequestExit} />}
    {preview && <FilePreviewDialog selection={preview} onClose={() => setPreview(null)} />}
  </section>;
}

function SftpConnect({ profile, onConnecting, onOpened }: { profile: SshProfile; onConnecting: (busy: boolean) => void; onOpened: (session: Session) => void }) {
  const [info, setInfo] = useState<Host | null>(null);
  const [selected, setSelected] = useState("");
  const [compared, setCompared] = useState(false);
  const [method, setMethod] = useState<"password" | "private_key">("password");
  const [secret, setSecret] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onConnecting(true);
    setError("");
    try { await action(); }
    catch (error) { setError(String(error)); }
    finally { pending.current = false; setBusy(false); onConnecting(false); }
  }

  function inspect() {
    void perform(async () => {
      const result = await invoke<Host>("inspect_ssh_host", { host: profile.host, port: profile.port });
      setInfo(result);
      setSelected(result.keys.length === 1 ? result.keys[0].fingerprint : "");
      setCompared(false);
    });
  }

  function trust() {
    if (!info?.token || !selected || !compared) return;
    void perform(async () => {
      setInfo(await invoke<Host>("trust_ssh_host", { token: info.token, fingerprint: selected, confirmation: "" }));
    });
  }

  function open(event: FormEvent) {
    event.preventDefault();
    if (info?.status !== "trusted") return;
    const authentication = method === "password" ? { kind: method, password: secret } : { kind: method, path: keyPath, passphrase: secret };
    setSecret("");
    void perform(async () => onOpened(await invoke<Session>("open_sftp", { profile, confirmation, authentication })));
  }

  return <form className="files-auth" data-step={info ? "review" : "inspect"} onSubmit={open}>
    <p className={`files-target ${profile.environment.toLowerCase()}`}>{profile.username}@{profile.host}:{profile.port} · {profile.environment}</p>
    {!info && <button type="button" className="secondary small" disabled={busy} onClick={inspect}>SSH 호스트 키 확인</button>}
    {info && !info.token && <p className="form-note">저장된 SSH 호스트 키 <code>{info.keys[0]?.fingerprint}</code></p>}
    {info?.token && <fieldset className="files-trust" disabled={busy}>
      <legend>서버 지문 확인</legend>
      <p className="form-note">서버 관리자에게 별도로 받은 지문과 비교한 뒤 일치하는 키를 선택하세요.</p>
      {info.keys.map(key => <label className="ssh-key" key={key.fingerprint}><input type="radio" name="sftp-key-fingerprint" checked={selected === key.fingerprint}
        onChange={() => { setSelected(key.fingerprint); setCompared(false); }} /><span><strong>{key.algorithm}</strong><code>{key.fingerprint}</code></span></label>)}
      <label className="files-check"><input type="checkbox" checked={compared} onChange={event => setCompared(event.target.checked)} /> 별도로 받은 지문과 일치합니다</label>
      <button type="button" className="secondary small" disabled={!selected || !compared} onClick={trust}>확인한 키 신뢰</button>
    </fieldset>}
    {info?.status === "trusted" && <fieldset className="files-credentials" disabled={busy}>
      <legend className="sr-only">SFTP 사용자 인증</legend>
      <label className="field">인증 방식<select value={method} onChange={event => { setMethod(event.target.value as typeof method); setSecret(""); setError(""); }}>
        <option value="password">SSH 암호</option><option value="private_key">개인 키 파일</option>
      </select></label>
      {method === "private_key" && <label className="field">개인 키 파일 경로<span className="file-input">
        <input required value={keyPath} onChange={event => setKeyPath(event.target.value)} />
        <button type="button" className="secondary" onClick={() => void perform(async () => {
          const path = await invoke<string | null>("choose_ssh_identity_file");
          if (path) setKeyPath(path);
        })}>키 선택</button>
      </span></label>}
      <label className="field">{method === "password" ? "SSH 암호" : "개인 키 암호 (선택)"}
        <input required={method === "password"} type="password" autoComplete="off" maxLength={4096} value={secret} onChange={event => setSecret(event.target.value)} />
      </label>
      {profile.environment === "PROD" && <label className="field">운영 환경 확인<input required pattern="PROD" placeholder="PROD" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      <button type="submit" className="primary small">SFTP 연결</button>
    </fieldset>}
    {busy && <p className="form-note" role="status">요청을 처리하는 중…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}

function displayPath(path: string) {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

function DirectoryPane({ id, active, title, load, initial, chooseFolder, onFolder, onPreview, onNameAction, onDestination, onDelete, onEdit, action, refresh }: {
  id: string; active: boolean; title: string; load: (path: BrowsePath) => Promise<Directory>; initial?: Directory; chooseFolder?: boolean;
  onPreview: (file: FileSelection) => void;
  onNameAction?: (action: SftpNameAction) => void;
  onDestination?: (selection: SftpDestinationSelection) => void;
  onDelete?: (directory: Directory, item: SftpListedItem) => void;
  onEdit?: (directory: Directory, item: SftpListedItem) => void;
  onFolder?: (directory: Directory) => void; action?: { kind: "download" | "upload"; run: (file: FileSelection) => void }; refresh: number;
}) {
  const [directory, setDirectory] = useState<Directory | null>(initial ?? null);
  const [value, setValue] = useState(initial ? displayPath(initial.path) : "");
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const shown = directory?.entries.filter(entry => hidden || !entry.hidden) ?? [];
  const actionLabel = action?.kind === "upload" ? "업로드" : "다운로드";

  async function navigate(path: BrowsePath | null) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!path) {
        const picked = await invoke<string | null>("choose_local_browse_directory");
        if (!picked) return;
        path = { kind: "text", value: picked };
      }
      const next = await load(path);
      setDirectory(next);
      setValue(displayPath(next.path));
      onFolder?.(next);
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const reload = useEffectEvent(() => {
    if (directory) void navigate({ kind: "token", value: directory.location });
  });
  useEffect(() => { if (refresh) reload(); }, [refresh]);

  function go(event: FormEvent) {
    event.preventDefault();
    void navigate(directory && value === displayPath(directory.path) ? { kind: "token", value: directory.location } : { kind: "text", value });
  }

  const PaneIcon = chooseFolder ? HardDrive : Server;
  return <section className="results-card files-pane" id={id} data-active={active} aria-label={title}>
    <div className="panel-heading"><div><PaneIcon size={15} aria-hidden /><strong>{title}</strong>{directory && <span>{numbers.format(shown.length)}개 항목</span>}</div>
      {chooseFolder && <button type="button" className="secondary small" disabled={busy} onClick={() => void navigate(null)}>폴더 선택</button>}
      {directory && onNameAction && <button type="button" className="secondary small" disabled={busy}
        onClick={() => onNameAction({ kind: "create", parent: directory })}><FolderPlus size={14} /> 새 폴더</button>}
    </div>
    <form className="files-path" onSubmit={go}>
      <button type="button" className="icon-button" aria-label={`${title} 상위 폴더`} disabled={busy || !directory?.parent}
        onClick={() => directory?.parent && void navigate({ kind: "token", value: directory.parent })}><ArrowUp size={15} /></button>
      <input required aria-label={`${title} 경로`} value={value} maxLength={4096} disabled={busy} onChange={event => setValue(event.target.value)} />
      <button type="submit" className="secondary small" disabled={busy}>이동</button>
      <button type="button" className="icon-button" aria-label={`${title} 새로고침`} disabled={busy || !directory}
        onClick={() => directory && void navigate({ kind: "token", value: directory.location })}><RefreshCw size={14} /></button>
    </form>
    {directory && <label className="files-check"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} /> 숨김 파일 표시</label>}
    {busy && <p className="form-note files-note" role="status">폴더를 읽는 중…</p>}
    {error && <p className="form-error files-note" role="alert">{error}</p>}
    {directory?.truncated && <p className="form-note files-note">처음 2,000개 항목을 표시합니다. 하위 폴더는 경로를 입력해 열 수 있습니다.</p>}
    {directory && <div className="files-table-wrap"><table className="files-table" aria-label={`${title} 목록`}>
      <thead><tr><th scope="col">이름</th><th scope="col">크기</th><th scope="col">수정</th>{!chooseFolder && <th scope="col">권한 · UID/GID</th>}<th scope="col"><span className="sr-only">파일 작업</span></th></tr></thead>
      <tbody>{shown.map((entry, index) => {
        const location = entry.location;
        const kind = entry.kind;
        const icon = entry.kind === "directory" ? <FolderOpen size={14} /> : entry.kind === "symlink" ? <Link size={14} /> : <File size={14} />;
        return <tr key={entry.location ?? index}>
          <td>{entry.kind === "directory" && location ? <button type="button" className="files-entry" disabled={busy}
            onClick={() => void navigate({ kind: "token", value: location })}>{icon}{entry.name}</button>
            : <span className="files-entry">{icon}{entry.name}</span>}</td>
          <td>{entry.kind !== "directory" && entry.size !== null ? `${numbers.format(BigInt(entry.size))} B` : "—"}</td>
          <td>{entry.modified === null ? "—" : dates.format(entry.modified * 1000)}</td>
          {!chooseFolder && <td>{entry.mode === null ? "—" : entry.mode.toString(8).padStart(4, "0")} · {entry.uid ?? "—"}/{entry.gid ?? "—"}</td>}
          <td>{location && (kind === "file" || kind === "directory") && <div className="files-row-actions">
            {kind === "file" && <>
              <button type="button" className="icon-button" disabled={busy} aria-label={`${entry.name} 미리보기`} title="미리보기"
                onClick={() => onPreview({ name: entry.name, location })}><Eye size={14} /></button>
              {onEdit && <button type="button" className="icon-button" disabled={busy}
                aria-label={`${entry.name} 편집`} title="텍스트 편집"
                onClick={() => onEdit(directory, { ...entry, kind, location })}><FilePenLine size={14} /></button>}
              {action && <button type="button" className="icon-button" disabled={busy}
                aria-label={`${entry.name} ${actionLabel}`} title={actionLabel} onClick={() => action.run({ name: entry.name, location })}>
                {action.kind === "upload" ? <Upload size={14} /> : <Download size={14} />}</button>}
            </>}
            {onNameAction && <button type="button" className="icon-button" disabled={busy}
              aria-label={`${entry.name} 이름 변경`} title="이름 변경"
              onClick={() => onNameAction({ kind: "rename", parent: directory, item: { ...entry, kind, location } })}><Pencil size={14} /></button>}
            {onDestination && <button type="button" className="icon-button" disabled={busy}
              aria-label={`${entry.name} 다른 폴더로 이동`} title="다른 폴더로 이동"
              onClick={() => onDestination({ kind: "move", parent: directory, item: { ...entry, kind, location } })}><FolderInput size={14} /></button>}
            {kind === "file" && onDestination && <button type="button" className="icon-button" disabled={busy}
              aria-label={`${entry.name} 복사`} title="복사"
              onClick={() => onDestination({ kind: "copy", parent: directory, item: { ...entry, kind, location } })}><Copy size={14} /></button>}
            {onDelete && <button type="button" className="icon-button" disabled={busy}
              aria-label={`${entry.name} 삭제`} title="삭제"
              onClick={() => onDelete(directory, { ...entry, kind, location })}><Trash2 size={14} /></button>}
          </div>}</td>
        </tr>;
      })}</tbody>
    </table></div>}
    {!directory && !busy && !error && <div className="files-empty"><p>폴더를 선택하거나 경로를 입력하세요.</p></div>}
    {directory && !shown.length && <p className="form-note files-note">표시할 파일이 없습니다.</p>}
  </section>;
}
