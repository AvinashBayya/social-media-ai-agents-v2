/**
 * Collector contract — OSINT-INTEGRATION-PLAN.md §7.
 *
 * This is the interface every collector adapter (existing-utility wrapper or
 * new external tool) implements, and the shape the registry (`registry.ts`)
 * and the future orchestrator (§11, P1 — not built here) program against.
 * Nothing under `src/utils/collectors/` calls out to a real collector yet;
 * this file only defines what one looks like.
 *
 * `execute()` and `normalize()` are deliberately separate, mirroring a
 * pattern already used across this codebase (`imaging.ts` pure vs.
 * `imaging-client.ts` impure, `credibility.ts`'s synchronous core, `llm.ts`'s
 * plain functions vs. their `createServerFn` wrappers): `execute()` does the
 * I/O and can fail in all the ways §5/Rule 5 describes, `normalize()` is a
 * pure function from whatever `execute()` produced to the common
 * `InvestigationResult` shape (`result.ts`) and is trivially unit-testable
 * without a network.
 */

import type { CollectorExecutionMeta } from "./result";
import type { InvestigationResult } from "./result";

// ─── Target types — plan §7 ─────────────────────────────────────────────────

export const TARGET_TYPES = [
  "person",
  "email",
  "phone",
  "username",
  "domain",
  "ip",
  "url",
  "location",
  "article",
  "image",
  "video",
] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export interface CollectorTarget {
  type: TargetType;
  value: string;
}

// ─── Collector metadata ──────────────────────────────────────────────────────

/**
 * Loose rather than a closed zod enum: a collector object lives in code, not
 * on the wire, so a new category for a future adapter is just a new string
 * literal here, additive, with no boundary to re-validate.
 */
export type CollectorCategory = "search" | "infrastructure" | "social" | "media" | "external";

/**
 * Plan §23's display states ("DNS READY", "SpiderFoot OFFLINE") reduced to a
 * type. Distinct from `ProbeStatus` in `collector-health.ts` — that one
 * reports one HTTP reachability probe; this reports a whole collector
 * (which may itself be backed by several endpoints, or an external process).
 */
export type CollectorHealthState = "ready" | "unavailable" | "no-credential" | "degraded";

export interface CollectorHealth {
  state: CollectorHealthState;
  detail: string;
  checkedAt: string;
}

/** What `Collector.execute()` resolves to: execution bookkeeping plus whatever raw payload (or none, on failure) the collector produced. */
export interface CollectorRunOutcome<TRaw> {
  execution: CollectorExecutionMeta;
  /** Null when `execution.status` is `failed` or `cancelled` — never an empty object standing in for "no data". */
  raw: TRaw | null;
}

/**
 * `TRaw` is intentionally per-collector (theHarvester's JSON is not
 * SpiderFoot's JSON is not a DNS lookup's answer). `normalize()` is where
 * that per-collector shape ends and the common `InvestigationResult` begins.
 *
 * `normalize()` takes the whole `CollectorRunOutcome`, not just `raw`,
 * because `InvestigationResult.execution` (plan §8) has to come from
 * *somewhere* and `execute()` is what computed it — threading it back in as
 * a second argument would just move the same requirement one call further
 * out. Every implementation's first line should handle `raw === null` (a
 * failed or cancelled run) by returning `emptyInvestigationResult(outcome.execution)`
 * — `existing/shared.ts`'s `normalizeGuard()` does this in one line.
 */
export interface Collector<TRaw = unknown> {
  id: string;
  name: string;
  category: CollectorCategory;
  supportedTargetTypes: TargetType[];
  requiresCredentials: boolean;
  /** False for collectors this project cannot run without (plan §5: "Sentinel must still work" if this is true and the tool is absent). */
  isOptional: boolean;

  execute(target: CollectorTarget): Promise<CollectorRunOutcome<TRaw>>;
  normalize(outcome: CollectorRunOutcome<TRaw>): InvestigationResult;
  healthCheck(): Promise<CollectorHealth>;
}
