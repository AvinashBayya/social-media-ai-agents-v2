/**
 * theHarvester adapter — OSINT-INTEGRATION-PLAN.md §13.
 *
 * **Read this before assuming theHarvester is "wired up."** This is a
 * client for a worker that does not exist in this deployment. It calls
 * `THEHARVESTER_WORKER_URL` (unset by default) and reports the collector as
 * `unavailable` when that's not configured — exactly the current, real
 * state, matching what `recon-sources.ts`'s `RECON_NOTES` already says
 * about theHarvester under "theHarvester executed in-app".
 *
 * That existing note's objection was specifically to *subprocessing a
 * GPL-licensed binary inside Sentinel's own process* — a licensing and a
 * scale-to-zero problem at once (theHarvester is GPL; bundling it as a
 * subprocess raises linking questions this system doesn't need to answer,
 * and the container holds no process between requests to run it in
 * anyway). This adapter does neither: it never subprocesses theHarvester
 * itself, only makes an HTTP call to an independently-deployed worker — the
 * same architecture plan §15 describes ("Sentinel + theHarvester worker",
 * Docker, optional) and the same pattern `ai-service/` already established
 * this session (a separate Python service, called over HTTP, deploying and
 * versioning independently). Standing up that worker (a small HTTP wrapper
 * around the theHarvester CLI) is real infrastructure work — a Dockerfile,
 * a host to run it on — genuinely out of scope for this pass and not
 * attempted here.
 *
 * **The response parser targets theHarvester's own documented `-f json`
 * export shape** (`emails`, `hosts` as `"hostname:ip"` strings, `ips`,
 * `urls`) from training-time knowledge of the tool, not a live instance —
 * there is no live worker to verify the exact field names against. The
 * parser is deliberately defensive (`asStringArray` drops anything that
 * isn't a string, `parseHostEntry` tolerates a bare hostname with no `:ip`
 * suffix) so an unexpected or missing field degrades to "not reported"
 * rather than throwing or fabricating a value — but the exact shape should
 * be reverified against a real worker's output before this is trusted.
 */

import { CollectorError, collectorUnavailable } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";
import { toHostname } from "../../attack-surface";

const TIMEOUT_MS = 30_000;

/**
 * Plan §13: "do not use `-b all` as the default strategy." crt.sh and
 * CertSpotter are the plan's own "Recommended first sources" — both
 * passive (read a public CT log, never touch the target), matching the
 * passive-only stance the rest of Module 2 already takes.
 */
export const DEFAULT_SOURCES = ["crtsh", "certspotter"];

