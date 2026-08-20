/**
 * Authorisation gate for ACTIVE scanning.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT OPTIONAL.
 *
 * Every Module 2 collector in this system up to now has been **passive**: it
 * reads a third-party record *about* a target — Certificate Transparency logs,
 * RDAP, Shodan's InternetDB — and never sends the target a packet. That is what
 * makes them usable without an engagement authorisation, and `recon-sources.ts`
 * says so in its own header.
 *
 * IVRE/Nmap breaks that property. It puts packets on the wire aimed at a host
 * someone else owns. In most jurisdictions that is lawful only with the owner's
 * permission, and for a system built for the Indian Air Force the standard is
 * higher than "probably fine" — it is a named authorising officer and a written
 * reference. This module is where that is enforced, and no scanning collector
 * may reach the network without passing through it.
 *
 * THE STANCE, MIRRORING `collection-policy.ts`. There, `policyFor()` returning
 * null means "no policy has been written", which callers must read as DENY and
 * never as "unrestricted" — that inversion is how an unreviewed source ends up
 * collected by default. Same here: an unlisted target is a gap, not a licence.
 *
 * DELIBERATELY A LEAF MODULE WITH ZERO IMPORTS.
 *
 * The obvious reuse — `isPrivateIPv4` from `attack-surface.ts`, `isWithinDomain`
 * from `recon-sources.ts` — was considered and REJECTED. Both of those files
 * import `createServerFn` from `@tanstack/react-start`, so importing them here
 * would make this module an edge into that graph. This project has now been
 * bitten twice by exactly that: `bun:sqlite` reaching the browser bundle, and
 * then `collector-health.ts` importing `gps-interference.ts`, which re-chunked
 * `bun:sqlite` into an SSR chunk and answered HTTP 500 on the Node runtime.
 * A gate that fails to load is a gate that is not enforcing anything, so this
 * one depends on nothing. The duplicated predicates below are small, pure and
 * directly tested. **Do not add an import to this file.**
 */

// ─── Vocabulary ────────────────────────────────────────────────────────────

/**
 * What a given authorisation permits.
 *
 * `passive` is recorded rather than assumed because an authorisation narrowed
 * to passive collection is a real and common outcome of an approval process,
 * and silently upgrading it to active is the failure this module prevents.
 */
export type ScanScope = "passive" | "active";

export interface ScanAuthorisation {
  /** Exact hostname, exact IPv4, or IPv4 CIDR. Never a wildcard or a pattern. */
  target: string;
  scope: ScanScope;
  /**
   * The NAMED individual who authorised this. Never a role ("SOC"), never a
   * team, never blank — accountability that cannot name a person is not
   * accountability, and a role name cannot be asked what it approved.
   */
  authorisedBy: string;
  /** Reference to the written authorisation this record stands for. */
  reference: string;
  grantedAt: string;
  /**
   * REQUIRED, and deliberately not nullable.
   *
   * An authorisation with no end is not an authorisation, it is a standing
   * permission nobody revisits. Every other "missing means unknown" field in
   * this codebase is `| null`; this one is not, because there is no honest
   * reading of "expiry not recorded" that permits a scan.
   */
  expiresAt: string;
}

/** Thrown on any refusal. Never swallowed, never downgraded to an empty result. */
export class ScanNotAuthorisedError extends Error {
  constructor(
    readonly target: string,
    /** Operator-facing reason. Authored here, never built from upstream text. */
    readonly reason: string,
  ) {
    super(`Active scan of "${target}" refused: ${reason}`);
    this.name = "ScanNotAuthorisedError";
  }
}

// ─── Target normalisation ──────────────────────────────────────────────────

/** Lowercase, strip scheme, port, path, brackets and a trailing dot. */
export function normaliseScanTarget(raw: string): string {
  let value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "";
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/\/.*$/, "");
  value = value.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1");
  // Strip a port only when it cannot be part of the address itself.
  if (/^[^:]+:\d{1,5}$/.test(value)) value = value.replace(/:\d{1,5}$/, "");
  return value.replace(/\.$/, "");
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isIPv4(value: string): boolean {
  return IPV4_RE.test(value);
}

/** Dotted quad to a 32-bit integer. Null when not a valid IPv4. */
export function ipv4ToInt(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

export interface ParsedCidr {
  base: number;
  bits: number;
}

/**
 * Parse `a.b.c.d/n`. Null when malformed.
 *
 * Parsing and policy are separate concerns: a `/0` parses fine here and is
 * refused by `assertScanAuthorised`.
 */
export function parseCidr(value: string): ParsedCidr | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const base = ipv4ToInt(match[1]);
  const bits = Number(match[2]);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return { base, bits };
}

/**
 * True when `ip` falls inside `cidr`.
 *
 * Containment is computed on masked integers. It is deliberately NOT string
 * prefix matching: a record for `10.0.0.0/24` must not satisfy a request for
 * `10.0.5.7`, and `192.168.1.1` must not match a record for `192.168.1.10`
 * merely because one is a text prefix of the other.
 */
export function cidrContains(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  const addr = ipv4ToInt(ip);
  if (!parsed || addr === null) return false;
  if (parsed.bits === 0) return true;
  // `>>>` keeps the mask unsigned; a signed shift breaks /1 through /8.
  const mask = (0xffffffff << (32 - parsed.bits)) >>> 0;
  return ((parsed.base & mask) >>> 0) === ((addr & mask) >>> 0);
}

/**
 * True when `host` IS `domain` or a subdomain of it.
 *
 * A bare `host.endsWith(domain)` is wrong and dangerous: for `example.com` it
 * also matches `notexample.com`, which would let an authorisation for one
 * organisation license scanning another. `recon-sources.ts` carries the same
 * predicate for the same reason; duplicated rather than imported per the header.
 */
