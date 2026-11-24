import { invoke } from "@tauri-apps/api/core";
import type { Directory, DirectoryLocation, Entry } from "./fileBrowse";
import type { FileDifference } from "./fileDifference";

export type FolderPair = { id: string; target: string; local: DirectoryLocation; remote: DirectoryLocation; exactRoots?: boolean };
type ComparedSides<T> = { local: T; remote: T } | { errors: string[] };
export type FolderComparison = ComparedSides<Directory>;
export type FolderTree = { path: string; folders: { relative_path: string; entries: Entry[]; issue: string | null }[] };
export type FolderTreeComparison = ComparedSides<FolderTree>;
export type FileSnapshot = { location: string; size: string | null; modified: number | null };
type Content = { matches: boolean; local_sha256: string; remote_sha256: string; difference: FileDifference | null };
export type ContentResult = Content | { error: string };

async function loadBoth<T>(localRequest: Promise<T>, remoteRequest: Promise<T>): Promise<ComparedSides<T>> {
  const [local, remote] = await Promise.allSettled([localRequest, remoteRequest]);
  if (local.status === "fulfilled" && remote.status === "fulfilled") return { local: local.value, remote: remote.value };
  const errors: string[] = [];
  if (local.status === "rejected") errors.push(`로컬 폴더 · ${String(local.reason)}`);
  if (remote.status === "rejected") errors.push(`원격 폴더 · ${String(remote.reason)}`);
  return { errors };
}

export async function loadFolderComparison(pair: FolderPair): Promise<FolderComparison> {
  const result = await loadBoth(
    invoke<Directory>("browse_local_directory", { path: pair.local.location }),
    invoke<Directory>("list_sftp_directory", { id: pair.id, path: { kind: "token", value: pair.remote.location } }),
  );
  if (pair.exactRoots && "local" in result && (result.local.location !== pair.local.location || result.remote.location !== pair.remote.location)) {
    return { errors: ["저장한 폴더 경로가 바뀌었습니다. 파일 창에서 폴더를 다시 선택하세요."] };
  }
  return result;
}

export function asFolderTree(comparison: FolderComparison): FolderTreeComparison {
  if ("errors" in comparison) return comparison;
  function asTree(directory: Directory): FolderTree {
    return { path: directory.path, folders: [{
      relative_path: "", entries: directory.entries,
      issue: directory.truncated ? "목록 한도에 도달해 일부 항목만 확인했습니다." : null,
    }] };
  }
  return { local: asTree(comparison.local), remote: asTree(comparison.remote) };
}

export async function loadFolderTreeComparison(pair: FolderPair): Promise<FolderTreeComparison> {
  const result = await loadBoth(
    invoke<FolderTree>("browse_local_folder_tree", { path: pair.local.location }),
    invoke<FolderTree>("browse_sftp_folder_tree", { id: pair.id, location: pair.remote.location }),
  );
  if (pair.exactRoots && "local" in result && result.local.path !== pair.local.path) {
    return { errors: ["저장한 로컬 폴더 경로가 바뀌었습니다. 파일 창에서 폴더를 다시 선택하세요."] };
  }
  return result;
}

export function fileComparisonSnapshot(entry: Entry): FileSnapshot | null {
  return entry.kind === "file" && !entry.name_is_lossy && entry.location
    ? { location: entry.location, size: entry.size, modified: entry.modified } : null;
}

export async function compareFileContents(id: string, local: FileSnapshot, remote: FileSnapshot): Promise<ContentResult> {
  try {
    return await invoke<Content>("compare_sftp_file_contents", { id, local, remote });
  } catch (error) {
    return { error: String(error) };
  }
}
