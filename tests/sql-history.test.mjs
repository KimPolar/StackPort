import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === "./editorSyntax" && context.parentURL?.endsWith("/src/sqlHistory.ts") ? "./editorSyntax.ts" : specifier, context);
} });
const { addSqlHistoryEntry, createSqlHistoryEntry, maskHistorySql } = await import("../src/sqlHistory.ts");
hooks.deregister();

function entry(id, profile, sql = "SELECT 1", scope = "document") {
  return createSqlHistoryEntry(id, profile, scope, sql, 100, { status: "completed", displayedRows: 1, elapsedMs: 5 });
}

test("masked SQLite history hides literals, parameter names, identifiers, and comments", () => {
  const sql = "select 'literal😀 ; ''inside''', \"quoted-secret\", 1234, x'BEEF', :internalName, `privateName` from privateTable /* sensitive note */;";
  const masked = maskHistorySql(sql);
  assert.equal(masked, "SELECT … , … , … , … , … , … FROM … ;");
  assert.equal(maskHistorySql("SELECT 'unterminated secret"), "SELECT …");
  assert.equal(maskHistorySql("-- just a note ; 'hidden'"), "…");
  assert.equal(maskHistorySql("SELECT " + "a".repeat(7000)), "SELECT … …");
  assert.ok(maskHistorySql("SELECT " + "a, ".repeat(1000)).length <= 162);
  const record = entry(1, "a", sql, "selection");
  assert.equal(record.sql, sql);
  assert.equal(record.masked, masked);
  assert.equal(record.scope, "selection");
});

test("orders late completions and bounds history per connection", () => {
  let history = [];
  for (let id = 1; id <= 35; id++) history = addSqlHistoryEntry(history, entry(id, "a"));
  history = addSqlHistoryEntry(history, entry(36, "b"));
  history = addSqlHistoryEntry(history, entry(0, "a"));
  assert.equal(history.length, 31);
  assert.deepEqual(history.map(item => item.id), Array.from({ length: 31 }, (_, index) => 36 - index));
  assert.equal(history.filter(item => item.profileId === "b").length, 1);
});

test("bounds total entries and retained SQL independently of profile counts", () => {
  let history = [];
  for (let id = 1; id <= 130; id++) history = addSqlHistoryEntry(history, entry(id, String(id)));
  assert.equal(history.length, 120);
  const large = "s".repeat(64 * 1024);
  for (let id = 131; id <= 160; id++) history = addSqlHistoryEntry(history, entry(id, "a", large));
  assert.equal(history.length, 16);
  const oversized = entry(161, "a", large + "more");
  assert.equal(oversized.sql, null);
  assert.equal(addSqlHistoryEntry(history, oversized)[0], oversized);
});
