import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { compareFileContents, fileComparisonSnapshot, loadFolderComparison, type ContentResult, type FileSnapshot, type FolderComparison, type FolderPair } from "./fileCompare";
import { displayFilePath, type Directory } from "./fileBrowse";
import { FileComparisonResult, FileDifferenceDialog, type ViewableDifference } from "./FileDifferenceDialog";

type ListedFile = { name: string; snapshot: FileSnapshot };
const nameOrder = new Intl.Collator("ko-KR", { numeric: true });

function listedFiles(directory?: Directory) {
  const files = new Map<string, ListedFile>();
  for (const entry of directory?.entries ?? []) {
    const snapshot = fileComparisonSnapshot(entry);
    if (snapshot) files.set(snapshot.location, { name: entry.name, snapshot });
  }
  return files;
}

function FilePicker({ label, path, files, value, onChange, busy }: {
  label: string;
  path: string;
  files: Map<string, ListedFile>;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
}) {
  const options = useMemo(() => [...files.values()].sort((left, right) => nameOrder.compare(left.name, right.name)), [files]);
  return <label className="field">
    {label}
    <span className="file-pair-path" title={path}>{path}</span>
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)} disabled={busy || !options.length}>
      <option value="">{options.length ? "파일 선택" : "선택할 일반 파일 없음"}</option>
      {options.map(file => <option key={file.snapshot.location} value={file.snapshot.location}>{file.name}</option>)}
    </select>
  </label>;
}

export function FilePairCompareDialog({ pair, initial, onClose }: {
  pair: FolderPair;
  initial: Promise<FolderComparison>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const comparing = useRef(false);
  const [listingRequest, setListingRequest] = useState(initial);
  const [listing, setListing] = useState<FolderComparison | null>(null);
  const [localValue, setLocalValue] = useState("");
  const [remoteValue, setRemoteValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ContentResult | null>(null);
  const [details, setDetails] = useState<ViewableDifference | null>(null);
  const folders = listing && "local" in listing ? listing : null;
  const local = useMemo(() => listedFiles(folders?.local), [folders?.local]);
  const remote = useMemo(() => listedFiles(folders?.remote), [folders?.remote]);
  const left = local.get(localValue);
  const right = remote.get(remoteValue);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    void listingRequest.then(value => { if (active) setListing(value); });
    return () => { active = false; };
  }, [listingRequest]);

  function refresh() {
    setListing(null);
    setLocalValue("");
    setRemoteValue("");
    setResult(null);
    setListingRequest(loadFolderComparison(pair));
  }

  async function compare() {
    if (!left || !right || comparing.current) return;
    comparing.current = true;
    setBusy(true);
    setResult(null);
    try {
      setResult(await compareFileContents(pair.id, left.snapshot, right.snapshot));
    } finally {
      comparing.current = false;
      setBusy(false);
    }
  }

  return <><dialog ref={dialog} className="dialog files-compare file-pair" aria-labelledby="file-pair-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="file-pair-title">파일 비교</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="files-compare-body" aria-busy={!listing || busy}>
      {!listing && <p className="form-note" role="status">양쪽 폴더를 읽는 중…</p>}
      {listing && "errors" in listing && listing.errors.map(error => <p className="form-error" role="alert" key={error}>{error}</p>)}
      {folders && <div className="file-pair-inputs">
        <FilePicker label="로컬 파일" path={displayFilePath(folders.local.path)} files={local} value={localValue} busy={busy}
          onChange={value => { setLocalValue(value); setResult(null); }} />
        <FilePicker label="원격 파일" path={`${pair.target} · ${folders.remote.path}`} files={remote} value={remoteValue} busy={busy}
          onChange={value => { setRemoteValue(value); setResult(null); }} />
      </div>}
      {folders && (folders.local.truncated || folders.remote.truncated) &&
        <p className="form-note">폴더마다 목록의 처음 2,000개 항목에서 선택할 수 있습니다.</p>}
      <div className="file-pair-actions">
        <button type="button" className="secondary small" disabled={!listing || busy} onClick={refresh}>
          <RefreshCw size={14} aria-hidden /> 목록 새로고침
        </button>
        <button type="button" className="primary small" disabled={!left || !right || busy} onClick={() => void compare()}>
          내용 비교
        </button>
      </div>
      {busy && <p className="form-note" role="status">내용을 읽는 중…</p>}
      {result && <div className="files-compare-hash">
        <FileComparisonResult result={result} differenceLabel="차이 보기" onDifference={setDetails} />
      </div>}
    </div>
  </dialog>
    {details && left && right && <FileDifferenceDialog
      name={left.name === right.name ? left.name : `${left.name} ↔ ${right.name}`}
      outputName={left.name} difference={details} onClose={() => setDetails(null)} />}
  </>;
}
