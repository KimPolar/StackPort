import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
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
type Target = "local" | "remote";
type BatchProgress = { completed: number; total: number; path: string };
type BatchItem = { path: string; target: Target } & (
  | { status: "applied"; bytes: string | null; sha256: string | null }
  | { status: "failed" | "skipped"; reason: string }
);
type BatchReport = { items: BatchItem[]; audit_warning: string | null };
const executionLabels = { applied: "완료", failed: "실패", skipped: "건너뜀" };
const targetLabels = { local: "로컬", remote: "원격" };

export function FolderSyncPlanDialog({ rows, content, localPath, remotePath, target, recursive, incomplete,
  sessionId, localRoot, remoteRoot, production, onExitGuard, onClose }: {
  rows: readonly FolderTreeRow[];
  content: ReadonlyMap<string, ContentResult>;
  localPath: string;
  remotePath: string;
  target: string;
  recursive: boolean;
  incomplete: number;
  sessionId: string;
  localRoot: string;
  remoteRoot: string;
  production: boolean;
  onExitGuard: (guard: (() => void) | null) => void;
  onClose: (executed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<SyncDirection>("upload");
  const [mirrorDeletes, setMirrorDeletes] = useState(false);
  const [patternText, setPatternText] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const running = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [error, setError] = useState("");
  const [exitNotice, setExitNotice] = useState(false);
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
  const additions = useMemo(() => {
    const byPath = new Map(rows.map(row => [row.name, row]));
    return plan.flatMap(item => {
      if (!item.target || (item.action !== "mkdir" && item.action !== "copy")) return [];
      const source = byPath.get(item.path)?.[item.target === "local" ? "remote" : "local"][0];
      if (!source) return [];
      return [{ path: item.path, target: item.target, kind: source.kind, size: source.size, modified: source.modified }];
    });
  }, [plan, rows]);
  const needsProd = production && additions.some(item => item.target === "remote");
  const executing = progress !== null;
  const locked = confirming || executing;
  const reported = report?.items ?? [];
  const reportPages = Math.ceil(reported.length / PAGE_SIZE);
  const counts = { applied: 0, failed: 0, skipped: 0 };
  for (const item of reported) counts[item.status]++;

  useEffect(() => { dialog.current?.showModal(); }, []);
  useLayoutEffect(() => {
    if (!executing) return;
    onExitGuard(() => setExitNotice(true));
    return () => onExitGuard(null);
  }, [executing, onExitGuard]);

  function goToPage(index: number) {
    setPage(index);
    results.current?.scrollTo({ top: 0 });
  }

  async function execute() {
    if (!confirming || running.current || !additions.length || (needsProd && confirmation !== "PROD")) return;
    running.current = true;
    setProgress({ completed: 0, total: additions.length, path: "" });
    setError("");
    setExitNotice(false);
    const channel = new Channel<BatchProgress>(setProgress);
    try {
      setReport(await invoke<BatchReport>("apply_sftp_sync_additions", {
        id: sessionId, input: { local_root: localRoot, remote_root: remoteRoot, confirmation, items: additions }, progress: channel,
      }));
      goToPage(0);
    } catch (error) {
      setError(String(error));
    } finally {
      channel.onmessage = () => {};
      setProgress(null);
      setConfirming(false);
      setConfirmation("");
      running.current = false;
    }
  }

  return <dialog ref={dialog} className="dialog files-compare" aria-labelledby="folder-sync-title" onClose={() => onClose(report !== null)}
    onCancel={event => { if (running.current) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="folder-sync-title">동기화 계획 미리보기</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={progress !== null} onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="files-compare-body">
      <dl className="files-compare-paths">
        <div><dt>로컬 폴더</dt><dd>{displayFilePath(localPath)}</dd></div>
        <div><dt>원격 폴더 · {target}</dt><dd>{remotePath}</dd></div>
      </dl>
      {report ? <>
        <h3 className="folder-sync-result-title">동기화 실행 결과</h3>
        <p role="status" className="form-note">완료 {numbers.format(counts.applied)}개 · 실패 {numbers.format(counts.failed)}개 · 건너뜀 {numbers.format(counts.skipped)}개</p>
        {report.audit_warning && <p role="alert" className="form-error">{report.audit_warning}</p>}
        <div ref={results} className="files-compare-results" role="region" aria-label="동기화 실행 결과 스크롤 영역" tabIndex={0}>
          <table className="files-table folder-sync-table" aria-label="동기화 실행 결과">
            <thead><tr><th scope="col">상대 경로</th><th scope="col">대상</th><th scope="col">결과</th><th scope="col">상세</th></tr></thead>
            <tbody>{reported.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(item => <tr key={item.path}>
              <th scope="row" title={item.path}>{item.path}</th><td>{targetLabels[item.target]}</td><td>{executionLabels[item.status]}</td>
              <td>{item.status === "applied" ? (item.bytes === null ? "폴더 생성" :
                <details><summary>{numbers.format(BigInt(item.bytes))} B</summary><code>{item.sha256}</code></details>) : item.reason}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {reportPages > 1 && <nav className="files-compare-pages" aria-label="동기화 실행 결과 페이지">
          <button type="button" className="secondary small" disabled={page === 0} onClick={() => goToPage(page - 1)}>이전</button>
          <span>{numbers.format(page + 1)} / {numbers.format(reportPages)} 페이지</span>
          <button type="button" className="secondary small" disabled={page + 1 === reportPages} onClick={() => goToPage(page + 1)}>다음</button>
        </nav>}
      </> : <>
      <p className="form-note">비교 시점의 {recursive ? "하위 폴더 포함" : "현재 폴더"} 목록으로 계산한 실행 전 미리보기입니다.</p>
      {incomplete > 0 && <p className="form-note" role="status">
        일부 또는 전체를 확인할 수 없는 폴더가 {numbers.format(incomplete)}개 있습니다. 확인한 항목만 계획에 반영됩니다.
      </p>}
      <div className="folder-sync-options">
        <div>
          <label className="field">동기화 방향
            <select value={direction} disabled={locked} onChange={event => {
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
            <input type="checkbox" checked={mirrorDeletes} disabled={locked || direction === "both"}
              onChange={event => { setMirrorDeletes(event.target.checked); goToPage(0); }} /> 대상에만 있는 항목을 삭제 후보에 포함
          </label>
          {direction === "both" && <p className="form-note">양방향 계획은 양쪽의 고유 항목을 보존하고, 같은 경로의 차이는 충돌로 표시합니다.</p>}
        </div>
        <label className="field">제외 패턴
          <textarea rows={3} value={patternText} disabled={locked} placeholder={"*.tmp\ncache/**"} aria-label="제외 패턴" aria-invalid={"error" in parsed}
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
              <td>{item.target ? targetLabels[item.target] : "—"}</td>
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
      {error && <p className="form-error" role="alert">{error}</p>}
      {exitNotice && progress && <p className="form-note" role="status">동기화 작업을 마친 뒤 앱을 닫을 수 있습니다.</p>}
      {progress ? <div className="files-transfer" role="status">
        <progress aria-label="동기화 진행률" max={progress.total} value={progress.completed} />
        <span>{numbers.format(progress.completed)} / {numbers.format(progress.total)} · {progress.path || "준비 중"}</span>
      </div> : confirming ? <div className="folder-sync-confirm">
        <p className="form-note">새 폴더와 파일 {numbers.format(additions.length)}개를 만들거나 복사합니다. 갱신·삭제 후보는 이 실행에서 보류합니다.</p>
        {needsProd && <label className="field">운영 연결 확인
          <input value={confirmation} placeholder="PROD" onChange={event => setConfirmation(event.target.value)} />
        </label>}
        <div className="folder-sync-run">
          <button type="button" className="secondary small" onClick={() => { setConfirming(false); setConfirmation(""); }}>계속 검토</button>
          <button type="button" className="primary small" disabled={needsProd && confirmation !== "PROD"}
            onClick={() => void execute()}>확인하고 시작</button>
        </div>
      </div> : additions.length > 0 && <div className="folder-sync-run">
        <button type="button" className="primary small" onClick={() => { setError(""); setConfirming(true); }}>
          새 항목 실행 ({numbers.format(additions.length)})
        </button>
      </div>}
      </>}
    </div>
  </dialog>;
}
