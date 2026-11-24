import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Match Vite's extensionless TypeScript resolution when using Node's built-in runner.
const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === "./editorSyntax" && context.parentURL?.endsWith("/src/sqlCompletion.ts") ? "./editorSyntax.ts" : specifier, context);
} });
const { sqlCompletionContext, sqlCompletionSuggestions, sqlDefinitionReference } = await import("../src/sqlCompletion.ts");
hooks.deregister();

function at(text) {
  const offset = text.indexOf("|");
  return sqlCompletionContext(text.replace("|", ""), offset);
}

const empty = { relations: [], columns: [], functions: [] };

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
