import type { ObjectDetails } from "./SqlSchemaDetails";
import { sqliteNameKey } from "./sqlCompletion";

export type Field = { table: number; column: string };
export type JoinPair = { left: string | null; right: string | null };
export type Join = { from: number; kind: "INNER" | "LEFT"; pairs: JoinPair[] };
export type QuerySource = { id: number; details: ObjectDetails; join?: Join };
export const aggregates = ["column", "COUNT", "SUM", "AVG", "MIN", "MAX"] as const;
export type Aggregate = typeof aggregates[number];
export type Projection = { id: number; field: Field | null; aggregate: Aggregate; name: string };
export const comparisons = ["=", "<>", "<", "<=", ">", ">=", "LIKE", "IS NULL", "IS NOT NULL"] as const;
export type Comparison = typeof comparisons[number];
export type QueryStructure = {
  sources: QuerySource[];
  projections: Projection[];
  filters: { id: number; field: Field; operator: Comparison }[];
  conjunction: "AND" | "OR";
  groups: { id: number; field: Field }[];
  having: { id: number; projection: number; operator: Comparison }[];
  order: { id: number; projection: number; direction: "ASC" | "DESC" }[];
  limit: string;
};

export const emptyQuery: QueryStructure = { sources: [], projections: [], filters: [], conjunction: "AND",
  groups: [], having: [], order: [], limit: "" };
export const tableAlias = (id: number) => `t${id}`;
export const fieldKey = (field: Field) => JSON.stringify([field.table, field.column]);
export const sourceColumns = (source: QuerySource) => source.details.columns.filter(column => column.hidden !== 1);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function relationCandidates(left: QuerySource, right: QuerySource) {
  function from(source: QuerySource, target: QuerySource) {
    const grouped = new Map<number, JoinPair[]>();
    const invalid = new Set<number>();
    const sourceNames = new Map(sourceColumns(source).map(column => [sqliteNameKey(column.name), column.name]));
    const targetColumns = sourceColumns(target);
    const targetNames = new Map(targetColumns.map(column => [sqliteNameKey(column.name), column.name]));
    const targetName = sqliteNameKey(target.details.object.name);
    for (const key of [...source.details.foreign_keys].sort((a, b) => a.sequence - b.sequence)) {
      if (sqliteNameKey(key.target_table) !== targetName) continue;
      const from = sourceNames.get(sqliteNameKey(key.from_column));
      const to = key.to_column === null ? targetColumns.find(column => column.primary_key_position === key.sequence + 1)?.name
        : targetNames.get(sqliteNameKey(key.to_column));
      if (from === undefined || to === undefined) { invalid.add(key.id); continue; }
      const pairs = grouped.get(key.id) ?? [];
      pairs.push({ left: from, right: to });
      grouped.set(key.id, pairs);
    }
    return [...grouped.entries()].filter(([id]) => !invalid.has(id)).map(([, pairs]) => pairs);
  }
  const found = [...from(left, right), ...from(right, left).map(pairs => pairs.map(pair => ({ left: pair.right, right: pair.left })))];
  return [...new Map(found.map(pairs => [JSON.stringify(pairs), pairs])).values()];
}

