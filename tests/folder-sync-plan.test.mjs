import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildFolderSyncPlan, parseSyncPatterns } from "../src/folderSyncPlan.ts";

function entry(name, kind = "file") {
  return { name, kind, location: name, size: kind === "file" ? "4" : null, name_is_lossy: false };
}

function only(path, side, kind = "file", props = {}) {
  return { name: path, local: [], remote: [], relation: side, [side]: [entry(path, kind)], ...props };
}

function shared(path, relation = "same", kind = "file", props = {}) {
  return { name: path, local: [entry(path, kind)], remote: [entry(path, kind)], relation, ...props };
}

function plan(rows, options = {}, content = new Map()) {
  const items = buildFolderSyncPlan(rows, content, { direction: "upload", mirrorDeletes: false, patterns: [], recursive: true,
    windowsLocal: true, ...options });
  return new Map(items.map(item => [item.path, [item.action, item.target]]));
}

test("plans both directions and distinguishes SHA-256 from metadata", () => {
  const rows = [only("자료", "local", "directory"), only("자료/새 파일", "local"), only("원격 파일", "remote"),
    shared("해시 변경"), shared("속성 일치"), shared("해시 일치", "difference")];
  const content = new Map([["해시 변경", { matches: false }], ["해시 일치", { matches: true }]]);
  const up = plan(rows, {}, content);
  assert.deepEqual(up.get("자료"), ["mkdir", "remote"]);
  assert.deepEqual(up.get("자료/새 파일"), ["copy", "remote"]);
  assert.deepEqual(up.get("원격 파일"), ["keep", "remote"]);
  assert.deepEqual(up.get("해시 변경"), ["update", "remote"]);
  assert.deepEqual(up.get("속성 일치"), ["verify", undefined]);
  assert.equal(up.has("해시 일치"), false);
  const down = plan(rows, { direction: "download" }, content);
  assert.deepEqual(down.get("원격 파일"), ["copy", "local"]);
  assert.deepEqual(down.get("해시 변경"), ["update", "local"]);
  const bidirectional = plan(rows, { direction: "both", mirrorDeletes: true }, content);
  assert.deepEqual(bidirectional.get("자료/새 파일"), ["copy", "remote"]);
  assert.deepEqual(bidirectional.get("원격 파일"), ["copy", "local"]);
  assert.deepEqual(bidirectional.get("해시 변경"), ["conflict", undefined]);
});

test("orders deletion candidates by depth and preserves folders with protected children", () => {
  const rows = [only("옛 폴더", "remote", "directory"), only("옛 폴더/하위", "remote", "directory"),
    only("옛 폴더/하위/문서", "remote"), only("자료", "remote", "directory"),
    only("자료/keep.tmp", "remote"), only("자료/삭제.txt", "remote"),
    only("미확인", "remote", "directory", { remoteIssue: "읽지 못함" })];
  const result = plan(rows, { mirrorDeletes: true, patterns: parseSyncPatterns("*.tmp").patterns });
  assert.deepEqual([...result.keys()].slice(0, 4), ["옛 폴더/하위/문서", "옛 폴더/하위", "자료/삭제.txt", "옛 폴더"]);
  assert.deepEqual(result.get("자료"), ["keep", "remote"]);
  assert.deepEqual(result.get("자료/keep.tmp"), ["exclude", undefined]);
  assert.deepEqual(result.get("미확인"), ["keep", "remote"]);
  const shallow = plan([only("기존 폴더", "remote", "directory"), only("기존 파일", "remote")],
    { mirrorDeletes: true, recursive: false });
  assert.deepEqual(shallow.get("기존 폴더"), ["keep", "remote"]);
  assert.deepEqual(shallow.get("기존 파일"), ["delete", "remote"]);
});

test("blocks unknown paths, changed snapshots and Windows path collisions", () => {
  const rows = [
    shared("부분 조회", "unknown", "directory", { remoteIssue: "부분 조회" }),
    shared("부분 조회/확인된 파일", "difference"),
    only("부분 조회/미확인 파일", "local", "file", { relation: "unknown" }),
    shared("형식 충돌", "difference", "directory", { local: [entry("형식 충돌")] }),
    only("형식 충돌/아래", "remote"),
    only("Folder", "local", "directory"), only("folder", "remote", "directory"), only("folder/a", "remote"),
    only("CON.txt", "remote"), shared("오래된 목록"),
  ];
  const selected = new Map([["오래된 목록", { error: "파일이 변경되었습니다." }]]);
  const result = plan(rows, { direction: "download", mirrorDeletes: true }, selected);
  for (const path of ["부분 조회", "부분 조회/미확인 파일", "형식 충돌", "형식 충돌/아래",
    "Folder", "folder", "folder/a", "CON.txt", "오래된 목록"]) {
    assert.deepEqual(result.get(path), ["conflict", undefined], path);
  }
  assert.deepEqual(result.get("부분 조회/확인된 파일"), ["update", "local"]);
});

test("matches globstar paths, literal folder exclusions and Unicode characters", () => {
  const parsed = parseSyncPatterns("cache/**\nrelease/**/피?.txt\n건너뛰기");
  const rows = ["cache", "cache/file", "release", "release/피🙂.txt", "release/deep/피a.txt",
    "release/피xx.txt", "sub", "sub/건너뛰기", "sub/건너뛰기/child"]
    .map(path => only(path, "local", path.includes(".") ? "file" : "directory"));
  const result = plan(rows, { patterns: parsed.patterns });
  for (const value of ["cache", "cache/file", "release/피🙂.txt", "release/deep/피a.txt", "sub/건너뛰기", "sub/건너뛰기/child"]) {
    assert.deepEqual(result.get(value), ["exclude", undefined], value);
  }
  assert.deepEqual(result.get("release/피xx.txt"), ["copy", "remote"]);
  for (const pattern of ["../*.txt", "/root", "C:/root", "cache/", "a**b", "dir\\item", "a".repeat(181), "x\n".repeat(25)]) {
    assert.ok(parseSyncPatterns(pattern).error, pattern);
  }
});
