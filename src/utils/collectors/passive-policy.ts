/**
 * Passive-only enforcement — PASSIVE-OSINT-PLATFORM-SPEC.md §2, gap N1.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT `collection-policy.ts`.
 *
 * `collection-policy.ts` says of itself, correctly and in its own header:
 * "NOTHING HERE IS AN ENFORCEMENT MECHANISM. It is a declaration of what the system
 * is permitted to do." That is a real and useful thing — it models *legal basis* per
 * platform, which is a compliance question. But the architecture audit found the
 * consequence: spec §2 requires that "any adapter marked ACTIVE must be rejected by
 * the orchestrator", and nothing in this codebase could reject anything, because
 * nothing knew how an adapter collected.
 *
 * This module is the missing half. It reads the `capability` declaration added to
 * `Collector` and decides whether the orchestrator may run it.
 *
 * THE DENY-BY-DEFAULT INVERSION, WHICH IS THE WHOLE POINT.
 *
 * An **undeclared** collector is refused, not permitted. This mirrors
 * `collection-policy.ts` (`policyFor()` returning null must be read as DENY) and
 * `scan-authorization.ts` ("an unlisted target is a gap, not a licence"). The
 * failure mode being prevented is specific and cheap to fall into: someone adds a
 * collector, forgets the capability block, and it runs anyway because absence read
 * as "probably fine". Then the gate is decorative.
 *
 * DELIBERATELY A LEAF MODULE — TYPE-ONLY IMPORTS, NO RUNTIME EDGES.
 *
 * This project has now been bitten twice by a cross-module import dragging
 * `bun:sqlite` into a chunk that could not load it: once into the browser bundle
 * (every route white-screened), once into an SSR chunk on the Node runtime
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME`, HTTP 500 on every `collectorHealth` call,
 * shipped as v28). Both times `bun test` and `tsc --noEmit` were clean throughout,
 * because the defect existed only in the bundle.
 *
 * A gate that fails to load is a gate that is not enforcing anything. This file
 * therefore imports from exactly one module, `./types`, which is itself a leaf: every
 * import in `types.ts` is `import type`, so it has no runtime edges of its own and the
 * single value import below (`PASSIVE_COLLECTION_MODES`) cannot drag anything into a
 * shared chunk. **Do not add an import from any other module to this file** — and if
 * `types.ts` ever gains a value import, this guarantee is gone with it.
 */

import type { Collector, SourceCapability, SourceCollectionMode } from "./types";
import { PASSIVE_COLLECTION_MODES } from "./types";

// ─── Why a collector was refused ────────────────────────────────────────────

/**
 * Distinct reasons rather than one boolean, because the UI has to tell an analyst
 * *why* a source is missing from a run. "Rejected" and "not configured" and "you
 * forgot to declare it" are three different operator actions.
 */
export type PassiveRejectionReason =
  | "active-mode"
  | "not-allowed"
  | "undeclared-capability"
  | "active-capable-without-gate";

export const PASSIVE_REJECTION_DETAIL: Record<PassiveRejectionReason, string> = {
  "active-mode":
    "Declares collectionMode ACTIVE. Spec §2 prohibits active reconnaissance; the orchestrator refuses it.",
  "not-allowed": "Declared with allowed: false — present in the registry but forbidden from running.",
  "undeclared-capability":
    "No capability declaration. An undeclared collector is a policy gap, not a permission — declare it before it can run.",
  "active-capable-without-gate":
    "Marked activeCapable but not authorisationGated. Data originating from packets on the wire may only be read behind an authorisation gate.",
};

/** Thrown by `assertPassiveCollector()`. Carries the machine-readable reason, not just prose. */
export class PassivePolicyViolationError extends Error {
  constructor(
    readonly collectorId: string,
    readonly reason: PassiveRejectionReason,
  ) {
    super(`Collector "${collectorId}" refused by passive-only policy: ${PASSIVE_REJECTION_DETAIL[reason]}`);
    this.name = "PassivePolicyViolationError";
  }
}

// ─── Predicates ─────────────────────────────────────────────────────────────

export function isPassiveMode(mode: SourceCollectionMode): boolean {
  return PASSIVE_COLLECTION_MODES.has(mode);
}

