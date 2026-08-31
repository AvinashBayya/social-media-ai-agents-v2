/**
 * Shodan InternetDB adapter — OSINT-INTEGRATION-PLAN.md §5 "Shodan" / §31 P1.
 *
 * Wraps `internetDb`/`resolveA`/`isIPv4`/`MAX_ADDRESSES` from
 * `src/utils/attack-surface.ts` verbatim — the free, keyless InternetDB
 * endpoint only, matching that file's own deliberate choice not to build on
 * undocumented `api.shodan.io` behavior. Full Shodan API stays P3 (plan §24:
 * "Never required").
 *
 * Ports/CPEs/tags/vulns are kept as metadata on the IP entity rather than
 * modeled as their own entities+relationships: the common result model
 * (plan §19) has no "service"/"port" entity type or edge, and forcing one in
 * here would be inventing vocabulary the plan doesn't define. Reverse
 * hostnames DO fit the existing model (domain entity + RESOLVES_TO), so
 * those are modeled properly.
 */

import { internetDb, isIPv4, MAX_ADDRESSES, resolveA, toHostname } from "../../attack-surface";
import type { HostSurface } from "../../attack-surface";
import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "./shared";

export interface ShodanRaw {
  hosts: HostSurface[];
}

async function resolveAddresses(target: CollectorTarget): Promise<string[]> {
  const hostname = toHostname(target.value);
  if (isIPv4(hostname)) return [hostname];
  const resolved = await resolveA(hostname);
  return resolved.slice(0, MAX_ADDRESSES);
}

export const shodanInternetDbCollector: Collector<ShodanRaw> = {
  id: "shodan-internetdb",
  name: "Shodan InternetDB",
  category: "infrastructure",
  supportedTargetTypes: ["ip", "domain"],
  requiresCredentials: false,
  isOptional: false,

  capability: {
    sourceId: "shodan-internetdb",
    name: "Shodan InternetDB",
    collectionMode: "PASSIVE_DATASET",
    activeCapable: false,
    allowed: true,
    requiresAuth: false,
    requiresManualAction: false,
    apiAvailable: true,
    notes: "Reads Shodan's own prior scan results. Sentinel sends the target nothing. Returns no geolocation — that needs the paid API, so the geo layer stays empty rather than faked.",
  },

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<ShodanRaw>> {
    const clock = startExecution();
    let addresses: string[];
    try {
      addresses = await resolveAddresses(target);
    } catch (err) {
      const classified = classifyError("shodan-internetdb", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
    if (addresses.length === 0) {
      const err = new CollectorError(
        "shodan-internetdb",
        "invalid-target",
        `No address to look up for "${target.value}".`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    try {
      const hosts = await Promise.all(addresses.map(internetDb));
      return { execution: finishExecution(clock, "completed", hosts.length), raw: { hosts } };
    } catch (err) {
      const classified = classifyError("shodan-internetdb", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const { hosts } = outcome.raw!;

    const entities: CollectorEntity[] = [];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;
    const warnings: string[] = [];

    for (const host of hosts) {
      const ipId = `shodan:ip:${host.ip}`;
      entities.push({
        id: ipId,
        type: "ip",
        value: host.ip,
        displayName: host.ip,
        source: "shodan-internetdb",
        confidence: UNSCORED,
        metadata: {
          scanned: host.scanned,
          ports: host.ports,
          cpes: host.cpes,
          tags: host.tags,
          vulns: host.vulns,
          devices: host.devices,
          shodanUrl: host.shodanUrl,
        },
      });

      if (!host.scanned) {
        warnings.push(`${host.ip}: no InternetDB record — Shodan has not scanned this address.`);
      }

      for (const hostname of host.hostnames) {
        const domainId = `shodan:domain:${hostname}`;
        if (!entities.some((e) => e.id === domainId)) {
          entities.push({
            id: domainId,
            type: "domain",
            value: hostname,
            displayName: hostname,
            source: "shodan-internetdb",
            confidence: UNSCORED,
            metadata: {},
          });
        }
        relationships.push({
          sourceEntity: domainId,
          relationshipType: "RESOLVES_TO",
          targetEntity: ipId,
          confidence: {
            value: null,
            reasons: ["Shodan-reported reverse hostname, not independently re-resolved"],
          },
          source: "shodan-internetdb",
        });
      }

      evidence.push({
        source: "Shodan InternetDB",
        sourceUrl: `https://internetdb.shodan.io/${host.ip}`,
        collector: "shodan-internetdb",
        collectedAt,
        rawValue: host,
        normalizedValue: host,
        confidence: null,
        metadata: {},
      });
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: { hostsProbed: hosts.length },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      // 8.8.8.8 is documented as always present in InternetDB.
      await internetDb("8.8.8.8");
      return { state: "ready", detail: "InternetDB answered a known-good test address", checkedAt };
    } catch (err) {
      return {
        state: "unavailable",
        detail: classifyError("shodan-internetdb", err).message,
        checkedAt,
      };
    }
  },
};
