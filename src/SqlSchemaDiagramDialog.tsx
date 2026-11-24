import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeftRight, FileDown, RefreshCw, Search, Table2, X } from "lucide-react";
import { sqliteNameKey } from "./sqlCompletion";
import { diagramCard, indexSchemaDiagram, layoutSchemaDiagram, type DiagramRelationship, type DiagramTable } from "./sqlSchemaDiagram";
import "./schemaDiagram.css";

type DiagramState<T> = { status: "loading" } | { status: "ready"; tables: T[] } | { status: "failed"; message: string };
type DiagramFilter = "all" | "related" | "isolated" | "issue";
type IdentifierKey = (name: string) => string;
const displayName = (name: string) => name || "(빈 이름)";
const issueLabel = { missing_table: "참조 테이블 없음", missing_columns: "참조 열 확인 필요" };
const relationsPerPage = 16;

function TableCard({ name, table, selected, x, y, onSelect, identifierKey }: {
  name: string;
  table: DiagramTable | undefined;
  selected?: boolean;
  x: number;
  y: number;
  onSelect: (name: string) => void;
  identifierKey: IdentifierKey;
}) {
  const sourceKeys = new Set(table?.foreign_keys.map(key => identifierKey(key.from_column)));
  const columns = table?.columns.map(column => ({ ...column, foreign: sourceKeys.has(identifierKey(column.name)) }))
    .sort((a, b) => Number(!!b.primary_key_position || b.foreign) - Number(!!a.primary_key_position || a.foreign)) ?? [];
  const label = displayName(table?.label ?? name);
  const title = <><Table2 size={14} aria-hidden /><strong title={label}>{label}</strong></>;
  return <article className="erd-table" data-selected={selected || undefined} data-missing={!table || undefined}
    style={{ left: x, top: y, width: diagramCard.width, height: diagramCard.height }}>
    {table ? <button type="button" className="erd-table-name" aria-pressed={Boolean(selected)} onClick={() => onSelect(name)}>
      {title}
    </button> : <div className="erd-table-name">{title}</div>}
    {table ? <>
      <ul>{columns.slice(0, 4).map(column => <li key={column.name}>
        <span title={column.name}>{displayName(column.name)}</span>
        <code title={column.declared_type}>{column.declared_type}</code>
        <small>{column.primary_key_position > 0 && "PK"}{column.primary_key_position > 0 && column.foreign && " · "}{column.foreign && "FK"}</small>
      </li>)}</ul>
      <small className="erd-remaining">{columns.length}개 열{columns.length > 4 && ` · ${columns.length - 4}개 더 있음`}</small>
    </> : <p>{issueLabel.missing_table}</p>}
  </article>;
}

