import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeftRight, Search, X } from "lucide-react";
import "./schemaComparison.css";

type Connection = { id: string; name: string; environment: string; project_name: string };
type Status = "source_only" | "target_only" | "changed";
type Member = { category: string; name: string; source: string | null; target: string | null };
type Difference = {
  name: string;
  status: Status;
  source_kind: string | null;
  target_kind: string | null;
  source_ddl: string | null;
  target_ddl: string | null;
  members: Member[];
  draft_sql: string | null;
};
type Comparison = { unchanged: number; changes: Difference[] };
const labels: Record<Status, string> = { source_only: "기준에만 있음", target_only: "대상에만 있음", changed: "정의가 다름" };
const describeKind = (kind: string | null) => kind === null ? "없음" : kind === "view" ? "뷰" : "테이블";
const displayName = (name: string) => name || "(빈 이름)";
const memberPageSize = 100;

function ObjectDifference({ change }: { change: Difference }) {
  const [page, setPage] = useState(0);
  const previewTitle = change.status === "source_only" ? "대상 생성 SQL 초안"
    : change.status === "target_only" ? "대상 삭제 SQL 초안" : "대상 뷰 재정의 SQL 초안";
  const totalPages = Math.ceil(change.members.length / memberPageSize);
  return <section className="schema-compare-details" aria-label="선택한 객체의 차이">
    <h3>{displayName(change.name)}</h3>
    <p className="form-note">{labels[change.status]} · 기준 {describeKind(change.source_kind)} · 대상 {describeKind(change.target_kind)}</p>
    {change.members.length > 0 && <>
      <div className="table-wrap sql-result-differences" role="region" tabIndex={0} aria-label="객체 속성 차이 스크롤 영역">
        <table aria-label="객체 속성 차이">
          <thead><tr><th scope="col">구분</th><th scope="col">이름</th><th scope="col">기준</th><th scope="col">대상</th></tr></thead>
          <tbody>{change.members.slice(page * memberPageSize, (page + 1) * memberPageSize).map(member =>
            <tr key={JSON.stringify([member.category, member.name])}>
              <td>{member.category}</td><th scope="row">{displayName(member.name)}</th>
              <td><code>{member.source ?? "—"}</code></td><td><code>{member.target ?? "—"}</code></td>
            </tr>)}</tbody>
        </table>
      </div>
      {totalPages > 1 && <div className="schema-compare-pages" role="group" aria-label="객체 속성 차이 페이지">
        <button type="button" className="secondary small" disabled={page === 0} onClick={() => setPage(value => value - 1)}>이전</button>
        <span role="status">{page + 1} / {totalPages}</span>
        <button type="button" className="secondary small" disabled={page + 1 === totalPages} onClick={() => setPage(value => value + 1)}>다음</button>
      </div>}
    </>}
    <details open={change.members.length === 0 || undefined}>
      <summary>정의 SQL</summary>
      <div className="schema-compare-ddl">
        <section><h4>기준</h4><pre aria-label="기준 정의 SQL">{change.source_ddl ?? "—"}</pre></section>
        <section><h4>대상</h4><pre aria-label="대상 정의 SQL">{change.target_ddl ?? "—"}</pre></section>
      </div>
    </details>
    {change.draft_sql && <details>
      <summary>{previewTitle}</summary>
      <p className="form-note">{change.status === "target_only"
        ? "삭제 SQL을 실행하면 대상 객체가 제거됩니다. 테이블은 저장된 행과 연결된 제약의 영향도 확인하세요."
        : "대상에서 이 초안을 사용하기 전에 참조 테이블과 뷰 등의 의존 관계를 확인하세요."}</p>
      <pre aria-label={previewTitle} tabIndex={0}>{change.draft_sql}</pre>
    </details>}
  </section>;
}

