import { useEffect, useEffectEvent, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, Copy, Download, Eye, File, FilePenLine, FolderInput, FolderOpen, FolderPlus, GitCompareArrows, HardDrive, Link, Pencil, RefreshCw, Search, Server, Trash2, Upload, X } from "lucide-react";
import { displayFilePath, type BrowsePath, type Directory, type DirectoryLocation, type Entry } from "./fileBrowse";
import { FilePreviewDialog, type FilePreview, type PreviewSelection } from "./FilePreviewDialog";
import { FolderCompareDialog } from "./FolderCompareDialog";
import { FolderSyncProfilesDialog, type SavedSyncProfile } from "./FolderSyncProfilesDialog";
import { FilePairCompareDialog } from "./FilePairCompareDialog";
import { asFolderTree, loadFolderComparison, loadFolderTreeComparison, type FolderComparison, type FolderPair, type FolderTreeComparison } from "./fileCompare";
import type { SshProfile } from "./ssh-profile-types";
import { SftpDeleteDialog, type SftpDeletePreview, type SftpDeleteSelection } from "./SftpDeleteDialog";
import { SftpDestinationDialog, type SftpDestinationSelection } from "./SftpDestinationDialog";
import { SftpEditorDialog, type SftpEditDocument, type SftpEditorSelection } from "./SftpEditorDialog";
import { listedItemSnapshot, SftpNameDialog, type SftpListedItem, type SftpNameAction } from "./SftpNameDialog";
import { SftpPermissionsDialog, type PermissionSelection } from "./SftpPermissionsDialog";
import { SftpTransferDialog, type FileSelection, type TransferResult, type TransferSelection } from "./SftpTransferDialog";
import { SftpRouteDialog } from "./SftpRouteDialog";
import type { TerminalDirectory } from "./terminalDirectory";

type Session = { id: string; directory: Directory };
type Host = { status: string; token: string | null; keys: { algorithm: string; fingerprint: string }[] };
type DirectoryHistory = { visits: DirectoryLocation[]; index: number };
type ComparisonSelection = { kind: "files"; pair: FolderPair; result: Promise<FolderComparison> }
  | { kind: "folder"; pair: FolderPair; result: Promise<FolderTreeComparison>; profile?: SavedSyncProfile };
type FileSort = { key: "name" | "size" | "modified"; direction: "ascending" | "descending" };
const numbers = new Intl.NumberFormat("ko-KR");
const dates = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" });
const names = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });
const fileColumns = [["name", "이름"], ["size", "크기"], ["modified", "수정"]] as const;
const mutationTitles = { create: "원격 폴더 생성 완료", rename: "원격 이름 변경 완료", move: "원격 이동 완료", delete: "원격 삭제 완료", permissions: "원격 권한·소유자 변경 완료" };
const transferTitles = { download: "다운로드 완료", upload: "업로드 완료", copy: "원격 복사 완료", edit: "원격 파일 저장 완료" };

