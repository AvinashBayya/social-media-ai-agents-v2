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

  /**
   * Passive-only capability declaration — spec §2. **Optional on purpose**: every
   * collector that predates this field keeps compiling and keeps working.
   *
   * Absence means **undeclared**, never "declared passive". `assertPassiveCollector()`
   * in `passive-policy.ts` treats an undeclared collector as a policy gap and refuses
   * it, exactly as `collection-policy.ts`'s `policyFor()` returning null must be read
   * as DENY. An unreviewed source that runs by default is how the enforcement gets
   * hollowed out.
   */
  capability?: SourceCapability;

  /**
   * Which intelligence discipline(s) this collector feeds — spec §1, §26, §28, §35.
   * Optional for the same reason `capability` is. Absence means untagged, and the
   * UI must show it as untagged rather than silently filing it under one.
   */
  disciplines?: Discipline[];

  execute(target: CollectorTarget): Promise<CollectorRunOutcome<TRaw>>;
  normalize(outcome: CollectorRunOutcome<TRaw>): InvestigationResult;
  healthCheck(): Promise<CollectorHealth>;
}

// ─── Intelligence disciplines — spec §1 ─────────────────────────────────────

/**
 * The four disciplines the platform must support.
 *
 * **MEDIAINT is MEDIA intelligence, not medical.** Public news/media/web coverage:
 * publishers, articles, claims, narratives, events, timelines, sentiment, source
 * comparison. Do not add a medical source here.
 */
export const DISCIPLINES = ["SOCMINT", "GEOINT", "TECHINT", "MEDIAINT"] as const;
export type Discipline = (typeof DISCIPLINES)[number];

export const DISCIPLINE_LABELS: Record<Discipline, string> = {
  SOCMINT: "Social Media Intelligence",
  GEOINT: "Geospatial Intelligence",
  TECHINT: "Technical Intelligence",
  MEDIAINT: "Media Intelligence",
};

// ─── Source capability model — spec §2 ──────────────────────────────────────

/**
 * How a source collects, in the spec §2 vocabulary.
 *
 * ⚠️ **Not the same type as `CollectionMode` in `collection-policy.ts`**, and the two
 * must not be merged. That one answers "may we collect from this platform, and on what
 * legal basis" (`automated` / `partial` / `manual-only` / `none`) — a compliance
 * question about a *platform*. This one answers "by what technical route does this
 * *adapter* obtain data", which is what decides whether the orchestrator may run it.
 * A source can be `PASSIVE_API` here and `manual-only` there; both are true.
 *
 * `ACTIVE` exists so a non-passive adapter can be *named and rejected* rather than
 * being unrepresentable. A vocabulary that cannot express the thing it forbids cannot
 * enforce the prohibition.
 */
export const SOURCE_COLLECTION_MODES = [
  "PASSIVE_API",
  "PASSIVE_PUBLIC_WEB",
  "PASSIVE_DATASET",
  "LOCAL_FILE_ANALYSIS",
  "MANUAL_ASSISTED",
  "ACTIVE",
] as const;
export type SourceCollectionMode = (typeof SOURCE_COLLECTION_MODES)[number];

/** The five modes spec §2 lists as permitted. `ACTIVE` is deliberately absent. */
export const PASSIVE_COLLECTION_MODES: ReadonlySet<SourceCollectionMode> = new Set([
  "PASSIVE_API",
  "PASSIVE_PUBLIC_WEB",
  "PASSIVE_DATASET",
  "LOCAL_FILE_ANALYSIS",
  "MANUAL_ASSISTED",
]);

/**
 * Spec §2's `SourceCapability`, in this codebase's camelCase idiom rather than the
 * spec's snake_case — the surrounding code (`supportedTargetTypes`, `requiresCredentials`)
 * is camelCase and consistency inside the file wins over transliteration.
 *
 * **`activeCapable` and `collectionMode` are separate on purpose.** IVRE is the case
 * that forces it: `ivreCollector.execute()` only ever READS an operator-owned scan
 * database and never emits a packet, so its mode is honestly `PASSIVE_DATASET` — but
 * the data in that database came from Nmap, so `activeCapable` is `true` and the
 * authorisation gate must stay. Collapsing the two into one boolean would force a
 * choice between lying about the mode and deleting a working, gated collector.
 */
export interface SourceCapability {
  sourceId: string;
  name: string;
  collectionMode: SourceCollectionMode;
  /**
   * True when the underlying data originates from packets sent to the target, even if
   * this adapter itself only reads a stored result. Requires `authorisationGated`.
   */
  activeCapable: boolean;
  /** False marks a source declared but forbidden — it stays visible in the registry and never runs. */
  allowed: boolean;
  requiresAuth: boolean;
  requiresManualAction: boolean;
  apiAvailable: boolean;
  /**
   * Whether every call passes an authorisation gate (`assertScanAuthorised()`).
   * Must be true whenever `activeCapable` is true — `passive-policy.ts` enforces this.
   */
  authorisationGated?: boolean;
  notes: string;
}
