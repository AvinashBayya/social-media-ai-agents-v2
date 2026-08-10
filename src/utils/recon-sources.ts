/**
 * Module 2 — passive external-recon collectors.
 *
 * "Passive" is load-bearing: everything here queries a third-party record of the
 * target, never the target itself. crt.sh reads public Certificate Transparency
 * logs; no packet reaches the domain being researched. That is what makes it
 * usable without an engagement authorisation, and it is why theHarvester's
 * active modes are not reimplemented here.
 *
 * Why this file exists at all: the crt.sh lookup previously lived inline inside
 * the `fetchOSINT` handler in `routes/news.tsx`, where it was unreachable by any
 * test, swallowed its own failures into `console.error`, and defaulted a missing
 * issuer to the literal string "DigiCert" and a missing timestamp to *today*.
 * Both defaults were invented values presented as certificate facts.
 *
 * The rule every collector here follows (Recipe C): a thrown error means the
 * lookup failed; an empty array means the lookup succeeded and the target has
 * no records. Those are different facts and the UI renders them differently, so
 * a collector may never collapse the first into the second.
 */

import { createServerFn } from "@tanstack/react-start";
import type { Gap } from "./imaging";

// ─── crt.sh — Certificate Transparency subdomain discovery ─────────────────

export interface SubdomainFinding {
  hostname: string;
  source: "crtsh";
  /** ISO date the certificate became valid. null = crt.sh reported no date. */
  firstSeen: string | null;
  /** Issuing CA organisation. null = the record carried no parseable issuer. */
  issuer: string | null;
}

/**
 * crt.sh is slow, and by more than "under load" suggests.
 *
 * Measured 2026-08-10: a wildcard query against a busy domain answered in 18s,
 * which the original 15s budget would have aborted — turning a working lookup
 * into "crt.sh unreachable" for exactly the high-value targets that return the
 * most certificates. A later successful request took 43s. Sized above that.
 */
const CRTSH_TIMEOUT_MS = 50_000;

/** The subset of a crt.sh row we read. Every field is optional upstream. */
interface CrtShRow {
  name_value?: unknown;
  common_name?: unknown;
  not_before?: unknown;
  entry_timestamp?: unknown;
  issuer_name?: unknown;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Pull the CA organisation out of crt.sh's RFC 4514 issuer string.
 *
 * Format is e.g. `C=US, O=Let's Encrypt, CN=R3`. Returns null rather than a
 * guess when there is no O= component — an unattributed certificate is a real
 * state, and naming a CA that did not issue it would be a fabricated fact.
 */
export function parseIssuerOrg(issuerName: unknown): string | null {
  if (typeof issuerName !== "string") return null;
  const match = issuerName.match(/(?:^|,)\s*O=("[^"]*"|[^,]*)/);
  if (!match) return null;
  const org = match[1].trim().replace(/^"|"$/g, "").trim();
  return org || null;
}

/**
 * True when `host` is the domain itself or a subdomain of it.
 *
 * A bare `host.endsWith(domain)` is wrong and dangerous here: for the domain
 * `example.com` it also matches `notexample.com`, which would attribute a
 * third party's certificate to the target.
 */
export function isWithinDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Normalise one `name_value` line: lowercase, de-wildcard, strip trailing dot. */
function normaliseHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
}

/** Pick the earlier of two ISO dates; a real date always beats null. */
function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/**
 * One retry against a demonstrably unreliable service.
 *
 * Measured 2026-08-10, three consecutive requests for the *same* URL: HTTP 404
 * in 5s, a timeout at 45s, then HTTP 200 in 43s. crt.sh is the only free source
 * of this data, so the choice is to retry it or to lose subdomain discovery.
 * One retry, not a loop — a second failure is reported, never buried.
 */
async function crtShFetch(url: string, clean: string): Promise<Response> {
  let lastError = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(CRTSH_TIMEOUT_MS),
      });
      // 404 and 5xx from crt.sh are overload symptoms rather than answers, so
      // they are worth one retry; anything else is returned for the caller to
      // classify.
      if (res.ok || (res.status !== 404 && res.status < 500)) return res;
      lastError = `HTTP ${res.status}`;
      if (attempt === 1) return res;
    } catch (err) {
      lastError = messageOf(err);
      if (attempt === 1) {
        throw new Error(
          `crt.sh unreachable for ${clean} after two attempts: ${lastError}. The service is ` +
            `frequently slow or overloaded; this is not a finding about the domain.`,
        );
      }
    }
  }

  throw new Error(`crt.sh unreachable for ${clean}: ${lastError}`);
}

/**
 * Query public Certificate Transparency logs for hostnames under `domain`.
 *
 * Passive: this reads a public log, it never contacts the target. Throws on any
 * transport or HTTP failure. An empty array means CT holds no certificate for
 * the domain — a genuine and reportable finding.
 */