export function SftpWorkspace({ projectName, profiles, onExitGuard, onRequestExit, terminalDirectory }: {
  projectName: string;
  profiles: SshProfile[];
  onExitGuard: (guard: (() => void) | null) => void;
  onRequestExit: () => void;
  terminalDirectory: TerminalDirectory | null;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [activePane, setActivePane] = useState<"local" | "remote">("local");
  const [remote, setRemote] = useState<{ id: string; profile: SshProfile; directory: Directory; projectName: string; route: string[] } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [localFolder, setLocalFolder] = useState<DirectoryLocation | null>(null);
  const [comparison, setComparison] = useState<ComparisonSelection | null>(null);
  const [showSyncProfiles, setShowSyncProfiles] = useState(false);
  const [transfer, setTransfer] = useState<TransferSelection | null>(null);
  const [finished, setFinished] = useState<TransferResult | null>(null);
  const [nameAction, setNameAction] = useState<SftpNameAction | null>(null);
  const [destinationSelection, setDestinationSelection] = useState<SftpDestinationSelection | null>(null);
  const [deleteSelection, setDeleteSelection] = useState<SftpDeleteSelection | null>(null);
  const [editorSelection, setEditorSelection] = useState<SftpEditorSelection | null>(null);
  const [permissionSelection, setPermissionSelection] = useState<PermissionSelection | null>(null);
  const [savedDraftPath, setSavedDraftPath] = useState("");
  const [nameResult, setNameResult] = useState<{ kind: keyof typeof mutationTitles; name: string; auditWarning: string | null } | null>(null);
  const [preview, setPreview] = useState<PreviewSelection | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [remoteRefresh, setRemoteRefresh] = useState(0);
  const [error, setError] = useState("");
  const selected = profiles.find(profile => profile.id === selectedId) ?? profiles[0];
  const followPaused = Boolean(closing || transfer || comparison || showSyncProfiles || nameAction || destinationSelection || deleteSelection || editorSelection || permissionSelection || preview);
  const remoteTerminalPath = terminalDirectory?.kind === "ssh" && remote && terminalDirectory.profileId === remote.profile.id
    && terminalDirectory.revision === remote.profile.revision ? terminalDirectory.path : null;

  async function disconnect() {
    if (!remote || closing) return;
    setClosing(true);
    setError("");
    try {
      await invoke("close_sftp", { id: remote.id });
      setRemote(null);
      setTransfer(null);
      setComparison(null);
      setShowSyncProfiles(false);
      setFinished(null);
      setNameAction(null);
      setDestinationSelection(null);
      setDeleteSelection(null);
      setEditorSelection(null);
      setPermissionSelection(null);
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

  function openComparison(kind: "folder" | "files") {
    if (!localFolder || !remote) return;
    const pair = {
      id: remote.id, target: `${remote.profile.name} · ${remote.profile.environment}`, exactRoots: kind === "folder",
      local: localFolder, remote: directoryLocation(remote.directory),
    };
    const result = loadFolderComparison(pair);
    setComparison(kind === "folder" ? { kind, pair, result: result.then(asFolderTree) } : { kind, pair, result });
  }

  function openSyncProfile(profile: SavedSyncProfile) {
    if (!remote || !profile.available) return;
    const pair = {
      id: remote.id, target: `${remote.profile.name} · ${remote.profile.environment}`, exactRoots: true,
      local: { path: profile.local_root, location: profile.local_root },
      remote: { path: profile.remote_path, location: profile.remote_root },
    };
    const result = profile.options.recursive ? loadFolderTreeComparison(pair) : loadFolderComparison(pair).then(asFolderTree);
    setShowSyncProfiles(false);
    setComparison({ kind: "folder", pair, result, profile });
  }

  return <section className="network-workspace files-workspace" aria-label="파일 탐색">
    <header className="files-header">
      <div className="files-title">
        <h1><FolderOpen size={20} aria-hidden /> 파일 탐색</h1>
        {remote && <div className="files-connection" aria-label="SFTP 연결 대상">
          <span className={`environment ${remote.profile.environment.toLowerCase()}`}>{remote.profile.environment}</span>
          <strong>{remote.profile.name}</strong>
          <span>{[remote.projectName, `${remote.profile.username}@${remote.profile.host}:${remote.profile.port}`].filter(Boolean).join(" · ")}</span>
          {remote.route.length > 0 && <span>경유 {remote.route.join(" → ")}</span>}
        </div>}
      </div>
      {remote && <div className="files-header-actions">
        <button type="button" className="secondary small" disabled={closing || !localFolder} onClick={() => openComparison("files")}>파일 비교</button>
        <button type="button" className="secondary small" disabled={closing || !localFolder} onClick={() => openComparison("folder")}>
          <GitCompareArrows size={14} aria-hidden /> 폴더 비교
        </button>
        <button type="button" className="secondary small" disabled={closing} onClick={() => setShowSyncProfiles(true)}>동기화 프로필</button>
        <button type="button" className="secondary small" disabled={closing} onClick={() => void disconnect()}>SFTP 연결 끊기</button>
      </div>}
    </header>
    {!remote && <div className="results-card files-setup">
      <label className="field">{projectName ? `${projectName}의 SSH 연결` : "SSH 연결"}
        <select aria-label="SSH 연결 선택" value={selected?.id ?? ""} disabled={!profiles.length || connecting} onChange={event => setSelectedId(event.target.value)}>
          {!profiles.length && <option value="">저장된 SSH 연결 없음</option>}
          {profiles.map(profile => <option value={profile.id} key={profile.id}>{profile.name} · {profile.environment}</option>)}
        </select>
      </label>
      {selected && <SftpConnect key={`${selected.id}:${selected.revision}`} profile={selected} profiles={profiles} onConnecting={setConnecting}
        onOpened={(session, route = []) => {
          setRemote({ ...session, profile: selected, projectName, route });
          setActivePane("remote");
        }} />}
    </div>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {finished && <div className="success-banner files-download-result" role="status">
      <strong>{transferTitles[finished.kind]}</strong><span>{displayFilePath(finished.path)} · {numbers.format(BigInt(finished.bytes))} B</span>
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
        terminalPath={terminalDirectory?.kind === "local" ? terminalDirectory.path : null} followPaused={followPaused}
        onFolder={directory => setLocalFolder(directoryLocation(directory))} refresh={localRefresh}
        onPreview={file => choosePreview(file.name, "로컬 파일", invoke("preview_local_browse_file", { path: file.location }))}
        action={remote ? { kind: "upload", run: file => chooseTransfer({ ...file, kind: "upload", remotePath: remote.directory.path, remoteDirectory: remote.directory.location }) } : undefined} />
      {remote ? <DirectoryPane id="remote-files" active={activePane === "remote"} key={remote.id} title="원격 파일" initial={remote.directory}
        load={path => invoke("list_sftp_directory", { id: remote.id, path })}
        terminalPath={remoteTerminalPath} followPaused={followPaused}
        onFolder={directory => setRemote(current => current?.id === remote.id ? { ...current, directory } : current)} refresh={remoteRefresh}
        onNameAction={chooseNameAction}
        onDestination={chooseDestination}
        onDelete={chooseDelete}
        onEdit={chooseEditor}
        onPermissions={selection => { setFinished(null); setNameResult(null); setPermissionSelection(selection); }}
        onPreview={file => choosePreview(file.name, `${remote.profile.name} · ${remote.profile.environment}`,
          invoke("preview_sftp_file", { id: remote.id, location: file.location }))}
        action={{ kind: "download", run: file => chooseTransfer({ ...file, kind: "download", folder: localFolder ? displayFilePath(localFolder.path) : "" }) }} />
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
    {remote && permissionSelection && <SftpPermissionsDialog id={remote.id} target={`${remote.profile.name} · ${remote.profile.host}:${remote.profile.port} · ${remote.profile.environment}`}
      production={remote.profile.environment === "PROD"} selection={permissionSelection} onClose={() => setPermissionSelection(null)}
      onRefresh={() => setRemoteRefresh(value => value + 1)} onSaved={(name, warning) => mutationSaved("permissions", name, warning)} />}
    {preview && <FilePreviewDialog selection={preview} onClose={() => setPreview(null)} />}
    {remote && showSyncProfiles && <FolderSyncProfilesDialog id={remote.id} target={`${remote.profile.name} · ${remote.profile.environment}`}
      onOpen={openSyncProfile} onClose={() => setShowSyncProfiles(false)} />}
    {comparison?.kind === "folder" && <FolderCompareDialog pair={comparison.pair} initial={comparison.result} profile={comparison.profile}
      production={remote?.profile.environment === "PROD"} onExitGuard={onExitGuard} onClose={() => setComparison(null)}
      onSynced={() => { setLocalRefresh(value => value + 1); setRemoteRefresh(value => value + 1); }} />}
    {comparison?.kind === "files" && <FilePairCompareDialog pair={comparison.pair} initial={comparison.result} onClose={() => setComparison(null)} />}
  </section>;
}

function SftpConnect({ profile, profiles, onConnecting, onOpened }: {
  profile: SshProfile; profiles: SshProfile[]; onConnecting: (busy: boolean) => void; onOpened: (session: Session, route?: string[]) => void;
}) {
  const [routeDialog, setRouteDialog] = useState(false);
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

  return <><form className="files-auth" data-step={info ? "review" : "inspect"} onSubmit={open}>
    <p className={`files-target ${profile.environment.toLowerCase()}`}>{profile.username}@{profile.host}:{profile.port} · {profile.environment}</p>
    {!info && <button type="button" className="secondary small" disabled={busy} onClick={inspect}>SSH 호스트 키 확인</button>}
    {profiles.some(item => item.host !== profile.host || item.port !== profile.port) &&
      <button type="button" className="secondary small" disabled={busy} onClick={() => setRouteDialog(true)}>경유 서버 사용</button>}
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
  </form>{routeDialog && <SftpRouteDialog target={profile} profiles={profiles} onBusy={onConnecting} onClose={() => setRouteDialog(false)} onOpened={onOpened} />}</>;
}

function directoryLocation({ path, location }: Directory): DirectoryLocation {
  return { path, location };
}

function compareEntries(left: Entry, right: Entry, { key, direction }: FileSort) {
  if ((left.kind === "directory") !== (right.kind === "directory")) return left.kind === "directory" ? -1 : 1;
  const byName = names.compare(left.name, right.name) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const order = direction === "ascending" ? 1 : -1;
  if (key === "name") return byName * order;
  const a = key === "size" && left.kind === "directory" ? null : left[key];
  const b = key === "size" && right.kind === "directory" ? null : right[key];
  if (a === null || b === null) return a === b ? byName : a === null ? 1 : -1;
  const sizeOrTimeA = key === "size" ? BigInt(a) : a;
  const sizeOrTimeB = key === "size" ? BigInt(b) : b;
  return (sizeOrTimeA < sizeOrTimeB ? -order : sizeOrTimeA > sizeOrTimeB ? order : byName);
}

function DirectoryPane({ id, active, title, load, initial, chooseFolder, onFolder, onPreview, onNameAction, onDestination, onDelete, onEdit, onPermissions, action, refresh, terminalPath, followPaused }: {
  id: string; active: boolean; title: string; load: (path: BrowsePath) => Promise<Directory>; initial?: Directory; chooseFolder?: boolean;
  onPreview: (file: FileSelection) => void;
  onNameAction?: (action: SftpNameAction) => void;
  onDestination?: (selection: SftpDestinationSelection) => void;
  onDelete?: (directory: Directory, item: SftpListedItem) => void;
  onEdit?: (directory: Directory, item: SftpListedItem) => void;
  onPermissions?: (selection: PermissionSelection) => void;
  onFolder?: (directory: Directory) => void; action?: { kind: "download" | "upload"; run: (file: FileSelection) => void }; refresh: number;
  terminalPath: string | null; followPaused: boolean;
}) {
  const [directory, setDirectory] = useState<Directory | null>(initial ?? null);
  const [value, setValue] = useState(initial ? displayFilePath(initial.path) : "");
  const [history, setHistory] = useState<DirectoryHistory>(() => ({
    visits: initial ? [directoryLocation(initial)] : [], index: initial ? 0 : -1,
  }));
  const [hidden, setHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<FileSort>({ key: "name", direction: "ascending" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [following, setFollowing] = useState(false);
  const lastTerminalPath = useRef<string | null>(null);
  const pending = useRef(false);
  const filterInput = useRef<HTMLInputElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const { shown, available } = useMemo(() => {
    const entries = directory?.entries.filter(entry => hidden || !entry.hidden) ?? [];
    const query = filter.normalize("NFC").toLocaleLowerCase("ko-KR");
    const shown = query ? entries.filter(entry => entry.name.normalize("NFC").toLocaleLowerCase("ko-KR").includes(query)) : entries;
    return { available: entries.length, shown: shown.sort((left, right) => compareEntries(left, right, sort)) };
  }, [directory, filter, hidden, sort]);
  const actionLabel = action?.kind === "upload" ? "업로드" : "다운로드";

  async function navigate(path: BrowsePath | null, historyIndex?: number, fromTerminal = false) {
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
      if (next.location !== directory?.location) setFilter("");
      setHistory(current => {
        if (historyIndex !== undefined) {
          const visits = current.visits.slice();
          visits[historyIndex] = directoryLocation(next);
          return { visits, index: historyIndex };
        }
        if (current.visits[current.index]?.location === next.location) return current;
        return { visits: [...current.visits.slice(0, current.index + 1), directoryLocation(next)], index: current.index + 1 };
      });
      setDirectory(next);
      setValue(displayFilePath(next.path));
      onFolder?.(next);
    } catch (error) {
      setError(fromTerminal ? `터미널 경로를 열지 못했습니다. ${String(error)}` : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const reload = useEffectEvent(() => {
    if (directory) void navigate({ kind: "token", value: directory.location });
  });
  useEffect(() => { if (refresh) reload(); }, [refresh]);

  const follow = useEffectEvent((path: string) => {
    if (pending.current || lastTerminalPath.current === path) return;
    lastTerminalPath.current = path;
    if (path !== displayFilePath(directory?.path ?? "")) void navigate({ kind: "text", value: path }, undefined, true);
  });
  useEffect(() => {
    if (!following || terminalPath === null) {
      lastTerminalPath.current = null;
      return;
    }
    if (busy || followPaused) return;
    const timer = window.setTimeout(() => follow(terminalPath), 180);
    return () => window.clearTimeout(timer);
  }, [following, terminalPath, busy, followPaused]);

  function go(event: FormEvent) {
    event.preventDefault();
    void navigate(directory && value === displayFilePath(directory.path) ? { kind: "token", value: directory.location } : { kind: "text", value });
  }

  function travel(offset: -1 | 1) {
    const index = history.index + offset;
    const target = history.visits[index];
    if (target) void navigate({ kind: "token", value: target.location }, index);
  }

  const previous = history.visits[history.index - 1];
  const next = history.visits[history.index + 1];
  const PaneIcon = chooseFolder ? HardDrive : Server;
  return <section className="results-card files-pane" id={id} data-active={active} aria-label={title} onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      travel(event.key === "ArrowLeft" ? -1 : 1);
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      pathInput.current?.focus();
      pathInput.current?.select();
    }
  }}>
    <div className="panel-heading"><div><PaneIcon size={15} aria-hidden /><strong>{title}</strong>
      {directory && <span aria-live="polite">{numbers.format(shown.length)}{filter ? ` / ${numbers.format(available)}` : ""}개 항목</span>}</div>
      {chooseFolder && <button type="button" className="secondary small" disabled={busy} onClick={() => void navigate(null)}>폴더 선택</button>}
      {directory && onNameAction && <button type="button" className="secondary small" disabled={busy}
        onClick={() => onNameAction({ kind: "create", parent: directory })}><FolderPlus size={14} /> 새 폴더</button>}
    </div>
    <form className="files-path" onSubmit={go}>
      <div className="files-path-history">
        <button type="button" className="icon-button" aria-label={`${title} 뒤로`} aria-keyshortcuts="Alt+ArrowLeft"
          title={previous ? displayFilePath(previous.path) : "뒤로"} disabled={busy || !previous}
          onClick={() => travel(-1)}><ArrowLeft size={15} aria-hidden /></button>
        <button type="button" className="icon-button" aria-label={`${title} 앞으로`} aria-keyshortcuts="Alt+ArrowRight"
          title={next ? displayFilePath(next.path) : "앞으로"} disabled={busy || !next}
          onClick={() => travel(1)}><ArrowRight size={15} aria-hidden /></button>
        <button type="button" className="icon-button" aria-label={`${title} 상위 폴더`} title="상위 폴더" disabled={busy || !directory?.parent}
          onClick={() => directory?.parent && void navigate({ kind: "token", value: directory.parent })}><ArrowUp size={15} aria-hidden /></button>
      </div>
      <div className="files-path-address">
        <input ref={pathInput} required aria-label={`${title} 경로`} aria-keyshortcuts="Control+L" value={value} maxLength={4096} disabled={busy}
          onChange={event => setValue(event.target.value)} />
        <button type="submit" className="secondary small" disabled={busy}>이동</button>
        <button type="button" className="icon-button" aria-label={`${title} 새로고침`} title="새로고침" disabled={busy || !directory}
          onClick={() => directory && void navigate({ kind: "token", value: directory.location })}><RefreshCw size={14} aria-hidden /></button>
      </div>
    </form>
    <div className="files-follow-control">
      <label className="files-check"><input type="checkbox" checked={following} onChange={event => setFollowing(event.target.checked)} />
        터미널 경로 따라가기</label>
      {following && !terminalPath && <span role="status">{chooseFolder ? "활성 PowerShell의 폴더 경로를 기다리는 중" : "같은 SSH 연결의 활성 터미널 경로를 기다리는 중"}</span>}
    </div>
    {directory && <div className="files-list-controls">
      <div className="files-filter">
        <Search size={14} aria-hidden />
        <input ref={filterInput} type="search" aria-label={`${title} 이름으로 찾기`} placeholder="이름으로 찾기" spellCheck={false} autoComplete="off"
          value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => {
            if (event.key === "Escape" && filter) {
              event.preventDefault();
              setFilter("");
            }
          }} />
        {filter && <button type="button" className="icon-button" aria-label={`${title} 이름 검색 지우기`}
          onClick={() => { setFilter(""); filterInput.current?.focus(); }}><X size={14} aria-hidden /></button>}
      </div>
      <label className="files-check"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} /> 숨김 파일 표시</label>
    </div>}
    {busy && <p className="form-note files-note" role="status">폴더를 읽는 중…</p>}
    {error && <p className="form-error files-note" role="alert">{error}</p>}
    {directory?.truncated && <p className="form-note files-note">처음 2,000개 항목을 표시합니다. 하위 폴더는 경로를 입력해 열 수 있습니다.</p>}
    {directory && <div className="files-table-wrap"><table className="files-table" aria-label={`${title} 목록`}>
      <thead><tr>{fileColumns.map(([key, label]) => {
        const active = sort.key === key;
        const SortIcon = active ? sort.direction === "ascending" ? ArrowUp : ArrowDown : ArrowUpDown;
        return <th scope="col" key={key} aria-sort={active ? sort.direction : undefined}>
          <button type="button" className="files-sort" onClick={() => setSort(current => ({
            key, direction: current.key === key && current.direction === "ascending" ? "descending" : "ascending",
          }))}>{label}<SortIcon size={12} aria-hidden /></button>
        </th>;
      })}{!chooseFolder && <th scope="col">권한 · UID/GID</th>}<th scope="col"><span className="sr-only">파일 작업</span></th></tr></thead>
      <tbody>{shown.map((entry, index) => {
        const location = entry.location;
        const kind = entry.kind;
        const rights = `${entry.mode === null ? "—" : entry.mode.toString(8).padStart(4, "0")} · ${entry.uid ?? "—"}/${entry.gid ?? "—"}`;
        const icon = entry.kind === "directory" ? <FolderOpen size={14} /> : entry.kind === "symlink" ? <Link size={14} /> : <File size={14} />;
        return <tr key={entry.location ?? index}>
          <td>{entry.kind === "directory" && location ? <button type="button" className="files-entry" disabled={busy}
            onClick={() => void navigate({ kind: "token", value: location })}>{icon}{entry.name}</button>
            : <span className="files-entry">{icon}{entry.name}</span>}</td>
          <td>{entry.kind !== "directory" && entry.size !== null ? `${numbers.format(BigInt(entry.size))} B` : "—"}</td>
          <td>{entry.modified === null ? "—" : dates.format(entry.modified * 1000)}</td>
          {!chooseFolder && <td>{onPermissions && location && !entry.name_is_lossy && (kind === "file" || kind === "directory") &&
            (entry.mode !== null || (entry.uid !== null && entry.gid !== null))
            ? <button type="button" className="files-sort files-permission-value" disabled={busy} aria-label={`${entry.name} 권한 변경`}
              title="권한·소유자 변경" onClick={() => onPermissions({ parent: directory, item: { ...entry, kind, location } })}>{rights}</button>
            : rights}</td>}
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
    {directory && !shown.length && <p className="form-note files-note">{filter ? "이름이 일치하는 항목이 없습니다." : "표시할 파일이 없습니다."}</p>}
  </section>;
}