function DiagramCanvas({ selected, relationships, tables, zoom, onSelect, identifierKey, labelFor }: {
  selected: string;
  relationships: DiagramRelationship[];
  tables: Map<string, DiagramTable>;
  zoom: number;
  onSelect: (name: string) => void;
  identifierKey: IdentifierKey;
  labelFor: (name: string) => string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const centerCard = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  const arrow = useId();
  const layout = useMemo(() => layoutSchemaDiagram(selected, relationships, identifierKey, labelFor),
    [selected, relationships, identifierKey, labelFor]);
  useLayoutEffect(() => {
    const container = viewport.current;
    if (!container) return;
    container.scrollTo({
      left: (layout.center.x + diagramCard.width / 2) * zoom - container.clientWidth / 2,
      top: (layout.center.y + diagramCard.height / 2) * zoom - container.clientHeight / 2,
    });
    if (moveFocus.current) {
      centerCard.current?.querySelector("button")?.focus({ preventScroll: true });
      moveFocus.current = false;
    }
  }, [layout, zoom]);
  return <div className="erd-viewport" ref={viewport} role="region" tabIndex={0} aria-label="관계도 캔버스">
    <div className="erd-extent" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
      <div className="erd-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
        <svg className="erd-edges" width={layout.width} height={layout.height} aria-hidden="true">
          <defs><marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 Z" />
          </marker></defs>
          {layout.neighbors.map(node => <path key={node.name} className="erd-link" d={node.path}
            data-missing={node.missing || undefined} markerEnd={`url(#${arrow})`} markerStart={node.reverse ? `url(#${arrow})` : undefined} />)}
          {layout.loop && <path className="erd-link" d={layout.loop} markerEnd={`url(#${arrow})`} />}
        </svg>
        <div ref={centerCard}><TableCard name={selected} table={tables.get(identifierKey(selected))}
          selected {...layout.center} onSelect={onSelect} identifierKey={identifierKey} /></div>
        {layout.neighbors.map(node => <TableCard key={node.name} {...node}
          table={tables.get(identifierKey(node.name))} identifierKey={identifierKey}
          onSelect={name => { moveFocus.current = true; onSelect(name); }} />)}
      </div>
    </div>
  </div>;
}

export function SqlSchemaDiagramDialog({ profileId, connection, initialTable, onOpen, onExport, onCompare, onClose }: {
  profileId: string;
  connection: string;
  initialTable: string | null;
  onOpen: (name: string) => void;
  onExport: (name: string) => void;
  onCompare: () => void;
  onClose: () => void;
}) {
  const load = useCallback(() => invoke<DiagramTable[]>("sqlite_schema_diagram", { profileId }), [profileId]);
  return <SchemaDiagramDialog title="SQLite 관계도" connection={connection} initialTable={initialTable}
    load={load} onOpen={table => onOpen(table.name)} onExport={onExport} onCompare={onCompare} onClose={onClose} />;
}

export function SchemaDiagramDialog<T extends DiagramTable>({ title, connection, initialTable, load, onOpen, onExport, onCompare, onClose,
  identifierKey = sqliteNameKey, scopeNote }: {
  title: string;
  connection: string;
  initialTable: string | null;
  load: () => Promise<T[]>;
  onOpen: (table: T) => void;
  onExport?: (name: string) => void;
  onCompare?: () => void;
  onClose: () => void;
  identifierKey?: IdentifierKey;
  scopeNote?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const selectedTableButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<DiagramState<T>>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState(initialTable);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<DiagramFilter>("all");
  const [zoom, setZoom] = useState(1);
  const [relationshipPage, setRelationshipPage] = useState(0);
  const index = useMemo(() => state.status === "ready" ? indexSchemaDiagram(state.tables, identifierKey) : null, [state, identifierKey]);
  const labelFor = useCallback((name: string) => displayName(index?.byName.get(identifierKey(name))?.label ?? name), [index, identifierKey]);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    void load().then(tables => {
      if (live) setState({ status: "ready", tables });
    }).catch(error => {
      if (live) setState({ status: "failed", message: String(error) });
    });
    return () => { live = false; };
  }, [load, refresh]);

  const current = state.status === "ready"
    ? (selected !== null ? index?.byName.get(identifierKey(selected)) : undefined) ?? state.tables[0]
    : undefined;
  const relations = current && index ? index.relationships.get(current.name)! : [];
  const pageRelations = useMemo(() => relations.slice(relationshipPage * relationsPerPage,
    (relationshipPage + 1) * relationsPerPage), [relations, relationshipPage]);
  const needle = sqliteNameKey(search.trim());
  const shown = state.status === "ready" ? state.tables.filter(table => {
    if (!sqliteNameKey(table.label ?? table.name).includes(needle)) return false;
    const links = index?.relationships.get(table.name) ?? [];
    if (filter === "related") return links.length > 0;
    if (filter === "isolated") return links.length === 0;
    if (filter === "issue") return links.some(link => link.issue);
    return true;
  }) : [];
  useLayoutEffect(() => {
    selectedTableButton.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current?.name, shown.length]);

  function selectTable(name: string) {
    if (name === current?.name) return;
    setSelected(name);
    setRelationshipPage(0);
  }

  return <dialog ref={dialog} className="dialog erd-dialog" aria-labelledby={titleId} onClose={onClose}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label="관계도 닫기" onClick={() => dialog.current?.close()}><X size={17} aria-hidden /></button>
    </div>
    <div className="erd-context"><span>{connection}</span>
      <button className="secondary small" type="button" disabled={state.status === "loading"} onClick={() => {
        setState({ status: "loading" });
        setRelationshipPage(0);
        setRefresh(value => value + 1);
      }}><RefreshCw size={14} aria-hidden /> 스키마 새로고침</button>
    </div>
    {state.status === "loading" && <p className="erd-message" role="status">테이블 관계를 불러오는 중…</p>}
    {state.status === "failed" && <p className="erd-message form-error" role="alert">{state.message}</p>}
    {state.status === "ready" && !state.tables.length && <p className="erd-message" role="status">표시할 테이블이 없습니다.</p>}
    <div className="erd-body" hidden={!current || !index}>
      <aside className="erd-index" aria-label="관계도 테이블 목록">
        <label className="object-search erd-search"><Search size={14} aria-hidden /><input
          aria-label="관계도 테이블 검색" placeholder="테이블 이름" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <label className="field">관계 범위<select value={filter} onChange={event => setFilter(event.target.value as DiagramFilter)}>
          <option value="all">모든 테이블</option><option value="related">관계 있음</option>
          <option value="isolated">관계 없음</option><option value="issue">참조 확인 필요</option>
        </select></label>
        <p className="form-note" role="status">{shown.length}개 테이블</p>
        <ul>{shown.map(table => <li key={table.name}><button type="button" aria-pressed={table.name === current?.name}
          ref={table.name === current?.name ? selectedTableButton : undefined}
          title={labelFor(table.name)} onClick={() => selectTable(table.name)}>{labelFor(table.name)}</button></li>)}</ul>
      </aside>
      {current && index && <div className="erd-main">
        <div className="erd-toolbar"><strong title={labelFor(current.name)}>{labelFor(current.name)}</strong>
          <label>확대 <select aria-label="관계도 확대" value={zoom} onChange={event => setZoom(Number(event.target.value))}>
            {[.6, .8, 1, 1.25, 1.5].map(value => <option key={value} value={value}>{value * 100}%</option>)}
          </select></label>
          {onExport && <button type="button" className="secondary small" aria-haspopup="dialog" onClick={() => onExport(current.name)}>
            <FileDown size={14} aria-hidden /> 데이터 사전
          </button>}
          {onCompare && <button type="button" className="secondary small" aria-haspopup="dialog" onClick={onCompare}>
            <ArrowLeftRight size={14} aria-hidden /> 스키마 비교
          </button>}
          <button type="button" className="secondary small" onClick={() => {
            dialog.current?.close();
            onOpen(current);
          }}>테이블 열기</button>
        </div>
        <DiagramCanvas selected={current.name} relationships={pageRelations} tables={index.byName} zoom={zoom} onSelect={selectTable}
          identifierKey={identifierKey} labelFor={labelFor} />
        <p className="form-note erd-legend">화살표는 외래 키를 선언한 테이블에서 참조 대상 테이블로 향합니다.{scopeNote && ` ${scopeNote}`}</p>
        <section className="erd-relations" aria-label="선택한 테이블의 외래 키">
          <div className="erd-relations-heading">
            <h3>외래 키 {relations.length}개</h3>
            {relations.length > relationsPerPage && <div className="erd-pagination" aria-label="외래 키 페이지" role="group">
              <button type="button" className="secondary small" disabled={relationshipPage === 0}
                onClick={() => setRelationshipPage(page => page - 1)}>이전 관계</button>
              <span role="status">{relationshipPage + 1} / {Math.ceil(relations.length / relationsPerPage)}</span>
              <button type="button" className="secondary small" disabled={(relationshipPage + 1) * relationsPerPage >= relations.length}
                onClick={() => setRelationshipPage(page => page + 1)}>다음 관계</button>
            </div>}
          </div>
          {!relations.length && <p className="form-note">선택한 테이블에 연결된 외래 키가 없습니다.</p>}
          {pageRelations.map(link => <details key={JSON.stringify([link.source, link.id])}>
            <summary><strong>{labelFor(link.source)} → {labelFor(link.target)}</strong>
              {link.issue && <span className="erd-issue">{issueLabel[link.issue]}</span>}
            </summary>
            <ul>{link.fields.map((field, index) => <li key={index}>{displayName(field.source)} → {field.target === null ? "기본 키 확인 필요" : displayName(field.target)}</li>)}</ul>
            <p className="form-note">삭제 {link.onDelete} · 수정 {link.onUpdate}</p>
          </details>)}
        </section>
      </div>}
    </div>
  </dialog>;
}
