import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { displayFilePath } from "./fileBrowse";
import type { ContentResult } from "./fileCompare";
import type { FolderTreeRow } from "./folderComparison";
import { buildFolderSyncPlan, parseSyncPatterns, syncActionLabels, type SyncAction, type SyncDirection } from "./folderSyncPlan";

const numbers = new Intl.NumberFormat("ko-KR");
const PAGE_SIZE = 100;
const proposed = new Set<SyncAction>(["mkdir", "copy", "update", "delete"]);
type Filter = "all" | "proposed" | SyncAction;
const filters: [Filter, string][] = [
  ["all", "전체"], ["proposed", "변경 후보"], ["conflict", "충돌"], ["verify", "내용 확인"],
  ["keep", "보존"], ["exclude", "제외"],
];

export function FolderSyncPlanDialog({ rows, content, localPath, remotePath, target, recursive, incomplete, onClose }: {
  rows: readonly FolderTreeRow[];
  content: ReadonlyMap<string, ContentResult>;
  localPath: string;
  remotePath: string;
  target: string;
  recursive: boolean;
  incomplete: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<SyncDirection>("upload");
  const [mirrorDeletes, setMirrorDeletes] = useState(false);
  const [patternText, setPatternText] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const parsed = useMemo(() => parseSyncPatterns(patternText), [patternText]);
  const plan = useMemo(() => "patterns" in parsed ? buildFolderSyncPlan(rows, content, {
    direction, mirrorDeletes, patterns: parsed.patterns, recursive, windowsLocal: /^(?:[a-z]:|\\\\)/i.test(localPath),
  }) : [], [rows, content, direction, mirrorDeletes, parsed, recursive, localPath]);
  const shown = plan.filter(item => filter === "all" || (filter === "proposed" ? proposed.has(item.action) : item.action === filter));
  const pages = Math.ceil(shown.length / PAGE_SIZE);
  const active = Math.max(0, Math.min(page, pages - 1));
  const changes = plan.filter(item => proposed.has(item.action)).length;
  const conflicts = plan.filter(item => item.action === "conflict").length;
  const verification = plan.filter(item => item.action === "verify").length;

  useEffect(() => { dialog.current?.showModal(); }, []);

  function goToPage(index: number) {
    setPage(index);
    results.current?.scrollTo({ top: 0 });
  }

  return <dialog ref={dialog} className="dialog files-compare" aria-labelledby="folder-sync-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="folder-sync-title">동기화 계획 미리보기</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="files-compare-body">
      <dl className="files-compare-paths">
        <div><dt>로컬 폴더</dt><dd>{displayFilePath(localPath)}</dd></div>
        <div><dt>원격 폴더 · {target}</dt><dd>{remotePath}</dd></div>
      </dl>
      <p className="form-note">비교 시점의 {recursive ? "하위 폴더 포함" : "현재 폴더"} 목록으로 계산한 실행 전 미리보기입니다.</p>
      {incomplete > 0 && <p className="form-note" role="status">
        일부 또는 전체를 확인할 수 없는 폴더가 {numbers.format(incomplete)}개 있습니다. 확인한 항목만 계획에 반영됩니다.
      </p>}
      <div className="folder-sync-options">
        <div>
          <label className="field">동기화 방향
            <select value={direction} onChange={event => {
              const next = event.target.value as SyncDirection;
              setDirection(next);
              if (next === "both") setMirrorDeletes(false);
              goToPage(0);
            }}>
              <option value="upload">로컬 → 원격</option>
              <option value="download">원격 → 로컬</option>
              <option value="both">양방향</option>
            </select>
          </label>
          <label className="folder-sync-delete">
            <input type="checkbox" checked={mirrorDeletes} disabled={direction === "both"}
              onChange={event => { setMirrorDeletes(event.target.checked); goToPage(0); }} /> 대상에만 있는 항목을 삭제 후보에 포함
          </label>
          {direction === "both" && <p className="form-note">양방향 계획은 양쪽의 고유 항목을 보존하고, 같은 경로의 차이는 충돌로 표시합니다.</p>}
        </div>
        <label className="field">제외 패턴
          <textarea rows={3} value={patternText} placeholder={"*.tmp\ncache/**"} aria-label="제외 패턴" aria-invalid={"error" in parsed}
            aria-describedby="folder-sync-pattern-hint" onChange={event => { setPatternText(event.target.value); goToPage(0); }} />
          <span id="folder-sync-pattern-hint" className="form-note">한 줄에 하나씩 입력하세요. *는 이름 일부, ?는 한 글자, **는 하위 경로에 대응합니다.</span>
        </label>
      </div>
      {"error" in parsed ? <p className="form-error" role="alert">{parsed.error}</p> : <>
        <div className="files-compare-tools">
          <label>표시 <select aria-label="동기화 계획 필터" value={filter}
            onChange={event => { setFilter(event.target.value as Filter); goToPage(0); }}>
            {filters.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          <span role="status">변경 후보 {numbers.format(changes)}개 · 충돌 {numbers.format(conflicts)}개 · 내용 확인 {numbers.format(verification)}개</span>
        </div>
        {shown.length ? <div ref={results} className="files-compare-results" role="region" aria-label="동기화 계획 스크롤 영역" tabIndex={0}>
          <table className="files-table folder-sync-table" aria-label="동기화 계획">
            <thead><tr><th scope="col">상대 경로</th><th scope="col">예상 작업</th><th scope="col">대상</th><th scope="col">사유</th></tr></thead>
            <tbody>{shown.slice(active * PAGE_SIZE, (active + 1) * PAGE_SIZE).map(item => <tr key={item.path}>
              <th scope="row" title={item.path}>{item.path}</th>
              <td>{syncActionLabels[item.action]}</td>
              <td>{item.target === "local" ? "로컬" : item.target === "remote" ? "원격" : "—"}</td>
              <td>{item.reason}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="form-note">이 조건에 해당하는 항목이 없습니다.</p>}
        {pages > 1 && <nav className="files-compare-pages" aria-label="동기화 계획 페이지">
          <button type="button" className="secondary small" disabled={active === 0} onClick={() => goToPage(active - 1)}>이전</button>
          <span role="status">{numbers.format(active + 1)} / {numbers.format(pages)} 페이지</span>
          <button type="button" className="secondary small" disabled={active + 1 === pages} onClick={() => goToPage(active + 1)}>다음</button>
        </nav>}
      </>}
    </div>
  </dialog>;
}
