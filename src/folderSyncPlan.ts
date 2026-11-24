import type { Entry } from "./fileBrowse";
import type { ContentResult } from "./fileCompare";
import type { FolderTreeRow } from "./folderComparison";

type Side = "local" | "remote";
export type SyncDirection = "upload" | "download" | "both";
export const syncActionLabels = {
  mkdir: "폴더 만들기", copy: "파일 복사", update: "파일 갱신", delete: "삭제 후보",
  conflict: "충돌", verify: "내용 확인 필요", keep: "보존", exclude: "제외",
};
export type SyncAction = keyof typeof syncActionLabels;
type PlanItem = { path: string; action: SyncAction; target?: Side; reason: string };
type PlanOptions = { direction: SyncDirection; mirrorDeletes: boolean; patterns: string[][]; recursive: boolean; windowsLocal: boolean };
const pathOrder = new Intl.Collator("ko-KR", { numeric: true });

export function parseSyncPatterns(input: string): { patterns: string[][] } | { error: string } {
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 24) return { error: "제외 패턴은 최대 24줄까지 입력하세요." };
  const patterns = [];
  for (const line of lines) {
    const segments = line.split("/");
    if (line.length > 180 || /^[a-z]:\//i.test(line) || line.includes("\\") || segments.some(part =>
      !part || part === "." || part === ".." || (part !== "**" && part.includes("**")))) {
      return { error: "제외 패턴은 180자 이하의 상대 경로로 입력하세요. 폴더 구분은 /를 사용하고 **는 경로 한 구간으로 입력하세요." };
    }
    patterns.push(segments.length === 1 && line !== "**" ? ["**", line] : segments);
  }
  return { patterns };
}

function wildcardMatch(pattern: string[], value: string[], star: string, match: (pattern: string, value: string) => boolean) {
  let token = 0;
  let char = 0;
  let backtrack = -1;
  let starEnd = 0;
  while (char < value.length) {
    if (pattern[token] === star) {
      backtrack = token++;
      starEnd = char;
    } else if (token < pattern.length && match(pattern[token], value[char])) {
      token++;
      char++;
    } else if (backtrack >= 0) {
      token = backtrack + 1;
      char = ++starEnd;
    } else {
      return false;
    }
  }
  while (pattern[token] === star) token++;
  return token === pattern.length;
}

function matchSegment(pattern: string, name: string) {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === name;
  return wildcardMatch(Array.from(pattern), Array.from(name), "*", (token, char) => token === "?" || token === char);
}

