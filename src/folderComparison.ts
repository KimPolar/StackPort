import type { Entry } from "./fileBrowse";
import type { FolderTree } from "./fileCompare";

export const relationLabels = {
  local: "로컬에만 있음", remote: "원격에만 있음", difference: "차이 있음",
  same: "크기·수정 시각 일치", folder: "양쪽 폴더", unknown: "확인 필요",
};
type Relation = keyof typeof relationLabels;
type PairedEntries = { local: Entry[]; remote: Entry[] };
type Status = { relation: Relation; detail?: string };
export type FolderTreeRow = PairedEntries & Status & { name: string; localIssue?: string; remoteIssue?: string };
type IndexedTree = ReturnType<typeof indexTree>;
const names = new Intl.Collator("ko-KR", { numeric: true });

function indexTree(tree: FolderTree) {
  const entries = new Map<string, Entry[]>();
  const incomplete = new Map<string, string>();
  for (const folder of tree.folders) {
    if (folder.issue) incomplete.set(folder.relative_path, folder.issue);
    for (const entry of folder.entries) {
      const path = folder.relative_path ? `${folder.relative_path}/${entry.name}` : entry.name;
      const paired = entries.get(path) ?? [];
      paired.push(entry);
      entries.set(path, paired);
    }
  }
  return { entries, incomplete };
}

function missingIssue(tree: IndexedTree, name: string) {
  let slash = name.lastIndexOf("/");
  while (slash >= 0) {
    name = name.slice(0, slash);
    const entries = tree.entries.get(name);
    if (entries) {
      return tree.incomplete.get(name) ?? (entries.length > 1 || entries.some(entry => entry.name_is_lossy ||
        entry.kind === "symlink" || entry.kind === "other") ? "이 경로의 하위 항목을 확인하지 않았습니다." : undefined);
    }
    slash = name.lastIndexOf("/");
  }
  return tree.incomplete.get("");
}

function checkEntries(row: PairedEntries, localMissing?: string, remoteMissing?: string): Status {
  const [local] = row.local;
  const [remote] = row.remote;
  if (row.local.length > 1 || row.remote.length > 1 || local?.name_is_lossy || remote?.name_is_lossy) {
    return { relation: "unknown", detail: "이름을 정확히 대조할 수 없습니다." };
  }
  if (!local) return localMissing ? { relation: "unknown", detail: `로컬 목록 미확인 · ${localMissing}` } : { relation: "remote" };
  if (!remote) return remoteMissing ? { relation: "unknown", detail: `원격 목록 미확인 · ${remoteMissing}` } : { relation: "local" };
  if (local.kind !== remote.kind) return { relation: "difference", detail: "유형 다름" };
  if (local.kind === "directory") return { relation: "folder" };
  if (local.kind !== "file") return { relation: "unknown", detail: "링크 또는 기타 항목" };
  const differences: string[] = [];
  if (local.size !== null && remote.size !== null && local.size !== remote.size) differences.push("크기 다름");
  if (local.modified !== null && remote.modified !== null && local.modified !== remote.modified) {
    differences.push(local.modified > remote.modified ? "로컬 수정 시각이 더 최근" : "원격 수정 시각이 더 최근");
  }
  if (differences.length) return { relation: "difference", detail: differences.join(" · ") };
  if (local.size === null || remote.size === null || local.modified === null || remote.modified === null) {
    return { relation: "unknown", detail: "크기 또는 수정 시각 미확인" };
  }
  return { relation: "same" };
}

export function compareFolderTrees(local: FolderTree, remote: FolderTree) {
  const left = indexTree(local);
  const right = indexTree(remote);
  const paths = new Set([...left.entries.keys(), ...right.entries.keys()]);
  const rows = Array.from(paths, (name): FolderTreeRow => {
    const row = { local: left.entries.get(name) ?? [], remote: right.entries.get(name) ?? [] };
    const status = checkEntries(row, row.local.length > 0 ? undefined : missingIssue(left, name),
      row.remote.length > 0 ? undefined : missingIssue(right, name));
    const localIssue = left.incomplete.get(name);
    const remoteIssue = right.incomplete.get(name);
    if (localIssue || remoteIssue) {
      const issues = [status.detail, localIssue && `로컬 · ${localIssue}`, remoteIssue && `원격 · ${remoteIssue}`].filter(Boolean);
      return { name, ...row, localIssue, remoteIssue, relation: status.relation === "folder" ? "unknown" : status.relation, detail: issues.join(" · ") };
    }
    return { name, ...row, ...status };
  }).sort((left, right) => names.compare(left.name, right.name));
  return { rows, localIncomplete: left.incomplete.size, remoteIncomplete: right.incomplete.size };
}
