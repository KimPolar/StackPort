import { strict as assert } from "node:assert";
import { test } from "node:test";
import { editorLanguageForFile, editorSyntaxLine, editorSyntaxTokens } from "../src/editorSyntax.ts";

function marked(text, language) {
  return editorSyntaxTokens(text, language).map(token => [token.kind, text.slice(token.start, token.end)]);
}

test("colors SQLite terms without mistaking quoted tokens for SQL keywords", () => {
  const sql = "select FROM_thing, \"FROM\", [select], `table`, '한😀 ''FROM''', x'ff', :한글, ?12, 0xFF, 1_000.5e-2 -- NULL\n/* CREATE\nSELECT */";
  assert.deepEqual(marked(sql, "sqlite"), [
    ["keyword", "select"], ["identifier", '"FROM"'], ["identifier", "[select]"], ["identifier", "`table`"],
    ["string", "'한😀 ''FROM'''"], ["string", "x'ff'"], ["parameter", ":한글"], ["parameter", "?12"],
    ["number", "0xFF"], ["number", "1_000.5e-2"], ["comment", "-- NULL"], ["comment", "/* CREATE\nSELECT */"],
  ]);
  assert.deepEqual(marked("select /* unfinished", "sqlite"), [["keyword", "select"], ["comment", "/* unfinished"]]);
});

test("distinguishes JSON properties and treats XML markup as text ranges", () => {
  assert.equal(editorLanguageForFile("설정.JSON"), "json");
  assert.equal(editorLanguageForFile("쿼리.sql"), "sqlite");
  assert.equal(editorLanguageForFile("파일.sql.txt"), undefined);
  assert.deepEqual(marked('{"키😀" \n: [true, null, -1.2300e+6, "a\\\"b"]}', "json"), [
    ["property", '"키😀"'], ["keyword", "true"], ["keyword", "null"], ["number", "-1.2300e+6"], ["string", '"a\\\"b"'],
  ]);
  assert.deepEqual(marked('<root a="1>0">&amp;<!-- x --><![CDATA[<node/>]]></root>', "xml"), [
    ["tag", '<root a="1>0">'], ["string", "&amp;"], ["comment", "<!-- x -->"], ["string", "<![CDATA[<node/>]]>"], ["tag", "</root>"],
  ]);
});

test("clips multiline tokens to the visible line and falls back at rendering limits", () => {
  const text = "/* 첫 줄\n둘😀째 */ SELECT 12";
  const tokens = editorSyntaxTokens(text, "sqlite");
  const start = text.indexOf("\n") + 1;
  assert.deepEqual(editorSyntaxLine(text, tokens, start, text.length), [
    { text: "둘😀째 */", kind: "comment" }, { text: " " }, { text: "SELECT", kind: "keyword" }, { text: " " }, { text: "12", kind: "number" },
  ]);
  assert.equal(editorSyntaxTokens("a".repeat(512 * 1024 + 1), "sqlite"), null);
  assert.equal(editorSyntaxTokens("1,".repeat(40_001), "json"), null);
  const denseLine = "1,".repeat(300);
  const parts = editorSyntaxLine(denseLine, editorSyntaxTokens(denseLine, "json"), 0, denseLine.length);
  assert.equal(parts.filter(part => part.kind).length, 240);
  assert.equal(parts.map(part => part.text).join(""), denseLine);
});
