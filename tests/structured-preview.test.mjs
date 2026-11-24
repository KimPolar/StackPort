import { strict as assert } from "node:assert";
import { test } from "node:test";
import { encodeClipboardRows, formatStructuredPreview, parseClipboardRows, structuredFormat } from "../src/structuredFilePreview.ts";

test("parses tab-separated clipboard ranges with headers, blanks and quoted cells", () => {
  const source = '\uFEFFname\tnote\tcount\r\n"한\t글"\t"두\r\n줄 ""인용"""\t9007199254740993\r\n둘째\t\t0\r\n';
  assert.deepEqual(parseClipboardRows(source, true), {
    headers: ["name", "note", "count"], columnCount: 3,
    rows: [["한\t글", '두\r\n줄 "인용"', "9007199254740993"], ["둘째", "", "0"]],
  });
  assert.deepEqual(parseClipboardRows('""\n\n', false), { headers: null, columnCount: 1, rows: [[""], [""]] });
  assert.match(parseClipboardRows("a\tb\nshort", false).error, /2행/);
  assert.match(parseClipboardRows('"unfinished', false).error, /따옴표/);
  assert.match(parseClipboardRows("heads\n", true).error, /데이터 행/);
  assert.match(parseClipboardRows("row\n".repeat(101), false).error, /100행/);
  assert.match(parseClipboardRows("한".repeat(100_000), false).error, /256 KiB/);
});

test("round trips NULL, empty text, and quoted clipboard fields when enabled", () => {
  const values = ['탭\t줄\r\n"인용"', null, "", "\\N", "plain"];
  const rows = [values, ["둘째", "", null, "\\N", "last"]].map(row => row.map(value => ({ value, textual: true })));
  const encoded = encodeClipboardRows(rows, ["문장", "a", "b", "c", "d"], false);
  assert.equal(encoded.text, '문장\ta\tb\tc\td\n"탭\t줄\r\n""인용"""\t\\N\t""\t"\\N"\tplain\n둘째\t""\t\\N\t"\\N"\tlast');
  const decoded = parseClipboardRows(encoded.text, true, true);
  assert.deepEqual(decoded.rows, [values, ["둘째", "", null, "\\N", "last"]]);
  assert.deepEqual(decoded.quotedEmpty, [new Set([2]), new Set([1])]);
  assert.equal(parseClipboardRows(encoded.text, true).rows[0][1], "\\N");
  const bom = encodeClipboardRows([[{ value: "\uFEFF본문", textual: true }]], null, false);
  assert.deepEqual(parseClipboardRows(bom.text, false, true).rows, [["\uFEFF본문"]]);
});

test("clipboard protection prefixes formula-like text and headers while preserving numeric values", () => {
  const values = ["=1+1", "\uFEFF ＠A", "\t본문", "-12.000", "-12.000"];
  const rows = [values.map((value, index) => ({ value, textual: index !== 4 }))];
  const headers = ["+header", "b", "c", "d", "e"];
  const protectedRange = encodeClipboardRows(rows, headers, true);
  const decoded = parseClipboardRows(protectedRange.text, true, true);
  assert.equal(protectedRange.protectedFields, 5);
  assert.equal(decoded.headers[0], "'+header");
  assert.deepEqual(decoded.rows[0], ["'=1+1", "'\uFEFF ＠A", "'\t본문", "'-12.000", "-12.000"]);
  const exact = encodeClipboardRows(rows, headers, false);
  assert.equal(exact.protectedFields, 0);
  assert.deepEqual(parseClipboardRows(exact.text, true, true).rows[0], values);
});

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