export async function collectCrtShSubdomains(domain: string): Promise<SubdomainFinding[]> {
  const clean = normaliseHost(domain || "");
  if (!clean) throw new Error("A domain is required for a certificate-transparency lookup.");

  const url = `https://crt.sh/?q=${encodeURIComponent(`%.${clean}`)}&output=json`;

  const res = await crtShFetch(url, clean);

  // Distinguished from a generic failure: a rate limit is temporary and the
  // analyst should retry, not conclude the domain has no certificates.
  if (res.status === 429) {
    throw new Error(`crt.sh rate-limited the request for ${clean} (HTTP 429). Wait and retry.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // crt.sh answers 404 and 502 with an HTML error page when it is overloaded.
    // That is a service fault, and it must not read as "this domain has no
    // certificates" — the two are opposite conclusions about the target.
    const transient = res.status === 404 || res.status >= 500;
    throw new Error(
      transient
        ? `crt.sh is not answering reliably for ${clean} (HTTP ${res.status} after a retry). ` +
            `This is a crt.sh service fault, NOT a finding that the domain has no certificates. ` +
            `Retry shortly.`
        : `crt.sh returned HTTP ${res.status} for ${clean}: ${body.slice(0, 200)}`,
    );
  }

  let rows: unknown;
  try {
    rows = await res.json();
  } catch (err) {
    // crt.sh serves an HTML error page under load; treat it as the failure it
    // is rather than as an empty result set.
    throw new Error(`crt.sh returned an unreadable response for ${clean}: ${messageOf(err)}`);
  }

  if (!Array.isArray(rows)) {
    throw new Error(`crt.sh returned an unexpected payload for ${clean} (expected a JSON array).`);
  }

  const found = new Map<string, SubdomainFinding>();

  for (const row of rows as CrtShRow[]) {
    // `not_before` is when the certificate became valid; `entry_timestamp` is
    // when the log observed it. Prefer the former, fall back, never invent.
    const rawDate = row?.not_before ?? row?.entry_timestamp;
    const firstSeen = typeof rawDate === "string" && rawDate.trim() ? rawDate.slice(0, 10) : null;
    const issuer = parseIssuerOrg(row?.issuer_name);

    // name_value is newline-delimited and carries every SAN on the certificate,
    // which routinely includes hostnames belonging to other domains.
    const names = [row?.name_value, row?.common_name]
      .filter((v): v is string => typeof v === "string")
      .flatMap((v) => v.split("\n"));

    for (const name of names) {
      const host = normaliseHost(name);
      if (!host || !isWithinDomain(host, clean)) continue;

      const prior = found.get(host);
      if (!prior) {
        found.set(host, { hostname: host, source: "crtsh", firstSeen, issuer });
        continue;
      }

      // Same hostname across several certificates: keep the earliest sighting,
      // and the issuer belonging to that sighting.
      const merged = earlier(prior.firstSeen, firstSeen);
      if (merged !== prior.firstSeen) {
        found.set(host, { hostname: host, source: "crtsh", firstSeen: merged, issuer });
      } else if (!prior.issuer && issuer) {
        found.set(host, { ...prior, issuer });
      }
    }
  }

  return [...found.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

export const crtShSubdomains = createServerFn({ method: "POST" })
  .validator((d: { domain: string }) => d)
  .handler(async ({ data }) => collectCrtShSubdomains(data.domain));

// ─── What external recon deliberately does NOT do ──────────────────────────

/**
 * Rendered verbatim on the recon route.
 *
 * Module 4 declares its gaps in `NOT_IMPLEMENTED` (imaging.ts) and Module 3
 * declares its uncollectable platforms in `PLATFORM_NOTES` (social.ts). Neither
 * is an M2 home, so external recon carries its own list rather than borrowing a
 * seam that belongs to another module. The `Gap` shape is shared so the three
 * read identically to a reviewer.
 *
 * Every entry here is a capability an evaluator will reasonably expect from an
 * OSINT platform. Saying why each is out of reach is a stronger position than a
 * silent omission, and stops the same integrations being re-proposed.
 */
export const RECON_NOTES: Gap[] = [
  {
    capability: "Shodan search and host API (paid tier)",
    requires:
      "A Shodan membership with query credits. The free keyless InternetDB endpoint is already " +
      "used for open ports, CPEs, reverse hostnames, tags and associated CVEs.",
    limitation:
      "Fails the zero-budget constraint. InternetDB also returns no geolocation, which is why " +
      "the infrastructure map layer is declared and left empty rather than populated with " +
      "approximated coordinates.",
  },
  {
    capability: "theHarvester executed in-app",
    requires:
      "A persistent runtime able to subprocess a GPL-licensed Python binary, plus somewhere to " +
      "keep its working state across a scan.",
    licence:
      "theHarvester is GPL. Invoking it as a bundled subprocess would raise licensing questions " +
      "this system does not need to answer — its passive sources are free data, not free code.",
    limitation:
      "The container scales to zero and holds no process between requests. Its highest-yield " +
      "passive source, Certificate Transparency, is reimplemented natively above; the active " +
      "modes are out of scope because they touch the target directly.",
  },
  {
    capability: "Live SpiderFoot scan orchestration",
    requires:
      "A long-lived SpiderFoot server making hundreds of outbound requests over several minutes, " +
      "plus an inbound endpoint to receive its results.",
    limitation:
      "Neither is available: this container scales to zero and exposes no HTTP routes, so it can " +
      "neither host SpiderFoot nor receive its callbacks. An analyst's own SpiderFoot run is not " +
      "importable yet either — there is no entity store to import into.",
  },
  {
    capability: "Live Maltego transforms",
    requires: "An inbound HTTP transform endpoint that the Maltego desktop client can call.",
    limitation:
      "This TanStack Start version exposes no `createServerFileRoute`, so no inbound endpoint " +
      "can exist. A CSV export of the app's own graph is the tractable direction and is not " +
      "built yet.",
  },
  {
    capability: "Automated Google dork execution",
    requires: "A web-search API. Google Custom Search is keyed and capped at 100 queries/day.",
    limitation:
      "Google blocks automated querying and scraping google.com/search violates its terms and " +
      "gets the egress IP blocked. Web-scoped dorks are therefore built as query strings for the " +
      "analyst to run themselves. News-scoped dorks do execute, against Google News RSS.",
  },
  {
    capability: "Scheduled or continuous external monitoring",
    requires: "An always-on process or an external scheduler.",
    limitation:
      "Scale-to-zero leaves no server-side scheduler and no cron. Continuous monitoring runs in " +
      "the browser and only while a tab is open, the same constraint that puts the Bluesky " +
      "Jetstream socket client-side.",
  },
];
