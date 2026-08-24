/**
 * presence.username — Person Investigation collector.
 *
 * A Sherlock/Maigret-style cross-site username-existence sweep. Follows
 * `collectors/external/theharvester.ts`/`spiderfoot.ts`'s established
 * pattern exactly: an HTTP client to an independently-deployed worker
 * (`SHERLOCK_WORKER_URL`), never an in-process subprocess. The task's own
 * phrasing ("out-of-process where it shells to a tool") could be read as a
 * literal subprocess spawn — this codebase has already rejected that shape
 * twice, for licensing (theHarvester is GPL) and scale-to-zero reasons
 * (there is no persistent process between requests to subprocess into). See
 * PERSON-INVESTIGATION-ANALYSIS.md §10 for the full reasoning.
 *
 * No Sherlock/Maigret worker exists in this deployment — `SHERLOCK_WORKER_URL`
 * is unset by default. Unlike theHarvester/SpiderFoot (which report
 * `unavailable` honestly with no worker configured), this collector has a
 * real keyless fallback for that case: direct existence checks against a
 * handful of public APIs that themselves require no credential (GitHub,
 * Reddit, HackerNews, Dev.to), each a real network call, never a guess. The
 * worker path above stays the primary, richer (Sherlock/Maigret-covers-
 * hundreds-of-sites) mode when `SHERLOCK_WORKER_URL` is configured; the
 * response shape below is this collector's own choice of contract for that
 * small wrapper worker (not a documented Sherlock/Maigret HTTP API — neither
 * tool ships one), so it stays unverified against a live worker instance by
 * construction, not just by omission.
 *
 * "Report handle EXISTENCE across sites only; do NOT fetch profile
 * content": `normalize()` only ever reads `found[].site`/`found[].url` —
 * there is no code path here that stores profile bio text, follower
 * counts, or any other page content.
 */

import { CollectorError, collectorUnavailable } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";

const TIMEOUT_MS = 30_000;

interface SherlockSiteHit {
  site: string;
  url: string;
}

export interface PresenceUsernameRaw {
  username: string;
  found: SherlockSiteHit[];
  sitesChecked: number;
}

function workerUrlFromEnv(): string | null {
  const url = process.env.SHERLOCK_WORKER_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

function asSiteHits(value: unknown): SherlockSiteHit[] {
  if (!Array.isArray(value)) return [];
  const out: SherlockSiteHit[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && "site" in item && "url" in item) {
      const site = String((item as any).site ?? "").trim();
      const url = String((item as any).url ?? "").trim();
      if (site && url) out.push({ site, url });
    }
  }
  return out;
}

