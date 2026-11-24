export type TerminalDirectory =
  | { kind: "local"; path: string }
  | { kind: "ssh"; path: string; profileId: string; revision: number };

// undefined means the sequence is unrelated. A null path clears the current directory.
export function terminalDirectoryFromOsc(data: string, localAuthority: string | null): string | null | undefined {
  if (data.length > 16_384) return;
  const uri = /^file:\/\/([\w.-]*)(\/[^?#]*)$/i.exec(data);
  if (!uri || (localAuthority && uri[1] !== localAuthority)) return;
  let path: string;
  try {
    path = decodeURIComponent(uri[2]);
  } catch {
    return;
  }
  if (path.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(path)) return;
  if (!localAuthority) return path;
  if (path === "/") return null;
  if (!/^\/[a-z]:\//i.test(path) || /[<>:"|?*\\]/.test(path.slice(4))) return;
  return path.slice(1).replaceAll("/", "\\");
}
