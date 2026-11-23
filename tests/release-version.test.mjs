import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bumpForCommits, compareVersions, nextVersion, parseVersion, stampVersions } from "../tools/release-version.mjs";

test("semantic versions are validated and compared numerically", () => {
  assert.deepEqual(parseVersion("1.10.2"), [1, 10, 2]);
  for (const invalid of ["v1.2.3", "01.2.3", "1.2", "1.2.3-beta", "1.2.65536"]) assert.equal(parseVersion(invalid), null);
  assert.ok(compareVersions(parseVersion("1.10.0"), parseVersion("1.9.100")) > 0);
});

test("release bump follows conventional commits and defaults to a patch", () => {
  assert.equal(bumpForCommits(["fix: correct timeout"]), "patch");
  assert.equal(bumpForCommits(["docs: update guide\n\nfeat: quoted example"]), "patch");
  assert.equal(bumpForCommits(["fix: repair", "feat(ssh): support keys"]), "minor");
  assert.equal(bumpForCommits(["feat!: remove legacy API"]), "major");
  assert.equal(bumpForCommits(["fix: adjust format\n\nBREAKING CHANGE: removes old format"]), "major");
  assert.deepEqual(nextVersion({ baseline: "0.1.0", latest: null, messages: [], bump: "auto" }), { version: "0.1.0", bump: "initial" });
  assert.deepEqual(nextVersion({ baseline: "0.1.0", latest: "0.1.0", messages: ["feat: add feature"], bump: "auto" }), { version: "0.2.0", bump: "minor" });
  assert.deepEqual(nextVersion({ baseline: "0.1.0", latest: "0.2.5", messages: [], bump: "auto" }), { version: "0.2.6", bump: "patch" });
  assert.deepEqual(nextVersion({ baseline: "0.1.0", latest: "0.2.5", messages: [], bump: "major" }), { version: "1.0.0", bump: "major" });
  assert.deepEqual(nextVersion({ baseline: "0.3.0", latest: "0.2.5", messages: [], bump: "auto" }), { version: "0.3.0", bump: "baseline" });
  assert.deepEqual(nextVersion({ baseline: "0.1.0", latest: null, messages: [], bump: "minor" }), { version: "0.2.0", bump: "minor" });
  assert.throws(() => nextVersion({ baseline: "0.1.0", latest: "0.1.65535", messages: [], bump: "patch" }));
});

test("all shipped application versions are stamped together or not changed on mismatch", t => {
  const tempParent = resolve(tmpdir());
  const root = mkdtempSync(join(tempParent, "stackport-release-test-"));
  t.after(() => {
    if (dirname(resolve(root)) !== tempParent || !basename(root).startsWith("stackport-release-test-")) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src-tauri"));
  const write = (path, value) => writeFileSync(join(root, path), value);
  write("package.json", JSON.stringify({ name: "stackport", version: "0.1.0" }));
  write("package-lock.json", JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" } } }));
  write("src-tauri/tauri.conf.json", JSON.stringify({ productName: "StackPort", version: "0.1.0" }));
  write("src-tauri/Cargo.toml", '[package]\nname = "stackport"\nversion = "0.1.0"\n');
  write("src-tauri/Cargo.lock", '[[package]]\nname = "stackport"\nversion = "0.1.0"\n\n[[package]]\nname = "stackport-core"\nversion = "0.1.0"\n');
  stampVersions(root, "0.2.3");
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).version, "0.2.3");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json")));
  assert.equal(lock.version, "0.2.3");
  assert.equal(lock.packages[""].version, "0.2.3");
  assert.equal(JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"))).version, "0.2.3");
  assert.match(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"), /version = "0\.2\.3"/);
  const cargoLock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
  assert.match(cargoLock, /name = "stackport"\nversion = "0\.2\.3"/);
  assert.match(cargoLock, /name = "stackport-core"\nversion = "0\.1\.0"/);
  write("src-tauri/tauri.conf.json", JSON.stringify({ version: "9.9.9" }));
  assert.throws(() => stampVersions(root, "0.2.4"), /versions.*must match/);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).version, "0.2.3");
});

test("real Git tags allocate one version per run and retries cannot change their source", t => {
  const tempParent = resolve(tmpdir());
  const root = mkdtempSync(join(tempParent, "stackport-release-git-"));
  t.after(() => {
    if (dirname(resolve(root)) !== tempParent || !basename(root).startsWith("stackport-release-git-")) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src-tauri"));
  const write = (path, value) => writeFileSync(join(root, path), value);
  write("package.json", JSON.stringify({ name: "stackport", version: "0.1.0" }));
  write("package-lock.json", JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" } } }));
  write("src-tauri/tauri.conf.json", JSON.stringify({ version: "0.1.0" }));
  write("src-tauri/Cargo.toml", '[package]\nname = "stackport"\nversion = "0.1.0"\n');
  write("src-tauri/Cargo.lock", '[[package]]\nname = "stackport"\nversion = "0.1.0"\n');
  write("note.txt", "initial\n");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "initial");
  const initial = git("rev-parse", "HEAD");
  const metadata = join(root, "metadata.json");
  const script = fileURLToPath(new URL("../tools/release-version.mjs", import.meta.url));
  const invoke = (runId, sha = initial) => spawnSync(process.execPath, [script], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_RUN_ID: runId, GITHUB_SHA: sha, RELEASE_METADATA: metadata, RELEASE_BUMP: "auto" },
  });
  const restore = () => git("restore", "--", "package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock");
  let result = invoke("101");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(metadata)).tag, "v0.1.0");
  restore();
  git("tag", "-a", "v0.1.0", "-m", "StackPort Actions run 101");
  result = invoke("101");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(metadata)).bump, "retry");
  restore();
  result = invoke("102");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(metadata)).tag, "v0.1.1");
  restore();
  write("note.txt", "feature\n");
  git("add", "note.txt");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "feat(ssh): add support");
  const feature = git("rev-parse", "HEAD");
  result = invoke("103", feature);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(metadata)).tag, "v0.2.0");
  restore();
  git("tag", "-a", "v0.2.0", initial, "-m", "StackPort Actions run 103");
  result = invoke("103", feature);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different commit/);
  const orphan = git("-c", "commit.gpgsign=false", "commit-tree", "HEAD^{tree}", "-m", "unrelated");
  git("tag", "-a", "v9.0.0", orphan, "-m", "other tag");
  result = invoke("104", feature);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not an ancestor/);
});
