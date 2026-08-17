/**
 * News adapter — OSINT-INTEGRATION-PLAN.md §5 "News/RSS/GDELT" / §31 P1.
 *
 * Wraps `collectNewsGeo` from `src/utils/geo-sources.ts` verbatim — Module
 * 5's existing GDELT DOC search, chosen over re-querying Google News RSS
 * (which the Dorks adapter already covers) because it returns geo-tagged
 * records (`GeoRecord.lat/lon/precision`) rather than a bare hit list, which
 * lets this adapter emit real `location` entities and `LOCATED_IN`
 * relationships instead of just articles. `collectNewsGeo` never throws —
 * it returns `{ error }` on failure — so this adapter's `execute()` maps
 * that field rather than relying on try/catch.
 *
 * GDELT's 1-request/5-second limit (CLAUDE.md) is enforced upstream by
 * GDELT itself (429), surfaced here as `rate-limited`, not throttled
 * client-side — this adapter makes exactly one request per `execute()`.
 */

import { collectNewsGeo } from "../../geo-sources";
import type { GeoRecord, LayerResult } from "../../geo";
import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "./shared";

export type NewsRaw = LayerResult;

export const newsCollector: Collector<NewsRaw> = {
  id: "news",
  name: "News (GDELT DOC, geo-tagged)",
  category: "media",
  supportedTargetTypes: ["person", "domain", "location"],
  requiresCredentials: false,
  isOptional: false,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<NewsRaw>> {
    const clock = startExecution();
    const query = (target.value || "").trim();
    if (!query) {
      const err = new CollectorError("news", "invalid-target", "A search query is required.");
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const result = await collectNewsGeo(query);
    if (result.error) {
      const classified = classifyError("news", new Error(result.error));
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
    return { execution: finishExecution(clock, "completed", result.records.length), raw: result };
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const { records, unplaceable } = outcome.raw!;

    const entities: CollectorEntity[] = [];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    for (const record of records as GeoRecord[]) {
      const articleId = `news:article:${record.id}`;
      entities.push({
        id: articleId,
        type: "article",
        value: record.url || record.id,
        displayName: record.title,
        source: "news",
        confidence: UNSCORED,
        metadata: { timestamp: record.timestamp, locates: record.locates, ...record.detail },
      });

      const locationId = `news:location:${record.lat.toFixed(4)},${record.lon.toFixed(4)}`;
      if (!entities.some((e) => e.id === locationId)) {
        entities.push({
          id: locationId,
          type: "location",
          value: `${record.lat},${record.lon}`,
          displayName: record.locates,
          source: "news",
          confidence: UNSCORED,
          metadata: { lat: record.lat, lon: record.lon, precision: record.precision },
        });
      }
      relationships.push({
        sourceEntity: articleId,
        relationshipType: "LOCATED_IN",
        targetEntity: locationId,
        confidence: {
          value: record.precision === "exact" ? 0.9 : record.precision === "city" ? 0.6 : 0.3,
          reasons: [`GDELT sourcecountry precision: ${record.precision}`],
        },
        source: "news",
      });

      evidence.push({
        source: record.source,
        sourceUrl: record.url || null,
        collector: "news",
        collectedAt,
        rawValue: record,
        normalizedValue: {
          title: record.title,
          timestamp: record.timestamp,
          lat: record.lat,
          lon: record.lon,
          precision: record.precision,
        },
        confidence:
          record.credibility !== null
            ? { value: record.credibility, reasons: ["Module 1 credibility score"] }
            : null,
        metadata: {},
      });
    }

    const warnings: string[] = [];
    if (unplaceable > 0) {
      warnings.push(
        `${unplaceable} article(s) returned by GDELT had no placeable sourcecountry and are not represented as entities.`,
      );
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: { recordCount: records.length, unplaceable },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    const result = await collectNewsGeo("test");
    return result.error
      ? { state: "degraded", detail: result.error, checkedAt }
      : { state: "ready", detail: `${result.records.length} record(s) on a test query`, checkedAt };
  },
};
