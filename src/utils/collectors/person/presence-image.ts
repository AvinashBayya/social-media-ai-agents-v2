/**
 * presence.image — Person Investigation collector for public avatar/profile image presence.
 */

import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { finishExecution, normalizeGuard, startExecution } from "../existing/shared";

export interface PresenceImageRaw {
  foundImages: { site: string; url: string }[];
}

export const presenceImageCollector: Collector<PresenceImageRaw> = {
  id: "presence.image",
  name: "Presence — Image/Avatar Presence",
  category: "media",
  supportedTargetTypes: ["person"],
  requiresCredentials: false,
  isOptional: true,

  capability: {
    sourceId: "presence.image",
    name: "Presence — Image/Avatar presence",
    collectionMode: "PASSIVE_PUBLIC_WEB",
    activeCapable: false,
    allowed: true,
    requiresAuth: false,
    requiresManualAction: false,
    apiAvailable: true,
    notes: "An unauthenticated HEAD request to a public GitHub avatar URL. Keyless, no login, no scraping.",
  },

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<PresenceImageRaw>> {
    const clock = startExecution();
    const clean = (target.value || "").replace(/^[@#]/, "").trim();
    if (!clean) {
      return { execution: finishExecution(clock, "completed", 0), raw: { foundImages: [] } };
    }

    const foundImages: { site: string; url: string }[] = [];
    try {
      const ghAvatarUrl = `https://github.com/${encodeURIComponent(clean)}.png`;
      const ghRes = await fetch(ghAvatarUrl, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      if (ghRes.ok && ghRes.headers.get("content-type")?.includes("image")) {
        foundImages.push({ site: "GitHub Profile Avatar", url: ghAvatarUrl });
      }
    } catch {
      // avatar check fallback
    }

    return { execution: finishExecution(clock, "completed", foundImages.length), raw: { foundImages } };
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const { foundImages } = outcome.raw!;

    const entities: CollectorEntity[] = [];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    for (const img of foundImages) {
      const mediaId = `presence:image:${img.url}`;
      entities.push({
        id: mediaId,
        type: "media",
        value: img.url,
        displayName: img.site,
        source: "presence.image",
        confidence: UNSCORED,
        metadata: { site: img.site, url: img.url },
      });

      evidence.push({
        source: img.site,
        sourceUrl: img.url,
        collector: "presence.image",
        collectedAt,
        rawValue: img,
        normalizedValue: img,
        confidence: null,
        metadata: {},
      });
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings: [],
      errors: [],
      metadata: { foundImagesCount: foundImages.length },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    return {
      state: "ready",
      detail: "Public profile image presence checker is ready",
      checkedAt: new Date().toISOString(),
    };
  },
};
