import assert from "node:assert/strict";
import { test } from "node:test";
import { duplicateConnectionName, duplicateProfileAction } from "../src/profileActions.ts";

test("copy names avoid case-insensitive collisions and preserve Unicode at the input limit", () => {
  assert.equal(duplicateConnectionName("Reports", ["reports 복사본", "REPORTS 복사본 2"]), "Reports 복사본 3");
  const source = "x".repeat(75) + "🚀🚀";
  const copy = duplicateConnectionName(source, []);
  assert.equal(copy, "x".repeat(75) + " 복사본");
  assert.ok(copy.length <= 80);
});

test("duplicate actions retain settings and only consider names in the source project", () => {
  const source = { project_id: "one", settings: { name: "운영", host: "reports.example", environment: "PROD" } };
  const action = duplicateProfileAction(source, [
    { project_id: "one", settings: { name: "운영 복사본" } },
    { project_id: "two", settings: { name: "운영 복사본 2" } },
  ]);
  assert.deepEqual(action, { kind: "duplicate", initial: { ...source.settings, name: "운영 복사본 2" } });
  action.initial.host = "staging.example";
  assert.equal(source.settings.host, "reports.example");
});