export function isWithinDomain(host: string, domain: string): boolean {
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * RFC1918, loopback, link-local, CGNAT, multicast and 0.0.0.0/8.
 *
 * Link-local matters most: `169.254.169.254` is the cloud instance-metadata
 * address, and reaching it from inside a container is how the Mastodon SSRF in
 * this codebase became interesting rather than theoretical.
 */
export function isPrivateOrReservedIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

// ─── Matching ──────────────────────────────────────────────────────────────

function isExpired(record: ScanAuthorisation, now: number): boolean {
  const expiry = Date.parse(record.expiresAt);
  // An unparseable expiry is treated as EXPIRED, not as absent. A malformed
  // date must never widen permission.
  if (!Number.isFinite(expiry)) return true;
  return expiry <= now;
}

/** Whether one record covers this target, ignoring expiry and scope. */
export function recordCoversTarget(record: ScanAuthorisation, target: string): boolean {
  const authorised = normaliseScanTarget(record.target);
  if (!authorised) return false;
  if (parseCidr(record.target)) return isIPv4(target) && cidrContains(record.target, target);
  if (isIPv4(authorised)) return authorised === target;
  return isWithinDomain(target, authorised);
}

/**
 * The authorisation covering `target`, or null.
 *
 * Null means **no record covers this**, which callers must read as deny. It
 * never means "unrestricted" — see the module header.
 */
export function findScanAuthorisation(
  target: string,
  records: readonly ScanAuthorisation[],
  now: number,
  scope: ScanScope = "active",
): ScanAuthorisation | null {
  const clean = normaliseScanTarget(target);
  if (!clean) return null;
  return (
    records.find(
      (r) =>
        !isExpired(r, now) &&
        // An `active` request is NOT satisfied by a `passive` authorisation.
        // A `passive` request is satisfied by either.
        (scope === "passive" || r.scope === "active") &&
        recordCoversTarget(r, clean),
    ) ?? null
  );
}

export interface AssertScanOptions {
  /**
   * Permit RFC1918/loopback targets. Off by default.
   *
   * Exists for scanning a lab range you own. It is an explicit per-call opt-in
   * precisely so that enabling it is visible at the call site rather than being
   * a config flag nobody reads.
   */
  allowPrivateRanges?: boolean;
}

/**
 * Throw unless `target` is covered by a live authorisation. Returns the record
 * that permitted it, so the caller can write it into the audit entry.
 *
 * `now` is injected — no `Date.now()` here, so expiry logic is testable, the
 * same convention `rate-limit.ts` and `credibility.ts` already follow.
 */
export function assertScanAuthorised(
  target: string,
  records: readonly ScanAuthorisation[],
  now: number,
  scope: ScanScope = "active",
  opts: AssertScanOptions = {},
): ScanAuthorisation {
  const clean = normaliseScanTarget(target);
  if (!clean) {
    throw new ScanNotAuthorisedError(String(target ?? ""), "no target was supplied");
  }

  if (isIPv4(clean) && isPrivateOrReservedIPv4(clean) && !opts.allowPrivateRanges) {
    throw new ScanNotAuthorisedError(
      clean,
      "it is a private, loopback, link-local or reserved address. Scanning cloud " +
        "instance metadata (169.254.169.254) or internal ranges is refused by default; " +
        "pass allowPrivateRanges only for a lab range you own.",
    );
  }

  const match = findScanAuthorisation(clean, records, now, scope);
  if (match) return match;

  // Distinguish the three refusal causes: they need different responses, and a
  // single "not authorised" would send an operator to renew a record that was
  // never written, or to write one that only needed renewing.
  const covering = records.filter((r) => recordCoversTarget(r, clean));
  if (covering.length === 0) {
    throw new ScanNotAuthorisedError(
      clean,
      "no written authorisation covers this target. An unlisted target is a gap in " +
        "the authorisation record, never a permission to scan.",
    );
  }
  const expired = covering.filter((r) => isExpired(r, now));
  if (expired.length === covering.length) {
    const latest = expired.map((r) => r.expiresAt).sort().pop();
    throw new ScanNotAuthorisedError(
      clean,
      `every authorisation covering it has expired (latest expiry ${latest}). Renew the ` +
        "written authorisation before scanning again.",
    );
  }
  throw new ScanNotAuthorisedError(
    clean,
    "it is covered only by a passive-scope authorisation, which does not permit active " +
      "scanning. Passive collection may proceed; packets to the target may not.",
  );
}

// ─── Audit ─────────────────────────────────────────────────────────────────

/**
 * One immutable record of a scan having been permitted.
 *
 * This project has NO audit trail anywhere — `collection-policy.ts` says so in
 * as many words about YouTube downloads ("there is no audit trail in this
 * build"). Active scanning is where that stops being acceptable: "who scanned
 * this host, when, and under whose authority" must have an answer that is not
 * somebody's memory.
 *
 * Building the record is separated from writing it so this module stays pure
 * and import-free; the caller persists it.
 */
export interface ScanAuditEntry {
  target: string;
  scope: ScanScope;
  authorisedBy: string;
  reference: string;
  /** When the scan was permitted — the moment of THIS decision. */
  at: string;
  collector: string;
}

export function scanAuditEntry(
  target: string,
  authorisation: ScanAuthorisation,
  collector: string,
  now: number,
): ScanAuditEntry {
  return {
    target: normaliseScanTarget(target),
    scope: authorisation.scope,
    authorisedBy: authorisation.authorisedBy,
    reference: authorisation.reference,
    at: new Date(now).toISOString(),
    collector,
  };
}
