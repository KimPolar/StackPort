import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === "./editorSyntax" && context.parentURL?.endsWith("/src/sqlHistory.ts") ? "./editorSyntax.ts" : specifier, context);
} });
const { addSqlHistoryEntry, createSqlHistoryEntry, maskHistorySql, sqlHistorySource, sumHistoryCounts } = await import("../src/sqlHistory.ts");
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

test("masks network SQL using each dialect and supports retaining preview metadata only", () => {
  for (const [dialect, sql, hidden] of [
    ["postgres", "SELECT $private$literal-private$private$, E'escape\\'private' FROM account_private", /private|literal|escape/iu],
    ["mysql", "SELECT 'escape\\'private', `account_private` FROM db_private", /private|escape/iu],
    ["tsql", "SELECT N'literal-private', [account_private] FROM db_private", /private|literal/iu],
    ["oracle", "SELECT nq'[literal-private]', \"account_private\" FROM db_private", /private|literal/iu],
    ["snowflake", "SELECT $$literal-private;$$, \"account_private\" FROM db_private", /private|literal/iu],
  ]) {
    const result = createSqlHistoryEntry(1, "connection", "statement", sql, 5,
      { status: "completed", affectedRows: 2 }, dialect, false);
    assert.equal(result.sql, null);
    assert.equal(result.withheld, "masked_only");
    assert.doesNotMatch(result.masked, hidden);
    assert.match(result.masked, /^SELECT.*FROM/u);
    assert.equal(result.outcome.affectedRows, 2);
    assert.ok(maskHistorySql("SELECT 'word' FROM hidden; ".repeat(100), dialect).length <= 162);
  }
});

test("takes the executed UTF-8 scope and leaves unavailable counts unset", () => {
  const omitted = "SELECT '처음😀';\n";
  const executed = "SELECT '둘째';";
  const start = Buffer.byteLength(omitted);
  const end = start + Buffer.byteLength(executed);
  assert.equal(sqlHistorySource(omitted + executed, { start, end }), executed);
  assert.equal(sqlHistorySource(omitted + executed, { start: start - 4, end: start - 1 }), undefined);
  assert.equal(sqlHistorySource(omitted + executed), undefined);
  assert.equal(sumHistoryCounts([null, undefined]), undefined);
  assert.equal(sumHistoryCounts([null, 0]), 0);
  assert.equal(sumHistoryCounts([10, null, 2]), 12);
  assert.equal(sumHistoryCounts([Number.MAX_SAFE_INTEGER, 1]), undefined);
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
