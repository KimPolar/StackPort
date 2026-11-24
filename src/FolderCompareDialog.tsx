import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, X } from "lucide-react";
import { displayFilePath, type Directory, type DirectoryLocation, type Entry } from "./fileBrowse";

const names = new Intl.Collator("ko-KR", { numeric: true });
const numbers = new Intl.NumberFormat("ko-KR");
const dates = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" });
const kindLabels = { directory: "폴더", file: "파일", symlink: "심볼릭 링크", other: "기타 항목" };
const relationLabels = {
  local: "로컬에만 있음", remote: "원격에만 있음", difference: "차이 있음",
  same: "크기·수정 시각 일치", folder: "양쪽 폴더", unknown: "확인 필요",
};
type Relation = keyof typeof relationLabels;
type Row = { name: string; local: Entry[]; remote: Entry[]; relation: Relation; detail?: string };
type Visible = "all" | "issues" | "local" | "remote";
export type FolderPair = { id: string; target: string; local: DirectoryLocation; remote: DirectoryLocation };
type Comparison = { local: Directory; remote: Directory } | { errors: string[] };
type FileSnapshot = { location: string; size: string | null; modified: number | null };
type Content = { matches: boolean; local_sha256: string; remote_sha256: string };
type ContentResult = Content | { error: string };

export async function loadFolderComparison(pair: FolderPair): Promise<Comparison> {
  const [local, remote] = await Promise.allSettled([
    invoke<Directory>("browse_local_directory", { path: pair.local.location }),
    invoke<Directory>("list_sftp_directory", { id: pair.id, path: { kind: "token", value: pair.remote.location } }),
  ]);
  if (local.status === "fulfilled" && remote.status === "fulfilled") return { local: local.value, remote: remote.value };
  const errors: string[] = [];
  if (local.status === "rejected") errors.push(`로컬 폴더 · ${String(local.reason)}`);
  if (remote.status === "rejected") errors.push(`원격 폴더 · ${String(remote.reason)}`);
  return { errors };
}

function relation(row: Pick<Row, "local" | "remote">, localTruncated: boolean, remoteTruncated: boolean): Pick<Row, "relation" | "detail"> {
  const [local] = row.local;
  const [remote] = row.remote;
  if (row.local.length > 1 || row.remote.length > 1 || local?.name_is_lossy || remote?.name_is_lossy) {
    return { relation: "unknown", detail: "이름을 정확히 대조할 수 없습니다." };
  }
  if (!local) return localTruncated ? { relation: "unknown", detail: "로컬 목록 일부만 확인" } : { relation: "remote" };
  if (!remote) return remoteTruncated ? { relation: "unknown", detail: "원격 목록 일부만 확인" } : { relation: "local" };
  if (local.kind !== remote.kind) return { relation: "difference", detail: "유형 다름" };
  if (local.kind === "directory") return { relation: "folder" };
  if (local.kind !== "file") return { relation: "unknown", detail: "링크 또는 기타 항목" };
  const differences: string[] = [];
  if (local.size !== null && remote.size !== null && local.size !== remote.size) differences.push("크기 다름");
  if (local.modified !== null && remote.modified !== null && local.modified !== remote.modified) {
    differences.push(local.modified > remote.modified ? "로컬 수정 시각이 더 최근" : "원격 수정 시각이 더 최근");
  }
  if (differences.length) return { relation: "difference", detail: differences.join(" · ") };
  if (local.size === null || remote.size === null || local.modified === null || remote.modified === null) {
    return { relation: "unknown", detail: "크기 또는 수정 시각 미확인" };
  }
  return { relation: "same" };
}

function compareFolders(local: Directory, remote: Directory): Row[] {
  const joined = new Map<string, Pick<Row, "local" | "remote">>();
  for (const side of ["local", "remote"] as const) {
    for (const entry of (side === "local" ? local : remote).entries) {
      const row = joined.get(entry.name) ?? { local: [], remote: [] };
      row[side].push(entry);
      joined.set(entry.name, row);
    }
  }
  return Array.from(joined, ([name, row]) => ({ name, ...row, ...relation(row, local.truncated, remote.truncated) }))
    .sort((left, right) => names.compare(left.name, right.name));
}

function fileSnapshot(entries: Entry[]): FileSnapshot | null {
  const [entry] = entries;
  return entries.length === 1 && entry.kind === "file" && !entry.name_is_lossy && entry.location
    ? { location: entry.location, size: entry.size, modified: entry.modified } : null;
}

function Metadata({ entries }: { entries: Entry[] }) {
  if (!entries.length) return <td>—</td>;
  if (entries.length > 1) return <td>{numbers.format(entries.length)}개 항목</td>;
  const [entry] = entries;
  return <td>
    <span>{kindLabels[entry.kind]}{entry.kind === "file" && entry.size !== null ? ` · ${numbers.format(BigInt(entry.size))} B` : ""}</span>
    {entry.modified !== null && <div className="files-compare-date">{dates.format(entry.modified * 1000)}</div>}
  </td>;
}