export function buildSqlQuery(structure: QueryStructure): { sql: string; parameters: number } | { error: string } {
  const { sources, projections, filters, conjunction, groups, having, order, limit } = structure;
  if (!sources.length) return { error: "조회할 테이블 또는 뷰를 추가하세요." };
  const byId = new Map(sources.map(source => [source.id, source]));
  const columns = new Map(sources.map(source => [source.id, new Set(sourceColumns(source).map(column => column.name))]));
  function readField(field: Field) {
    return columns.get(field.table)?.has(field.column) ? `${tableAlias(field.table)}.${quote(field.column)}` : "";
  }
  function relation(source: QuerySource) {
    return `main.${quote(source.details.object.name)} AS ${tableAlias(source.id)}`;
  }
  let parameters = 0;
  function condition(expression: string, operator: Comparison, slot: string) {
    if (!comparisons.includes(operator) || !expression) return "";
    if (operator === "IS NULL" || operator === "IS NOT NULL") return `${expression} ${operator}`;
    parameters++;
    return `${expression} ${operator} :${slot}`;
  }

  const groupSql = new Set(groups.map(group => readField(group.field)));
  if (groupSql.has("")) return { error: "그룹 열을 다시 선택하세요." };
  const grouped = groups.length > 0 || projections.some(item => item.aggregate !== "column");
  if (grouped && !projections.length) return { error: "그룹 조회에 표시할 열을 추가하세요." };
  const expressions = new Map<number, string>();
  const projectionSql: string[] = [];
  for (const item of projections) {
    const field = item.field ? readField(item.field) : item.aggregate === "COUNT" ? "*" : "";
    if (!field || !aggregates.includes(item.aggregate)) return { error: "조회 열을 다시 선택하세요." };
    if (grouped && item.aggregate === "column" && !groupSql.has(field)) {
      return { error: "집계하지 않는 조회 열을 GROUP BY에 추가하세요." };
    }
    const alias = item.name.trim();
    if (alias.length > 100 || /[\x00-\x1f\x7f]/.test(alias)) return { error: "열 별칭을 확인하세요." };
    const expression = item.aggregate === "column" ? field : `${item.aggregate}(${field})`;
    expressions.set(item.id, expression);
    projectionSql.push(alias ? `${expression} AS ${quote(alias)}` : expression);
  }
  const lines = [`SELECT ${projectionSql.join(", ") || "*"}`, `FROM ${relation(sources[0])}`];
  const available = new Set([sources[0].id]);
  for (const source of sources.slice(1)) {
    const join = source.join;
    const left = join && available.has(join.from) ? byId.get(join.from) : undefined;
    if (!join || !left || !join.pairs.length || !["INNER", "LEFT"].includes(join.kind)) {
      return { error: "각 조인의 기준 테이블과 관계를 선택하세요." };
    }
    const pairs: string[] = [];
    for (const pair of join.pairs) {
      const a = pair.left === null ? "" : readField({ table: left.id, column: pair.left });
      const b = pair.right === null ? "" : readField({ table: source.id, column: pair.right });
      if (!a || !b) return { error: `${source.details.object.name} 조인의 양쪽 열을 선택하세요.` };
      pairs.push(`${a} = ${b}`);
    }
    lines.push(`${join.kind} JOIN ${relation(source)}\n  ON ${pairs.join("\n  AND ")}`);
    available.add(source.id);
  }
  if (filters.length) {
    const where = filters.map((item, index) => condition(readField(item.field), item.operator, `where_${index + 1}`));
    if (where.some(part => !part) || !["AND", "OR"].includes(conjunction)) return { error: "WHERE 조건을 확인하세요." };
    lines.push(`WHERE ${where.join(`\n  ${conjunction} `)}`);
  }
  if (groups.length) lines.push(`GROUP BY ${[...groupSql].join(", ")}`);
  if (having.length) {
    const aggregates = new Set(projections.filter(item => item.aggregate !== "column").map(item => item.id));
    const parts = having.map((item, index) => aggregates.has(item.projection)
      ? condition(expressions.get(item.projection) ?? "", item.operator, `having_${index + 1}`) : "");
    if (parts.some(part => !part)) return { error: "HAVING에 사용할 집계 열을 선택하세요." };
    lines.push(`HAVING ${parts.join("\n  AND ")}`);
  }
  if (order.length) {
    const parts = order.map(item => expressions.has(item.projection) && ["ASC", "DESC"].includes(item.direction)
      ? `${expressions.get(item.projection)} ${item.direction}` : "");
    if (parts.some(part => !part)) return { error: "정렬할 조회 열과 방향을 확인하세요." };
    lines.push(`ORDER BY ${parts.join(", ")}`);
  }
  if (limit.trim()) {
    const value = limit.trim();
    if (!/^\d{1,19}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
      return { error: "LIMIT에 0 이상의 64비트 정수를 입력하세요." };
    }
    lines.push(`LIMIT ${value}`);
  }
  if (parameters > 32) return { error: "매개변수가 필요한 조건은 최대 32개까지 사용할 수 있습니다." };
  return { sql: lines.join("\n") + ";", parameters };
}
