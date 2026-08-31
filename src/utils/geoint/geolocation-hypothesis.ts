/**
 * VISUAL GEOLOCATION HYPOTHESIS (2026-08-30, ported from the teammate's fork).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OUTPUT OF THIS MODULE IS ALWAYS A HYPOTHESIS. THERE IS NO OTHER PATH.
 *
 * A visual-geolocation result must be represented as a HYPOTHESIS, not fact,
 * and never as `OBSERVED`. So `claimClass` is not a parameter here — it is
 * hard-coded to `HYPOTHESIS` on every record this module can produce.
 *
 * That matters because `confidenceBandOf()` (`collectors/result.ts`) forces the
 * HYPOTHESIS band whenever the class is HYPOTHESIS, *regardless of the numeric
 * score attached*. A provider returning 0.97 therefore still renders as a
 * hypothesis — "do not let a model-generated location automatically become HIGH
 * confidence" is enforced by that existing mechanism rather than by a rule this
 * file has to remember.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WORDING IS PART OF THE CONTRACT.
 *
 * `describeHypothesis()` exists so no renderer has to compose the sentence
 * itself. It never emits "the image was taken at X" — always "Visual geolocation
 * hypothesis: X". The phrasing was specified, and a phrase assembled ad hoc in a
 * component is one refactor away from losing its qualifier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO PROVIDER IS AUTOMATED TODAY. GeoSpy is a paid API behind an account, so it
 * ships MANUAL_ASSISTED (see `providers.ts`). This module therefore takes
 * hypotheses from an analyst-assisted workflow, and would take them from an
 * automated provider unchanged if one were ever configured — the record shape and
 * the HYPOTHESIS class do not vary by route.
 */

import type { GeoPoint } from "../../types/core";
import { toGeoPoint } from "../../types/core-adapters";
import type { ClaimClass, ConfidenceScore } from "../collectors/result";
import type { GeoIntProviderId } from "./providers";
import { providerById } from "./providers";

export interface LocationHypothesis {
  hypothesisId: string;
  /** The image this is a hypothesis about. */
  imageRef: string;
  provider: GeoIntProviderId;
  /** How the hypothesis reached Sentinel. */
  discoveredBy: "AUTOMATED_PROVIDER" | "MANUAL_ASSISTED";

  /** The place, in words. Always present — a hypothesis with no candidate is not one. */
  candidateLocation: string;
  /**
   * Coordinates, ONLY when the provider actually supplied them and they passed
   * the coordinate gate. Null otherwise — a named place is never geocoded into
   * invented numbers.
   */
  point: GeoPoint | null;
  /** Why the provider or analyst proposes this. Required — an unexplained hypothesis is unreviewable. */
  reasoning: string;
  /** Provider/model version where reported. Null otherwise. */
  providerVersion: string | null;

  /** When the provider produced it, when known. */
  observedAt: string | null;
  retrievedAt: string;

  confidence: ConfidenceScore;
  /** Always "HYPOTHESIS". Present as a field so it travels with the record. */
  claimClass: ClaimClass;
  /** Literal classification stored alongside for renderers that read this field directly. */
  classification: "HYPOTHESIS";
  evidenceRef: string | null;
  notes: string | null;
}

export const HYPOTHESIS_CAVEATS: string[] = [
  "A visual geolocation is a hypothesis about what a picture resembles. It is never an observation of where the picture was taken.",
  "A confident-sounding score from a provider does not make it a finding — every result here bands as HYPOTHESIS regardless of the number attached.",
  "Coordinates appear only when the provider actually supplied them. A named place is never converted into coordinates by this system.",
  "Two providers agreeing is not corroboration if both are guessing from the same visual cues.",
];

export class HypothesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HypothesisError";
  }
}