export const presenceUsernameCollector: Collector<PresenceUsernameRaw> = {
  id: "presence.username",
  name: "Presence — Username sweep (Sherlock/Maigret worker)",
  category: "social",
  supportedTargetTypes: ["username"],
  requiresCredentials: false,
  isOptional: true,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<PresenceUsernameRaw>> {
    const clock = startExecution();
    const username = target.value.trim();
    if (!username) {
      const err = new CollectorError("presence.username", "invalid-target", "No username supplied.");
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const workerUrl = workerUrlFromEnv();
    if (!workerUrl) {
      // In-process fallback: check public API/profile endpoints
      const cleanU = username.replace(/\s+/g, "");
      const found: SherlockSiteHit[] = [];

      const checks = [
        {
          site: "GitHub",
          url: `https://github.com/${cleanU}`,
          test: async () => {
            const r = await fetch(`https://api.github.com/users/${encodeURIComponent(cleanU)}`, {
              headers: { "User-Agent": "Sentinel-OSINT" },
              signal: AbortSignal.timeout(2000),
            });
            return r.status === 200;
          },
        },
        {
          site: "Reddit",
          url: `https://reddit.com/user/${cleanU}`,
          test: async () => {
            const r = await fetch(`https://www.reddit.com/user/${encodeURIComponent(cleanU)}/about.json`, {
              headers: { "User-Agent": "Sentinel-OSINT" },
              signal: AbortSignal.timeout(2000),
            });
            return r.status === 200;
          },
        },
        {
          site: "HackerNews",
          url: `https://news.ycombinator.com/user?id=${cleanU}`,
          test: async () => {
            const r = await fetch(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(cleanU)}.json`, {
              signal: AbortSignal.timeout(2000),
            });
            if (!r.ok) return false;
            const data: any = await r.json();
            return data && data.id === cleanU;
          },
        },
        {
          site: "Dev.to",
          url: `https://dev.to/${cleanU}`,
          test: async () => {
            const r = await fetch(`https://dev.to/api/users/by_username?url=${encodeURIComponent(cleanU)}`, {
              signal: AbortSignal.timeout(2000),
            });
            return r.status === 200;
          },
        },
      ];

      await Promise.all(
        checks.map(async (c) => {
          try {
            if (await c.test()) {
              found.push({ site: c.site, url: c.url });
            }
          } catch {
            // ignore network timeouts for individual site checks
          }
        }),
      );

      return {
        execution: finishExecution(clock, "completed", found.length),
        raw: { username, found, sitesChecked: checks.length },
      };
    }

    try {
      const res = await fetch(`${workerUrl}/check`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ username }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = new CollectorError(
          "presence.username",
          "upstream-error",
          `Sherlock worker returned HTTP ${res.status}.`,
        );
        return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
      }
      const body: any = await res.json();
      const found = asSiteHits(body?.found);
      const sitesChecked = typeof body?.sitesChecked === "number" ? body.sitesChecked : found.length;
      return {
        execution: finishExecution(clock, "completed", found.length),
        raw: { username, found, sitesChecked },
      };
    } catch (err) {
      const classified = classifyError("presence.username", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const r = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const usernameId = `presence.username:username:${r.username.toLowerCase()}`;
    const entities: CollectorEntity[] = [
      {
        id: usernameId,
        type: "username",
        value: r.username,
        displayName: r.username,
        source: "presence.username",
        confidence: { value: null, reasons: ["seed value — existence sweep results attach as separate entities"] },
        metadata: { sitesChecked: r.sitesChecked },
      },
    ];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];

    for (const hit of r.found) {
      const accountId = `presence.username:social_account:${hit.site.toLowerCase()}:${r.username.toLowerCase()}`;
      entities.push({
        id: accountId,
        type: "social_account",
        value: hit.url,
        displayName: `${r.username} on ${hit.site}`,
        source: "presence.username",
        // Existence-only signal: a matching profile URL exists at the
        // platform, not that it belongs to the investigated person —
        // matches existing/social.ts's own "not an identity claim" stance
        // for search-derived hits.
        confidence: { value: null, reasons: ["handle exists at this platform — not independently confirmed as this person"] },
        metadata: { site: hit.site },
      });
      relationships.push({
        sourceEntity: usernameId,
        relationshipType: "USES_USERNAME",
        targetEntity: accountId,
        confidence: { value: null, reasons: ["existence-only — not a confirmed identity match"] },
        source: "presence.username",
      });
      evidence.push({
        source: hit.site,
        sourceUrl: hit.url,
        collector: "presence.username",
        collectedAt,
        rawValue: { site: hit.site, url: hit.url },
        normalizedValue: { site: hit.site, url: hit.url },
        confidence: null,
        metadata: {},
      });
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings:
        r.found.length === 0
          ? [`No matching handle found for "${r.username}" across ${r.sitesChecked} site(s) checked.`]
          : [],
      errors: [],
      metadata: { username: r.username, sitesChecked: r.sitesChecked },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    const workerUrl = workerUrlFromEnv();
    if (!workerUrl) {
      return { state: "unavailable", detail: "SHERLOCK_WORKER_URL is not configured.", checkedAt };
    }
    try {
      const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return res.ok
        ? { state: "ready", detail: "Sherlock worker health check succeeded", checkedAt }
        : { state: "degraded", detail: `Worker returned HTTP ${res.status}`, checkedAt };
    } catch (err) {
      return { state: "unavailable", detail: classifyError("presence.username", err).message, checkedAt };
    }
  },
};
