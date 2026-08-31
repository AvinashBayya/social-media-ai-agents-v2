/**
 * METADATA GEOINT (2026-08-30, ported from the teammate's fork).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS DOES NOT PARSE EXIF. `imaging.ts` already does.
 *
 * `interpretExif()` produces `ExifReport` — camera, software, `capture`,
 * `modifyTime`, `gps`, and analyst-facing `findings`. That code is tested against
 * real JPEG fixtures and is not duplicated here. This module is a pure
 * *projection* of that report into the GEOINT/evidence vocabulary: normalised
 * observations with provenance, a coordinate that has passed the project's
 * coordinate gate, and a claim class.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TIMESTAMP RULE, WHICH IS THE SUBTLE ONE.
 *
 * `ExifReport.captureTime` is a CAMERA WALL CLOCK and is deliberately never
 * Z-suffixed. EXIF `DateTimeOriginal` is timezone-naive. `imaging.ts` documents
 * at length that passing it through `new Date(...).toISOString()` applied the
 * *analyst machine's* offset and then asserted UTC — a file written
 * 2026:07:04 11:22:33 displayed as 05:52:33Z, silently shifted 5.5 hours, and
 * showed a different capture time to analysts in different timezones.
 *
 * So a GEOINT observation only ever carries an `observedAt` INSTANT when the file
 * recorded a UTC offset — that is `ExifCaptureTime.absolute`, which is null
 * otherwise. The wall-clock string is still reported, as a wall clock, clearly
 * labelled. **Never read `captureTime` into a timeline.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GPS IS OBSERVED, AND THAT IS NOT THE SAME AS TRUE.
 *
 * A GPS block that exists in the file is genuinely OBSERVED: we read it. It is
 * also trivially forgeable, and `/images` already tells the analyst to treat it
 * as "a strong lead rather than a fact". OBSERVED here classifies *the reading*,
 * not the location. It is never interpreted as anyone's current position.
 */

import type { ExifReport, GpsFix } from "../imaging";
import type { GeoPoint } from "../../types/core";
import { toGeoPoint } from "../../types/core-adapters";
import type { ClaimClass, ConfidenceScore } from "../collectors/result";

// ─── Observations ───────────────────────────────────────────────────────────

/** One normalised metadata fact, with everything needed to trace it back. */
export interface MetadataObservation {
  /** Stable within a file: the EXIF field this came from. */
  field: string;
  label: string;
  /** Exactly what the file carried, stringified. Never cleaned up into something prettier. */
  rawValue: string;
  /** The interpreted form. Equal to rawValue when no interpretation applies. */
  normalizedValue: string;
  claimClass: ClaimClass;
}

export interface MetadataGeoint {
  /** The file this describes. */
  sourceFile: string;
  /** Present is false when the file carried no EXIF at all — an absence, not a failure. */
  exifPresent: boolean;
  observations: MetadataObservation[];

  /** Coordinate, only when the file carried one AND it passed the coordinate gate. */
  location: GeoPoint | null;
  /** Metres ASL, when recorded. */
  altitude: number | null;
  /**
   * ISO instant — populated ONLY when the file recorded a UTC offset. Null
   * otherwise, because a wall clock without an offset is not an instant.
   * This is what the evidence timeline may use as `observedAt`.
   */
  observedAt: string | null;
  /** The camera wall clock as written, e.g. "2026-07-04 11:22:33". Never Z-suffixed. */
  captureWallClock: string | null;
  /** The UTC offset the file recorded, when it recorded one. */
  captureOffset: string | null;
  /** When Sentinel read the file. Injected, never read from a clock in here. */
  retrievedAt: string;

  confidence: ConfidenceScore;
  /** Things this cannot establish, stated rather than left blank — mirrors `assessProvenance`. */
  cannotDetermine: string[];
}

export const METADATA_CAVEATS: string[] = [
  "EXIF GPS is a recorded reading, not a verified position. It is trivially forgeable with ordinary tools — treat it as a strong lead, never as proof of where an image was taken.",
  "A GPS fix in a file is not the location of whoever sent it, and not anyone's current position.",
  "A camera clock without a recorded UTC offset is a wall-clock reading, not an instant. It is shown as written and is deliberately not placed on a timeline.",
  "Absent EXIF is the normal case for redistributed media — every major platform strips it on upload. Absence is not evidence of tampering.",
];

/** Fields lifted into observations, in a fixed order so output is stable. */
const CAMERA_FIELDS = ["make", "model", "lens", "serial"] as const;

function push(
  list: MetadataObservation[],
  field: string,
  label: string,
  raw: unknown,
  claimClass: ClaimClass,
  normalized?: string,
): void {
  if (raw === null || raw === undefined) return;
  const rawValue = String(raw).trim();
  if (!rawValue) return;
  list.push({ field, label, rawValue, normalizedValue: normalized ?? rawValue, claimClass });
}

