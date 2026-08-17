/**
 * OSINT orchestrator — OSINT-INTEGRATION-PLAN.md §11.
 *
 * Runs the plan `query-planner.ts` produces: calls each selected collector's
 * `execute()` then `normalize()`, and merges the results into one
 * `Investigation`. No UI code (per §11's own instruction) and no registry
 * side effects — it uses whatever collectors are already registered in the
 * `CollectorRegistry` it's given, defaulting to the global singleton. A
 * caller against the global registry must call
 * `registerExistingCollectors()` (`collectors/existing/index.ts`) first;
 * this file doesn't do that itself so that a test (or a future caller)
 * supplying its own isolated registry never has real network-calling
 * adapters silently added to it.
 *
 * What this deliberately does NOT do, because each is its own separate task
 * in plan §31's P1 list, not this one:
 *   - Job system (§12): this function runs every collector synchronously,
 *     in-process, inside one `runInvestigation()` call — no queue, no
 *     polling, no per-job status. `jobs.ts` is the async, pollable sibling
 *     built on the same query planner and collector registry; use that when
 *     a caller needs to start a run and check back on it later rather than
 *     block on the whole thing.
 *   - Entity resolution (§17): the dedup in `./merge.ts` this file uses only
 *     removes an entity appearing under the literal same id twice (e.g.
 *     matched via two candidate target types). It does NOT merge
 *     "dns:domain:example.com" and "rdap:domain:example.com" into one
 *     entity even though both name the same real domain — collectors mint
 *     their own namespaced ids, so cross-collector semantic merging is
 *     exactly what `entity-resolution.ts` (not yet built) exists to do.
 *     Treat entities from different collectors as potentially-overlapping,
 *     not already deduplicated.
 *   - Graph/evidence-store integration: `Investigation` is returned to the
 *     caller; nothing here writes to `investigations-store.ts` or any graph.
 */

import { createServerFn } from "@tanstack/react-start";
import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
  InvestigationResult,
} from "../collectors/result";
import type { CollectorRegistry } from "../collectors/registry";
import { collectorRegistry } from "../collectors/registry";
import { registerExistingCollectors } from "../collectors/existing";
import { registerExternalCollectors } from "../collectors/external";
import { resolveInvestigationEntities } from "./entity-resolution";
import { dedupeEntitiesById, dedupeRelationships } from "./merge";
import type { OsintPlan } from "./query-planner";
import { planInvestigation } from "./query-planner";

export interface CollectorRunResult {
  collectorId: string;
  result: InvestigationResult;
}

export interface Investigation {
  input: string;
  plan: OsintPlan;
  collectorResults: CollectorRunResult[];
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
  evidence: CollectorEvidence[];
  warnings: string[];
  errors: string[];
  startedAt: string;
  completedAt: string;
}

export async function runInvestigation(
  rawInput: string,
  registry: CollectorRegistry = collectorRegistry,
): Promise<Investigation> {
  const startedAt = new Date().toISOString();
  const plan = planInvestigation(rawInput, registry);

  const collectorResults = await Promise.all(
    plan.collectors.map(async ({ collectorId, targetType }): Promise<CollectorRunResult> => {
      const collector = registry.get(collectorId);
      if (!collector) {
        // The plan was built from this same registry moments ago; a
        // collector vanishing between planning and execution would be a
        // caller mutating the registry mid-run, not a normal outcome. Fail
        // loudly rather than silently skipping — Rule 5 applies to the
        // orchestrator's own bookkeeping, not just upstream collectors.
        throw new Error(`Planned collector "${collectorId}" is no longer registered.`);
      }
      const outcome = await collector.execute({ type: targetType, value: plan.input });
      const result = collector.normalize(outcome);
      return { collectorId, result };
    }),
  );

  const entities = dedupeEntitiesById(collectorResults.flatMap((r) => r.result.entities));
  const relationships = dedupeRelationships(
    collectorResults.flatMap((r) => r.result.relationships),
  );
  const evidence = collectorResults.flatMap((r) => r.result.evidence);
  const warnings = collectorResults.flatMap((r) => r.result.warnings);
  const errors = collectorResults.flatMap((r) => r.result.errors);

  return {
    input: plan.input,
    plan,
    collectorResults,
    entities,
    relationships,
    evidence,
    warnings,
    errors,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Browser-facing entry point — OSINT-INTEGRATION-PLAN.md §31 P2 "Investigation
 * start". Registers the P1 existing-collector adapters into the global
 * registry (idempotent — `registerExistingCollectors` no-ops on an id
 * that's already there) and applies entity resolution (§17) before
 * returning, so the UI sees merged entities (one "example.com", not three
 * namespaced duplicates) rather than the raw per-collector output
 * `runInvestigation()` alone would give it.
 *
 * theHarvester/SpiderFoot are registered like every other collector but
 * report `unavailable` unless `THEHARVESTER_WORKER_URL`/
 * `SPIDERFOOT_WORKER_URL` are configured (see their own files) — Rule 5
 * means their absence shows up as one collector's status, not a failed
 * investigation.
 */
export const runOsintInvestigation = createServerFn({ method: "POST" })
  .validator((d: { target: string }) => d)
  .handler(async ({ data }) => {
    registerExistingCollectors();
    registerExternalCollectors();
    const investigation = await runInvestigation(data.target);
    const resolved = resolveInvestigationEntities(investigation);
    // `Investigation.entities[].metadata`/`evidence[].rawValue` are typed
    // `unknown` in the P0 contract (result.ts) — deliberately conservative
    // there, since collector-specific provenance data is genuinely
    // heterogeneous. TanStack Start's serialization type-checker rejects
    // `unknown` fields even though every value that ever reaches them is
    // plain JSON at runtime (never a function, class instance, or Map).
    // Round-tripping through JSON here is a real safety net, not just a
    // type-checker workaround: it proves the value actually is
    // JSON-serializable rather than asserting it. `JSON.parse` returns
    // `any`, which is what lets this satisfy the checker without loosening
    // the P0 contract itself for every other (non-serverFn) consumer.
    return JSON.parse(JSON.stringify(resolved));
  });
