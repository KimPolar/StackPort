import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Table2, X } from "lucide-react";
import type { DatabaseObject, ObjectDetails } from "./SqlSchemaDetails";
import { SqlBuilderClauses } from "./SqlBuilderClauses";
import { buildSqlQuery, emptyQuery, relationCandidates, sourceColumns, tableAlias,
  type Join, type JoinPair, type QuerySource, type QueryStructure } from "./sqlQueryBuilder";

const dragType = "application/x-stackport-sql-object";
const emptyPair: JoinPair = { left: null, right: null };
const maxSources = 8;

function SourceName({ source }: { source: QuerySource }) {
  return <span className="sql-builder-source-name"><code>{tableAlias(source.id)}</code> {source.details.object.name || "(빈 이름)"}</span>;
}

function JoinColumn({ source, value, name, change }: { source: QuerySource; value: string | null; name: string; change: (value: string | null) => void }) {
  return <select aria-label={name} value={value === null ? "" : JSON.stringify(value)} onChange={event =>
    change(event.target.value ? JSON.parse(event.target.value) as string : null)}>
    <option value="">열 선택</option>
    {sourceColumns(source).map(column => <option key={column.position} value={JSON.stringify(column.name)}>{column.name || "(빈 열 이름)"}</option>)}
  </select>;
}

function JoinControls({ source, prior, index, join, change }: {
  source: QuerySource;
  prior: QuerySource[];
  index: number;
  join: Join;
  change: (join: Join) => void;
}) {
  const left = prior.find(item => item.id === join.from)!;
  const candidates = relationCandidates(left, source);
  const matched = candidates.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(join.pairs));
  const label = `조인 ${index}`;
  const labelPair = (pair: JoinPair) => `${pair.left} = ${pair.right}`;
  return <>
    <div className="sql-builder-relation" aria-label={`${tableAlias(left.id)}에서 ${tableAlias(source.id)}로 조인`}>
      <SourceName source={left} /><span className="sql-builder-join-edge" aria-hidden />
      <code>{join.kind} JOIN</code><span className="sql-builder-join-edge" aria-hidden /><SourceName source={source} />
    </div>
    <div className="sql-builder-row">
      <label>기준 테이블<select aria-label={`${label} 기준 테이블`} value={join.from} onChange={event => {
        const from = Number(event.target.value);
        const target = prior.find(item => item.id === from);
        if (!target) return;
        const keys = relationCandidates(target, source);
        change({ ...join, from, pairs: keys.length === 1 ? keys[0] : [emptyPair] });
      }}>{prior.map(item => <option key={item.id} value={item.id}>{tableAlias(item.id)} · {item.details.object.name}</option>)}</select></label>
      <label>조인 유형<select aria-label={`${label} 유형`} value={join.kind} onChange={event => change({ ...join, kind: event.target.value as Join["kind"] })}>
        <option value="INNER">INNER JOIN</option><option value="LEFT">LEFT JOIN</option>
      </select></label>
      {!!candidates.length && <label>외래 키<select aria-label={`${label} 외래 키`} value={matched < 0 ? "" : matched}
        onChange={event => change({ ...join, pairs: event.target.value ? candidates[Number(event.target.value)] : [emptyPair] })}>
        <option value="">열 직접 선택</option>
        {candidates.map((candidate, ordinal) => <option key={ordinal} value={ordinal}>{candidate.map(labelPair).join(" AND ")}</option>)}
      </select></label>}
    </div>
    <div className="sql-builder-rows">
      {join.pairs.map((pair, pairIndex) => <div className="sql-builder-row" key={pairIndex}>
        <JoinColumn source={left} value={pair.left} name={`${label} 관계 ${pairIndex + 1} 기준 열`}
          change={column => change({ ...join, pairs: join.pairs.map((item, at) => at === pairIndex ? { ...item, left: column } : item) })} />
        <span aria-hidden>=</span>
        <JoinColumn source={source} value={pair.right} name={`${label} 관계 ${pairIndex + 1} 연결 열`}
          change={column => change({ ...join, pairs: join.pairs.map((item, at) => at === pairIndex ? { ...item, right: column } : item) })} />
        <button type="button" className="icon-button" aria-label={`${label} 관계 ${pairIndex + 1} 삭제`} disabled={join.pairs.length === 1}
          onClick={() => change({ ...join, pairs: join.pairs.filter((_, at) => at !== pairIndex) })}><X size={14} aria-hidden /></button>
      </div>)}
      <button type="button" className="secondary small" disabled={join.pairs.length >= 16}
        onClick={() => change({ ...join, pairs: [...join.pairs, emptyPair] })}>관계 열 추가</button>
    </div>
  </>;
}