function windowsFilename(name: string) {
  return !/[<>:"\\|?*\u0000-\u001f\u007f-\u009f]/.test(name) && !/[ .]$/.test(name) &&
    !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/i.test(name.split(".")[0].trimEnd());
}

function otherSide(side: Side): Side {
  return side === "local" ? "remote" : "local";
}

function supported(entry: Entry) {
  return (entry.kind === "file" || entry.kind === "directory") && Boolean(entry.location);
}

export function buildFolderSyncPlan(rows: readonly FolderTreeRow[], content: ReadonlyMap<string, ContentResult>, options: PlanOptions) {
  const source = options.direction === "both" ? null : options.direction === "upload" ? "local" : "remote";
  const ordered = rows.map(row => {
    const segments = row.name.split("/");
    return { row, segments, parent: segments.slice(0, -1).join("/") };
  }).sort((a, b) => a.segments.length - b.segments.length);
  const children = new Map<string, string[]>();
  const items = new Map<string, PlanItem>();
  const excluded = new Set<string>();
  const blocked = new Set<string>();
  const folded = new Map<string, Set<string>>();

  for (const { row, parent, segments } of ordered) {
    const siblings = children.get(parent) ?? [];
    siblings.push(row.name);
    children.set(parent, siblings);
    if (excluded.has(parent) || options.patterns.some(pattern => wildcardMatch(pattern, segments, "**", matchSegment))) {
      excluded.add(row.name);
    }
    if (options.windowsLocal && (row.local.length > 0 || !excluded.has(row.name))) {
      const key = row.name.toUpperCase();
      const names = folded.get(key) ?? new Set();
      names.add(row.name);
      folded.set(key, names);
    }
  }

  for (const { row, parent, segments } of ordered) {
    const path = row.name;
    const [local] = row.local;
    const [remote] = row.remote;
    const isSharedFolder = row.local.length === 1 && row.remote.length === 1 &&
      local.kind === "directory" && remote.kind === "directory" && !local.name_is_lossy && !remote.name_is_lossy;
    function add(action: SyncAction, reason: string, target?: Side) {
      items.set(path, { path, action, reason, target });
    }
    function conflict(reason: string, stopChildren = true) {
      add("conflict", reason);
      if (stopChildren) blocked.add(path);
    }

    if (excluded.has(path)) {
      add("exclude", "제외 패턴에 해당합니다.");
      continue;
    }
    if (blocked.has(parent)) {
      conflict("상위 경로의 충돌을 먼저 확인하세요.");
      continue;
    }
    if ((folded.get(path.toUpperCase())?.size ?? 0) > 1) {
      conflict("Windows에서 대소문자가 다른 이름이 같은 경로일 수 있습니다.");
      continue;
    }
    const checked = content.get(path);
    if (checked && "error" in checked) {
      conflict(checked.error);
      continue;
    }
    if (row.relation === "unknown") {
      conflict(row.detail ?? "항목의 존재 또는 속성을 확인할 수 없습니다.", !isSharedFolder);
      continue;
    }
    if ((local && !supported(local)) || (remote && !supported(remote)) || (local && remote && local.kind !== remote.kind)) {
      conflict("파일·폴더 유형 또는 경로를 확인하세요. 링크와 특수 항목은 보존합니다.");
      continue;
    }
    if (local && remote) {
      if (isSharedFolder || checked?.matches) continue;
      if (row.relation === "same" && !checked) {
        add("verify", "크기와 수정 시각이 같습니다. 필요하면 폴더 비교에서 SHA-256을 확인하세요.");
      } else if (!source) {
        conflict("양쪽에 내용 또는 속성 차이가 있습니다. 유지할 쪽을 확인하세요.");
      } else {
        add("update", checked ? "SHA-256이 다릅니다." : row.detail ?? "파일 속성이 다릅니다.", otherSide(source));
      }
      continue;
    }

    const present: Side = local ? "local" : "remote";
    const target = otherSide(present);
    const entry = (local ?? remote)!;
    const issue = row.localIssue ?? row.remoteIssue;
    if (!source || source === present) {
      if (issue) {
        conflict(issue);
      } else if (target === "local" && options.windowsLocal && !segments.every(windowsFilename)) {
        conflict("이 상대 경로를 Windows 파일 이름으로 만들 수 없습니다.");
      } else {
        add(entry.kind === "directory" ? "mkdir" : "copy", "대상에 없는 항목입니다.", target);
      }
    } else if (!options.mirrorDeletes) {
      add("keep", "삭제 반영이 꺼져 있습니다.", present);
    } else if (entry.kind === "directory" && (!options.recursive || issue)) {
      add("keep", issue ?? "하위 목록까지 확인해야 폴더 삭제를 계획할 수 있습니다.", present);
    } else {
      add("delete", "기준 폴더에 없는 항목입니다.", present);
    }
  }

  for (const { row } of ordered.reverse()) {
    const item = items.get(row.name);
    if (item?.action !== "delete") continue;
    if (children.get(row.name)?.some(path => items.get(path)?.action !== "delete")) {
      item.action = "keep";
      item.reason = "보존하거나 확인해야 할 하위 항목이 있습니다.";
    }
  }
  const rank: Record<SyncAction, number> = { mkdir: 0, copy: 1, update: 2, delete: 3, conflict: 4, verify: 5, keep: 6, exclude: 7 };
  const depth = (path: string) => path.split("/").length;
  return [...items.values()].sort((a, b) => rank[a.action] - rank[b.action] ||
    (a.action === "mkdir" ? depth(a.path) - depth(b.path) : a.action === "delete" ? depth(b.path) - depth(a.path) : 0)
    || pathOrder.compare(a.path, b.path));
}
