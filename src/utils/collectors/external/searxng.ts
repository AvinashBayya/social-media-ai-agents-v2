/**
 * SearXNG adapter — executes the web-scoped Google dorks this system has never
 * been able to run.
 *
 * WHAT THIS CLOSES. `dorks.ts` splits its 21 templates into two scopes.
 * The 8 `scope: "news"` ones execute against Google News RSS. The 13
 * `scope: "web"` ones target the full web index (`filetype:`, `inurl:`,
 * `"index of"`, pastebin, github) and have always been **built as query strings
 * for the analyst to run in their own browser**, because Google has no free web
 * search API and scraping google.com/search violates their terms and gets the
 * egress IP blocked.
 *
 * `recon-sources.ts`'s `RECON_NOTES` names Google Custom Search as the remedy
 * ("keyed and capped at 100 queries/day"). **That escape hatch is gone**: the
 * Custom Search JSON API is closed to new customers and is discontinued on
 * 1 January 2027, so a new project cannot sign up for it at all.
 *
 * SearXNG is the answer that survives. It is a self-hosted metasearch engine
 * that aggregates results from many upstream engines and exposes them at
 * `GET /search?q=...&format=json` with **no API key**. Because the operator runs
 * it, there is no vendor quota — the practical ceiling is how hard the upstream
 * engines will tolerate being queried, which is comfortable at analyst pace and
 * is not a bulk-mining tool.
 *
 * TWO THINGS THAT WOULD MAKE THIS LIE, BOTH HANDLED BELOW.
 *
 * 1. **`format=json` is disabled by default.** A stock SearXNG answers HTTP 403
 *    to it until `search.formats` in `settings.yml` includes `json`. A 403 here
 *    is a *configuration* state, not "no results", and is reported as such.
 * 2. **A blocked upstream engine returns an empty result set, not an error.**
 *    SearXNG scrapes Google/Bing, and under load they CAPTCHA it. The response
 *    carries the affected engines in `unresponsive_engines`, and if that is
 *    dropped, "Google blocked us" renders identically to "nothing matched" —
 *    the precise failure this codebase keeps having to fix. Every unresponsive
 *    engine becomes a warning on the result.
 */

import { CollectorError, collectorUnavailable } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";
import { toHostname } from "../../attack-surface";

const TIMEOUT_MS = 25_000;
const HEALTH_TIMEOUT_MS = 8_000;

/** Cap on rendered results. SearXNG will happily return far more. */
const MAX_RESULTS = 50;

export interface SearxngResult {
  title: string;
  url: string;
  /** The snippet SearXNG extracted. Empty string when it produced none. */
  content: string;
  /** Which upstream engine produced this hit. Never invented. */
  engine: string | null;
}

export interface SearxngRaw {
  query: string;
  results: SearxngResult[];
  /**
   * Engines that failed or were blocked on this query. NOT cosmetic: this is
   * what separates "Google CAPTCHA'd us" from "nothing matched".
   */
  unresponsiveEngines: string[];
  /** Total SearXNG claimed, when it said. null = it did not report one. */
  numberOfResults: number | null;
}

function baseUrlFromEnv(): string | null {
  const url = process.env.SEARXNG_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * SearXNG reports unresponsive engines as an array whose elements are either a
 * plain string or a `[engine, reason]` tuple, depending on version. Both are
 * flattened to a readable line; anything else is dropped rather than rendered
 * as `[object Object]`.
 */
export function parseUnresponsiveEngines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      out.push(entry.trim());
      continue;
    }
    if (Array.isArray(entry)) {
      const parts = entry.filter((p): p is string => typeof p === "string" && p.trim() !== "");
      if (parts.length) out.push(parts.join(": "));
    }
  }
  return out;
}

export function parseSearxngResults(value: unknown): SearxngResult[] {
  if (!Array.isArray(value)) return [];
  const out: SearxngResult[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const url = asString(record.url);
    if (!url) continue; // A result with no URL is not a result.
    out.push({
      title: asString(record.title) || url,
      url,
      content: asString(record.content),
      // null, never "unknown engine" — an unattributed hit is a real state.
      engine: asString(record.engine) || null,
    });
  }
  return out;
}

