import { useMemo, useState, type FormEvent } from "react";
import { Dialog } from "./Dialog";
import { postgresObjectLabels, postgresSectionLabels, type PostgresObjectKind, type PostgresStructureSection } from "./PostgresObjectStructure";
import { PostgresPager } from "./PostgresPager";
import { usePostgresRead } from "./usePostgresRead";

type SearchField = "name" | "column" | "comment" | "definition";
type SearchInput = { schema: number | null; kind: PostgresObjectKind | null; field: SearchField; term: string; page: number };
export type PostgresSearchHit = { id: number; schema_id: number; schema: string; name: string;
  kind: PostgresObjectKind; section: PostgresStructureSection; excerpt: string };
type SearchPage = { hits: PostgresSearchHit[]; has_next: boolean };

export function PostgresSearchDialog({ id, database, schema, onClose, onOpen }: {
  id: string; database: string; schema: { id: number; name: string } | null;
  onClose: () => void; onOpen: (hit: PostgresSearchHit) => void;
}) {
  const [scope, setScope] = useState<"database" | "schema">("database");
  const [kind, setKind] = useState<PostgresObjectKind | "">("");
  const [field, setField] = useState<SearchField>("name");
  const [term, setTerm] = useState("");
  const [input, setInput] = useState<SearchInput | null>(null);
  const args = useMemo(() => input ? { id, input } : null, [id, input]);
  const results = usePostgresRead<SearchPage>("search_postgres_objects", args);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = term.trim();
    if (!trimmed && !kind) return;
    setInput({ schema: scope === "schema" ? schema?.id ?? null : null,
      kind: kind || null, field: trimmed ? field : "name", term: trimmed, page: 0 });
  }

  return <Dialog title="PostgreSQL 객체 검색" className="postgres-search-dialog" onClose={onClose} busy={false}>
    <form onSubmit={submit}>
      <label className="field">검색 범위<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
        <option value="database">데이터베이스 전체 · {database}</option>
        {schema && <option value="schema">현재 스키마 · {schema.name}</option>}
      </select></label>
      <div className="postgres-search-fields">
        <label className="field">검색 기준<select value={field} onChange={event => setField(event.target.value as SearchField)}>
          <option value="name">객체 이름</option><option value="column">열 이름</option>
          <option value="comment">객체·열 주석</option><option value="definition">SQL 정의</option>
        </select></label>
        <label className="field">객체 종류<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
          <option value="">모든 종류</option>
          {Object.entries(postgresObjectLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </div>
      <div className="postgres-search-fields postgres-search-submit">
        <label className="field">검색어<input type="search" value={term} autoFocus maxLength={256} onChange={event => setTerm(event.target.value)} /></label>
        <button type="submit" className="primary" disabled={!term.trim() && !kind}>검색</button>
      </div>
    </form>
    <div className="postgres-object-results" aria-busy={results.loading}>
      {results.error && <p className="form-error" role="alert">{results.error}</p>}
      {results.loading && <p className="form-note" role="status">객체를 검색하는 중…</p>}
      {results.data && input && <>
        {results.data.hits.length > 0 ? <ul aria-label="일치하는 PostgreSQL 객체">
          {results.data.hits.map(hit => <li key={hit.id}>
            <button className="secondary" type="button" onClick={() => onOpen(hit)}>
              <strong>{hit.schema}.{hit.name}</strong>
              <small>{postgresObjectLabels[hit.kind]} · {postgresSectionLabels[hit.section]} 열기</small>
            </button>
            {input.field !== "name" && <p>{hit.excerpt}</p>}
          </li>)}
        </ul> : <p className="form-note" role="status">검색 조건에 맞는 객체가 없습니다.</p>}
      </>}
      {input && <PostgresPager label="검색 결과" page={input.page} next={results.data?.has_next ?? false}
        change={page => setInput({ ...input, page })} />}
    </div>
  </Dialog>;
}