/**
 * Projects an `ExifReport` into GEOINT form.
 *
 * Pure. `retrievedAt` is injected for the same reason the claim extractor injects
 * `extractedAt`: a function that reads a clock cannot be tested for the property
 * this module exists to guarantee.
 */
export function metadataGeoint(
  sourceFile: string,
  exif: ExifReport | null | undefined,
  retrievedAt: string,
): MetadataGeoint {
  const observations: MetadataObservation[] = [];
  const cannotDetermine: string[] = [];

  if (!exif || !exif.present) {
    return {
      sourceFile,
      exifPresent: false,
      observations,
      location: null,
      altitude: null,
      observedAt: null,
      captureWallClock: null,
      captureOffset: null,
      retrievedAt,
      // Nothing was measured, so nothing is scored. Never a zero.
      confidence: { value: null, reasons: ["No EXIF present — nothing to measure."] },
      cannotDetermine: [
        "No EXIF metadata is present, so nothing about capture device, time or location can be established from this file.",
        "This is the normal case for media redistributed through a social platform and is not evidence of manipulation.",
      ],
    };
  }

  for (const key of CAMERA_FIELDS) {
    push(observations, `camera.${key}`, `Camera ${key}`, exif.camera?.[key], "OBSERVED");
  }
  push(observations, "software", "Software", exif.software, "OBSERVED");
  push(observations, "modifyTime", "File modified", exif.modifyTime, "OBSERVED");

  // ── Timestamps ──────────────────────────────────────────────────────────
  const capture = exif.capture ?? null;
  const captureWallClock = capture?.local ?? exif.captureTime ?? null;
  const captureOffset = capture?.offset ?? null;
  const observedAt = capture?.absolute ?? null;

  if (captureWallClock) {
    push(
      observations,
      "captureTime",
      captureOffset ? "Capture time" : "Capture time (camera wall clock)",
      captureWallClock,
      "OBSERVED",
      captureOffset ? `${captureWallClock}${captureOffset}` : captureWallClock,
    );
    if (!captureOffset) {
      cannotDetermine.push(
        "The file records a capture time but no UTC offset, so the absolute instant cannot be established. The wall-clock value is shown as written and is not placed on the timeline.",
      );
    }
  } else {
    cannotDetermine.push("The file records no capture time.");
  }

  // ── Location ────────────────────────────────────────────────────────────
  const gps: GpsFix | null = exif.gps ?? null;
  // Through the project's own coordinate gate: 0,0 and out-of-range are refused.
  // EXIF is an exact fix by nature, so precision is "exact" when it passes.
  const location = gps ? toGeoPoint(gps.latitude, gps.longitude, "exact") : null;
  const altitude = gps?.altitude ?? null;

  if (gps && !location) {
    cannotDetermine.push(
      "The file carries a GPS block, but the coordinates did not pass validation (0,0 or out of range) and were rejected rather than plotted.",
    );
  }
  if (location) {
    push(
      observations,
      "gps",
      "GPS fix",
      `${location.lat}, ${location.lon}`,
      "OBSERVED",
      `${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}`,
    );
    if (altitude !== null) {
      push(observations, "gps.altitude", "Altitude", altitude, "OBSERVED", `${altitude} m`);
    }
  } else if (!gps) {
    cannotDetermine.push("The file carries no GPS block, so no metadata location can be established.");
  }

  // Confidence describes the READING, not the location. A present, in-range fix
  // is a high-confidence reading of the file; it says nothing about whether the
  // value was written honestly.
  const reasons: string[] = [];
  if (location) {
    reasons.push("GPS block present in the file and within valid coordinate range.");
    reasons.push("Scores the reliability of the READING, not the truth of the location — EXIF is forgeable.");
  } else {
    reasons.push("No usable GPS block, so no location reading to score.");
  }

  return {
    sourceFile,
    exifPresent: true,
    observations,
    location,
    altitude,
    observedAt,
    captureWallClock,
    captureOffset,
    retrievedAt,
    confidence: { value: location ? 0.9 : null, reasons },
    cannotDetermine,
  };
}

/**
 * Canonical id for a location entity, so two sources reporting the same place
 * produce ONE entity rather than duplicates.
 *
 * Rounded to 5 decimal places — about 1.1 m, finer than any consumer-GPS fix is
 * actually accurate to, so it collapses float noise without merging genuinely
 * distinct places.
 */
export function locationEntityId(point: GeoPoint): string {
  return `geoint:location:${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
}

/** Display label for a coordinate. No reverse geocoding — we do not have a place name and will not invent one. */
export function locationLabel(point: GeoPoint): string {
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}