export interface HypothesisInput {
  imageRef: string;
  provider: GeoIntProviderId;
  discoveredBy?: "AUTOMATED_PROVIDER" | "MANUAL_ASSISTED";
  candidateLocation: string;
  reasoning: string;
  /** Supplied by the provider only. Absent means absent. */
  latitude?: number | null;
  longitude?: number | null;
  /**
   * How precise the provider claims to be. Defaults to "city": a visual guess is
   * not an exact fix, and defaulting to "exact" would let a guess render as a
   * pinpoint. `exact` is accepted but must be explicitly asked for.
   */
  precision?: GeoPoint["precision"];
  providerVersion?: string | null;
  observedAt?: string | null;
  providerConfidence?: number | null;
  evidenceRef?: string | null;
  notes?: string | null;
}

/**
 * Builds a location hypothesis.
 *
 * Validates; never fills in. `candidateLocation` and `reasoning` are required —
 * a hypothesis an analyst cannot evaluate is not usable intelligence.
 */
export function buildLocationHypothesis(
  input: HypothesisInput,
  retrievedAt: string,
): LocationHypothesis {
  const candidate = (input.candidateLocation ?? "").trim();
  if (!candidate) throw new HypothesisError("A candidate location is required.");

  const reasoning = (input.reasoning ?? "").trim();
  if (!reasoning) {
    throw new HypothesisError(
      "Reasoning is required. An unexplained location hypothesis cannot be reviewed, and an unreviewable hypothesis is not evidence.",
    );
  }
  if (!input.imageRef) throw new HypothesisError("imageRef is required.");
  if (!providerById(input.provider)) {
    throw new HypothesisError(`"${input.provider}" is not a declared GEOINT provider.`);
  }

  // Coordinates only when genuinely supplied, and only through the project's
  // coordinate gate — 0,0 and out-of-range are refused there.
  const hasCoords =
    typeof input.latitude === "number" && typeof input.longitude === "number";
  const point = hasCoords
    ? toGeoPoint(input.latitude, input.longitude, input.precision ?? "city")
    : null;

  const providerConfidence = input.providerConfidence;
  const scored =
    typeof providerConfidence === "number" && providerConfidence >= 0 && providerConfidence <= 1;

  return {
    hypothesisId: `hypothesis:${input.provider}:${input.imageRef}:${candidate.slice(0, 48)}`,
    imageRef: input.imageRef,
    provider: input.provider,
    discoveredBy: input.discoveredBy ?? "MANUAL_ASSISTED",
    candidateLocation: candidate,
    point,
    reasoning,
    providerVersion: (input.providerVersion ?? "").trim() || null,
    observedAt: (input.observedAt ?? "").trim() || null,
    retrievedAt,
    confidence: {
      value: scored ? providerConfidence! : null,
      reasons: scored
        ? [
            "Confidence as reported by the provider.",
            "Does NOT raise the finding above a hypothesis — the HYPOTHESIS class overrides the band whatever this number is.",
          ]
        : ["No confidence reported — unscored, not zero."],
    },
    // Not a parameter. There is no code path here that produces anything else.
    claimClass: "HYPOTHESIS",
    classification: "HYPOTHESIS",
    evidenceRef: input.evidenceRef ?? null,
    notes: (input.notes ?? "").trim() || null,
  };
}

/**
 * The sentence a UI should print. Never "the image was taken at X".
 *
 * Centralised so the qualifier cannot be dropped by a component composing its own
 * string — which is exactly how a hypothesis becomes an assertion.
 */
export function describeHypothesis(h: LocationHypothesis): string {
  const where = h.point
    ? `${h.candidateLocation} (${h.point.lat.toFixed(5)}, ${h.point.lon.toFixed(5)}, ${h.point.precision} precision)`
    : h.candidateLocation;
  return `Visual geolocation hypothesis: ${where}`;
}

export interface HypothesisSummary {
  total: number;
  withCoordinates: number;
  providers: number;
  unscored: number;
  /** Always true while any hypothesis exists — asserted, so a UI cannot forget to caveat. */
  allHypotheses: boolean;
}

export function summariseHypotheses(list: readonly LocationHypothesis[]): HypothesisSummary {
  return {
    total: list.length,
    withCoordinates: list.filter((h) => h.point !== null).length,
    providers: new Set(list.map((h) => h.provider)).size,
    unscored: list.filter((h) => h.confidence.value === null).length,
    allHypotheses: list.every((h) => h.claimClass === "HYPOTHESIS"),
  };
}
