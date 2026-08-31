/**
 * contact.domain — Person Investigation collector.
 *
 * The task's spec was "reuse existing RDAP + a self-hosted Wappalyzer tech
 * check." RDAP is already fully covered by the existing, separately
 * registered `rdap` collector (`collectors/existing/rdap.ts`,
 * `supportedTargetTypes: ["domain"]`) — this file does NOT re-query RDAP or
 * duplicate that collector's entities; doing so would register two
 * `domain`-typed collectors both firing on every domain investigation and
 * double up results, which PERSON-INVESTIGATION-ANALYSIS.md §12 flagged as
 * the wrong shape of "reuse." `registerPersonCollectors()` (`person/index.ts`)
 * registers this file's collector *alongside* the existing `rdap` one, not
 * instead of it — both run, neither duplicates the other's work.
 *
 * What this file actually adds: a small, self-hosted (no third-party API
 * call, no Wappalyzer npm dependency — that package's fingerprint database
 * is large and its licence/maintenance status wasn't evaluated) HTTP-
 * response-header and HTML-source signature check. This is a genuinely
 * smaller signature set than full Wappalyzer — disclosed explicitly in
 * `metadata.disclosure` on every result, not presented as parity.
 */

import { toHostname } from "../../attack-surface";
import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 200_000; // enough for <head> plus a good chunk of <body>, bounded

/** Each signature: a short label, and a test against headers + a capped slice of the HTML body. */
const SIGNATURES: Array<{
  label: string;
  test: (headers: Headers, body: string) => boolean;
}> = [
  { label: "WordPress", test: (_h, b) => /wp-content|wp-includes/i.test(b) },
  { label: "Shopify", test: (_h, b) => /cdn\.shopify\.com|Shopify\.theme/i.test(b) },
  { label: "Next.js", test: (_h, b) => /__NEXT_DATA__/.test(b) },
  { label: "React", test: (_h, b) => /data-reactroot|react-dom/i.test(b) },
  { label: "Vue.js", test: (_h, b) => /data-v-app|__VUE__/i.test(b) },
  { label: "Cloudflare", test: (h) => Boolean(h.get("cf-ray") || h.get("server")?.toLowerCase().includes("cloudflare")) },
  { label: "Nginx", test: (h) => Boolean(h.get("server")?.toLowerCase().includes("nginx")) },
  { label: "Apache", test: (h) => Boolean(h.get("server")?.toLowerCase().includes("apache")) },
  { label: "Google Analytics", test: (_h, b) => /gtag\(|google-analytics\.com|googletagmanager\.com/i.test(b) },
  { label: "jQuery", test: (_h, b) => /jquery(\.min)?\.js/i.test(b) },
  { label: "Bootstrap", test: (_h, b) => /bootstrap(\.min)?\.css|bootstrap(\.min)?\.js/i.test(b) },
];

const DISCLOSURE =
  "A small, self-hosted, fixed signature set (11 technologies) checked against response " +
  "headers and a capped slice of the HTML source — not a Wappalyzer integration and not " +
  "parity with its much larger fingerprint database. Absence of a match means none of these " +
  "11 signatures fired, not that the site uses nothing.";

export interface ContactDomainRaw {
  domain: string;
  reachable: boolean;
  statusCode: number | null;
  detected: string[];
  serverHeader: string | null;
}

export const contactDomainCollector: Collector<ContactDomainRaw> = {
  id: "contact.domain",
  name: "Contact — Domain tech check (self-hosted signatures)",
  category: "infrastructure",
  supportedTargetTypes: ["domain"],
  requiresCredentials: false,
  isOptional: true,

  capability: {
    sourceId: "contact.domain",
    name: "Contact — Domain tech check",
    collectionMode: "PASSIVE_PUBLIC_WEB",
    activeCapable: false,
    allowed: true,
    requiresAuth: false,
    requiresManualAction: false,
    apiAvailable: true,
    notes:
      "An ordinary GET of the domain's own homepage — the same request any browser visitor makes — checked against a small, self-hosted, fixed signature set. No port scan, no third-party API.",
  },

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<ContactDomainRaw>> {
    const clock = startExecution();
    const hostname = toHostname(target.value);
    if (!hostname) {
      const err = new CollectorError("contact.domain", "invalid-target", `Could not read a hostname from "${target.value}".`);
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    try {
      const res = await fetch(`https://${hostname}/`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "Mozilla/5.0 (compatible; SentinelAI-PersonInvestigation/1.0)" },
      });
      const bodyFull = await res.text();
      const body = bodyFull.slice(0, MAX_BODY_CHARS);
      const detected = SIGNATURES.filter((s) => s.test(res.headers, body)).map((s) => s.label);
      return {
        execution: finishExecution(clock, "completed", detected.length),
        raw: {
          domain: hostname,
          reachable: true,
          statusCode: res.status,
          detected,
          serverHeader: res.headers.get("server"),
        },
      };
    } catch (err) {
      // A domain that doesn't serve HTTP at all is a real, reportable finding
      // (reachable: false), not a collector failure — the domain itself was
      // successfully investigated, it simply has no live web server.
      const classified = classifyError("contact.domain", err);
      if (classified.reason === "timeout" || classified.reason === "upstream-error") {
        return {
          execution: finishExecution(clock, "completed", 0),
          raw: { domain: hostname, reachable: false, statusCode: null, detected: [], serverHeader: null },
        };
      }
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const r = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const domainId = `contact.domain:domain:${r.domain}`;
    const entities: CollectorEntity[] = [
      {
        id: domainId,
        type: "domain",
        value: r.domain,
        displayName: r.domain,
        source: "contact.domain",
        confidence: UNSCORED,
        metadata: { reachable: r.reachable, detected: r.detected, disclosure: DISCLOSURE },
      },
    ];
    const evidence: CollectorEvidence[] = [
      {
        source: `https://${r.domain}/ (headers + HTML signatures)`,
        sourceUrl: r.reachable ? `https://${r.domain}/` : null,
        collector: "contact.domain",
        collectedAt,
        rawValue: r,
        normalizedValue: { reachable: r.reachable, detected: r.detected, serverHeader: r.serverHeader },
        confidence: null,
        metadata: { disclosure: DISCLOSURE },
      },
    ];

    return InvestigationResultSchema.parse({
      entities,
      relationships: [],
      evidence,
      warnings: r.reachable
        ? r.detected.length === 0
          ? [`${r.domain} answered but matched none of this collector's 11 tech signatures.`]
          : []
        : [`${r.domain} did not answer an HTTPS request — no live web server, or it refused the connection.`],
      errors: [],
      metadata: { domain: r.domain },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch("https://example.com/", { signal: AbortSignal.timeout(5_000) });
      return res.ok
        ? { state: "ready", detail: "Test HTTPS fetch succeeded", checkedAt }
        : { state: "degraded", detail: `Test fetch returned HTTP ${res.status}`, checkedAt };
    } catch (err) {
      return { state: "unavailable", detail: classifyError("contact.domain", err).message, checkedAt };
    }
  },
};
