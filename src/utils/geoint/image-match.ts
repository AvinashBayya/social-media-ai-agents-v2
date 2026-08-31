/**
 * REVERSE-IMAGE / IMAGE-MATCH GEOINT (2026-08-30, ported from the teammate's
 * fork).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A VISUAL MATCH IS NOT PROOF OF IDENTITY OR ORIGIN.
 *
 * That is the rule the whole file is arranged around. Two images being
 * perceptually identical means they are the same picture — it says nothing about
 * who took it, when, where, or which copy came first. `MATCH_TYPES` exists so a
 * result is always qualified, and `UNKNOWN` is a first-class value rather than a
 * fallback nobody chose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ROUTES IN, ONE RECORD OUT.
 *
 *   1. AUTOMATED — `local-phash` only, and it queries nothing: it compares
 *      against images already hashed in this browser, reusing `findNearDuplicates`
 *      from `imaging.ts`. It finds re-use *within this investigation*, never
 *      across the open web, and says so.
 *   2. MANUAL_ASSISTED — Google Lens, TinEye, Yandex. The analyst runs the search
 *      in their own browser under the provider's terms and brings the result
 *      back. There is no scraper here and there must not be one; see
 *      `providers.ts` for why each is manual.
 *
 * Both produce the same `ImageMatch`, so a renderer and a report never care which
 * route a finding came in by — but `discoveredBy` always records which it was,
 * because an analyst-attested match and a computed one are different evidence.
 */

import type { DuplicateReport, HashedImage } from "../imaging";
import { IDENTICAL_DISTANCE, NEAR_DUPLICATE_DISTANCE } from "../imaging";
import type { ClaimClass, ConfidenceScore } from "../collectors/result";
import type { GeoIntProviderId } from "./providers";
import { providerById } from "./providers";

// ─── Match vocabulary ────────────────────────────────────────────────────────

export const MATCH_TYPES = [
  "EXACT_MATCH",
  "NEAR_MATCH",
  "VISUAL_SIMILARITY",
  "POSSIBLE_SOURCE",
  "UNKNOWN",
] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export const MATCH_TYPE_DETAIL: Record<MatchType, string> = {
  EXACT_MATCH: "Byte- or hash-identical. The same picture, not evidence of who published it first.",
  NEAR_MATCH: "The same picture after resize or recompression. Common for redistributed media.",
  VISUAL_SIMILARITY: "Visually similar but not the same file. May be a different shot of the same scene, or coincidence.",
  POSSIBLE_SOURCE: "An analyst judged this a plausible earlier publication. A judgement, not a measurement.",
  UNKNOWN: "A match was recorded but its nature could not be established.",
};

/** How the match was found. Kept because an attested match and a computed one are different evidence. */
export type MatchDiscovery = "AUTOMATED_PROVIDER" | "MANUAL_ASSISTED";

export interface ImageMatch {
  matchId: string;
  /** The image being investigated. */
  imageRef: string;
  provider: GeoIntProviderId;
  discoveredBy: MatchDiscovery;

  matchType: MatchType;
  /** Where the match was found. Null when the analyst recorded no URL. */
  matchedUrl: string | null;
  /** The analyst's or the engine's own words for what was found. */
  description: string;
  /** Perceptual distance where one was computed. Null for manual matches — never a stand-in number. */
  hammingDistance: number | null;

  /** When the match was observed by the provider or the analyst. Null when unknown. */
  observedAt: string | null;
  /** When it entered Sentinel. Always known. */
  retrievedAt: string;

  /** SHA-256 or filename of a screenshot the analyst attached. Null when none. */
  screenshotRef: string | null;
  notes: string | null;
  confidence: ConfidenceScore;
  claimClass: ClaimClass;
  /** Evidence record this match belongs to, when one exists. */
  evidenceRef: string | null;
}

export const MATCH_CAVEATS: string[] = [
  "A visual match is not proof of identity or origin. The same picture appearing in two places says nothing about which came first or who took it.",
  "Local perceptual matching compares only against images analysed in this browser. It is not a search of the open web, and finding nothing here means nothing.",
  "Perceptual hashing does not survive heavy cropping, mirroring or rotation. A missed match is not an absence.",
  "Manual-assisted results are the analyst's attestation of what a provider showed them. They carry the analyst's judgement, not the provider's guarantee.",
];

// ─── Automated route: local perceptual match ────────────────────────────────

/**
 * Classifies a perceptual distance into the documented vocabulary.
 *
 * Uses `imaging.ts`'s existing thresholds rather than inventing new ones:
 * `IDENTICAL_DISTANCE` (4) and `NEAR_DUPLICATE_DISTANCE` (10). Beyond the
 * near-duplicate threshold nothing is claimed — `UNKNOWN`, not a guess dressed
 * as similarity.
 */
export function classifyDistance(distance: number): MatchType {
  if (!Number.isFinite(distance) || distance < 0) return "UNKNOWN";
  if (distance <= IDENTICAL_DISTANCE) return "EXACT_MATCH";
  if (distance <= NEAR_DUPLICATE_DISTANCE) return "NEAR_MATCH";
  return "UNKNOWN";
}

/**
 * Projects `findNearDuplicates()`'s report into `ImageMatch` records.
 *
 * Reuses the existing engine wholesale — no new hashing, no new comparison.
 */
