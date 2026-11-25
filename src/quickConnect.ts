type NetworkKind = "ssh" | "rdp" | "postgres";
export type NetworkAddress = { host: string; port: number; username: string };
export type QuickTarget = (NetworkAddress & { kind: "ssh" }) | (NetworkAddress & { kind: "rdp" })
  | (NetworkAddress & { kind: "postgres"; database: string })
  | { kind: "sqlite"; path: string; name: string };

const schemes = new Map<string, NetworkKind>([["ssh", "ssh"], ["rdp", "rdp"], ["postgres", "postgres"], ["postgresql", "postgres"]]);
const defaultPorts = { ssh: 22, rdp: 3389, postgres: 5432 };
const controls = /[\u0000-\u001f\u007f]/;

function component(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    if (!controls.test(decoded)) return decoded;
  } catch {
    // Malformed percent escapes are invalid in a connection address.
  }
  throw new Error("주소의 문자 인코딩을 확인하세요.");
}

function networkHost(value: string) {
  if (value.includes(":")) {
    try {
      return new URL(`http://[${value}]`).hostname.slice(1, -1);
    } catch {
      throw new Error("IPv6 주소 형식을 확인하세요.");
    }
  }
  const labels = value.replace(/\.$/, "").split(".");
  if (value.length > 253 || labels.some(label => !/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error("호스트 이름 또는 IP 주소를 확인하세요.");
  }
  if (/^[\d.]+$/.test(value) && (labels.length !== 4 || labels.some(label => !/^(0|[1-9]\d{0,2})$/.test(label) || Number(label) > 255))) {
    throw new Error("IPv4 주소는 0부터 255까지의 숫자 네 부분으로 입력하세요.");
  }
  return value.toLowerCase();
}

export function parseQuickTarget(input: string): QuickTarget {
  const text = input.trim();
  if (!text || controls.test(text)) throw new Error("연결 주소를 한 줄로 입력하세요.");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  const protocol = scheme?.[1].toLowerCase();
  const sqliteUrl = protocol === "sqlite";
  if (sqliteUrl || /^[a-z]:[\\/]|^\/(?!\/)/i.test(text)) {
    const raw = sqliteUrl ? text.slice("sqlite://".length) : text;
    if (sqliteUrl && (!raw.startsWith("/") || /[?#]/.test(raw))) throw new Error("sqlite:/// 뒤에 SQLite 파일의 절대 경로를 입력하세요.");
    let path = sqliteUrl ? component(raw).replace(/^\/(?=[a-z]:\/)/i, "") : raw;
    if (/^[a-z]:\//i.test(path)) path = path.replaceAll("/", "\\");
    const name = path.split(/[\\/]/).at(-1);
    if (!name || name === "." || name === ".." || (sqliteUrl && path.startsWith("//"))) {
      throw new Error("SQLite 파일의 절대 경로를 입력하세요.");
    }
    return { kind: "sqlite", path, name };
  }
  const explicit = protocol ? schemes.get(protocol) : undefined;
  if (protocol && !explicit) throw new Error("SSH, PostgreSQL, RDP 또는 SQLite 주소를 입력하세요.");
  const address = scheme ? text.slice(scheme[0].length) : text;
  if (/[?#\\\s]/.test(address)) throw new Error("주소에서 공백, URL 옵션 또는 조각을 제거하세요.");
  const slash = address.indexOf("/");
  const authority = slash < 0 ? address : address.slice(0, slash);
  const path = slash < 0 ? "" : address.slice(slash + 1);
  const at = authority.indexOf("@");
  const user = at < 0 ? "" : authority.slice(0, at);
  const endpoint = at < 0 ? authority : authority.slice(at + 1);
  if (at >= 0 && (!user || user.includes(":") || endpoint.includes("@"))) {
    throw new Error("주소에는 사용자 이름만 넣으세요. 암호는 연결 화면에서 입력합니다.");
  }
  const username = component(user);
  if (username.includes(":")) throw new Error("암호 없이 사용자 이름만 입력하세요.");
  const hostPort = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::(\d+))?$/.exec(endpoint);
  const bareIpv6 = !scheme && !endpoint.startsWith("[") && endpoint.split(":").length > 2;
  if (!hostPort && !bareIpv6) throw new Error("호스트와 포트를 확인하세요. IPv6에 포트를 붙일 때는 [주소]:포트를 사용하세요.");
  if (hostPort?.[1] && !hostPort[1].includes(":")) throw new Error("대괄호 안에는 IPv6 주소를 입력하세요.");
  const host = networkHost(hostPort?.[1] ?? hostPort?.[2] ?? endpoint);
  const port = hostPort?.[3] === undefined ? null : Number(hostPort[3]);
  if (port !== null && (port < 1 || port > 65535)) throw new Error("포트는 1부터 65535까지 입력하세요.");
  const kind = explicit ?? (port === 3389 ? "rdp" : port === 5432 ? "postgres" : "ssh");
  if (path && (kind !== "postgres" || path.includes("/"))) throw new Error("PostgreSQL 주소의 경로에만 데이터베이스 이름을 입력할 수 있습니다.");
  if (kind === "ssh" && username && !/^[a-z0-9_.][a-z0-9._-]{0,127}$/i.test(username)) {
    throw new Error("SSH 사용자 이름에는 영문, 숫자, 점, 밑줄, 하이픈을 사용하세요.");
  }
  const target = { host, port: port ?? defaultPorts[kind], username };
  return kind === "postgres" ? { ...target, kind, database: component(path) } : { ...target, kind };
}

export function networkAddressText({ host, port }: Pick<NetworkAddress, "host" | "port">) {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function matchesNetworkAddress(target: NetworkAddress, saved: NetworkAddress) {
  return target.port === saved.port && (!target.username || target.username === saved.username)
    && target.host === (saved.host.includes(":") ? networkHost(saved.host) : saved.host.toLowerCase());
}