export function FolderCompareDialog({ pair, initial, onClose }: { pair: FolderPair; initial: Promise<Comparison>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(initial);
  const [result, setResult] = useState<Comparison | null>(null);
  const [visible, setVisible] = useState<Visible>("issues");
  const [content, setContent] = useState(new Map<string, ContentResult>());
  const [hashing, setHashing] = useState<string | null>(null);
  const hashPending = useRef(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    void pending.then(value => { if (live) setResult(value); });
    return () => { live = false; };
  }, [pending]);

  const folders = result && "local" in result ? result : null;
  const rows = useMemo(() => folders ? compareFolders(folders.local, folders.remote) : [], [folders]);
  const shown = rows.filter(row => {
    if (visible === "all") return true;
    if (visible !== "issues") return row.relation === visible;
    const checked = content.get(row.name);
    return (row.relation !== "same" && row.relation !== "folder") || hashing === row.name
      || (checked !== undefined && ("error" in checked || !checked.matches));
  });

  async function compareFile(name: string, local: FileSnapshot, remote: FileSnapshot) {
    if (hashPending.current) return;
    hashPending.current = true;
    setHashing(name);
    setContent(current => {
      const next = new Map(current);
      next.delete(name);
      return next;
    });
    try {
      const result = await invoke<Content>("compare_sftp_file_contents", { id: pair.id, local, remote });
      setContent(current => new Map(current).set(name, result));
    } catch (error) {
      setContent(current => new Map(current).set(name, { error: String(error) }));
    } finally {
      hashPending.current = false;
      setHashing(null);
    }
  }

  return <dialog ref={dialog} className="dialog files-compare" aria-labelledby="files-compare-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="files-compare-title">폴더 비교</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="files-compare-body" aria-busy={!result}>
      <dl className="files-compare-paths">
        <div><dt>로컬 폴더</dt><dd>{displayFilePath(folders?.local.path ?? pair.local.path)}</dd></div>
        <div><dt>원격 폴더 · {pair.target}</dt><dd>{folders?.remote.path ?? pair.remote.path}</dd></div>
      </dl>
      <p className="form-note">현재 폴더 바로 아래 항목의 이름·유형·크기·수정 시각을 비교합니다.</p>
      {!result && <p className="form-note" role="status">양쪽 폴더를 읽는 중…</p>}
      {result && "errors" in result && result.errors.map(error => <p className="form-error" role="alert" key={error}>{error}</p>)}
      {folders && (folders.local.truncated || folders.remote.truncated) && <p className="form-note" role="status">
        {folders.local.truncated && folders.remote.truncated ? "두 목록" : folders.local.truncated ? "로컬 목록" : "원격 목록"}의 처음 2,000개 항목을 확인했습니다.
      </p>}
      <div className="files-compare-tools">
        {folders && <>
          <label>표시 <select aria-label="비교 결과 필터" value={visible} onChange={event => setVisible(event.target.value as Visible)}>
            <option value="issues">차이 및 확인 필요</option><option value="all">전체 항목</option>
            <option value="local">로컬에만 있음</option><option value="remote">원격에만 있음</option>
          </select></label>
          <span role="status">{numbers.format(shown.length)} / {numbers.format(rows.length)}개 항목</span>
        </>}
        <button type="button" className="secondary small" disabled={!result || hashing !== null} onClick={() => {
          setResult(null);
          setContent(new Map());
          setPending(loadFolderComparison(pair));
        }}><RefreshCw size={14} aria-hidden /> 다시 비교</button>
      </div>
      {folders && shown.length > 0 && <div className="files-compare-results"><table className="files-table" aria-label="폴더 비교 결과">
        <thead><tr><th scope="col">이름</th><th scope="col">비교 결과</th><th scope="col">로컬</th><th scope="col">원격</th></tr></thead>
        <tbody>{shown.map(row => {
          const local = fileSnapshot(row.local);
          const remote = fileSnapshot(row.remote);
          const checked = content.get(row.name);
          return <tr key={row.name}>
            <th scope="row" title={row.name}>{row.name}</th>
            <td>
              <strong>{relationLabels[row.relation]}</strong>{row.detail && <div className="files-compare-date">{row.detail}</div>}
              {local && remote && <div className="files-compare-hash">
                <button type="button" className="secondary small" disabled={hashing !== null}
                  aria-label={`${row.name} 내용 비교`} title="SHA-256 · 파일당 16 MiB"
                  onClick={() => void compareFile(row.name, local, remote)}>내용 비교</button>
                {hashing === row.name && <span role="status">내용을 읽는 중…</span>}
                {checked && ("error" in checked ? <p className="form-error" role="alert">{checked.error}</p> : <>
                  <span role="status">{checked.matches ? "내용 일치" : "내용 다름"}</span>
                  <details><summary>SHA-256</summary><dl>
                    <dt>로컬</dt><dd><code>{checked.local_sha256}</code></dd>
                    <dt>원격</dt><dd><code>{checked.remote_sha256}</code></dd>
                  </dl></details>
                </>)}
              </div>}
            </td>
            <Metadata entries={row.local} /><Metadata entries={row.remote} />
          </tr>;
        })}</tbody>
      </table></div>}
      {folders && shown.length === 0 && <p className="form-note">이 조건에 해당하는 항목이 없습니다.</p>}
    </div>
  </dialog>;
}
