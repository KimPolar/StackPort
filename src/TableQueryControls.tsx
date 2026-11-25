import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, SlidersHorizontal, X } from "lucide-react";
import { TableQueryPresetsDialog, type TableQueryTarget } from "./TableQueryPresetsDialog";

const operators = [
  ["eq", "같음"], ["ne", "다름"], ["lt", "미만"], ["le", "이하"],
  ["gt", "초과"], ["ge", "이상"], ["between", "범위"],
  ["contains", "포함"], ["is_null", "NULL"], ["is_not_null", "NULL 아님"],
] as const;
type Operator = (typeof operators)[number][0];
type Comparison = Exclude<Operator, "between" | "contains" | "is_null" | "is_not_null">;
type FilterValue = { kind: "text" | "date" | "integer" | "real"; value: string };
type Condition =
  | { kind: Comparison; value: FilterValue }
  | { kind: "between"; from: FilterValue; to: FilterValue }
  | { kind: "contains"; value: string }
  | { kind: "is_null" | "is_not_null" };
type Conjunction = "all" | "any";
type Sort = { column: string; direction: "asc" | "desc"; nulls: "default" | "first" | "last" };

export type TableQueryClauses = {
  conjunction: Conjunction;
  filters: { column: string; condition: Condition }[];
  sort: Sort[];
};
export type TableQuery = TableQueryClauses & { object: string };
type FilterDraft = { id: number; column: string; operator: Operator; kind: FilterValue["kind"]; value: string; to: string };
type SortDraft = Sort & { id: number };

export function defaultTableQuery(object: string): TableQuery {
  return { object, ...emptyTableQueryClauses };
}

export const emptyTableQueryClauses: TableQueryClauses = { conjunction: "all", filters: [], sort: [] };

function filterCondition(draft: FilterDraft): Condition {
  const { operator, kind, value, to } = draft;
  if (operator === "is_null" || operator === "is_not_null") return { kind: operator };
  if (operator === "contains") return { kind: operator, value };
  if (operator === "between") return { kind: operator, from: { kind, value }, to: { kind, value: to } };
  return { kind: operator, value: { kind, value } };
}

function filterDraft(id: number, column: string, condition: Condition): FilterDraft {
  const base = { id, column, operator: condition.kind, kind: "text" as const, value: "", to: "" };
  if (condition.kind === "between") return { ...base, kind: condition.from.kind, value: condition.from.value, to: condition.to.value };
  if (condition.kind === "contains") return { ...base, value: condition.value };
  if ("value" in condition) return { ...base, kind: condition.value.kind, value: condition.value.value };
  return base;
}

