/**
 * crt.sh adapter — OSINT-INTEGRATION-PLAN.md §5 "crt.sh" / §31 P1.
 *
 * Wraps `collectCrtShSubdomains` in `src/utils/recon-sources.ts` verbatim —
 * no logic duplicated or changed. That function already follows Recipe C
 * (throw on failure, empty array on a genuine zero-result success), so this
 * adapter's job is purely reshaping its output into the common result model.
 */

import { collectCrtShSubdomains } from "../../recon-sources";
import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "./shared";

export type CrtShRaw = Awaited<ReturnType<typeof collectCrtShSubdomains>>;

export const crtshCollector: Collector<CrtShRaw> = {
  id: "crtsh",
  name: "crt.sh Certificate Transparency",
  category: "infrastructure",
  supportedTargetTypes: ["domain"],
  requiresCredentials: false,
  isOptional: false,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<CrtShRaw>> {
    const clock = startExecution();
    if (target.type !== "domain") {
      const err = new CollectorError(
        "crtsh",
        "invalid-target",
        `crt.sh requires a domain target, got "${target.type}".`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }
    try {
      const findings = await collectCrtShSubdomains(target.value);
      return { execution: finishExecution(clock, "completed", findings.length), raw: findings };
    } catch (err) {
      const classified = classifyError("crtsh", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const findings = outcome.raw!;

    const entities: CollectorEntity[] = [];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];

    for (const finding of findings) {
      const entityId = `crtsh:domain:${finding.hostname}`;
      entities.push({
        id: entityId,
        type: "domain",
        value: finding.hostname,
        displayName: finding.hostname,
        source: "crtsh",
        confidence: UNSCORED,
        metadata: { firstSeen: finding.firstSeen, issuer: finding.issuer },
      });

      evidence.push({
        source: "crt.sh",
        sourceUrl: `https://crt.sh/?q=${encodeURIComponent(finding.hostname)}`,
        collector: "crtsh",
        collectedAt: outcome.execution.completedAt ?? outcome.execution.startedAt,
        rawValue: finding,
        normalizedValue: {
          hostname: finding.hostname,
          firstSeen: finding.firstSeen,
          issuer: finding.issuer,
        },
        confidence: null,
        metadata: {},
      });
    }

    // §19's relationship vocabulary has no "is a subdomain of" edge. OWNS_DOMAIN
    // read from parent → child is the closest honest fit ("example.com's
    // certificate log encompasses mail.example.com"), not literal ownership.
    if (findings.length > 0) {
      const parentDomain = findings[0]!.hostname.split(".").slice(-2).join(".");
      const parentId = `crtsh:domain:${parentDomain}`;
      if (!entities.some((e) => e.id === parentId)) {
        entities.push({
          id: parentId,
          type: "domain",
          value: parentDomain,
          displayName: parentDomain,
          source: "crtsh",
          confidence: UNSCORED,
          metadata: { queried: true },
        });
      }
      for (const finding of findings) {
        if (finding.hostname === parentDomain) continue;
        relationships.push({
          sourceEntity: parentId,
          relationshipType: "OWNS_DOMAIN",
          targetEntity: `crtsh:domain:${finding.hostname}`,
          confidence: {
            value: 0.9,
            reasons: [
              "hostname observed in a Certificate Transparency log entry within the queried domain",
            ],
          },
          source: "crtsh",
        });
      }
    }

    const result = {
      entities,
      relationships,
      evidence,
      warnings: [],
      errors: [],
      metadata: { subdomainCount: findings.length },
      execution: outcome.execution,
    };
    return InvestigationResultSchema.parse(result);
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch("https://crt.sh/?q=%.github.com&output=json", {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok
        ? { state: "ready", detail: `HTTP ${res.status}`, checkedAt }
        : { state: "degraded", detail: `HTTP ${res.status}`, checkedAt };
    } catch (err) {
      return { state: "unavailable", detail: classifyError("crtsh", err).message, checkedAt };
    }
  },
};
