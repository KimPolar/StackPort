export type Entry = {
  name: string;
  name_is_lossy: boolean;
  kind: "directory" | "file" | "symlink" | "other";
  location: string | null;
  size: string | null;
  modified: number | null;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  hidden: boolean;
};

export type DirectoryLocation = { path: string; location: string };
export type Directory = DirectoryLocation & { parent: string | null; entries: Entry[]; truncated: boolean };
export type BrowsePath = { kind: "text" | "token"; value: string };

export function displayFilePath(path: string) {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}
