import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesNetworkAddress, networkAddressText, parseQuickTarget } from "../src/quickConnect.ts";

test("infers host protocols and keeps explicit schemes authoritative", () => {
  assert.deepEqual(parseQuickTarget("Staging_Box.example:2200"), { kind: "ssh", host: "staging_box.example", port: 2200, username: "" });
  assert.deepEqual(parseQuickTarget("op@192.0.2.1:3389"), { kind: "rdp", host: "192.0.2.1", port: 3389, username: "op" });
  assert.deepEqual(parseQuickTarget("ssh://op@192.0.2.1:3389"), { kind: "ssh", host: "192.0.2.1", port: 3389, username: "op" });
  assert.deepEqual(parseQuickTarget("postgresql://data%20user@db.example/store%2Farchive"), {
    kind: "postgres", host: "db.example", port: 5432, username: "data user", database: "store/archive",
  });
  assert.deepEqual(parseQuickTarget("db.example:5432"), { kind: "postgres", host: "db.example", port: 5432, username: "", database: "" });
});

test("accepts bracketed and bare IPv6 and matches equivalent saved addresses", () => {
  const target = parseQuickTarget("ssh://op@[0:0:0:0:0:ffff:192.0.2.1]:2222");
  assert.deepEqual(target, { kind: "ssh", host: "::ffff:c000:201", port: 2222, username: "op" });
  assert.equal(networkAddressText(target), "[::ffff:c000:201]:2222");
  assert.equal(matchesNetworkAddress(target, { host: "::ffff:192.0.2.1", port: 2222, username: "op" }), true);
  assert.equal(matchesNetworkAddress(target, { host: "::ffff:192.0.2.1", port: 2222, username: "other" }), false);
  assert.equal(matchesNetworkAddress(parseQuickTarget("example.com"), { host: "192.0.2.999", port: 22, username: "op" }), false);
  assert.equal(parseQuickTarget("2001:db8::2").port, 22);
  assert.equal(parseQuickTarget("rdp://[2001:db8::2]:4444").port, 4444);
});

test("reads SQLite paths with literal or escaped spaces", () => {
  assert.deepEqual(parseQuickTarget("D:\\My Data\\작업.sqlite"), { kind: "sqlite", path: "D:\\My Data\\작업.sqlite", name: "작업.sqlite" });
  assert.deepEqual(parseQuickTarget("sqlite:///D:/My%20Data/local.sqlite"), { kind: "sqlite", path: "D:\\My Data\\local.sqlite", name: "local.sqlite" });
  assert.deepEqual(parseQuickTarget("/data/local.db"), { kind: "sqlite", path: "/data/local.db", name: "local.db" });
});

test("rejects credential strings, unsupported options and malformed coordinates", () => {
  for (const input of ["postgres://user:secret@db.test/base", "ssh://user%3Asecret@host", "user:secret@host"]) {
    assert.throws(() => parseQuickTarget(input), error => /암호/.test(error.message) && !error.message.includes("secret"));
  }
  for (const input of ["https://host", "host:0", "host:65536", "127.1", "256.0.0.1", "[host]:22", "ssh://2001:db8::1",
    "rdp://host/path", "postgres://host/a/b", "postgres://host/base?sslmode=disable", "postgres://host/x%00",
    "sqlite://server/local.sqlite", "host\nother", "-user@host", "%20user@host"]) {
    assert.throws(() => parseQuickTarget(input), Error, input);
  }
});
