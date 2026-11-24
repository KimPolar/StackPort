import { X } from "lucide-react";
import { aggregates, comparisons, fieldKey, sourceColumns, tableAlias,
  type Aggregate, type Comparison, type Field, type Projection, type QuerySource, type QueryStructure } from "./sqlQueryBuilder";

function FieldControl({ label, sources, field, allowStar, change }: {
  label: string;
  sources: QuerySource[];
  field: Field | null;
  allowStar?: boolean;
  change: (field: Field | null) => void;
}) {
  return <select aria-label={label} value={field ? fieldKey(field) : ""} onChange={event => {
    const value = event.target.value;
    if (!value) { change(null); return; }
    const [table, column] = JSON.parse(value) as [number, string];
    change({ table, column });
  }}>
    {allowStar && <option value="">모든 행 (*)</option>}
    {sources.map(source => <optgroup key={source.id} label={`${tableAlias(source.id)} · ${source.details.object.name}`}>
      {sourceColumns(source).map(column => <option key={column.position} value={fieldKey({ table: source.id, column: column.name })}>{column.name}</option>)}
    </optgroup>)}
  </select>;
}

function ComparisonControl({ label, value, change }: { label: string; value: Comparison; change: (value: Comparison) => void }) {
  return <select aria-label={label} value={value} onChange={event => change(event.target.value as Comparison)}>
    {comparisons.map(operator => <option key={operator}>{operator}</option>)}
  </select>;
}

function Remove({ label, remove }: { label: string; remove: () => void }) {
  return <button type="button" className="icon-button" aria-label={`${label} 삭제`} onClick={remove}><X size={15} aria-hidden /></button>;
}

function projectionName(projection: Projection) {
  return projection.name.trim() || (projection.aggregate === "column" ? "" : projection.aggregate + " · ")
    + (projection.field ? `${tableAlias(projection.field.table)}.${projection.field.column}` : "*");
}

