/**
 * Jina Reader adapter — OSINT-INTEGRATION-PLAN.md §31 P3.
 *
 * `r.jina.ai` converts any URL into clean extracted text (title + body,
 * stripped of nav/ads/markup) — real capability gain for Module 2: article
 * bodies collected elsewhere in this app are whatever a feed snippet gives,
 * often a few sentences, not the full page. **Free and keyless** — 20
 * requests/minute unauthenticated, 500/minute with a free API key (not
 * required here, so this collector needs no credential and is never
 * `unavailable` for a configuration reason the way theHarvester/SpiderFoot
 * are). Verified against the live endpoint while building this (not from
 * documentation alone): `curl https://r.jina.ai/<url> -H "Accept:
 * application/json"` against a real page, a 404 target, and a malformed
 * URL — see the two behaviors below that verification actually surfaced.
 *
 * **Jina Reader's own HTTP status is not the target page's HTTP status.**
 * A target returning a real 404 still comes back as an outer HTTP 200 from
 * `r.jina.ai`, with the target's real status embedded at
 * `data.httpStatus` and a `data.warning` string ("Target URL returned
 * error 404: Not Found"). Treating the outer 200 alone as "the page loaded
 * fine" would misrepresent a failed fetch as a successful one — `normalize()`
 * checks `data.httpStatus` explicitly and surfaces a warning rather than
 * silently presenting fallback/cached content as if it were the live page.
 *
 * A genuinely malformed URL (not a fetchable target at all) fails at the
 * outer HTTP layer instead (422, `SubmittedDataMalformedError`) — that path
 * is a real `execute()` failure, not a warning.
 */

import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";
import { toHostname } from "../../attack-surface";

const TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 8_000;
const READER_BASE = "https://r.jina.ai/";

export interface JinaReaderRaw {
  requestedUrl: string;
  /** Jina's own resolved/canonical form of the URL — sometimes differs (e.g. a trailing slash added). */
  resolvedUrl: string;
  title: string | null;
  content: string;
  /** As the page itself declares it (e.g. an HTTP-date string), null when not present — never defaulted to collection time. */
  publishedTime: string | null;
  /** The TARGET page's real HTTP status, distinct from r.jina.ai's own (always 200 on a request-level success) — see file header. */
  targetHttpStatus: number | null;
  warning: string | null;
}

interface JinaReaderResponse {
  data?: {
    title?: unknown;
    content?: unknown;
    url?: unknown;
    publishedTime?: unknown;
    httpStatus?: unknown;
    warning?: unknown;
  };
  message?: unknown;
}

export const jinaReaderCollector: Collector<JinaReaderRaw> = {
  id: "jina-reader",
  name: "Jina Reader (r.jina.ai)",
  category: "media",
  supportedTargetTypes: ["url"],
  requiresCredentials: false,
  isOptional: true,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<JinaReaderRaw>> {
    const clock = startExecution();
    const url = target.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      const err = new CollectorError(
        "jina-reader",
        "invalid-target",
        `"${target.value}" is not an http(s) URL.`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    let res: Response;
    try {
      res = await fetch(`${READER_BASE}${url}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const classified = classifyError("jina-reader", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }

    const json = (await res.json().catch(() => null)) as JinaReaderResponse | null;

    if (!res.ok) {
      const message =
        typeof json?.message === "string"
          ? json.message
          : `Jina Reader returned HTTP ${res.status}.`;
      const reason = res.status === 429 ? "rate-limited" : "upstream-error";
      const err = new CollectorError("jina-reader", reason, message);
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const data = json?.data;
    if (!data || typeof data.content !== "string") {
      const err = new CollectorError(
        "jina-reader",
        "upstream-error",
        "Jina Reader responded but returned no extractable content.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const raw: JinaReaderRaw = {
      requestedUrl: url,
      resolvedUrl: typeof data.url === "string" && data.url ? data.url : url,
      title: typeof data.title === "string" && data.title.trim() ? data.title.trim() : null,
      content: data.content,
      publishedTime: typeof data.publishedTime === "string" ? data.publishedTime : null,
      targetHttpStatus: typeof data.httpStatus === "number" ? data.httpStatus : null,
      warning: typeof data.warning === "string" && data.warning.trim() ? data.warning.trim() : null,
    };
    return { execution: finishExecution(clock, "completed", 1), raw };
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const raw = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const articleId = `jina-reader:article:${raw.resolvedUrl}`;
    const entities: CollectorEntity[] = [
      {
        id: articleId,
        type: "article",
        value: raw.resolvedUrl,
        displayName: raw.title ?? raw.resolvedUrl,
        source: "jina-reader",
        confidence: UNSCORED,
        metadata: raw.publishedTime ? { publishedTime: raw.publishedTime } : {},
      },
    ];
    const relationships: CollectorRelationship[] = [];

    const hostname = toHostname(raw.resolvedUrl);
    if (hostname) {
      const domainId = `jina-reader:domain:${hostname}`;
      entities.push({
        id: domainId,
        type: "domain",
        value: hostname,
        displayName: hostname,
        source: "jina-reader",
        confidence: UNSCORED,
        metadata: {},
      });
      relationships.push({
        sourceEntity: articleId,
        relationshipType: "HOSTED_ON",
        targetEntity: domainId,
        confidence: { value: 1, reasons: ["URL hostname, directly observed"] },
        source: "jina-reader",
      });
    }

    const evidence: CollectorEvidence[] = [
      {
        source: "Jina Reader (r.jina.ai)",
        sourceUrl: raw.resolvedUrl,
        collector: "jina-reader",
        collectedAt,
        rawValue: raw,
        normalizedValue: {
          title: raw.title,
          content: raw.content,
          publishedTime: raw.publishedTime,
        },
        confidence: null,
        metadata: {},
      },
    ];

    const warnings: string[] = [];
    if (
      raw.targetHttpStatus !== null &&
      (raw.targetHttpStatus < 200 || raw.targetHttpStatus >= 300)
    ) {
      warnings.push(
        `The target page itself returned HTTP ${raw.targetHttpStatus} — the extracted content may be ` +
          `stale, cached, or a fallback rather than the live page.`,
      );
    }
    if (raw.warning) warnings.push(`Jina Reader: ${raw.warning}`);

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: { url: raw.resolvedUrl },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(`${READER_BASE}https://example.com`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return res.ok
        ? { state: "ready", detail: `HTTP ${res.status}`, checkedAt }
        : { state: "degraded", detail: `HTTP ${res.status}`, checkedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "unavailable", detail: message, checkedAt };
    }
  },
};
