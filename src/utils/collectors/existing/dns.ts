/**
 * DNS adapter — OSINT-INTEGRATION-PLAN.md §5 "DNS/RDAP" (DNS half) / §31 P1.
 *
 * Wraps `resolveA`/`toHostname`/`isIPv4` from `src/utils/attack-surface.ts`
 * verbatim (Cloudflare DNS-over-HTTPS — no new resolution logic written
 * here). Those three were exported from that file additively for exactly
 * this reuse; `lookupAttackSurface`'s own behavior there is unchanged.
 */

import { isIPv4, isPrivateIPv4, resolveA, toHostname } from "../../attack-surface";
import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "./shared";

export interface DnsRaw {
  hostname: string;
  addresses: string[];
}

export const dnsCollector: Collector<DnsRaw> = {
  id: "dns",
  name: "DNS (Cloudflare DoH)",
  category: "infrastructure",
  supportedTargetTypes: ["domain"],
  requiresCredentials: false,
  isOptional: false,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<DnsRaw>> {
    const clock = startExecution();
    const hostname = toHostname(target.value);
    if (!hostname) {
      const err = new CollectorError(
        "dns",
        "invalid-target",
        `Could not read a hostname from "${target.value}".`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }
    if (isIPv4(hostname)) {
      const err = new CollectorError(
        "dns",
        "invalid-target",
        `"${target.value}" is an IP address, not a domain — use the Shodan InternetDB collector directly on it.`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    try {
      const resolved = await resolveA(hostname);
      const addresses = resolved.filter((ip) => !isPrivateIPv4(ip));
      return {
        execution: finishExecution(clock, "completed", addresses.length),
        raw: { hostname, addresses },
      };
    } catch (err) {
      const classified = classifyError("dns", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const { hostname, addresses } = outcome.raw!;

    const domainId = `dns:domain:${hostname}`;
    const entities: CollectorEntity[] = [
      {
        id: domainId,
        type: "domain",
        value: hostname,
        displayName: hostname,
        source: "dns",
        confidence: UNSCORED,
        metadata: {},
      },
    ];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    for (const ip of addresses) {
      const ipId = `dns:ip:${ip}`;
      entities.push({
        id: ipId,
        type: "ip",
        value: ip,
        displayName: ip,
        source: "dns",
        confidence: UNSCORED,
        metadata: {},
      });
      relationships.push({
        sourceEntity: domainId,
        relationshipType: "RESOLVES_TO",
        targetEntity: ipId,
        confidence: { value: 1, reasons: ["live A-record answer from Cloudflare DNS-over-HTTPS"] },
        source: "dns",
      });
      evidence.push({
        source: "Cloudflare DNS-over-HTTPS",
        sourceUrl: null,
        collector: "dns",
        collectedAt,
        rawValue: { hostname, ip },
        normalizedValue: { hostname, ip },
        confidence: null,
        metadata: {},
      });
    }

    if (addresses.length === 0) {
      // A genuine zero-address success (e.g. domain resolves only to
      // addresses filtered as private) is still a completed run, not a
      // failure — Rule 5 distinguishes "found nothing" from "couldn't look".
      return InvestigationResultSchema.parse({
        entities,
        relationships,
        evidence,
        warnings: [`${hostname} resolved with no public A records.`],
        errors: [],
        metadata: { hostname },
        execution: outcome.execution,
      });
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings: [],
      errors: [],
      metadata: { hostname },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await resolveA("github.com");
      return { state: "ready", detail: "Cloudflare DoH answered a test query", checkedAt };
    } catch (err) {
      return { state: "unavailable", detail: classifyError("dns", err).message, checkedAt };
    }
  },
};