export function SqlBuilderClauses({ draft, change, nextId }: {
  draft: QueryStructure;
  change: (draft: QueryStructure) => void;
  nextId: () => number;
}) {
  const { sources, projections, filters, conjunction, groups, having, order, limit } = draft;
  const firstSource = sources.find(source => sourceColumns(source).length);
  const firstField = firstSource ? { table: firstSource.id, column: sourceColumns(firstSource)[0].name } : null;
  const aggregateFields = projections.filter(item => item.aggregate !== "column");
  const groupKeys = new Set(groups.map(item => fieldKey(item.field)));
  const nextGroup = sources.flatMap(source => sourceColumns(source).map(column => ({ table: source.id, column: column.name })))
    .find(field => !groupKeys.has(fieldKey(field)));
  function changeProjection(id: number, update: Partial<Projection>) {
    change({ ...draft, projections: projections.map(item => item.id === id ? { ...item, ...update } : item),
      having: update.aggregate === "column" ? having.filter(item => item.projection !== id) : having });
  }
  const projectedChoices = (items: Projection[]) => items.map(item => <option key={item.id} value={item.id}>{projectionName(item)}</option>);

  return <div className="sql-builder-clauses">
    <details open>
      <summary>조회 열</summary>
      <div className="sql-builder-rows">
        {!projections.length && <p className="form-note">조회 열을 추가하면 표시할 열과 집계를 정할 수 있습니다.</p>}
        {projections.map((item, index) => {
          const label = `조회 열 ${index + 1}`;
          return <div className="sql-builder-row" key={item.id}>
            <select aria-label={`${label} 함수`} value={item.aggregate} onChange={event => {
              const aggregate = event.target.value as Aggregate;
              changeProjection(item.id, { aggregate, field: aggregate === "COUNT" ? item.field : item.field ?? firstField });
            }}>{aggregates.map(aggregate => <option key={aggregate} value={aggregate}>{aggregate === "column" ? "그대로 표시" : aggregate}</option>)}</select>
            <FieldControl label={`${label} 원본`} sources={sources} field={item.field} allowStar={item.aggregate === "COUNT"}
              change={field => changeProjection(item.id, { field })} />
            <input aria-label={`${label} 별칭`} placeholder="별칭" maxLength={100} value={item.name}
              onChange={event => changeProjection(item.id, { name: event.target.value })} />
            <Remove label={label} remove={() => change({ ...draft, projections: projections.filter(row => row.id !== item.id),
              having: having.filter(row => row.projection !== item.id), order: order.filter(row => row.projection !== item.id) })} />
          </div>;
        })}
        <button type="button" className="secondary small" disabled={!firstField || projections.length >= 16} onClick={() => {
          if (firstField) change({ ...draft, projections: [...projections, { id: nextId(), name: "", aggregate: "column", field: firstField }] });
        }}>조회 열 추가</button>
      </div>
    </details>
    <details>
      <summary>WHERE</summary>
      <div className="sql-builder-rows">
        {filters.length > 1 && <label className="sql-builder-inline">조건 연결
          <select value={conjunction} onChange={event => change({ ...draft, conjunction: event.target.value as QueryStructure["conjunction"] })}>
            <option>AND</option><option>OR</option>
          </select>
        </label>}
        {filters.map((item, index) => {
          const label = `WHERE ${index + 1}`;
          return <div key={item.id} className="sql-builder-row">
            <FieldControl label={`${label} 열`} sources={sources} field={item.field}
              change={field => { if (field) change({ ...draft, filters: filters.map(row => row.id === item.id ? { ...row, field } : row) }); }} />
            <ComparisonControl label={`${label} 연산자`} value={item.operator} change={operator =>
              change({ ...draft, filters: filters.map(row => row.id === item.id ? { ...row, operator } : row) })} />
            {!item.operator.startsWith("IS ") && <code>:where_{index + 1}</code>}
            <Remove label={label} remove={() => change({ ...draft, filters: filters.filter(row => row.id !== item.id) })} />
          </div>;
        })}
        <button type="button" className="secondary small" disabled={!firstField || filters.length >= 16} onClick={() => {
          if (firstField) change({ ...draft, filters: [...filters, { id: nextId(), field: firstField, operator: "=" }] });
        }}>WHERE 조건 추가</button>
      </div>
    </details>
    <details>
      <summary>GROUP BY와 HAVING</summary>
      <div className="sql-builder-rows">
        {groups.map((item, index) => {
          const label = `GROUP BY ${index + 1}`;
          return <div key={item.id} className="sql-builder-row">
            <FieldControl label={`${label} 열`} sources={sources} field={item.field}
              change={field => { if (field) change({ ...draft, groups: groups.map(row => row.id === item.id ? { ...row, field } : row) }); }} />
            <Remove label={label} remove={() => change({ ...draft, groups: groups.filter(row => row.id !== item.id) })} />
          </div>;
        })}
        <button type="button" className="secondary small" disabled={!nextGroup || groups.length >= 16} onClick={() => {
          if (nextGroup) change({ ...draft, groups: [...groups, { id: nextId(), field: nextGroup }] });
        }}>그룹 열 추가</button>
        {having.map((item, index) => {
          const label = `HAVING ${index + 1}`;
          return <div key={item.id} className="sql-builder-row">
            <select aria-label={`${label} 집계 열`} value={item.projection} onChange={event =>
              change({ ...draft, having: having.map(row => row.id === item.id ? { ...row, projection: Number(event.target.value) } : row) })}>
              {projectedChoices(aggregateFields)}
            </select>
            <ComparisonControl label={`${label} 연산자`} value={item.operator} change={operator =>
              change({ ...draft, having: having.map(row => row.id === item.id ? { ...row, operator } : row) })} />
            {!item.operator.startsWith("IS ") && <code>:having_{index + 1}</code>}
            <Remove label={label} remove={() => change({ ...draft, having: having.filter(row => row.id !== item.id) })} />
          </div>;
        })}
        <button type="button" className="secondary small" disabled={!aggregateFields.length || having.length >= 16}
          onClick={() => change({ ...draft, having: [...having, { id: nextId(), projection: aggregateFields[0].id, operator: ">=" }] })}>HAVING 조건 추가</button>
      </div>
    </details>
    <details>
      <summary>ORDER BY와 LIMIT</summary>
      <div className="sql-builder-rows">
        {order.map((item, index) => {
          const label = `ORDER BY ${index + 1}`;
          return <div key={item.id} className="sql-builder-row">
            <select aria-label={`${label} 열`} value={item.projection} onChange={event =>
              change({ ...draft, order: order.map(row => row.id === item.id ? { ...row, projection: Number(event.target.value) } : row) })}>
              {projectedChoices(projections)}
            </select>
            <select aria-label={`${label} 방향`} value={item.direction} onChange={event =>
              change({ ...draft, order: order.map(row => row.id === item.id ? { ...row, direction: event.target.value as "ASC" | "DESC" } : row) })}>
              <option value="ASC">오름차순</option><option value="DESC">내림차순</option>
            </select>
            <Remove label={label} remove={() => change({ ...draft, order: order.filter(row => row.id !== item.id) })} />
          </div>;
        })}
        <button type="button" className="secondary small" disabled={!projections.length || order.length >= 8}
          onClick={() => change({ ...draft, order: [...order, { id: nextId(), projection: projections[0].id, direction: "ASC" }] })}>정렬 열 추가</button>
        <label className="sql-builder-inline">LIMIT
          <input value={limit} maxLength={19} inputMode="numeric" onChange={event => change({ ...draft, limit: event.target.value })} />
        </label>
      </div>
    </details>
  </div>;
}