export function TableQueryControls({ columns, busy, apply, target, errorId }: {
  columns: string[];
  busy: boolean;
  apply: (query: TableQueryClauses) => void;
  target: TableQueryTarget;
  errorId?: string;
}) {
  const [conjunction, setConjunction] = useState<Conjunction>("all");
  const [filters, setFilters] = useState<FilterDraft[]>([]);
  const [sort, setSort] = useState<SortDraft[]>([]);
  const [presets, setPresets] = useState<{ target: TableQueryTarget; clauses: TableQueryClauses; valid: boolean } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const presetsButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLElement>(null);
  const id = useRef(0);
  const unusedSortColumn = columns.find(column => !sort.some(row => row.column === column));

  function addFilter() {
    const row: FilterDraft = { id: ++id.current, column: columns[0], operator: "eq", kind: "text", value: "", to: "" };
    setFilters(current => [...current, row]);
  }

  function addSort() {
    if (unusedSortColumn === undefined) return;
    const row: SortDraft = { id: ++id.current, column: unusedSortColumn, direction: "asc", nulls: "default" };
    setSort(current => [...current, row]);
  }

  function updateFilter(id: number, change: Partial<FilterDraft>) {
    setFilters(current => current.map(row => row.id === id ? { ...row, ...change } : row));
  }

  function updateSort(id: number, change: Partial<Sort>) {
    setSort(current => current.map(row => row.id === id ? { ...row, ...change } : row));
  }

  function moveSort(index: number, direction: -1 | 1) {
    setSort(current => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function reset() {
    setConjunction("all");
    setFilters([]);
    setSort([]);
    apply(emptyTableQueryClauses);
  }

  function draft(): TableQueryClauses {
    return {
      conjunction,
      filters: filters.map(row => ({ column: row.column, condition: filterCondition(row) })),
      sort: sort.map(({ column, direction, nulls }) => ({ column, direction, nulls })),
    };
  }

  function closePresets() {
    setPresets(null);
    requestAnimationFrame(() => {
      if (presetsButton.current && !presetsButton.current.disabled) presetsButton.current.focus();
      else summary.current?.focus();
    });
  }

  function applyPreset(clauses: TableQueryClauses) {
    setConjunction(clauses.conjunction);
    setFilters(clauses.filters.map(({ column, condition }) => filterDraft(++id.current, column, condition)));
    setSort(clauses.sort.map(item => ({ ...item, id: ++id.current })));
    closePresets();
    apply(clauses);
  }

  return <><details className="table-query-controls">
    <summary ref={summary}><SlidersHorizontal size={14} aria-hidden /> 필터 및 정렬</summary>
    <form ref={form} aria-describedby={errorId} onSubmit={event => {
      event.preventDefault();
      apply(draft());
    }}>
      <fieldset disabled={busy}>
        <legend>필터</legend>
        {filters.length > 1 && <label className="table-query-combine">일치 조건
          <select value={conjunction} onChange={event => setConjunction(event.target.value as Conjunction)}>
            <option value="all">모든 조건 (AND)</option>
            <option value="any">하나 이상의 조건 (OR)</option>
          </select>
        </label>}
        {filters.map((row, index) => {
          const label = `필터 ${index + 1}`;
          const hasValue = row.operator !== "is_null" && row.operator !== "is_not_null";
          return <div className="table-query-row" key={row.id}>
            <select aria-label={`${label} 열`} value={row.column} onChange={event => updateFilter(row.id, { column: event.target.value })}>
              {columns.map(column => <option key={column}>{column}</option>)}
            </select>
            <select aria-label={`${label} 연산자`} value={row.operator} onChange={event => updateFilter(row.id, { operator: event.target.value as Operator })}>
              {operators.map(([operator, name]) => <option key={operator} value={operator}>{name}</option>)}
            </select>
            {hasValue && row.operator !== "contains" && <select aria-label={`${label} 값 형식`} value={row.kind} onChange={event => updateFilter(row.id, { kind: event.target.value as FilterDraft["kind"] })}>
              <option value="text">{target.engine === "sqlite" ? "텍스트" : "열의 형식"}</option>
              {target.engine === "sqlite" && <>
                <option value="integer">정수</option>
                <option value="real">실수</option>
              </>}
              <option value="date">날짜 (YYYY-MM-DD)</option>
            </select>}
            {hasValue && <input type={row.kind === "date" && row.operator !== "contains" ? "date" : "text"} aria-label={`${label} 값`} placeholder={row.operator === "between" ? "시작 값" : "값"} value={row.value} maxLength={4096} required={row.kind !== "text" && row.operator !== "contains"} onChange={event => updateFilter(row.id, { value: event.target.value })} />}
            {row.operator === "between" && <input type={row.kind === "date" ? "date" : "text"} aria-label={`${label} 끝 값`} placeholder="끝 값" value={row.to} maxLength={4096} required={row.kind !== "text"} onChange={event => updateFilter(row.id, { to: event.target.value })} />}
            <button type="button" className="icon-button" aria-label={`${label} 삭제`} onClick={() => setFilters(current => current.filter(item => item.id !== row.id))}><X size={15} /></button>
          </div>;
        })}
        <button type="button" className="secondary small" disabled={!columns.length || filters.length >= 16} onClick={addFilter}><Plus size={14} /> 조건 추가</button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>정렬 <span className="subtle">위에서부터 적용</span></legend>
        {sort.map((row, index) => {
          const label = `정렬 ${index + 1}`;
          return <div className="table-query-row" key={row.id}>
            <select aria-label={`${label} 열`} value={row.column} onChange={event => updateSort(row.id, { column: event.target.value })}>
              {columns.map(column => <option key={column} disabled={column !== row.column && sort.some(item => item.column === column)}>{column}</option>)}
            </select>
            <select aria-label={`${label} 방향`} value={row.direction} onChange={event => updateSort(row.id, { direction: event.target.value as Sort["direction"] })}>
              <option value="asc">오름차순</option>
              <option value="desc">내림차순</option>
            </select>
            <select aria-label={`${label} NULL 순서`} value={row.nulls} onChange={event => updateSort(row.id, { nulls: event.target.value as Sort["nulls"] })}>
              <option value="default">NULL 기본 순서</option>
              <option value="first">NULL 먼저</option>
              <option value="last">NULL 나중에</option>
            </select>
            <button type="button" className="icon-button" disabled={!index} aria-label={`${label} 위로`} onClick={() => moveSort(index, -1)}><ChevronUp size={15} /></button>
            <button type="button" className="icon-button" disabled={index + 1 === sort.length} aria-label={`${label} 아래로`} onClick={() => moveSort(index, 1)}><ChevronDown size={15} /></button>
            <button type="button" className="icon-button" aria-label={`${label} 삭제`} onClick={() => setSort(current => current.filter(item => item.id !== row.id))}><X size={15} /></button>
          </div>;
        })}
        <button type="button" className="secondary small" disabled={unusedSortColumn === undefined || sort.length >= 8} onClick={addSort}><Plus size={14} /> 정렬 열 추가</button>
      </fieldset>
      <div className="table-query-actions">
        <button type="button" className="secondary small" ref={presetsButton} disabled={busy}
          onClick={() => setPresets({ target, clauses: draft(), valid: form.current?.checkValidity() ?? false })}>저장된 조건</button>
        <button type="button" className="secondary small" disabled={busy} onClick={reset}>초기화</button>
        <button type="submit" className="primary small" disabled={busy}>적용</button>
      </div>
    </form>
  </details>
    {presets && <TableQueryPresetsDialog target={presets.target} draft={presets.clauses} valid={presets.valid}
      columns={columns} onApply={applyPreset} onClose={closePresets} />}
  </>;
}
