import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { displayFilePath, type Entry } from "./fileBrowse";
import { asFolderTree, compareFileContents, fileComparisonSnapshot, loadFolderComparison, loadFolderTreeComparison,
  type ContentResult, type FileSnapshot, type FolderComparison, type FolderPair, type FolderTreeComparison } from "./fileCompare";
import { FileComparisonResult, FileDifferenceDialog, type ViewableDifference } from "./FileDifferenceDialog";
import { compareFolderTrees, relationLabels } from "./folderComparison";

const numbers = new Intl.NumberFormat("ko-KR");
const dates = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" });
const kindLabels = { directory: "폴더", file: "파일", symlink: "심볼릭 링크", other: "기타 항목" };
type Visible = "all" | "issues" | "local" | "remote";
const PAGE_SIZE = 200;

function Metadata({ entries }: { entries: Entry[] }) {
  if (!entries.length) return <td>—</td>;
  if (entries.length > 1) return <td>{numbers.format(entries.length)}개 항목</td>;
  const [entry] = entries;
  return <td>
    <span>{kindLabels[entry.kind]}{entry.kind === "file" && entry.size !== null ? ` · ${numbers.format(BigInt(entry.size))} B` : ""}</span>
    {entry.modified !== null && <div className="files-compare-date">{dates.format(entry.modified * 1000)}</div>}
  </td>;
}

export function FolderCompareDialog({ pair, initial, onClose }: { pair: FolderPair; initial: Promise<FolderComparison>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const resultList = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(() => initial.then(asFolderTree));
  const [result, setResult] = useState<FolderTreeComparison | null>(null);
  const [recursive, setRecursive] = useState(false);
  const [visible, setVisible] = useState<Visible>("issues");
  const [page, setPage] = useState(0);
  const [content, setContent] = useState(new Map<string, ContentResult>());
  const [hashing, setHashing] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ name: string; difference: ViewableDifference } | null>(null);
  const hashPending = useRef(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    void pending.then(value => { if (live) setResult(value); });
    return () => { live = false; };
  }, [pending]);

  const folders = result && "local" in result ? result : null;
  const { rows, localIncomplete, remoteIncomplete } = useMemo(() => folders ? compareFolderTrees(folders.local, folders.remote)
    : { rows: [], localIncomplete: 0, remoteIncomplete: 0 }, [folders]);
  const shown = rows.filter(row => {
    if (visible === "all") return true;
    if (visible !== "issues") return row.relation === visible;
    const checked = content.get(row.name);
    return (row.relation !== "same" && row.relation !== "folder") || hashing === row.name
      || (checked !== undefined && ("error" in checked || !checked.matches));
  });
  const pages = Math.ceil(shown.length / PAGE_SIZE);
  const currentPage = Math.max(0, Math.min(page, pages - 1));
  const pageRows = shown.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  function goToPage(next: number) {
    setPage(next);
    resultList.current?.scrollTo({ top: 0 });
  }

  function refresh(includeChildren: boolean) {
    setRecursive(includeChildren);
    setResult(null);
    setContent(new Map());
    setPage(0);
    setPending(includeChildren ? loadFolderTreeComparison(pair) : loadFolderComparison(pair).then(asFolderTree));
  }

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
      const result = await compareFileContents(pair.id, local, remote);
      setContent(current => new Map(current).set(name, result));
    } finally {
      hashPending.current = false;
      setHashing(null);
    }
  }

  return <><dialog ref={dialog} className="dialog files-compare" aria-labelledby="files-compare-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="files-compare-title">폴더 비교</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="files-compare-body" aria-busy={!result}>
      <dl className="files-compare-paths">
        <div><dt>로컬 폴더</dt><dd>{displayFilePath(folders?.local.path ?? pair.local.path)}</dd></div>
        <div><dt>원격 폴더 · {pair.target}</dt><dd>{folders?.remote.path ?? pair.remote.path}</dd></div>
      </dl>
      <p className="form-note">{recursive
        ? "하위 항목을 루트 기준 상대 경로로 맞춰 유형·크기·수정 시각을 비교합니다."
        : "현재 폴더 바로 아래 항목의 이름·유형·크기·수정 시각을 비교합니다."}</p>
      {!result && <p className="form-note" role="status">양쪽 폴더를 읽는 중…</p>}
      {result && "errors" in result && result.errors.map(error => <p className="form-error" role="alert" key={error}>{error}</p>)}
      {folders && (localIncomplete > 0 || remoteIncomplete > 0) && <p className="form-note" role="status">
        일부 또는 전체 목록을 확인할 수 없는 폴더 · 로컬 {numbers.format(localIncomplete)}개 / 원격 {numbers.format(remoteIncomplete)}개
      </p>}
      <div className="files-compare-tools">
        <label className="files-compare-scope"><input type="checkbox" checked={recursive} disabled={!result || hashing !== null}
          onChange={event => refresh(event.target.checked)} /> 하위 폴더 포함</label>
        {folders && <>
          <label>표시 <select aria-label="비교 결과 필터" value={visible} onChange={event => { setVisible(event.target.value as Visible); goToPage(0); }}>
            <option value="issues">차이 및 확인 필요</option><option value="all">전체 항목</option>
            <option value="local">로컬에만 있음</option><option value="remote">원격에만 있음</option>
          </select></label>
          <span role="status">{numbers.format(shown.length)} / {numbers.format(rows.length)}개 항목</span>
        </>}
        <button type="button" className="secondary small" disabled={!result || hashing !== null}
          onClick={() => refresh(recursive)}><RefreshCw size={14} aria-hidden /> 다시 비교</button>
      </div>
      {folders && shown.length > 0 && <div ref={resultList} className="files-compare-results" role="region" aria-label="폴더 비교 결과 스크롤 영역" tabIndex={0}>
        <table className="files-table" aria-label="폴더 비교 결과">
        <thead><tr><th scope="col">{recursive ? "상대 경로" : "이름"}</th><th scope="col">비교 결과</th><th scope="col">로컬</th><th scope="col">원격</th></tr></thead>
        <tbody>{pageRows.map(row => {
          const local = row.local.length === 1 ? fileComparisonSnapshot(row.local[0]) : null;
          const remote = row.remote.length === 1 ? fileComparisonSnapshot(row.remote[0]) : null;
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
                {checked && <FileComparisonResult result={checked} differenceLabel={`${row.name} 차이 보기`}
                  onDifference={difference => setSelection({ name: row.name, difference })} />}
              </div>}
            </td>
            <Metadata entries={row.local} /><Metadata entries={row.remote} />
          </tr>;
        })}</tbody>
      </table></div>}
      {pages > 1 && <nav className="files-compare-pages" aria-label="폴더 비교 결과 페이지">
        <button type="button" className="secondary small" disabled={currentPage === 0} onClick={() => goToPage(currentPage - 1)}>이전</button>
        <span role="status">{numbers.format(currentPage + 1)} / {numbers.format(pages)} 페이지</span>
        <button type="button" className="secondary small" disabled={currentPage + 1 === pages} onClick={() => goToPage(currentPage + 1)}>다음</button>
      </nav>}
      {folders && shown.length === 0 && <p className="form-note">이 조건에 해당하는 항목이 없습니다.</p>}
    </div>
  </dialog>
    {selection && <FileDifferenceDialog {...selection} onClose={() => setSelection(null)} />}
  </>;
}