export function SchemaComparisonDialog({ initial, onClose }: {
  initial: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [profiles, setProfiles] = useState<Connection[] | null>(null);
  const [source, setSource] = useState(initial);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Comparison | null>(null);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    void invoke<Connection[]>("schema_comparison_connections").then(items => {
      if (!live) return;
      const chosen = items.find(item => item.id === initial) ?? items[0];
      setProfiles(items);
      setSource(chosen?.id ?? "");
      setTarget(items.find(item => item.id !== chosen?.id)?.id ?? "");
    }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [initial]);

  function clear() { setResult(null); setError(""); setSelected(null); }

  async function compare() {
    if (pending.current || !source || !target || source === target) return;
    pending.current = true;
    clear(); setBusy(true); setSearch(""); setFilter("all");
    try {
      setResult(await invoke<Comparison>("compare_sqlite_schema", { sourceId: source, targetId: target }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const needle = search.trim().toLocaleLowerCase();
  const found = result?.changes.filter(change => (filter === "all" || change.status === filter)
    && change.name.toLocaleLowerCase().includes(needle)) ?? [];
  const current = found.find(change => change.name === selected) ?? found[0];
  const options = profiles?.map(profile => <option key={profile.id} value={profile.id}>
    {profile.project_name} / {profile.name} · {profile.environment}
  </option>);

  return <dialog ref={dialog} className="dialog schema-comparison-dialog" aria-labelledby="schema-comparison-title" onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2 id="schema-comparison-title">SQLite 스키마 비교</h2>
      <button type="button" className="icon-button" disabled={busy} aria-label="스키마 비교 닫기" onClick={() => dialog.current?.close()}><X size={17} aria-hidden /></button>
    </div>
    <div className="schema-compare-body">
      {!profiles && !error && <p className="form-note" role="status">SQLite 연결을 불러오는 중…</p>}
      {profiles && profiles.length < 2 && <p className="form-note" role="status">비교할 SQLite 연결을 두 개 이상 등록하세요.</p>}
      {profiles && profiles.length >= 2 && <form className="schema-compare-controls" onSubmit={event => { event.preventDefault(); void compare(); }}>
        <label className="field">기준 연결<select value={source} disabled={busy} onChange={event => {
          if (event.target.value === target) setTarget(source);
          setSource(event.target.value); clear();
        }}>{options}</select></label>
        <button type="button" className="icon-button" aria-label="기준과 대상 바꾸기" title="기준과 대상 바꾸기" disabled={busy || !target}
          onClick={() => { setSource(target); setTarget(source); clear(); }}><ArrowLeftRight size={16} aria-hidden /></button>
        <label className="field">대상 연결<select value={target} disabled={busy} onChange={event => {
          if (event.target.value === source) setSource(target);
          setTarget(event.target.value); clear();
        }}>{options}</select></label>
        <button type="submit" className="primary" disabled={busy || !target || source === target}>비교 실행</button>
      </form>}
      {busy && <p role="status" className="form-note">스키마를 읽고 있습니다…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {result && <>
        <p role="status" className="form-note">
          일치 {result.unchanged}개 · 기준에만 {result.changes.filter(change => change.status === "source_only").length}개
          {" · 대상에만 "}{result.changes.filter(change => change.status === "target_only").length}개
          {" · 변경 "}{result.changes.filter(change => change.status === "changed").length}개
        </p>
        {!result.changes.length ? <p className="form-note">두 연결의 스키마가 같습니다.</p> : <div className="schema-compare-grid">
          <aside className="schema-compare-list" aria-label="스키마 차이 목록">
            <label className="object-search"><Search size={14} aria-hidden /><input aria-label="변경 객체 검색"
              placeholder="객체 이름" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label className="field">차이 범위<select value={filter} onChange={event => setFilter(event.target.value as Status | "all")}>
              <option value="all">모든 차이</option>
              <option value="source_only">{labels.source_only}</option><option value="target_only">{labels.target_only}</option>
              <option value="changed">{labels.changed}</option>
            </select></label>
            <ul>{found.map(change => <li key={change.name}>
              <button type="button" aria-pressed={current?.name === change.name} onClick={() => setSelected(change.name)}>
                <strong>{displayName(change.name)}</strong><small>{labels[change.status]}</small>
              </button>
            </li>)}</ul>
            {!found.length && <p role="status" className="form-note">조건에 맞는 객체가 없습니다.</p>}
          </aside>
          {current && <ObjectDifference key={current.name} change={current} />}
        </div>}
      </>}
    </div>
  </dialog>;
}
