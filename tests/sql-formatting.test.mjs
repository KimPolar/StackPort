import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === "./editorSyntax" && context.parentURL?.endsWith("/src/sqlFormatting.ts") ? "./editorSyntax.ts" : specifier, context);
} });
const { formatSql } = await import("../src/sqlFormatting.ts");
hooks.deregister();

const options = { keywordCase: "upper", indent: "4", blankLines: 2 };
function format(source, changes = {}) {
  return formatSql({ source, start: 0, end: source.length, mode: "pretty", options, ...changes });
}

test("formats SQLite statements with the requested casing, indentation and blank lines", () => {
  const source = "select  id,  name from people where id >= :value;\nselect '한😀  그대로';";
  assert.deepEqual(format(source), { text: "SELECT\n    id,\n    name\nFROM\n    people\nWHERE\n    id >= :value;\n\n\nSELECT\n    '한😀  그대로';" });
  assert.deepEqual(format("SELECT 1; SELECT 2;", { options: { keywordCase: "lower", indent: "tabs", blankLines: 0 } }), {
    text: "select\n\t1;\nselect\n\t2;",
  });
});

test("preserves literals, comments, parameters and contextual names while formatting", () => {
  const source = "select x'AaFf', 'i''m  here', [a b], :value  -- keep  \n from t;";
  assert.deepEqual(format(source), { text: "SELECT\n    x'AaFf',\n    'i''m  here',\n    [a b],\n    :value -- keep  \nFROM\n    t;" });
  const aliases = format("select 1 as Desc, 2 as window, $scope::key(a;b);").text;
  assert.match(aliases, /1 AS Desc,\s+2 AS\s+window\s*,\s+\$scope::key\(a;b\);/);
});

test("compacts only gaps outside tokens and preserves line-comment boundaries", () => {
  const source = "select   -- keep  \n    x'0a', [이름], $p::a(x;y)  from  t where a - - 1 = ?12 and __a b = 2;\n";
  assert.deepEqual(format(source, { mode: "compact" }), {
    text: "select -- keep  \nx'0a', [이름], $p::a(x;y) from t where a - - 1 = ?12 and __a b = 2;\n",
  });
});

test("edits the requested range and rejects a selection that cuts through a token", () => {
  const source = "select 1;\n\n  select   null;  \nselect 3;";
  assert.deepEqual(format(source, { start: 11, end: source.lastIndexOf("select"), mode: "compact" }), {
    text: "  select null;  \n",
  });
  const start = source.indexOf("null") + 1;
  assert.match(format(source, { start, end: start + 2 }).error, /잘린 SQL 토큰/);
  assert.match(format("한".repeat(90_000)).error, /256 KiB/);
});
