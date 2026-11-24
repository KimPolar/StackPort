import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatStructuredPreview, structuredFormat } from "../src/structuredFilePreview.ts";

test("recognizes extensions and formats JSON without rounding values or dropping keys", () => {
  assert.equal(structuredFormat("한글.JSON"), "json");
  assert.equal(structuredFormat("json"), null);
  assert.equal(structuredFormat("x.json.txt"), null);
  const source = '{"x":90071992547409931234,"x":1.2300e+25,"nested":[{},"[quoted]\\n",{"escape":"\\u0001"}]}';
  const preview = formatStructuredPreview("json", source);
  assert.equal(preview.kind, "json");
  assert.equal(preview.text, '{\n  "x": 90071992547409931234,\n  "x": 1.2300e+25,\n  "nested": [\n    {},\n    "[quoted]\\n",\n    {\n      "escape": "\\u0001"\n    }\n  ]\n}');
  assert.ok("error" in formatStructuredPreview("json", "[0,]"));
  assert.ok("error" in formatStructuredPreview("json", "[".repeat(34) + "0" + "]".repeat(34)));
});

test("handles CSV commas, doubled quotes, embedded line endings and empty cells", () => {
  const source = '이름,"쉼표, 따옴표 ""값""",\r\n=1+1,"첫 줄\r\n둘째 줄",끝\n\n빈 값,';
  assert.deepEqual(formatStructuredPreview("csv", source), {
    kind: "csv", rowCount: 4, columnCount: 3,
    rows: [["이름", '쉼표, 따옴표 "값"', ""], ["=1+1", "첫 줄\r\n둘째 줄", "끝"], [""], ["빈 값", ""]],
  });
  assert.ok("error" in formatStructuredPreview("csv", 'a,"unterminated'));
  assert.ok("error" in formatStructuredPreview("csv", 'a,"closed"suffix'));
  assert.ok("error" in formatStructuredPreview("csv", 'bad"quote'));
});

test("counts the complete CSV while bounding rendered rows and columns", () => {
  const wide = Array.from({ length: 35 }, (_, index) => String(index)).join(",");
  const preview = formatStructuredPreview("csv", (wide + "\r\n").repeat(107));
  assert.equal(preview.kind, "csv");
  assert.equal(preview.rowCount, 107);
  assert.equal(preview.columnCount, 35);
  assert.equal(preview.rows.length, 100);
  assert.equal(preview.rows[0].length, 32);
});

test("rejects XML external declarations and unfinished comments before invoking a parser", () => {
  assert.match(formatStructuredPreview("xml", '<!DOCTYPE x SYSTEM "https://example.invalid/test"><x/>').error, /DTD/);
  assert.match(formatStructuredPreview("xml", '<?xml-stylesheet href="https://example.invalid/test"?><x/>').error, /처리 지시문/);
  assert.match(formatStructuredPreview("xml", "<!--".repeat(10_000)).error, /XML 형식/);
});
