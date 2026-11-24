export type TunnelKind = "local" | "dynamic" | "remote";
export type TunnelSettings = { name: string; ssh_profile_id: string; kind: TunnelKind; listen_port: number;
  target_host: string | null; target_port: number | null };
export type SavedSshTunnel = { id: string; project_id: string; revision: number; settings: TunnelSettings };

export const tunnelKindLabels: Record<TunnelKind, string> = {
  local: "로컬 전달 (-L)", dynamic: "동적 SOCKS5 (-D)", remote: "원격 전달 (-R)",
};
export const tunnelListenAddress = (port: number) => `127.0.0.1:${port || "자동"}`;

export function tunnelTarget({ kind, target_host: host, target_port: port }: TunnelSettings) {
  if (!host || port === null) return "SOCKS5 요청의 대상";
  const address = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  return kind === "remote" ? `이 PC에서 ${address}` : address;
}

export function tunnelPath(settings: TunnelSettings) {
  const address = tunnelListenAddress(settings.listen_port);
  if (settings.kind === "dynamic") return `${address} · SOCKS5`;
  if (settings.kind === "remote") return `SSH 서버의 ${address} → ${tunnelTarget(settings)}`;
  return `${address} → ${tunnelTarget(settings)}`;
}