export interface TheHarvesterRaw {
  domain: string;
  sources: string[];
  emails: string[];
  /** Raw `"hostname"` or `"hostname:ip"` strings, exactly as theHarvester's JSON export carries them. */
  hosts: string[];
  ips: string[];
  urls: string[];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function parseHostEntry(raw: string): { hostname: string; ip: string | null } {
  const idx = raw.indexOf(":");
  if (idx === -1) return { hostname: raw.trim().toLowerCase(), ip: null };
  const ip = raw.slice(idx + 1).trim();
  return { hostname: raw.slice(0, idx).trim().toLowerCase(), ip: ip || null };
}

function workerUrlFromEnv(): string | null {
  const url = process.env.THEHARVESTER_WORKER_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

async function queryWorker(
  workerUrl: string,
  domain: string,
  sources: string[],
): Promise<TheHarvesterRaw> {
  let res: Response;
  try {
    res = await fetch(`${workerUrl}/harvest`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ domain, sources }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`theHarvester worker request failed: ${message}`);
  }

  if (res.status === 429) {
    throw new Error(
      `theHarvester worker rate-limited the request for ${domain} (HTTP 429). Wait and retry.`,
    );
  }
  if (!res.ok) {
    throw new Error(`theHarvester worker returned HTTP ${res.status} for ${domain}.`);
  }

  const json: unknown = await res.json();
  const record = asRecord(json) ?? {};
  return {
    domain,
    sources,
    emails: asStringArray(record.emails),
    hosts: asStringArray(record.hosts),
    ips: asStringArray(record.ips ?? record.ip_addresses),
    urls: asStringArray(record.urls ?? record.interesting_urls),
  };
}

export const theHarvesterCollector: Collector<TheHarvesterRaw> = {
  id: "theharvester",
  name: "theHarvester (external worker)",
  category: "external",
  supportedTargetTypes: ["domain"],
  requiresCredentials: false,
  /** Rule 5: "If theHarvester is unavailable, Sentinel must still work." No worker deployed by default — see the file header. */
  isOptional: true,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<TheHarvesterRaw>> {
    const clock = startExecution();
    const workerUrl = workerUrlFromEnv();
    if (!workerUrl) {
      const err = collectorUnavailable(
        "theharvester",
        "THEHARVESTER_WORKER_URL is not configured — no worker is deployed for this environment.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const hostname = toHostname(target.value);
    if (!hostname) {
      const err = new CollectorError(
        "theharvester",
        "invalid-target",
        `Could not read a domain from "${target.value}".`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    try {
      const raw = await queryWorker(workerUrl, hostname, DEFAULT_SOURCES);
      const resultCount = raw.emails.length + raw.hosts.length + raw.ips.length + raw.urls.length;
      return { execution: finishExecution(clock, "completed", resultCount), raw };
    } catch (err) {
      const classified = classifyError("theharvester", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const raw = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const domainId = `theharvester:domain:${raw.domain}`;
    const entities: CollectorEntity[] = [
      {
        id: domainId,
        type: "domain",
        value: raw.domain,
        displayName: raw.domain,
        source: "theharvester",
        confidence: UNSCORED,
        metadata: { sources: raw.sources },
      },
    ];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];

    for (const email of raw.emails) {
      const emailId = `theharvester:email:${email.toLowerCase()}`;
      if (!entities.some((e) => e.id === emailId)) {
        entities.push({
          id: emailId,
          type: "email",
          value: email,
          displayName: email,
          source: "theharvester",
          confidence: UNSCORED,
          metadata: {},
        });
      }
      relationships.push({
        sourceEntity: domainId,
        relationshipType: "HAS_EMAIL",
        targetEntity: emailId,
        confidence: UNSCORED,
        source: "theharvester",
      });
      evidence.push({
        source: "theharvester",
        sourceUrl: null,
        collector: "theharvester",
        collectedAt,
        rawValue: email,
        normalizedValue: { email },
        confidence: null,
        metadata: {},
      });
    }

    for (const hostRaw of raw.hosts) {
      const { hostname, ip } = parseHostEntry(hostRaw);
      if (!hostname) continue;
      const hostId = `theharvester:domain:${hostname}`;
      if (!entities.some((e) => e.id === hostId)) {
        entities.push({
          id: hostId,
          type: "domain",
          value: hostname,
          displayName: hostname,
          source: "theharvester",
          confidence: UNSCORED,
          metadata: {},
        });
      }
      if (ip) {
        const ipId = `theharvester:ip:${ip}`;
        if (!entities.some((e) => e.id === ipId)) {
          entities.push({
            id: ipId,
            type: "ip",
            value: ip,
            displayName: ip,
            source: "theharvester",
            confidence: UNSCORED,
            metadata: {},
          });
        }
        relationships.push({
          sourceEntity: hostId,
          relationshipType: "RESOLVES_TO",
          targetEntity: ipId,
          confidence: {
            value: null,
            reasons: ["theHarvester-reported, not independently re-resolved"],
          },
          source: "theharvester",
        });
      }
      evidence.push({
        source: "theharvester",
        sourceUrl: null,
        collector: "theharvester",
        collectedAt,
        rawValue: hostRaw,
        normalizedValue: { hostname, ip },
        confidence: null,
        metadata: {},
      });
    }

    for (const ip of raw.ips) {
      const ipId = `theharvester:ip:${ip}`;
      if (!entities.some((e) => e.id === ipId)) {
        entities.push({
          id: ipId,
          type: "ip",
          value: ip,
          displayName: ip,
          source: "theharvester",
          confidence: UNSCORED,
          metadata: {},
        });
      }
      evidence.push({
        source: "theharvester",
        sourceUrl: null,
        collector: "theharvester",
        collectedAt,
        rawValue: ip,
        normalizedValue: { ip },
        confidence: null,
        metadata: {},
      });
    }

    for (const url of raw.urls) {
      const urlId = `theharvester:url:${url}`;
      if (!entities.some((e) => e.id === urlId)) {
        entities.push({
          id: urlId,
          type: "url",
          value: url,
          displayName: url,
          source: "theharvester",
          confidence: UNSCORED,
          metadata: {},
        });
      }
      evidence.push({
        source: "theharvester",
        sourceUrl: url,
        collector: "theharvester",
        collectedAt,
        rawValue: url,
        normalizedValue: { url },
        confidence: null,
        metadata: {},
      });
    }

    const warnings: string[] = [];
    if (entities.length === 1) {
      warnings.push(
        `theHarvester (${raw.sources.join(", ")}) returned no findings for ${raw.domain}.`,
      );
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: { domain: raw.domain, sources: raw.sources },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    const workerUrl = workerUrlFromEnv();
    if (!workerUrl) {
      return {
        state: "unavailable",
        detail: "THEHARVESTER_WORKER_URL is not configured.",
        checkedAt,
      };
    }
    try {
      const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return res.ok
        ? { state: "ready", detail: `HTTP ${res.status}`, checkedAt }
        : { state: "degraded", detail: `HTTP ${res.status}`, checkedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "unavailable", detail: message, checkedAt };
    }
  },
};
