import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Match Vite's extensionless TypeScript resolution when using Node's built-in runner.
const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === "./editorSyntax" && context.parentURL?.endsWith("/src/sqlCompletion.ts") ? "./editorSyntax.ts" : specifier, context);
} });
const { proposeSqlAliasRename, sqlAliasRenameTarget, sqlCompletionContext, sqlCompletionSuggestions, sqlDefinitionReference } = await import("../src/sqlCompletion.ts");
hooks.deregister();

function at(text) {
  const offset = text.indexOf("|");
  return sqlCompletionContext(text.replace("|", ""), offset);
}

const empty = { relations: [], columns: [], functions: [] };

test("renames resolved table aliases across correlated subqueries without changing shadowed names", () => {
  const sql = "SELECT P.id, 'p.id' AS note FROM main.people p "
    + "WHERE EXISTS (SELECT p.id FROM people p) "
    + "AND EXISTS (SELECT 1 FROM people q WHERE q.id = p.id); -- p.id\nSELECT p.id FROM people p;";
  const target = sqlAliasRenameTarget(sql, sql.indexOf("P.id") + 1);
  assert.equal(target.alias, "p");
  assert.equal(target.occurrences.length, 3);
  assert.match(proposeSqlAliasRename(sql, target, "Q").error, /다른 테이블이나 별칭/);
  const edit = proposeSqlAliasRename(sql, target, "한 팀");
  assert.equal(edit.text, 'SELECT "한 팀".id, \'p.id\' AS note FROM main.people "한 팀" '
    + 'WHERE EXISTS (SELECT p.id FROM people p) '
    + 'AND EXISTS (SELECT 1 FROM people q WHERE q.id = "한 팀".id)');
  assert.equal(sql.slice(target.statement.end), "; -- p.id\nSELECT p.id FROM people p;");
});

test("handles aliases of CTEs and derived tables, and rejects newly captured outer references", () => {
  const sql = "WITH c AS (SELECT id FROM people) SELECT d.id FROM (SELECT c.id FROM c) AS d "
    + "WHERE EXISTS (SELECT q.id FROM c q WHERE q.id = d.id)";
  const target = sqlAliasRenameTarget(sql, sql.indexOf("AS d") + 4);
  assert.equal(target.alias, "d");
  assert.equal(target.occurrences.length, 3);
  assert.match(proposeSqlAliasRename(sql, target, "q").error, /참조가 바뀝니다/);

  const outer = "SELECT p.id FROM people p WHERE EXISTS (SELECT q.id FROM people q WHERE q.id = p.id)";
  const inner = sqlAliasRenameTarget(outer, outer.lastIndexOf("q.id") + 1);
  assert.equal(inner.alias, "q");
  assert.match(proposeSqlAliasRename(outer, inner, "p").error, /참조가 바뀝니다/);
  assert.equal(sqlAliasRenameTarget("SELECT p.id FROM people p UNION SELECT 1", 8), null);
  assert.equal(sqlAliasRenameTarget("SELECT p.id FROM people p WHERE (", 8), null);
});

test("resolves SQLite quoted aliases and skips schema-qualified table names", () => {
  const sql = "SELECT 'main'.id, [main].note, main.main.id FROM main.people AS 'main'";
  const target = sqlAliasRenameTarget(sql, sql.indexOf("'main'") + 3);
  assert.equal(target.occurrences.length, 4);
  assert.equal(proposeSqlAliasRename(sql, target, 'by"team').text,
    'SELECT "by""team".id, "by""team".note, main."by""team".id FROM main.people AS "by""team"');
});

