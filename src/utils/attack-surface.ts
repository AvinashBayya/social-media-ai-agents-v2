/**
 * Attack-surface lookup: Cloudflare DoH resolution → Shodan InternetDB.
 *
 * InternetDB (https://internetdb.shodan.io/{ip}) is Shodan's free endpoint. It
 * needs no API key and no account, and returns open ports, detected CPEs,
 * reverse hostnames, tags and known CVEs for an address.
 *
 * We deliberately do NOT use api.shodan.io. Its host endpoint currently answers
 * some keyless requests, but that is undocumented and will start returning 401
 * without notice — building on it would produce a feature that silently dies.
 *
 * Nothing here invents data. A host that resolves to an address Shodan has never
 * scanned returns `scanned: false`, which is a real finding ("no internet-facing
 * services observed"), not an empty placeholder dressed up as a clean result.
 */

import { createServerFn } from "@tanstack/react-start";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** RFC1918 / loopback / link-local / CGNAT — never worth sending to Shodan. */
function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(IPV4);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isIPv4(value: string): boolean {
  const m = (value || "").trim().match(IPV4);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

/** Strip scheme, credentials, port and path down to a bare hostname. */
export function toHostname(target: string): string {
  return (target || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "");
}

export interface HostSurface {
  ip: string;
  /** False when Shodan has no record for this address (HTTP 404). */
  scanned: boolean;
  ports: number[];
  /** Detected software, as CPE strings. */
  cpes: string[];
  /** Reverse DNS names Shodan associates with the address. */
  hostnames: string[];
  tags: string[];
  /** CVE identifiers Shodan associates with the observed services. */
  vulns: string[];
}

export interface AttackSurfaceResult {
  target: string;
  hostname: string;
  /** Addresses the hostname resolved to (or the literal IP that was supplied). */
  addresses: string[];
  hosts: HostSurface[];
  /** ISO timestamp of this lookup, so the UI can show data age honestly. */
  retrievedAt: string;
}

/** Resolve A records over Cloudflare DNS-over-HTTPS. */
async function resolveA(hostname: string): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err: any) {
    throw new Error(`DNS resolution failed for ${hostname}: ${err?.message ?? String(err)}`);
  }

  if (!res.ok) {
    throw new Error(`DNS resolution failed for ${hostname}: HTTP ${res.status}`);
  }

  const json: any = await res.json();

  // NXDOMAIN (3) is a definite answer, not a transport failure — report it as
  // such so the UI can say "does not resolve" instead of "lookup broke".
  if (json?.Status === 3) {
    throw new Error(`${hostname} does not resolve (NXDOMAIN).`);
  }
  if (json?.Status !== 0) {
    throw new Error(`DNS resolution for ${hostname} returned status ${json?.Status}.`);
  }

  const answers: any[] = Array.isArray(json?.Answer) ? json.Answer : [];
  const ips = answers
    .filter((a) => a?.type === 1 && typeof a?.data === "string") // type 1 = A
    .map((a) => a.data.trim())
    .filter(isIPv4);

  return Array.from(new Set(ips));
}

/** Look one address up in Shodan InternetDB. */
async function internetDb(ip: string): Promise<HostSurface> {
  let res: Response;
  try {
    res = await fetch(`https://internetdb.shodan.io/${ip}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err: any) {
    throw new Error(`Shodan InternetDB request failed for ${ip}: ${err?.message ?? String(err)}`);
  }

  // 404 means Shodan holds no record for the address. That is a real, reportable
  // result, so it is not an error.
  if (res.status === 404) {
    return { ip, scanned: false, ports: [], cpes: [], hostnames: [], tags: [], vulns: [] };
  }

  // A rate limit is temporary and retryable. Collapsing it into the generic
  // error below would tell the analyst the lookup broke when the correct
  // advice is to wait — and it must never be read as "nothing exposed".
  if (res.status === 429) {
    throw new Error(
      `Shodan InternetDB rate-limited the request for ${ip} (HTTP 429). Wait and retry.`,
    );
  }

  if (!res.ok) {
    throw new Error(`Shodan InternetDB returned HTTP ${res.status} for ${ip}.`);
  }

  const json: any = await res.json();
  const arr = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

  return {
    ip,
    scanned: true,
    ports: Array.isArray(json?.ports) ? json.ports.filter((p: any) => Number.isInteger(p)) : [],
    cpes: arr(json?.cpes),
    hostnames: arr(json?.hostnames),
    tags: arr(json?.tags),
    vulns: arr(json?.vulns),
  };
}

/** Addresses probed per target. Keeps one lookup bounded and predictable. */
const MAX_ADDRESSES = 4;

export const lookupAttackSurface = createServerFn({ method: "POST" })
  .validator((d: { target: string }) => d)
  .handler(async ({ data }): Promise<AttackSurfaceResult> => {
    const raw = (data?.target || "").trim();
    if (!raw) throw new Error("A domain or IP address is required.");

    const hostname = toHostname(raw);
    if (!hostname) throw new Error(`Could not read a hostname from "${raw}".`);

    let addresses: string[];
    if (isIPv4(hostname)) {
      if (isPrivateIPv4(hostname)) {
        throw new Error(`${hostname} is a private address and is not internet-reachable.`);
      }
      addresses = [hostname];
    } else {
      addresses = await resolveA(hostname);
      if (addresses.length === 0) {
        throw new Error(`${hostname} resolved with no A records.`);
      }
      addresses = addresses.filter((ip) => !isPrivateIPv4(ip));
      if (addresses.length === 0) {
        throw new Error(`${hostname} resolves only to private addresses.`);
      }
    }

    const probed = addresses.slice(0, MAX_ADDRESSES);
    const hosts = await Promise.all(probed.map(internetDb));

    return {
      target: raw,
      hostname,
      addresses: probed,
      hosts,
      retrievedAt: new Date().toISOString(),
    };
  });
