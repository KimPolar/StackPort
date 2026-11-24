import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(["./sqlCompletion", "./editorSyntax"].includes(specifier) &&
    /\/src\/(sqlQueryBuilder|sqlCompletion)\.ts$/.test(context.parentURL ?? "") ? specifier + ".ts" : specifier, context);
} });
const { buildSqlQuery, emptyQuery, relationCandidates } = await import("../src/sqlQueryBuilder.ts");
hooks.deregister();

function source(id, name, names, keys = []) {
  return { id, details: { object: { name, kind: "table", ddl: null }, indexes: [],
    columns: names.map((name, position) => ({ position, name, hidden: 0, primary_key_position: position + 1 })),
    foreign_keys: keys.map((key, sequence) => ({ id: 0, sequence, ...key })) } };
}

test("preserves composite SQLite relationships in either direction, including implicit PK columns", () => {
  const parent = source(1, "Parent", ["id", "part"]);
  const child = source(2, "Child", ["parent_id", "parent_part"], [
    { target_table: "parent", from_column: "parent_id", to_column: null },
    { target_table: "PARENT", from_column: "parent_part", to_column: null },
  ]);
  assert.deepEqual(relationCandidates(parent, child), [[{ left: "id", right: "parent_id" }, { left: "part", right: "parent_part" }]]);
  assert.deepEqual(relationCandidates(child, parent), [[{ left: "parent_id", right: "id" }, { left: "parent_part", right: "part" }]]);
  assert.deepEqual(relationCandidates(source(3, "Parent", ["id"]), child), []);
});

test("builds quoted read-only queries with explicit bindings, grouping and ordering", () => {
  const base = source(1, '팀 "표"', ["id", '팀 "이름"']);
  const joined = { ...source(2, "members", ["id", "team"]), join: { from: 1, kind: "LEFT", pairs: [{ left: "id", right: "team" }] } };
  const team = { table: 1, column: '팀 "이름"' };
  const query = buildSqlQuery({ ...emptyQuery,
    sources: [base, joined],
    projections: [
      { id: 1, field: team, aggregate: "column", name: '이름 "표시"' },
      { id: 2, field: { table: 2, column: "id" }, aggregate: "COUNT", name: "명수" },
    ],
    filters: [
      { id: 1, field: { table: 1, column: "id" }, operator: ">=" },
      { id: 2, field: { table: 2, column: "id" }, operator: "IS NOT NULL" },
    ],
    groups: [{ id: 1, field: team }],
    having: [{ id: 1, projection: 2, operator: ">" }],
    order: [{ id: 1, projection: 2, direction: "DESC" }],
    limit: "2",
  });
  assert.equal(query.parameters, 2);
  assert.equal(query.sql, [
    'SELECT t1."팀 ""이름""" AS "이름 ""표시""", COUNT(t2."id") AS "명수"',
    'FROM main."팀 ""표""" AS t1',
    'LEFT JOIN main."members" AS t2\n  ON t1."id" = t2."team"',
    'WHERE t1."id" >= :where_1\n  AND t2."id" IS NOT NULL',
    'GROUP BY t1."팀 ""이름"""', 'HAVING COUNT(t2."id") > :having_1', 'ORDER BY COUNT(t2."id") DESC', 'LIMIT 2;',
  ].join("\n"));
});

test("rejects incomplete joins, bare aggregate projections, and invalid limits", () => {
  const base = source(1, "entries", ["id"]);
  const incomplete = { ...source(2, "other", ["key"]), join: { from: 1, kind: "INNER", pairs: [{ left: "id", right: null }] } };
  assert.match(buildSqlQuery({ ...emptyQuery, sources: [base, incomplete] }).error, /양쪽 열/);
  assert.match(buildSqlQuery({ ...emptyQuery, sources: [base], limit: "9223372036854775808" }).error, /LIMIT/);
  assert.match(buildSqlQuery({ ...emptyQuery, sources: [base], projections: [
    { id: 1, field: { table: 1, column: "id" }, aggregate: "column", name: "" },
    { id: 2, field: null, aggregate: "COUNT", name: "" },
  ] }).error, /GROUP BY/);
});