test("finds the active statement, active query scope and names declared after the cursor", () => {
  const result = at("SELECT unrelated FROM prior; SELECT p.na| FROM main.people AS p WHERE EXISTS (SELECT 1 FROM hidden h)");
  assert.equal(result.mode, "column");
  assert.equal(result.prefix, "na");
  assert.deepEqual(result.sources, [{ name: "people", qualifier: "p" }]);
  const inner = at("SELECT * FROM outer_table o WHERE EXISTS (SELECT i.na| FROM inner_table i WHERE i.id = o.id)");
  assert.deepEqual(inner.sources, [{ name: "inner_table", qualifier: "i" }]);
  const func = at("SELECT coalesce(p.na|) FROM people p");
  assert.deepEqual(func.sources, [{ name: "people", qualifier: "p" }]);
  assert.equal(at("SELECT 'p.n|a' FROM people p"), null);
  assert.equal(at("SELECT 1 -- p.n|a\nFROM people p"), null);
});

test("uses main schema relations and quotes special identifiers", () => {
  const relation = at("SELECT * FROM main.we|b");
  assert.equal(relation.mode, "relation");
  assert.equal(relation.schemaQualified, true);
  assert.equal(relation.end - relation.start, 3);
  const suggestions = sqlCompletionSuggestions(relation, { ...empty, relations: [{ name: 'web "view"', kind: "view" }] });
  assert.equal(suggestions[0].insert, '"web ""view"""');
  assert.equal(at("SELECT * FROM people p, ord|").mode, "relation");
  const cte = at("WITH people AS (SELECT 1 AS id) SELECT p.| FROM people p");
  assert.deepEqual(cte.sources, []);
  assert.deepEqual(cte.localRelations, ["people"]);
});

test("qualifies duplicate columns and inserts functions without doubling parentheses", () => {
  const names = { ...empty, columns: [{ relation: "people", names: ["id"] }, { relation: "orders", names: ["id"] }] };
  const result = sqlCompletionSuggestions(at("SELECT i| FROM people p JOIN orders o ON p.id = o.id"), names);
  assert.deepEqual(result.filter(item => item.label === "id").map(item => item.insert), ["p.id", "o.id"]);
  const funcs = { ...empty, functions: ["count"] };
  assert.equal(sqlCompletionSuggestions(at("select cou|"), funcs).at(-1).insert, "count()");
  assert.equal(sqlCompletionSuggestions(at("select co|unt ("), funcs).at(-1).insert, "count");
});

function definition(text) {
  return sqlDefinitionReference(text.replace("|", ""), text.indexOf("|"));
}

test("finds a column's owner and references without including strings or a nested alias", () => {
  const text = "SELECT p.na|me FROM main.PEOPLE p WHERE p.name = 'p.name' AND EXISTS (SELECT 1 FROM other p WHERE p.name IS NOT NULL)";
  const source = text.replace("|", "");
  const result = definition(text);
  assert.equal(result.column, "name");
  assert.equal(result.sources[0].name, "PEOPLE");
  assert.deepEqual(result.sources[0].uses.map(item => item.start), [source.indexOf("p.name") + 2, source.indexOf("p.name =") + 2]);
  const unqualified = definition("SELECT na|me FROM people WHERE name IS NOT NULL");
  assert.equal(unqualified.sources[0].uses.length, 2);
});

test("maps table declarations and aliases, and skips locally shadowed or unsupported symbols", () => {
  const text = 'SELECT p.name FROM "odd| name" AS p; SELECT p.name FROM people p';
  const source = text.replace("|", "");
  const result = definition(text);
  assert.equal(result.column, null);
  assert.equal(result.sources[0].name, "odd name");
  assert.deepEqual(result.sources[0].uses.map(item => source.slice(item.start, item.end)), ["p", '"odd name"', "p"]);
  assert.equal(definition("WITH people AS (SELECT 1 AS id) SELECT p.i|d FROM people p"), null);
  assert.equal(definition("SELECT 'p.na|me' FROM people p"), null);
  assert.equal(definition("SELECT co|unt(*) FROM people"), null);
  assert.equal(definition("SELECT 1 AS id FROM people ORDER BY i|d"), null);
  assert.equal(definition("SELECT na|me FROM people JOIN (SELECT name FROM other) t"), null);
});
