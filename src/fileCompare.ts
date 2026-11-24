import { invoke } from "@tauri-apps/api/core";
import type { Directory, DirectoryLocation, Entry } from "./fileBrowse";
import type { FileDifference } from "./fileDifference";

export type FolderPair = { id: string; target: string; local: DirectoryLocation; remote: DirectoryLocation };
export type FolderComparison = { local: Directory; remote: Directory } | { errors: string[] };
export type FileSnapshot = { location: string; size: string | null; modified: number | null };
type Content = { matches: boolean; local_sha256: string; remote_sha256: string; difference: FileDifference | null };
export type ContentResult = Content | { error: string };

export async function loadFolderComparison(pair: FolderPair): Promise<FolderComparison> {
  const [local, remote] = await Promise.allSettled([
    invoke<Directory>("browse_local_directory", { path: pair.local.location }),
    invoke<Directory>("list_sftp_directory", { id: pair.id, path: { kind: "token", value: pair.remote.location } }),
  ]);
  if (local.status === "fulfilled" && remote.status === "fulfilled") return { local: local.value, remote: remote.value };
  const errors: string[] = [];
  if (local.status === "rejected") errors.push(`로컬 폴더 · ${String(local.reason)}`);
  if (remote.status === "rejected") errors.push(`원격 폴더 · ${String(remote.reason)}`);
  return { errors };
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