export function SqlQueryBuilderDialog({ profileId, connection, objects, onOpen, onClose }: {
  profileId: string;
  connection: string;
  objects: DatabaseObject[];
  onOpen: (sql: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nextTable = useRef(0);
  const nextRow = useRef(0);
  const pending = useRef(false);
  const [draft, setDraft] = useState<QueryStructure>(emptyQuery);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => buildSqlQuery(draft), [draft]);
  const matches = objects.filter(object => object.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const available = matches.slice(0, 64);
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function addSource(name: string) {
    if (pending.current || draft.sources.length >= maxSources || !objects.some(object => object.name === name)) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const details = draft.sources.find(source => source.details.object.name === name)?.details
        ?? await invoke<ObjectDetails>("describe_object", { profileId, name });
      if (!dialog.current?.open) return;
      const source: QuerySource = { id: ++nextTable.current, details };
      setDraft(current => {
        const { sources } = current;
        if (!sources.length) return { ...current, sources: [source] };
        const candidates = sources.flatMap(left => relationCandidates(left, source).map(pairs => ({ from: left.id, pairs })));
        const relation = candidates.length === 1 ? candidates[0] : { from: sources[0].id, pairs: [emptyPair] };
        return { ...current, sources: [...sources, { ...source, join: { kind: "INNER", ...relation } }] };
      });
    } catch (reason) {
      if (dialog.current?.open) setError(String(reason));
    } finally {
      pending.current = false;
      if (dialog.current?.open) setBusy(false);
    }
  }

  function removeSource(id: number) {
    if (draft.sources.some(source => source.join?.from === id)) return;
    const projections = draft.projections.filter(item => item.field?.table !== id);
    const projectionIds = new Set(projections.map(item => item.id));
    setDraft({ ...draft, projections,
      sources: draft.sources.filter(source => source.id !== id),
      filters: draft.filters.filter(item => item.field.table !== id),
      groups: draft.groups.filter(item => item.field.table !== id),
      having: draft.having.filter(item => projectionIds.has(item.projection)),
      order: draft.order.filter(item => projectionIds.has(item.projection)),
    });
  }

  return <dialog className="dialog sql-query-builder" ref={dialog} aria-labelledby="sql-builder-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="sql-builder-title">쿼리 빌더</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="sql-builder-body">
      <p className="form-note"><strong>{connection}</strong> · 테이블이나 뷰를 선택하거나 관계 영역으로 드래그하세요.</p>
      <div className="sql-builder-layout">
        <div className="sql-builder-catalog">
          <input type="search" aria-label="조회 객체 검색" placeholder="테이블·뷰 검색" value={search} onChange={event => setSearch(event.target.value)} />
          {!!available.length && <ul aria-label="조회 객체 목록">{available.map(object => <li key={object.name}>
            <button type="button" draggable={!busy && draft.sources.length < maxSources}
              aria-label={`${object.name || "(빈 이름)"} 추가`} disabled={busy || draft.sources.length >= maxSources}
              onDragStart={event => { event.dataTransfer.setData(dragType, object.name); event.dataTransfer.effectAllowed = "copy"; }}
              onClick={() => void addSource(object.name)}><Table2 size={14} aria-hidden /><span>{object.name || "(빈 이름)"}</span><Plus size={13} aria-hidden /></button>
          </li>)}</ul>}
          {!matches.length && <p className="form-note">조건에 맞는 테이블이나 뷰가 없습니다.</p>}
          {matches.length > available.length && <p className="form-note">처음 {available.length}개를 표시합니다.</p>}
          {draft.sources.length >= maxSources && <p className="form-note">조회 객체를 최대 {maxSources}개 추가할 수 있습니다.</p>}
        </div>
        <section className="sql-builder-sources" aria-label="조회 테이블 관계" aria-busy={busy}
          onDragOver={event => { if (event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
          onDrop={event => {
            if (!event.dataTransfer.types.includes(dragType)) return;
            event.preventDefault();
            void addSource(event.dataTransfer.getData(dragType));
          }}>
          {!draft.sources.length && <p className="form-note">조인을 시작할 테이블이나 뷰를 추가하세요.</p>}
          {draft.sources.map((source, index) => {
            const used = draft.sources.some(other => other.join?.from === source.id);
            return <div key={source.id} className="sql-builder-source">
              <div className="sql-builder-source-heading"><SourceName source={source} />
                <button type="button" className="icon-button" disabled={used}
                  aria-label={`${tableAlias(source.id)} 테이블 제거`} title={used ? "이 테이블을 사용하는 조인을 변경하세요." : undefined}
                  onClick={() => removeSource(source.id)}><X size={15} aria-hidden /></button>
              </div>
              {source.join && <JoinControls source={source} prior={draft.sources.slice(0, index)} index={index} join={source.join}
                change={join => setDraft(current => ({ ...current, sources: current.sources.map(item => item.id === source.id ? { ...item, join } : item) }))} />}
            </div>;
          })}
          {busy && <p role="status" className="form-note">스키마를 불러오는 중…</p>}
          {error && <p role="alert" className="form-error">{error}</p>}
        </section>
      </div>
      {!!draft.sources.length && <SqlBuilderClauses draft={draft} change={setDraft} nextId={() => ++nextRow.current} />}
      <section aria-label="생성 SQL 미리보기">
        {"sql" in preview ? <>
          <pre aria-label="생성된 조회 SQL" tabIndex={0}>{preview.sql}</pre>
          {preview.parameters > 0 && <p className="form-note">새 탭에서 실행할 때 매개변수 값을 입력하세요.</p>}
        </> : !!draft.sources.length && <p className="form-note" role="status">{preview.error}</p>}
      </section>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => dialog.current?.close()}>닫기</button>
        <button type="button" className="primary" disabled={busy || !("sql" in preview)}
          onClick={() => { if ("sql" in preview) onOpen(preview.sql); }}>SQL을 새 탭에서 열기</button>
      </div>
    </div>
  </dialog>;
}
