import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("publishing falls back on generated-note errors, resumes its own draft and rejects other runs", t => {
  const tempParent = resolve(tmpdir());
  const root = mkdtempSync(join(tempParent, "stackport-publish-test-"));
  t.after(() => {
    if (dirname(resolve(root)) !== tempParent || !basename(root).startsWith("stackport-publish-test-")) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const mockBin = join(root, "bin");
  const releaseDir = join(root, "release");
  const runnerTemp = join(root, "runner");
  for (const path of [repo, mockBin, runnerTemp, join(repo, "release-assets")]) mkdirSync(path, { recursive: true });
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", "-q", remote);
  git("-C", repo, "init", "-q");
  git("-C", repo, "config", "user.name", "Release test");
  git("-C", repo, "config", "user.email", "release-test@example.invalid");
  writeFileSync(join(repo, "source.txt"), "source\n");
  git("-C", repo, "add", "source.txt");
  git("-C", repo, "-c", "commit.gpgsign=false", "commit", "-qm", "initial");
  git("-C", repo, "remote", "add", "origin", remote);
  const sha = git("-C", repo, "rev-parse", "HEAD");
  const executable = join(repo, "release-assets", "StackPort-Windows-x64.exe");
  const writeAsset = value => {
    writeFileSync(executable, value);
    const hash = createHash("sha256").update(value).digest("hex");
    writeFileSync(join(repo, "release-assets", "SHA256SUMS.txt"), `${hash}  StackPort-Windows-x64.exe\n`);
  };
  writeAsset("original executable");
  const mock = join(mockBin, "gh");
  copyFileSync(fileURLToPath(new URL("./fixtures/mock-gh.sh", import.meta.url)), mock);
  chmodSync(mock, 0o755);
  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const posix = path => process.platform === "win32"
    ? execFileSync("C:\\Program Files\\Git\\usr\\bin\\cygpath.exe", ["-u", path], { encoding: "utf8" }).trim()
    : path;
  const script = posix(fileURLToPath(new URL("../tools/publish-release.sh", import.meta.url)));
  const execute = (extra = {}) => spawnSync(bash, [script], {
    cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${mockBin}${delimiter}${process.env.PATH}`, RELEASE_TAG: "v0.1.0", GITHUB_SHA: sha, GITHUB_RUN_ID: "101", RUNNER_TEMP: posix(runnerTemp), MOCK_RELEASE_DIR: posix(releaseDir), ...extra },
  });

  let result = execute({ MOCK_FAIL_GENERATED_NOTES: "1", MOCK_FAIL_UPLOAD: "SHA256SUMS.txt" });
  assert.notEqual(result.status, 0, "the simulated upload must fail");
  assert.match(result.stdout, /Retrying draft creation with the bundled release notes/);
  assert.equal(readFileSync(join(releaseDir, "draft"), "utf8").trim(), "true");
  assert.equal(readFileSync(join(releaseDir, "assets", "StackPort-Windows-x64.exe"), "utf8"), "original executable");
  writeFileSync(join(releaseDir, "assets", "StackPort-Windows-x64.exe"), "conflicting asset");
  result = execute();
  assert.notEqual(result.status, 0, "a different existing asset must not be replaced");
  assert.equal(readFileSync(join(releaseDir, "assets", "StackPort-Windows-x64.exe"), "utf8"), "conflicting asset");
  writeFileSync(join(releaseDir, "assets", "StackPort-Windows-x64.exe"), "original executable");
  result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(releaseDir, "draft"), "utf8").trim(), "false");
  assert.equal(readFileSync(join(releaseDir, "assets", "SHA256SUMS.txt"), "utf8"), readFileSync(join(repo, "release-assets", "SHA256SUMS.txt"), "utf8"));
  writeAsset("new build of same run");
  result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(releaseDir, "assets", "StackPort-Windows-x64.exe"), "utf8"), "original executable");
  result = execute({ GITHUB_RUN_ID: "102" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different run or commit/);
});
