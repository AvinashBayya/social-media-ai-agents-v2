/**
 * Dorks adapter — OSINT-INTEGRATION-PLAN.md §5 "Google Dorks" / §31 P1.
 *
 * Wraps `DORK_TEMPLATES`/`buildDork`/`fetchNewsDorkHits` from
 * `src/utils/dorks.ts` verbatim. Only news-scope dorks execute — matching
 * that file's own documented reason web-scope dorks cannot (no free
 * web-search API, and scraping google.com/search violates its ToS). A
 * domain target additionally gets its web-scope dorks *listed* (as
 * `warnings`, each with the manual URL an analyst would open) rather than
 * silently dropped — "we know this search exists, we cannot run it for you"
 * is the same honest-gap framing `RECON_NOTES` in `recon-sources.ts` uses.
 */

import { buildDork, DORK_TEMPLATES, fetchNewsDorkHits } from "../../dorks";
import type { BuiltDork, DorkHit } from "../../dorks";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type {
  Collector,
  CollectorHealth,
  CollectorRunOutcome,
  CollectorTarget,
  TargetType,
} from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "./shared";

export interface DorksRaw {
  targetValue: string;
  targetType: TargetType;
  query: string;
  hits: DorkHit[];
  webDorks: BuiltDork[];
}

const NEWS_BASELINE_TEMPLATE = DORK_TEMPLATES.find((t) => t.id === "news-coverage")!;

export const dorksCollector: Collector<DorksRaw> = {
  id: "dorks",
  name: "Google Dorks (news-scope execution)",
  category: "search",
  supportedTargetTypes: ["person", "domain", "email", "username"],
  requiresCredentials: false,
  isOptional: false,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<DorksRaw>> {
    const clock = startExecution();
    try {
      const built = buildDork(NEWS_BASELINE_TEMPLATE, target.value);
      const { query, hits } = await fetchNewsDorkHits(built.query);

      const webDorks: BuiltDork[] =
        target.type === "domain"
          ? DORK_TEMPLATES.filter((t) => t.scope === "web").map((t) =>
              buildDork(t, target.value, undefined),
            )
          : [];

      return {
        execution: finishExecution(clock, "completed", hits.length),
        raw: { targetValue: target.value, targetType: target.type, query, hits, webDorks },
      };
    } catch (err) {
      const classified = classifyError("dorks", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const { targetValue, targetType, hits, webDorks } = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const targetId = `dorks:target:${targetValue}`;
    const entities: CollectorEntity[] = [
      {
        id: targetId,
        type: targetType,
        value: targetValue,
        displayName: targetValue,
        source: "dorks",
        confidence: UNSCORED,
        metadata: {},
      },
    ];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];

    for (const hit of hits) {
      const identifier = hit.url || hit.title;
      if (!identifier) continue;
      const articleId = `dorks:article:${identifier}`;
      entities.push({
        id: articleId,
        type: "article",
        value: identifier,
        displayName: hit.title || identifier,
        source: "dorks",
        confidence: UNSCORED,
        metadata: { publishedAt: hit.pubDate || null },
      });
      relationships.push({
        sourceEntity: targetId,
        relationshipType: "MENTIONED_IN",
        targetEntity: articleId,
        confidence: UNSCORED,
        source: "dorks",
      });
      evidence.push({
        source: hit.source,
        sourceUrl: hit.url || null,
        collector: "dorks",
        collectedAt,
        rawValue: hit,
        normalizedValue: {
          title: hit.title,
          source: hit.source,
          url: hit.url,
          publishedAt: hit.pubDate || null,
        },
        confidence: null,
        metadata: {},
      });
    }

    const warnings = webDorks.map(
      (d) =>
        `Web-scope dork "${d.template.label}" not executed (no free web-search API) — open manually: ${d.manualUrl}`,
    );

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: { hitCount: hits.length, webDorkCount: webDorks.length },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await fetchNewsDorkHits('"github" -opinion', 1);
      return { state: "ready", detail: "Google News RSS answered a test dork", checkedAt };
    } catch (err) {
      const classified = classifyError("dorks", err);
      return {
        state: classified.reason === "rate-limited" ? "degraded" : "unavailable",
        detail: classified.message,
        checkedAt,
      };
    }
  },
};
