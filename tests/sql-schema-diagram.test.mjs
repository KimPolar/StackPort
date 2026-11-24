import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(["./sqlCompletion", "./editorSyntax"].includes(specifier) &&
    /\/src\/(sqlSchemaDiagram|sqlCompletion)\.ts$/.test(context.parentURL ?? "") ? specifier + ".ts" : specifier, context);
} });
const { indexSchemaDiagram, layoutSchemaDiagram } = await import("../src/sqlSchemaDiagram.ts");
hooks.deregister();

const column = (name, primary_key_position = 0) => ({ name, primary_key_position, declared_type: "TEXT" });
const key = (id, sequence, target_table, from_column, to_column = null) => ({
  id, sequence, target_table, from_column, to_column, on_update: "NO ACTION", on_delete: "CASCADE",
});

test("orders implicit composite keys by PK position and identifies unresolved definitions", () => {
  const parent = { name: "Parent", columns: [column("rev", 2), column("code", 1)], foreign_keys: [] };
  const child = { name: "child", columns: [column("ref_code"), column("ref_rev")], foreign_keys: [
    key(0, 1, "PARENT", "ref_rev"), key(0, 0, "PARENT", "REF_CODE"),
    key(1, 0, "Parent", "ref_code"),
    key(2, 0, "Parent", "ref_rev", "missing"),
    key(3, 0, "unknown", "ref_rev", "id"),
  ] };
  const index = indexSchemaDiagram([parent, child]);
  const [composite, wrongSize, invalidColumn, missingTable] = index.relationships.get("child");
  assert.equal(composite.target, "Parent");
  assert.equal(composite.issue, null);
  assert.deepEqual(composite.fields, [{ source: "ref_code", target: "code" }, { source: "ref_rev", target: "rev" }]);
  assert.equal(wrongSize.issue, "missing_columns");
  assert.equal(invalidColumn.issue, "missing_columns");
  assert.equal(missingTable.issue, "missing_table");
  assert.equal(index.relationships.get("Parent").length, 3);
});

test("places outgoing, incoming, reciprocal and self relationships", () => {
  const a = { name: "a", columns: [column("id", 1)], foreign_keys: [
    key(0, 0, "b", "id"), key(1, 0, "a", "id"), key(2, 0, "missing", "id"),
  ] };
  const b = { name: "b", columns: [column("id", 1)], foreign_keys: [key(0, 0, "a", "id")] };
  const c = { name: "c", columns: [column("id", 1)], foreign_keys: [key(0, 0, "a", "id")] };
  const index = indexSchemaDiagram([a, b, c]);
  const layout = layoutSchemaDiagram("a", index.relationships.get("a"));
  const [incoming, reciprocal, dangling] = layout.neighbors;
  assert.ok(incoming.x < layout.center.x);
  assert.equal(incoming.name, "c");
  assert.ok(reciprocal.x > layout.center.x);
  assert.equal(reciprocal.name, "b");
  assert.equal(reciprocal.reverse, true);
  assert.equal(dangling.missing, true);
  assert.ok(layout.loop);
  assert.equal(layoutSchemaDiagram("isolated", []).neighbors.length, 0);
});
