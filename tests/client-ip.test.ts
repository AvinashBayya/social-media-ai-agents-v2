import { describe, expect, it } from "bun:test";

import {
  UNKNOWN_CLIENT_KEY,
  collapseIPv6Prefix,
  isIPv4Address,
  isIPv6Address,
  normaliseAddress,
  parseTrustedForwardedFor,
  resolveClientKey,
  stripAddressDecoration,
} from "../src/utils/client-ip";

/** Minimal stand-in for a `Headers` instance. */
function headers(map: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

describe("address validation", () => {
  it("accepts dotted quads and rejects out-of-range octets", () => {
    expect(isIPv4Address("203.0.113.7")).toBe(true);
    expect(isIPv4Address("255.255.255.255")).toBe(true);
    expect(isIPv4Address("256.0.0.1")).toBe(false);
    expect(isIPv4Address("1.2.3")).toBe(false);
    expect(isIPv4Address("not-an-ip")).toBe(false);
  });

  it("accepts compressed and IPv4-mapped IPv6", () => {
    expect(isIPv6Address("2001:db8::1")).toBe(true);
    expect(isIPv6Address("::1")).toBe(true);
    expect(isIPv6Address("::ffff:192.0.2.1")).toBe(true);
    expect(isIPv6Address("2001:db8:::1")).toBe(false);
  });
});

describe("stripAddressDecoration", () => {
  it("strips a port from IPv4", () => {
    expect(stripAddressDecoration("203.0.113.7:44321")).toBe("203.0.113.7");
  });

  it("strips brackets and port from IPv6", () => {
    expect(stripAddressDecoration("[2001:db8::1]:44321")).toBe("2001:db8::1");
    expect(stripAddressDecoration("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it("does NOT truncate a bare IPv6 address at its first colon", () => {
    // The naive `split(":")[0]` bug would return "2001" here and collapse the
    // entire v6 internet into a handful of buckets.
    expect(stripAddressDecoration("2001:db8::1")).toBe("2001:db8::1");
  });
});

describe("collapseIPv6Prefix", () => {
  it("collapses distinct addresses in one /64 to the same key", () => {
    const a = collapseIPv6Prefix("2001:db8:0:1::dead", 64);
    const b = collapseIPv6Prefix("2001:db8:0:1::beef", 64);
    expect(a).toBe(b);
  });

  it("keeps different /64s distinct", () => {
    const a = collapseIPv6Prefix("2001:db8:0:1::1", 64);
    const b = collapseIPv6Prefix("2001:db8:0:2::1", 64);
    expect(a).not.toBe(b);
  });

  it("masks the boundary group on a non-16-bit-aligned prefix", () => {
    const a = collapseIPv6Prefix("2001:db8:0:0100::1", 56);
    const b = collapseIPv6Prefix("2001:db8:0:01ff::1", 56);
    expect(a).toBe(b);
  });

  it("leaves IPv4 untouched", () => {
    expect(collapseIPv6Prefix("203.0.113.7", 64)).toBe("203.0.113.7");
  });
});

describe("parseTrustedForwardedFor", () => {
  const forged = "1.1.1.1, 2.2.2.2, 203.0.113.7";

  it("takes the RIGHTMOST hop, not the leftmost", () => {
    // The leftmost entry is entirely caller-supplied. h3's
    // getRequestIP({xForwardedFor:true}) takes it, which is why this module
    // exists.
    expect(parseTrustedForwardedFor(forged, 1)).toBe("203.0.113.7");
    expect(parseTrustedForwardedFor(forged, 1)).not.toBe("1.1.1.1");
  });

  it("counts additional hops from the right", () => {
    expect(parseTrustedForwardedFor(forged, 2)).toBe("2.2.2.2");
    expect(parseTrustedForwardedFor(forged, 3)).toBe("1.1.1.1");
  });

  it("returns null when the header has fewer entries than the hop count", () => {
    expect(parseTrustedForwardedFor("203.0.113.7", 2)).toBeNull();
  });

  it("returns null for absent or empty headers", () => {
    expect(parseTrustedForwardedFor(null, 1)).toBeNull();
    expect(parseTrustedForwardedFor("", 1)).toBeNull();
    expect(parseTrustedForwardedFor("  ,  ,  ", 1)).toBeNull();
  });
});

describe("resolveClientKey", () => {
  it("keys on the trusted hop", () => {
    const res = resolveClientKey(headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }));
    expect(res.key).toBe("203.0.113.7");
    expect(res.source).toBe("forwarded");
  });

  it("cannot be bypassed by prepending forged entries", () => {
    const a = resolveClientKey(headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.7" }));
    const b = resolveClientKey(headers({ "x-forwarded-for": "8.8.8.8, 203.0.113.7" }));
    // Different forged prefixes must NOT produce different buckets.
    expect(a.key).toBe(b.key);
  });

  it("rejects a non-IP trusted hop rather than keying on it", () => {
    const res = resolveClientKey(headers({ "x-forwarded-for": "not-an-address" }));
    expect(res.key).toBe(UNKNOWN_CLIENT_KEY);
    expect(res.source).toBe("unknown");
    expect(res.detail).toContain("unbounded-cardinality");
  });

  it("falls back to the peer address when no header is present", () => {
    const res = resolveClientKey(headers({}), { peerAddress: "203.0.113.9" });
    expect(res.key).toBe("203.0.113.9");
    expect(res.source).toBe("peer");
  });

  it("reports an actionable reason when nothing is resolvable", () => {
    const res = resolveClientKey(headers({}));
    expect(res.key).toBe(UNKNOWN_CLIENT_KEY);
    expect(res.detail).toContain("RATE_LIMIT_TRUSTED_PROXY_HOPS");
  });

  it("collapses IPv6 callers to their prefix", () => {
    const a = resolveClientKey(headers({ "x-forwarded-for": "[2001:db8:0:1::1]:443" }));
    const b = resolveClientKey(headers({ "x-forwarded-for": "[2001:db8:0:1::2]:443" }));
    expect(a.key).toBe(b.key);
  });
});

describe("normaliseAddress", () => {
  it("returns null for anything that is not an address", () => {
    expect(normaliseAddress("example.com")).toBeNull();
    expect(normaliseAddress("")).toBeNull();
    expect(normaliseAddress("../../etc/passwd")).toBeNull();
  });
});
