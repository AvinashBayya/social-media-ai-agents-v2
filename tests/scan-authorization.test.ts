/**
 * The deny paths come first on purpose.
 *
 * A gate tested only on the allow path is untested: every bug that matters here
 * is a case that should have been refused and was not.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ScanNotAuthorisedError,
  type ScanAuthorisation,
  assertScanAuthorised,
  cidrContains,
  findScanAuthorisation,
  ipv4ToInt,
  isPrivateOrReservedIPv4,
  isWithinDomain,
  normaliseScanTarget,
  parseCidr,
  recordCoversTarget,
  scanAuditEntry,
} from "../src/utils/scan-authorization";

const NOW = Date.parse("2026-08-17T12:00:00Z");

function auth(over: Partial<ScanAuthorisation> = {}): ScanAuthorisation {
  return {
    target: "example.com",
    scope: "active",
    authorisedBy: "Wg Cdr A. Sharma",
    reference: "IAF/PS18/AUTH/2026/014",
    grantedAt: "2026-08-01T00:00:00Z",
    expiresAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

describe("default deny", () => {
  test("an empty authorisation list refuses everything", () => {
    expect(() => assertScanAuthorised("example.com", [], NOW)).toThrow(ScanNotAuthorisedError);
  });

  test("an unlisted target is a gap, not a licence", () => {
    expect(() => assertScanAuthorised("other.com", [auth()], NOW)).toThrow(
      /no written authorisation covers this target/,
    );
  });

  test("an empty target string is refused rather than matching anything", () => {
    expect(() => assertScanAuthorised("   ", [auth({ target: "" })], NOW)).toThrow(
      /no target was supplied/,
    );
  });
});

describe("the subdomain-suffix trap", () => {
  test("an authorisation for example.com does NOT license notexample.com", () => {
    // A bare endsWith() would license scanning an unrelated organisation.
    expect(() => assertScanAuthorised("notexample.com", [auth()], NOW)).toThrow(
      ScanNotAuthorisedError,
    );
    expect(isWithinDomain("notexample.com", "example.com")).toBe(false);
  });

  test("it does cover the domain itself and its subdomains", () => {
    expect(assertScanAuthorised("example.com", [auth()], NOW).reference).toBe(
      "IAF/PS18/AUTH/2026/014",
    );
    expect(assertScanAuthorised("mail.eu.example.com", [auth()], NOW).scope).toBe("active");
  });
});

describe("expiry is mandatory and enforced", () => {
  test("an expired authorisation refuses, and says so distinctly", () => {
    const expired = auth({ expiresAt: "2026-08-16T00:00:00Z" });
    expect(() => assertScanAuthorised("example.com", [expired], NOW)).toThrow(
      /every authorisation covering it has expired/,
    );
  });

  test("expiry is exclusive at the boundary", () => {
    const atBoundary = auth({ expiresAt: "2026-08-17T12:00:00Z" });
    expect(() => assertScanAuthorised("example.com", [atBoundary], NOW)).toThrow(
      ScanNotAuthorisedError,
    );
  });

  test("an unparseable expiry is treated as EXPIRED, never as absent", () => {
    // A malformed date must never widen permission.
    const broken = auth({ expiresAt: "whenever" });
    expect(() => assertScanAuthorised("example.com", [broken], NOW)).toThrow(
      ScanNotAuthorisedError,
    );
  });

  test("a live record among expired ones still authorises", () => {
    const records = [auth({ expiresAt: "2026-01-01T00:00:00Z" }), auth()];
    expect(assertScanAuthorised("example.com", records, NOW).expiresAt).toBe(
      "2026-09-01T00:00:00Z",
    );
  });
});

describe("passive scope does not permit active scanning", () => {
  test("a passive authorisation refuses an active request, with its own reason", () => {
    const passive = auth({ scope: "passive" });
    expect(() => assertScanAuthorised("example.com", [passive], NOW, "active")).toThrow(
      /covered only by a passive-scope authorisation/,
    );
  });

  test("but it does permit a passive request", () => {
    const passive = auth({ scope: "passive" });
    expect(assertScanAuthorised("example.com", [passive], NOW, "passive").scope).toBe("passive");
  });

  test("an active authorisation also covers a passive request", () => {
    expect(findScanAuthorisation("example.com", [auth()], NOW, "passive")).not.toBeNull();
  });
});

describe("private and reserved ranges are refused by default", () => {
  test.each([
    ["169.254.169.254", "cloud instance metadata"],
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "RFC1918"],
    ["192.168.1.1", "RFC1918"],
    ["172.16.0.1", "RFC1918"],
    ["100.64.0.1", "CGNAT"],
    ["224.0.0.1", "multicast"],
    ["0.0.0.0", "this-network"],
  ])("%s (%s) is refused even WITH an authorisation", (ip) => {
    const record = auth({ target: "0.0.0.0/0" });
    expect(() => assertScanAuthorised(ip, [record], NOW)).toThrow(/private, loopback, link-local/);
  });

  test("the opt-in is explicit and per-call", () => {
    const record = auth({ target: "10.0.0.0/8" });
    expect(
      assertScanAuthorised("10.1.2.3", [record], NOW, "active", { allowPrivateRanges: true })
        .reference,
    ).toBe("IAF/PS18/AUTH/2026/014");
  });

  test("a public address is not caught by the private check", () => {
    expect(isPrivateOrReservedIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIPv4("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateOrReservedIPv4("100.128.0.1")).toBe(false); // just outside CGNAT
  });
});

describe("CIDR containment is arithmetic, not string matching", () => {
  test("a /24 record does not satisfy an address outside it", () => {
    expect(cidrContains("10.0.0.0/24", "10.0.5.7")).toBe(false);
    expect(cidrContains("10.0.0.0/24", "10.0.0.7")).toBe(true);
  });

  test("text-prefix lookalikes do not match", () => {
    // "192.168.1.1".startsWith("192.168.1.1") would wrongly match 192.168.1.10
    expect(cidrContains("192.168.1.10/32", "192.168.1.1")).toBe(false);
  });

  test("wide masks work — a signed shift would break these", () => {
    expect(cidrContains("10.0.0.0/8", "10.255.255.255")).toBe(true);
    expect(cidrContains("128.0.0.0/1", "200.1.1.1")).toBe(true);
    expect(cidrContains("128.0.0.0/1", "10.1.1.1")).toBe(false);
    expect(cidrContains("0.0.0.0/0", "1.2.3.4")).toBe(true);
  });

  test("malformed CIDRs match nothing rather than everything", () => {
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("999.0.0.0/8")).toBeNull();
    expect(parseCidr("not-a-cidr")).toBeNull();
    expect(cidrContains("not-a-cidr", "1.2.3.4")).toBe(false);
  });

  test("a CIDR record only ever matches an IP, never a hostname", () => {
    expect(recordCoversTarget(auth({ target: "8.8.8.0/24" }), "example.com")).toBe(false);
    expect(recordCoversTarget(auth({ target: "8.8.8.0/24" }), "8.8.8.8")).toBe(true);
  });

  test("ipv4ToInt rejects non-addresses", () => {
    expect(ipv4ToInt("1.2.3")).toBeNull();
    expect(ipv4ToInt("256.1.1.1")).toBeNull();
    expect(ipv4ToInt("1.2.3.4")).toBe(16909060);
  });
});

describe("target normalisation", () => {
  test.each([
    ["https://Example.COM/path?q=1", "example.com"],
    ["example.com.", "example.com"],
    ["example.com:8443", "example.com"],
    ["  EXAMPLE.com  ", "example.com"],
    ["[2001:db8::1]:443", "2001:db8::1"],
  ])("%s -> %s", (input, expected) => {
    expect(normaliseScanTarget(input)).toBe(expected);
  });

  test("a URL form still resolves to the authorised domain", () => {
    expect(assertScanAuthorised("https://mail.example.com/inbox", [auth()], NOW).scope).toBe(
      "active",
    );
  });
});

describe("audit record", () => {
  test("carries who authorised it, under what reference, and when", () => {
    const entry = scanAuditEntry("https://Example.com/x", auth(), "ivre", NOW);
    expect(entry).toEqual({
      target: "example.com",
      scope: "active",
      authorisedBy: "Wg Cdr A. Sharma",
      reference: "IAF/PS18/AUTH/2026/014",
      at: "2026-08-17T12:00:00.000Z",
      collector: "ivre",
    });
  });
});

describe("the module stays a dependency-free leaf", () => {
  test("no imports and no require", () => {
    // A gate that fails to load enforces nothing. attack-surface.ts and
    // recon-sources.ts both import createServerFn, and depending on them would
    // put this module in that chunk graph — the hazard that produced the
    // bun:sqlite HTTP 500 on the Node runtime.
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "utils", "scan-authorization.ts"),
      "utf-8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\s*\(/);
    // Guard the guard: a naive // strip would truncate at https:// and make the
    // assertions above vacuously pass.
    expect(code).toContain("export function assertScanAuthorised");
  });
});