export function matchesFromDuplicateReport(
  imageRef: string,
  report: DuplicateReport | null | undefined,
  retrievedAt: string,
): ImageMatch[] {
  if (!report || !Array.isArray(report.matches)) return [];

  return report.matches.map((m, i) => {
    const matchType = m.identical ? "EXACT_MATCH" : classifyDistance(m.distance);
    const image: HashedImage = m.image;
    return {
      matchId: `match:local:${imageRef}:${image.id}`,
      imageRef,
      provider: "local-phash" as const,
      discoveredBy: "AUTOMATED_PROVIDER" as const,
      matchType,
      matchedUrl: image.url || null,
      description:
        `Perceptual distance ${m.distance} against an image analysed in this browser` +
        (m.daysEarlier !== null ? `, first seen ${m.daysEarlier} day(s) earlier.` : "."),
      hammingDistance: m.distance,
      // The corpus records when THIS analyst saw it, which is a real observation.
      observedAt: image.seenAt || null,
      retrievedAt,
      screenshotRef: null,
      notes: null,
      confidence: {
        // A computed hash distance is a real measurement of similarity. It is
        // deliberately NOT a confidence that the two are related in the world.
        value: matchType === "EXACT_MATCH" ? 0.9 : matchType === "NEAR_MATCH" ? 0.65 : null,
        reasons: [
          `Hamming distance ${m.distance} (identical ≤ ${IDENTICAL_DISTANCE}, near-duplicate ≤ ${NEAR_DUPLICATE_DISTANCE}).`,
          "Measures image similarity only. It is not a confidence that the two images share an origin.",
          "Compared against this browser's corpus, not the open web.",
        ],
      },
      // Reading a hash distance is a computation over observations.
      claimClass: "DERIVED" as const,
      evidenceRef: null,
      // Ordering stability for identical distances.
      ...(i === -1 ? {} : {}),
    } satisfies ImageMatch;
  });
}

// ─── Manual-assisted route ──────────────────────────────────────────────────

export interface ManualMatchInput {
  imageRef: string;
  provider: GeoIntProviderId;
  matchType: MatchType;
  matchedUrl?: string | null;
  description: string;
  observedAt?: string | null;
  screenshotRef?: string | null;
  notes?: string | null;
  /** Analyst's own confidence, 0–1. Omitted means unscored — never defaulted. */
  analystConfidence?: number | null;
  evidenceRef?: string | null;
}

export class ManualMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualMatchError";
  }
}

/**
 * Builds an attested reverse-image match from what an analyst recorded.
 *
 * Validates rather than fills in. A description is required because a match with
 * no account of what was seen is not evidence; everything else may be absent and
 * is stored as `null`, which a UI renders as an explicit gap.
 */
export function buildManualMatch(input: ManualMatchInput, retrievedAt: string): ImageMatch {
  const description = (input.description ?? "").trim();
  if (!description) {
    throw new ManualMatchError(
      "A description of what the provider showed is required. A match with no account of what was seen is not evidence.",
    );
  }
  if (!input.imageRef) throw new ManualMatchError("imageRef is required — a match must attach to an image.");
  if (!providerById(input.provider)) {
    throw new ManualMatchError(`"${input.provider}" is not a declared GEOINT provider.`);
  }
  if (!MATCH_TYPES.includes(input.matchType)) {
    throw new ManualMatchError(`"${input.matchType}" is not a recognised match type.`);
  }

  const url = (input.matchedUrl ?? "").trim() || null;
  if (url && !/^https?:\/\//i.test(url)) {
    throw new ManualMatchError("A matched URL must be http(s), so it can be reopened and checked.");
  }

  const analyst = input.analystConfidence;
  const scored = typeof analyst === "number" && analyst >= 0 && analyst <= 1;

  return {
    matchId: `match:manual:${input.provider}:${input.imageRef}:${url ?? description.slice(0, 40)}`,
    imageRef: input.imageRef,
    provider: input.provider,
    discoveredBy: "MANUAL_ASSISTED",
    matchType: input.matchType,
    matchedUrl: url,
    description,
    // No distance was computed. Null, never a placeholder number.
    hammingDistance: null,
    observedAt: (input.observedAt ?? "").trim() || null,
    retrievedAt,
    screenshotRef: (input.screenshotRef ?? "").trim() || null,
    notes: (input.notes ?? "").trim() || null,
    confidence: {
      value: scored ? analyst! : null,
      reasons: scored
        ? [
            "Analyst-assigned confidence for a manually-verified match.",
            "Describes the analyst's judgement of the match, not the provider's guarantee.",
          ]
        : ["No confidence was recorded by the analyst — unscored, not zero."],
    },
    // An analyst reporting what a provider displayed is a reported observation,
    // not something this system measured.
    claimClass: "REPORTED",
    evidenceRef: input.evidenceRef ?? null,
  };
}

export interface MatchSummary {
  total: number;
  exact: number;
  near: number;
  manual: number;
  automated: number;
  withUrl: number;
  unscored: number;
}

export function summariseMatches(matches: readonly ImageMatch[]): MatchSummary {
  return {
    total: matches.length,
    exact: matches.filter((m) => m.matchType === "EXACT_MATCH").length,
    near: matches.filter((m) => m.matchType === "NEAR_MATCH").length,
    manual: matches.filter((m) => m.discoveredBy === "MANUAL_ASSISTED").length,
    automated: matches.filter((m) => m.discoveredBy === "AUTOMATED_PROVIDER").length,
    withUrl: matches.filter((m) => m.matchedUrl !== null).length,
    unscored: matches.filter((m) => m.confidence.value === null).length,
  };
}
