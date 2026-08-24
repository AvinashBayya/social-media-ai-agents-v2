/**
 * presence.image — Person Investigation collector.
 *
 * **Read this before assuming there is a face-matching capability behind
 * this file.** The task this was built against said "reuse existing
 * Module-4 face MATCH against an operator-supplied reference set." That
 * capability does not exist anywhere in this codebase — confirmed directly
 * against `src/utils/imaging.ts`'s own `NOT_IMPLEMENTED` array:
 *
 *   capability: "Face matching against a watchlist"
 *   requires: "A face recognition model, a curated reference set, and a
 *              lawful basis to hold it."
 *   limitation: "Beyond the technical requirement, holding biometric
 *              templates of identifiable individuals engages the DPDP Act
 *              2023. Not a gap to close without a legal basis first."
 *
 * See PERSON-INVESTIGATION-ANALYSIS.md §8 for the full investigation. There
 * is no face detection/embedding/comparison code anywhere in `imaging.ts`
 * or `imaging-client.ts` to reuse — pHash near-duplicate matching exists,
 * but that answers a different question ("is this the same image file,
 * possibly recompressed?"), not "does this person's face appear in this
 * photo?", and presenting one as a stand-in for the other would itself be
 * exactly the kind of fabricated-confidence result CLAUDE.md's hard
 * constraints forbid.
 *
 * This collector is therefore implemented as a real, registered `Collector`
 * — satisfying "each new PERSON-capable collector, each implementing the
 * shared Collector interface" literally — that ALWAYS reports `unavailable`
 * with this explanation. There is no env var or credential that turns it
 * on: unlike theHarvester/SpiderFoot (adapter built, worker just not
 * deployed *yet*), this is a deliberate, standing decision, not a
 * deployment gap. Building the real capability is a separate, much larger
 * initiative — a face-recognition model, GPU inference (this deployment has
 * none — see CLAUDE.md's GPU-quota section), and its own DPDP Act 2023
 * lawful-basis review — explicitly out of scope here.
 */

import { collectorUnavailable } from "../errors";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { finishExecution, normalizeGuard, startExecution } from "../existing/shared";

const UNAVAILABLE_MESSAGE =
  "Face matching is not implemented anywhere in this system, by deliberate design, not a " +
  "missing deployment step. It would require a face-recognition model, GPU inference (none is " +
  "provisioned), and its own lawful-basis review under the DPDP Act 2023 for holding biometric " +
  "templates of identifiable individuals — see NOT_IMPLEMENTED in src/utils/imaging.ts. No " +
  "credential or worker configuration will change this collector's result.";

export type PresenceImageRaw = never;

export const presenceImageCollector: Collector<PresenceImageRaw> = {
  id: "presence.image",
  name: "Presence — Image/face match (not implemented — deliberate)",
  category: "media",
  supportedTargetTypes: ["person"],
  requiresCredentials: false,
  isOptional: true,

  async execute(_target: CollectorTarget): Promise<CollectorRunOutcome<PresenceImageRaw>> {
    const clock = startExecution();
    const err = collectorUnavailable("presence.image", UNAVAILABLE_MESSAGE);
    return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
  },

  normalize(outcome) {
    // raw is always null (execute() never succeeds) — normalizeGuard() always
    // returns the populated-empty result here; this call exists only to
    // satisfy the Collector contract and keep the failure message attached.
    return normalizeGuard(outcome)!;
  },

  async healthCheck(): Promise<CollectorHealth> {
    return {
      state: "unavailable",
      detail: "Deliberately not implemented — see this file's own header for why.",
      checkedAt: new Date().toISOString(),
    };
  },
};
