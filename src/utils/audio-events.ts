/**
 * Module 4 — semantic sound-event classification, pure/types half.
 *
 * Real inference happens server-side, in ai-service (YAMNet — Google,
 * Apache 2.0, verified not Llama-derived). See ai-service-client.ts's
 * `aiServiceClassifyAudio`. This file holds the types, the explicit
 * non-goals as Gap entries (mirroring imaging.ts's own NOT_IMPLEMENTED
 * shape), and small pure formatting/grouping helpers so
 * audio-events-panel.tsx stays a thin render layer.
 *
 * Honesty framing, matching ai-service's own: YAMNet's outputs are
 * independent, uncalibrated per-class sigmoids — every number here is a
 * "model score", never a "confidence". A hazard class (gunshot, siren,
 * crying, alarm) carries a "confirm by listening" marker, never a bare
 * label rendered as a finding — impulsive real-world sounds are a
 * documented confuser for exactly these classes.
 */

import type { Gap } from "./imaging";
import type { AiAudioEvent, AiAudioEventsResult } from "./ai-service-client";

export const AUDIO_EVENT_CANNOT_DETERMINE: string[] = [
  "Which specific person, animal, or device produced the sound from the class label alone — " +
    "\"Siren\" names a category, not a source. Use the Audio spectral analysis panel's own " +
    "reference matching (save this clip's fingerprint, compare it to references you've saved) " +
    "for that — it answers 'does this resemble a sound I've heard before', never 'what is this'.",
  "Emotional state, distress, or duress. An acoustic category (e.g. \"Crying, sobbing\") is " +
    "not a psychological finding — a downstream report must not make that leap.",
  "Reliability on heavily re-compressed or re-uploaded audio. YAMNet's published 0.306 " +
    "balanced mAP is measured on the clean AudioSet eval set, not on redistributed OSINT media.",
];

export const AUDIO_EVENT_GAPS: Gap[] = [
  {
    capability: "Identifying which specific person, animal, or device produced a classified sound, from the class label alone",
    requires:
      "A reference recording of that exact source to fingerprint-match against — now real, in " +
      "the sibling Audio spectral analysis panel's reference matching (extractFingerprint / " +
      "compareFingerprints in audio-frequency.ts): save a clip as a named reference, then " +
      "compare others against it. This module's own class label is not that reference.",
    limitation:
      "A category label (\"Siren\", \"Dog\") is not an identity by itself. Reference matching " +
      "only works against clips an analyst has actually saved — a high similarity score there " +
      "is real evidence worth review, never a confirmed identity, and an unmatched sound is " +
      "not proof it lacks one.",
  },
  {
    capability: "Inferring emotional state, distress or duress from a sound category",
    requires: "A clinical or behavioural assessment, which this system does not perform.",
    limitation:
      "\"Crying, sobbing\" or \"Screaming\" are acoustic categories, not psychological " +
      "findings. Treating a class label as evidence of distress would be an overclaim this " +
      "module is deliberately built not to make.",
  },
  {
    capability: "Detecting drones, UAVs, or other defence-specific audio signatures",
    requires:
      "A model trained and independently benchmarked on a defence-relevant sound ontology — " +
      "checked directly (2026-08-26) for one that could be vendored the way YAMNet itself " +
      "was: only research papers and hand-collected datasets with no officially released, " +
      "publicly benchmarked checkpoint exist. Training one here would mean shipping an " +
      "unverified guess, the opposite of this project's own standard.",
    limitation:
      "Verified directly against the real AudioSet class map: none of its 521 classes name a " +
      "drone, UAV, or quadcopter. The single question this audience is most likely to ask " +
      "first has no real answer in this feature — stated plainly rather than left implicit.",
  },
  {
    capability: "Distinguishing weapon type or calibre within a matched class",
    requires:
      "A far more specific model than a 521-class general-purpose sound classifier — checked " +
      "directly (2026-08-26) for a vendorable option: the closest real projects found are " +
      "individual, unbenchmarked GitHub repositories with no institutional accuracy figure to " +
      "verify against, the same problem as drone detection above.",
    limitation:
      "\"Gunshot, gunfire\" or \"Machine gun\" are the finest granularity AudioSet offers for " +
      "that category — this module cannot say more than the class name itself states.",
  },
  {
    capability: "Identifying a specific speaker from their voice within a matched class",
    requires:
      "A voice-matching model plus a reference-voice corpus to match against — technically " +
      "similar to face matching against a watchlist, which this system already declined for " +
      "the same reason.",
    limitation:
      "Matching a voice to a known identity is DPDP Act 2023-scoped personal-data processing, " +
      "the exact ground this project already refused a standing face watchlist on. This is a " +
      "policy line, not a missing model — it will not be revisited as an engineering task.",
  },
];

export interface GroupedAudioEvents {
  hazards: AiAudioEvent[];
  other: AiAudioEvent[];
}

/**
 * Splits real classification results by the `hazard` flag ai-service
 * already computed from its own fixed HAZARD_CLASSES set — never
 * re-derived client-side, so the two layers can't silently disagree on
 * which classes count.
 */
export function groupAudioEvents(result: AiAudioEventsResult): GroupedAudioEvents {
  return {
    hazards: result.events.filter((e) => e.hazard),
    other: result.events.filter((e) => !e.hazard),
  };
}

/**
 * Whether it's worth rendering the closest-below-threshold list at all —
 * only when there's nothing else to show. Once real events exist, showing
 * near-misses alongside them adds noise without adding a decision an
 * analyst needs to make; the coverage line already states how much of the
 * clip cleared nothing.
 */
export function shouldShowClosestMatches(result: AiAudioEventsResult): boolean {
  return result.events.length === 0 && result.closestBelowThreshold.length > 0;
}

export function describeCoverage(result: AiAudioEventsResult): string {
  const { windowsAnalysed, windowsWithAnyClassAboveThreshold } = result.coverage;
  if (windowsAnalysed === 0) {
    return "No windows were analysed — the audio may be too short or empty.";
  }
  return (
    `${windowsAnalysed} window(s) analysed, ${windowsWithAnyClassAboveThreshold} with at least ` +
    "one class above the reporting threshold; the rest matched nothing confidently enough to report."
  );
}
