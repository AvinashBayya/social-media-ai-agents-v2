/**
 * Client identity resolution for rate limiting.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID.
 *
 * h3's `getRequestIP({ xForwardedFor: true })` returns `header.split(",")[0]` —
 * the LEFTMOST entry of `X-Forwarded-For`. That entry is 100% caller-supplied.
 * A limiter keyed on it is not merely weak, it is worse than no limiter at all:
 *
 *   1. An attacker sets a fresh random XFF per request and is never throttled.
 *   2. Those random keys evict real offenders' strike records from the bounded
 *      counter map, so the limiter actively forgets the callers it should
 *      remember.
 *
 * The trustworthy value is the one the ingress proxy APPENDED, i.e. counted
 * from the RIGHT. Azure Container Apps' Envoy ingress is one hop, so the
 * rightmost entry is the peer Envoy saw. `trustedProxyHops` is configurable
 * because that number is a property of the deployment, not of this code, and
 * getting it wrong is the single most likely way to break the app: too many
 * hops and every caller collapses into one bucket.
 *
 * Pure on purpose — no h3 import, no `process.env` read, `now` and options
 * injected. Same convention as demo-session.ts, so `bun test` can cover it.
 */

/** Result of resolving a client key from request headers. */
export interface ClientKeyResolution {
  /** The rate-limit key. Never null — falls back to UNKNOWN_CLIENT_KEY. */
  key: string;
  /** Where the key came from. `unknown` means no usable address was found. */
  source: "forwarded" | "peer" | "unknown";
  /**
   * Real reason the resolution landed where it did. Never a placeholder —
   * this is logged, and "why is every caller in one bucket" is the question
   * it has to answer.
   */
  detail: string;
}

/**
 * Key used when no address could be established. Callers give this its own
 * (tighter) tier rather than exempting it — an unkeyed request must not be a
 * free pass, and must not share a bucket with real addresses either.
 */
export const UNKNOWN_CLIENT_KEY = "unknown";

/** Strict dotted-quad. Deliberately rejects leading zeros and >255 octets. */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * IPv6, including `::` compression and IPv4-mapped tails. Not exhaustive to
 * the letter of RFC 4291 — it is a validity filter, not a parser. Anything it
 * rejects becomes UNKNOWN rather than a key, which is the safe direction.
 */
const IPV6_RE =
  /^(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?:(?::[0-9a-f]{1,4}){1,7}|:)|::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))$/i;

export function isIPv4Address(value: string): boolean {
  return IPV4_RE.test(value);
}

export function isIPv6Address(value: string): boolean {
  return IPV6_RE.test(value);
}

/**
 * Strip transport decoration an address may arrive with.
 *
 * Three shapes reach us: `1.2.3.4`, `1.2.3.4:5678`, and `[2001:db8::1]:5678`.
 * A bare IPv6 also contains colons, so a naive `split(":")[0]` truncates every
 * v6 address to `2001` — which would silently collapse the entire v6 internet
 * into a handful of buckets. Port stripping is therefore shape-matched, never
 * unconditional.
 */
export function stripAddressDecoration(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  // [v6]:port or bare [v6]
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) return bracketed[1].trim().toLowerCase();

  // v4:port — exactly one colon, and what precedes it looks like IPv4.
  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    const head = value.slice(0, firstColon);
    const tail = value.slice(firstColon + 1);
    if (IPV4_RE.test(head) && /^\d{1,5}$/.test(tail)) return head;
  }

  return value.toLowerCase();
}

/**
 * Collapse an IPv6 address to its routing prefix.
 *
 * A single residential IPv6 allocation is typically a /64 — 2^64 addresses.
 * Keying on the full address lets one allocation mint a fresh identity per
 * request, which defeats both the limit and the bounded map. Collapsing to the
 * prefix makes the allocation the unit of accounting, which is what a limiter
 * actually wants to bound.
 *
 * Returns the input unchanged for IPv4 — a v4 address is already the unit.
 */
export function collapseIPv6Prefix(address: string, prefixBits = 64): string {
  if (!isIPv6Address(address)) return address;
  if (prefixBits >= 128) return address;

  const groups = expandIPv6(address);
  if (!groups) return address;

  const keptGroups = Math.max(0, Math.min(8, Math.ceil(prefixBits / 16)));
  const kept = groups.slice(0, keptGroups);
  // Zero the sub-prefix bits of the boundary group when the prefix does not
  // land on a 16-bit boundary, so /56 and /64 cannot produce the same key from
  // different networks.
  const remainder = prefixBits % 16;
  if (remainder !== 0 && kept.length > 0) {
    const mask = (0xffff << (16 - remainder)) & 0xffff;
    kept[kept.length - 1] = (parseInt(kept[kept.length - 1], 16) & mask)
      .toString(16)
      .padStart(4, "0");
  }
  return `${kept.join(":")}::/${prefixBits}`;
}

