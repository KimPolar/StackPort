import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compareResultPages, resultPageBytes } from "../src/sqlResults.ts";

const cell = (display, kind = "text", truncated = false) => ({ display, kind, truncated });
const page = (columns, rows, number = 0) => ({ columns, rows, page: number, has_more: false });

test("compares cells by position and preserves SQLite value type", () => {
  const previous = page(["id", "value"], [[cell("1", "integer"), cell("same")], [cell("2", "integer"), cell("old")]]);
  const current = page(["id", "value"], [[cell("1"), cell("same")], [cell("2", "integer"), cell("new")], [cell("3", "integer"), cell("added")]]);
  const result = compareResultPages(previous, current);
  assert.equal(result.kind, "rows");
  assert.equal(result.changed, 2);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 0);
  assert.deepEqual(result.differences.map(item => [item.kind, item.row]), [["cell", 0], ["cell", 1], ["row", 2]]);
  assert.equal(compareResultPages(current, previous).removed, 1);
  assert.ok(resultPageBytes(current) > resultPageBytes(previous));
});

test("keeps page numbers and column order in the comparison", () => {
  assert.equal(compareResultPages(page(["a"], []), page(["a"], [], 1)).kind, "different_page");
  assert.deepEqual(compareResultPages(page(["id", "name"], []), page(["name", "id", ""], [])), {
    kind: "columns",
    total: 3,
    columns: [
      { index: 0, before: "id", after: "name" },
      { index: 1, before: "name", after: "id" },
      { index: 2, before: undefined, after: "" },
    ],
  });
});

test("same-size blobs and incomplete previews are inconclusive", () => {
  const columns = ["blob", "preview", "lossy", "complete"];
  const first = [cell("[BLOB · 2 bytes]", "blob"), cell("prefix", "text", true), cell("a\uFFFD"), cell("complete")];
  const second = [cell("[BLOB · 2 bytes]", "blob"), cell("prefix", "text", true), cell("a\uFFFD"), cell("complete")];
  const diff = compareResultPages(page(columns, [first]), page(columns, [second]));
  assert.equal(diff.changed, 0);
  assert.equal(diff.uncertain, 3);
  const changed = [cell("[BLOB · 3 bytes]", "blob"), cell("prefix"), cell("a\uFFFD"), cell("complete")];
  const known = compareResultPages(page(columns, [first]), page(columns, [changed]));
  assert.equal(known.changed, 2);
  assert.equal(known.uncertain, 1);
});

test("counts all differences while limiting displayed entries", () => {
  const columns = Array.from({ length: 201 }, (_, index) => String(index));
  const previous = page(columns, [columns.map(() => cell("a"))]);
  const current = page(columns, [columns.map(() => cell("b"))]);
  const diff = compareResultPages(previous, current);
  assert.equal(diff.changed, 201);
  assert.equal(diff.differences.length, 200);
});