/**
 * The single decision function. Returns the reason a capability is refused, or
 * `null` when it passes.
 *
 * Order matters: `ACTIVE` is checked before `allowed`, so an ACTIVE adapter that
 * also sets `allowed: true` is still refused. The spec's prohibition is not
 * something a declaration can opt out of.
 */
export function rejectionReasonFor(capability: SourceCapability | undefined): PassiveRejectionReason | null {
  if (!capability) return "undeclared-capability";
  if (!isPassiveMode(capability.collectionMode)) return "active-mode";
  if (!capability.allowed) return "not-allowed";
  if (capability.activeCapable && !capability.authorisationGated) return "active-capable-without-gate";
  return null;
}

export function isPassiveCollector(collector: Pick<Collector, "capability">): boolean {
  return rejectionReasonFor(collector.capability) === null;
}

/** Throws `PassivePolicyViolationError` if the collector may not run. */
export function assertPassiveCollector(collector: Pick<Collector, "id" | "capability">): void {
  const reason = rejectionReasonFor(collector.capability);
  if (reason) throw new PassivePolicyViolationError(collector.id, reason);
}

// ─── Bulk filtering, for the planner and orchestrator ───────────────────────

export interface PassiveRejection {
  collectorId: string;
  reason: PassiveRejectionReason;
  detail: string;
}

export interface PassiveFilterResult<T> {
  allowed: T[];
  /**
   * Never silently dropped. Spec §33: an unavailable source must be reported, not
   * hidden, or the analyst reads a partial result as a complete one.
   */
  rejected: PassiveRejection[];
}

export function filterPassiveCollectors<T extends Pick<Collector, "id" | "capability">>(
  collectors: readonly T[],
): PassiveFilterResult<T> {
  const allowed: T[] = [];
  const rejected: PassiveRejection[] = [];
  for (const collector of collectors) {
    const reason = rejectionReasonFor(collector.capability);
    if (reason) {
      rejected.push({
        collectorId: collector.id,
        reason,
        detail: PASSIVE_REJECTION_DETAIL[reason],
      });
    } else {
      allowed.push(collector);
    }
  }
  return { allowed, rejected };
}

// ─── Capability matrix rows — spec §42 ──────────────────────────────────────

/**
 * One row of spec §42's capability matrix. Kept as a pure projection so the page
 * that renders it (`/crawlers`) holds no policy logic of its own — a UI that
 * re-derives "is this passive?" is a UI that can disagree with the orchestrator.
 *
 * `status` and `lastCheck` are deliberately NOT here. They come from a live probe
 * (`collector-health.ts`), and a static capability declaration must never be able
 * to render as a health result.
 */
export interface CapabilityMatrixRow {
  sourceId: string;
  name: string;
  disciplines: string[];
  inputTypes: string[];
  collectionMode: SourceCollectionMode;
  passive: boolean;
  apiAvailable: boolean;
  requiresAuth: boolean;
  requiresManualAction: boolean;
  activeCapable: boolean;
  authorisationGated: boolean;
  allowed: boolean;
  rejection: PassiveRejection | null;
  notes: string;
}

export function capabilityMatrixRow(collector: Collector): CapabilityMatrixRow {
  const cap = collector.capability;
  const reason = rejectionReasonFor(cap);
  return {
    sourceId: collector.id,
    name: collector.name,
    disciplines: collector.disciplines ? [...collector.disciplines] : [],
    inputTypes: [...collector.supportedTargetTypes],
    // An undeclared collector has no honest mode to report. "ACTIVE" is the
    // conservative stand-in: it is the value that keeps it refused and visible,
    // and `rejection` below states the real reason so nothing is misread.
    collectionMode: cap?.collectionMode ?? "ACTIVE",
    passive: reason === null,
    apiAvailable: cap?.apiAvailable ?? false,
    requiresAuth: cap?.requiresAuth ?? collector.requiresCredentials,
    requiresManualAction: cap?.requiresManualAction ?? false,
    activeCapable: cap?.activeCapable ?? false,
    authorisationGated: cap?.authorisationGated ?? false,
    allowed: cap?.allowed ?? false,
    rejection: reason ? { collectorId: collector.id, reason, detail: PASSIVE_REJECTION_DETAIL[reason] } : null,
    notes: cap?.notes ?? "No capability declaration.",
  };
}

export function capabilityMatrix(collectors: readonly Collector[]): CapabilityMatrixRow[] {
  return collectors.map(capabilityMatrixRow);
}