export const searxngCollector: Collector<SearxngRaw> = {
  id: "searxng",
  name: "SearXNG (self-hosted web search)",
  category: "search",
  supportedTargetTypes: ["domain", "person", "username", "email", "url"],
  requiresCredentials: false,
  /** Rule 5: Sentinel must still work without it. Web dorks fall back to hand-off. */
  isOptional: true,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<SearxngRaw>> {
    const clock = startExecution();
    const base = baseUrlFromEnv();
    if (!base) {
      const err = collectorUnavailable(
        "searxng",
        "SEARXNG_URL is not configured — no SearXNG instance is running for this environment. " +
          "Web-scoped dorks remain available as query strings for the analyst to run.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const query = target.value.trim();
    if (!query) {
      const err = new CollectorError("searxng", "invalid-target", "An empty query cannot be run.");
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const classified = classifyError("searxng", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }

    if (res.status === 403) {
      // The single most likely misconfiguration, and it is indistinguishable
      // from a refusal unless named.
      const err = new CollectorError(
        "searxng",
        "upstream-error",
        "SearXNG returned HTTP 403 for a JSON request. The JSON output format is disabled by " +
          "default: add `json` to `search.formats` in settings.yml and restart. This is a " +
          "configuration state, not a finding that the query matched nothing.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }
    if (res.status === 429) {
      const err = new CollectorError(
        "searxng",
        "rate-limited",
        "SearXNG rate-limited the request (HTTP 429). Its own limiter, or an upstream engine, is " +
          "throttling. Wait and retry.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }
    if (!res.ok) {
      const err = new CollectorError(
        "searxng",
        "upstream-error",
        `SearXNG returned HTTP ${res.status} for "${query}".`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") {
      const err = new CollectorError(
        "searxng",
        "upstream-error",
        "SearXNG responded with a payload that could not be read as JSON.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const results = parseSearxngResults(json.results).slice(0, MAX_RESULTS);
    const raw: SearxngRaw = {
      query,
      results,
      unresponsiveEngines: parseUnresponsiveEngines(json.unresponsive_engines),
      numberOfResults:
        typeof json.number_of_results === "number" && Number.isFinite(json.number_of_results)
          ? json.number_of_results
          : null,
    };
    return { execution: finishExecution(clock, "completed", results.length), raw };
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const raw = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const entities: CollectorEntity[] = [];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];

    for (const result of raw.results) {
      const urlId = `searxng:url:${result.url}`;
      if (!entities.some((e) => e.id === urlId)) {
        entities.push({
          id: urlId,
          type: "url",
          value: result.url,
          displayName: result.title,
          source: "searxng",
          confidence: UNSCORED,
          metadata: result.engine ? { engine: result.engine } : {},
        });
      }

      const hostname = toHostname(result.url);
      if (hostname) {
        const domainId = `searxng:domain:${hostname}`;
        if (!entities.some((e) => e.id === domainId)) {
          entities.push({
            id: domainId,
            type: "domain",
            value: hostname,
            displayName: hostname,
            source: "searxng",
            confidence: UNSCORED,
            metadata: {},
          });
        }
        relationships.push({
          sourceEntity: urlId,
          relationshipType: "HOSTED_ON",
          targetEntity: domainId,
          confidence: { value: 1, reasons: ["URL hostname, directly observed"] },
          source: "searxng",
        });
      }

      evidence.push({
        source: result.engine ? `SearXNG (${result.engine})` : "SearXNG",
        sourceUrl: result.url,
        collector: "searxng",
        collectedAt,
        rawValue: result,
        // The snippet is what the engine returned, never a summary we wrote.
        normalizedValue: { title: result.title, snippet: result.content || null },
        confidence: null,
        metadata: {},
      });
    }

    const warnings: string[] = [];
    if (raw.unresponsiveEngines.length) {
      // THE LOAD-BEARING WARNING. Without it a CAPTCHA reads as "no matches".
      warnings.push(
        `${raw.unresponsiveEngines.length} search engine(s) did not answer this query ` +
          `(${raw.unresponsiveEngines.join("; ")}). These results are therefore PARTIAL — a ` +
          `blocked engine is not the same as a query that matched nothing.`,
      );
    }
    if (raw.results.length === 0 && raw.unresponsiveEngines.length === 0) {
      warnings.push(
        `SearXNG answered and every engine responded, but no result matched "${raw.query}". ` +
          `This is a genuine empty result, not a collection failure.`,
      );
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: {
        query: raw.query,
        numberOfResults: raw.numberOfResults,
        unresponsiveEngines: raw.unresponsiveEngines,
      },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    const base = baseUrlFromEnv();
    if (!base) {
      return { state: "unavailable", detail: "SEARXNG_URL is not configured.", checkedAt };
    }
    try {
      const res = await fetch(`${base}/search?q=test&format=json`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (res.status === 403) {
        return {
          state: "degraded",
          detail:
            "Reachable, but JSON output is disabled (HTTP 403). Add `json` to `search.formats` " +
            "in settings.yml and restart.",
          checkedAt,
        };
      }
      return res.ok
        ? { state: "ready", detail: `HTTP ${res.status}`, checkedAt }
        : { state: "degraded", detail: `HTTP ${res.status}`, checkedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "unavailable", detail: message, checkedAt };
    }
  },
};
