import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gridDisplay, postgresGridValueType, readCellFormat, sqliteGridValueType } from "../src/gridValuePresentation.ts";

const number = digits => ({ kind: "number", digits });
const date = pattern => ({ kind: "date", pattern });

test("groups and rounds exact decimal text without converting the value to a number", () => {
  assert.equal(gridDisplay("9007199254740993.125", false, number(2)), "9,007,199,254,740,993.13");
  assert.equal(gridDisplay("-999.995", false, number(2)), "-1,000.00");
  assert.equal(gridDisplay("999.5", false, number(0)), "1,000");
  assert.equal(gridDisplay("-0.004", false, number(2)), "-0.00");
  assert.equal(gridDisplay("1.2300e+5", false, number(null)), "123,000");
  assert.equal(gridDisplay("-2.50e-3", false, number(null)), "-0.00250");
  assert.equal(gridDisplay("9007199254740993", false, number(2)), "9,007,199,254,740,993.00");
  for (const original of ["NULL", "NaN", "Infinity", "a17", "1e9999", ""]) {
    assert.equal(gridDisplay(original, false, number(2)), original);
  }
  assert.equal(gridDisplay("9007199254740993", true, number(2)), "9007199254740993");
});

test("reorders only a valid ISO calendar date and preserves the rest of the timestamp", () => {
  const source = "2024-02-29T23:45:01.123456+09:30";
  assert.equal(gridDisplay(source, false, date("day_first")), "29/02/2024T23:45:01.123456+09:30");
  assert.equal(gridDisplay(source, false, date("month_first")), "02/29/2024T23:45:01.123456+09:30");
  assert.equal(gridDisplay(source, false, date("korean")), "2024년 02월 29일T23:45:01.123456+09:30");
  assert.equal(gridDisplay("2026-01-02", false, date("year_first")), "2026/01/02");
  for (const original of ["1900-02-29", "2024-13-02", "2024-01-00", "infinity", "12.03.2026", "2026-01-02suffix", "1767360000"]) {
    assert.equal(gridDisplay(original, false, date("day_first")), original);
  }
  assert.equal(gridDisplay(source, true, date("day_first")), source);
});

test("reads older settings and classifies values using the engine's type information", () => {
  assert.deepEqual(readCellFormat(undefined), { kind: "raw" });
  assert.deepEqual(readCellFormat({ kind: "number", digits: 21 }), number(null));
  assert.deepEqual(readCellFormat({ kind: "number", digits: 0 }), number(0));
  assert.deepEqual(readCellFormat({ kind: "date", pattern: "toString" }), { kind: "raw" });
  assert.deepEqual(readCellFormat(date("korean")), date("korean"));
  assert.equal(postgresGridValueType("numeric(30,3)", false), "number");
  assert.equal(postgresGridValueType("timestamp(6) with time zone", false), "date");
  assert.equal(postgresGridValueType("boolean[]", false), "structured");
  assert.equal(postgresGridValueType("bytea", false), "binary");
  assert.equal(postgresGridValueType("integer", true), "null");
  assert.equal(sqliteGridValueType("integer", "BOOLEAN", "1"), "boolean");
  assert.equal(sqliteGridValueType("integer", "BOOLEAN", "99"), "number");
  assert.equal(sqliteGridValueType("integer", "DATETIME", "1767360000"), "number");
  assert.equal(sqliteGridValueType("text", "DATETIME", "2026-01-02"), "date");
  assert.equal(sqliteGridValueType("text", "TEXT", "2026-01-02"), "text");
  assert.equal(sqliteGridValueType("blob", "TEXT", "00ff"), "binary");
});
