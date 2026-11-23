import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(value) {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(part => Number.isSafeInteger(part) && part <= 65535) ? parts : null;
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function bumpForCommits(messages) {
  const header = message => message.trimStart().split(/\r?\n/, 1)[0];
  if (messages.some(message => /^(?:[a-z][\w-]*)(?:\([^\r\n)]*\))?!:/i.test(header(message)) || /^BREAKING[ -]CHANGE\s*:/im.test(message))) return "major";
  if (messages.some(message => /^feat(?:\([^\r\n)]*\))?:/i.test(header(message)))) return "minor";
  return "patch";
}

export function nextVersion({ baseline, latest, messages, bump }) {
  const base = parseVersion(baseline);
  if (!base) throw new Error("Application baseline must be a stable MAJOR.MINOR.PATCH version.");
  if (!["auto", "patch", "minor", "major"].includes(bump)) throw new Error("Unknown version bump.");
  if (!latest && bump === "auto") return { version: baseline, bump: "initial" };
  if (!latest) latest = baseline;
  const previous = parseVersion(latest);
  if (!previous) throw new Error("Latest release tag is not a supported stable version.");
  if (bump === "auto" && compareVersions(base, previous) > 0) return { version: baseline, bump: "baseline" };
  const kind = bump === "auto" ? bumpForCommits(messages) : bump;
  const parts = [...previous];
  if (kind === "major") { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (kind === "minor") { parts[1]++; parts[2] = 0; }
  else parts[2]++;
  const version = parts.join(".");
  if (!parseVersion(version)) throw new Error("Version exceeds Windows version component limits.");
  if (compareVersions(parts, base) < 0) throw new Error("The requested version is below the source baseline.");
  return { version, bump: kind };
}

export function stampVersions(root, version) {
  if (!parseVersion(version)) throw new Error("Invalid release version.");
  const packagePath = join(root, "package.json");
  const npmLockPath = join(root, "package-lock.json");
  const configPath = join(root, "src-tauri", "tauri.conf.json");
  const manifestPath = join(root, "src-tauri", "Cargo.toml");
  const cargoLockPath = join(root, "src-tauri", "Cargo.lock");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const npmLock = JSON.parse(readFileSync(npmLockPath, "utf8"));
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const manifest = readFileSync(manifestPath, "utf8");
  const cargoLock = readFileSync(cargoLockPath, "utf8");
  const manifestMatch = /^version\s*=\s*"([^"]+)"\s*$/m.exec(manifest);
  const cargoPattern = /(\[\[package\]\]\r?\nname = "stackport"\r?\nversion = ")([^"]+)(")/g;
  const cargoMatches = [...cargoLock.matchAll(cargoPattern)];
  const baseline = pkg.version;
  if (!manifestMatch || cargoMatches.length !== 1 || !npmLock.packages?.[""] ||
      [config.version, manifestMatch[1], cargoMatches[0][2], npmLock.version, npmLock.packages[""].version].some(value => value !== baseline)) {
    throw new Error("Application versions in package, Tauri, Cargo and lockfiles must match.");
  }
  pkg.version = version;
  npmLock.version = version;
  npmLock.packages[""].version = version;
  config.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(npmLockPath, `${JSON.stringify(npmLock, null, 2)}\n`);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(manifestPath, manifest.replace(manifestMatch[0], manifestMatch[0].replace(`"${baseline}"`, `"${version}"`)));
  writeFileSync(cargoLockPath, cargoLock.replace(cargoPattern, (_match, prefix, _old, suffix) => `${prefix}${version}${suffix}`));
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function prepare() {
  const runId = process.env.GITHUB_RUN_ID;
  const sha = process.env.GITHUB_SHA;
  const output = process.env.RELEASE_METADATA;
  const bump = process.env.RELEASE_BUMP || "auto";
  if (!/^\d+$/.test(runId || "") || !/^[0-9a-f]{40}$/.test(sha || "") || !output) {
    throw new Error("GITHUB_RUN_ID, GITHUB_SHA and RELEASE_METADATA are required.");
  }
  if (git("rev-parse", "HEAD") !== sha) throw new Error("Checked-out commit does not match the workflow run.");
  const raw = git("for-each-ref", "--format=%(refname:short)%09%(objecttype)%09%(contents:subject)", "refs/tags/");
  const tags = raw ? raw.split(/\r?\n/).map(line => {
    const [name, type, subject] = line.split("\t");
    if (name.startsWith("v") && VERSION_PATTERN.test(name.slice(1)) && !parseVersion(name.slice(1))) {
      throw new Error(`Release tag ${name} exceeds Windows version component limits.`);
    }
    return { name, type, subject, parts: name.startsWith("v") ? parseVersion(name.slice(1)) : null };
  }).filter(tag => tag.parts) : [];
  const owned = tags.filter(tag => tag.type === "tag" && tag.subject === `StackPort Actions run ${runId}`);
  if (owned.length > 1) throw new Error("More than one tag belongs to this workflow run.");
  let result;
  if (owned.length) {
    if (git("rev-parse", `${owned[0].name}^{}`) !== sha) throw new Error("Existing run tag points to a different commit.");
    result = { version: owned[0].name.slice(1), bump: "retry" };
  } else {
    const latest = tags.sort((a, b) => compareVersions(b.parts, a.parts))[0];
    let messages = [];
    if (latest) {
      const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", latest.name, sha], { stdio: "ignore" });
      if (ancestor.status !== 0) throw new Error("The latest version tag is not an ancestor of this commit; refusing to publish older source.");
      const log = git("log", "--format=%B%x00", `${latest.name}..${sha}`);
      messages = log ? log.split("\0") : [];
    }
    const baseline = JSON.parse(readFileSync("package.json", "utf8")).version;
    result = nextVersion({ baseline, latest: latest?.name.slice(1), messages, bump });
  }
  stampVersions(process.cwd(), result.version);
  const metadata = { ...result, tag: `v${result.version}`, sha, runId };
  writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`Prepared ${metadata.tag} (${metadata.bump}) for ${sha}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { prepare(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