/** Expand a v6 address to eight 4-hex-digit groups. Null if unparseable. */
function expandIPv6(address: string): string[] | null {
  let value = address.toLowerCase();

  // Convert an IPv4-mapped tail into two hex groups so the group count is 8.
  const v4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (v4Tail) {
    const octets = v4Tail[1].split(".").map((o) => Number.parseInt(o, 10));
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16).padStart(4, "0");
    const lo = ((octets[2] << 8) | octets[3]).toString(16).padStart(4, "0");
    value = `${value.slice(0, v4Tail.index)}${hi}:${lo}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":").filter((g) => g !== "") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter((g) => g !== "") : [];

  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map(padGroup);
  }

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill("0"), ...tail].map(padGroup);
}

function padGroup(group: string): string {
  return group.padStart(4, "0");
}

/**
 * Pick the trusted entry from an `X-Forwarded-For` header.
 *
 * Counts from the RIGHT: `hops = 1` takes the last entry, which is what the
 * nearest proxy appended. Everything to its left is caller-authored text and
 * is discarded, not merely deprioritised.
 *
 * Returns null when the header is absent, empty, or has fewer entries than
 * `hops` — a header shorter than the configured hop count means the request
 * did not traverse the expected path, and guessing at that point would key on
 * attacker text.
 */
export function parseTrustedForwardedFor(header: string | null | undefined, hops = 1): string | null {
  if (!header) return null;
  const parts = String(header)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const index = parts.length - Math.max(1, Math.floor(hops));
  if (index < 0) return null;
  return parts[index];
}

export interface ResolveClientKeyOptions {
  /** How many proxies sit in front of this process. ACA Envoy ingress = 1. */
  trustedProxyHops?: number;
  /** Prefix width IPv6 addresses collapse to. */
  ipv6PrefixBits?: number;
  /** Address of the direct peer, when the runtime exposes one. */
  peerAddress?: string | null;
}

/**
 * Resolve the rate-limit key for a request.
 *
 * `headers` is anything with a case-insensitive `.get()` — a `Headers` instance
 * in practice. Taking the interface rather than the `Request` keeps this
 * testable without constructing one.
 */
export function resolveClientKey(
  headers: { get(name: string): string | null },
  opts: ResolveClientKeyOptions = {},
): ClientKeyResolution {
  const hops = opts.trustedProxyHops ?? 1;
  const prefixBits = opts.ipv6PrefixBits ?? 64;

  const forwarded = parseTrustedForwardedFor(headers.get("x-forwarded-for"), hops);
  if (forwarded) {
    const normalised = normaliseAddress(forwarded, prefixBits);
    if (normalised) {
      return {
        key: normalised,
        source: "forwarded",
        detail: `x-forwarded-for hop -${hops}`,
      };
    }
    return {
      key: UNKNOWN_CLIENT_KEY,
      source: "unknown",
      detail:
        `x-forwarded-for hop -${hops} was not a valid IP address. Rejected rather than ` +
        `used as a key: an unvalidated key is an unbounded-cardinality key.`,
    };
  }

  if (opts.peerAddress) {
    const normalised = normaliseAddress(opts.peerAddress, prefixBits);
    if (normalised) {
      return { key: normalised, source: "peer", detail: "direct peer address" };
    }
  }

  return {
    key: UNKNOWN_CLIENT_KEY,
    source: "unknown",
    detail:
      "No x-forwarded-for and no peer address. Every such request shares one bucket — " +
      "if this appears in production, the ingress is not forwarding the header and " +
      "RATE_LIMIT_TRUSTED_PROXY_HOPS is likely wrong.",
  };
}

/** Strip decoration, validate, and collapse. Null when not a valid address. */
export function normaliseAddress(raw: string, ipv6PrefixBits = 64): string | null {
  const stripped = stripAddressDecoration(raw);
  if (!stripped) return null;
  if (isIPv4Address(stripped)) return stripped;
  if (isIPv6Address(stripped)) return collapseIPv6Prefix(stripped, ipv6PrefixBits);
  return null;
}
