/**
 * Analyst-attested capture — the only route by which Instagram and Facebook
 * content enters this system.
 *
 * WHY A SEPARATE TYPE, AND NOT A SocialPost.
 *
 * A `SocialPost` is a record this system collected. An attested capture is a
 * record an analyst asserts. Those are different epistemic objects and the
 * difference has to survive into the data, because everything downstream —
 * CIB signals, credibility scoring, report citations — treats a collected post
 * as an observation. A screenshot is not an observation of a post; it is an
 * observation of a screen, made by a person who is the actual source.
 *
 * The v1 tree collapsed exactly this distinction: `agent_scraper.py` wrote
 * fabricated Instagram posts into the same cache the real collectors used, and
 * the page rendered them beside genuine Bluesky data with no visible difference.
 * Keeping a separate type is what makes that collapse impossible rather than
 * merely discouraged.
 *
 * WHY NOT A CONTRACT Post EITHER. `PlatformSchema` in `types/core.ts` is
 * `bluesky | reddit | telegram`, and `core-adapters.ts` documents at length why
 * widening a frozen enum is not the additive change the freeze permits — every
 * consumer switching on `platform` would fall through its default branch on a
 * value it has never seen. A capture therefore crosses the developer boundary
 * as a `MediaAsset`, whose schema already names "analyst upload" among its
 * sources and which carries the hashes and provenance a bare Post could not.
 */

import type { MediaAsset } from "../types/core";
import { isSha256 } from "./evidence";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Platforms a manual capture may record.
 *
 * Not the same list as `SocialPost["platform"]` and deliberately so: this is
 * the set of sources whose policy row permits a manual route, which is close to
 * the complement of the automated set.
 */
export type CapturePlatform = "instagram" | "facebook" | "x-twitter" | "youtube" | "other";

export const CAPTURE_PLATFORM_LABELS: Record<CapturePlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  "x-twitter": "X / Twitter",
  youtube: "YouTube",
  other: "Other",
};

export class AttestationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "AttestationError";
    this.field = field;
  }
}

export interface AttestedCapture {
  id: string;
  platform: CapturePlatform;
  /** Public URL of the post captured. Required — see buildAttestedCapture. */
  sourceUrl: string;
  /**
   * When the analyst captured it, ISO 8601.
   *
   * NOT when the post was made. Those are different times and conflating them
   * would let a capture taken today read as contemporaneous evidence of an
   * event last year. The post's own timestamp, if legible in the capture, is an
   * analyst observation and belongs in `note`.
   */
  capturedAt: string;
  /** Who attests. Free text until real auth exists — see the note below. */
  capturedBy: string;
  /** The analyst's account of what this shows and how it was obtained. */
  note: string;
  /** SHA-256 of the uploaded file. Always present; an unhashed capture is refused. */
  sha256: string;
  /** Perceptual hash, for matching this capture against other imagery. */
  phash: string | null;
  /** Original filename, for the analyst's own reference. */
  filename: string;
  /** Bytes, or null when not supplied. */
  fileSize: number | null;
  /**
   * Fixed marker. Every consumer can test one field to know this was asserted
   * rather than collected, without having to know which platforms are manual.
   */
  provenance: "analyst-attested-capture";
}

export interface AttestedCaptureInput {
  platform: CapturePlatform;
  sourceUrl: string;
  capturedAt: string;
  capturedBy: string;
  note?: string;
  sha256: string;
  phash?: string | null;
  filename?: string;
  fileSize?: number | null;
  /** Injectable for deterministic ids under test. */
  id?: string;
}

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Whether a URL is a plausible public post address.
 *
 * Deliberately permissive about which platform — an analyst pasting a
 * `threads.net` or a regional mirror should not be blocked — but it must be an
 * absolute http(s) URL. A capture whose provenance is "I found it somewhere" is
 * not evidence, and a relative or malformed string is exactly that.
 */
export function isPublicPostUrl(raw: string): boolean {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Build a capture record, or throw naming the field that is missing.
 *
 * Every field validated here is required because without it the record is not
 * attributable, and an unattributable screenshot is not evidence — it is an
 * image of unknown origin that will nonetheless sit in a case file looking
 * official. Refusing at the point of entry is the only place this can be
 * enforced cheaply.
 */
export function buildAttestedCapture(input: AttestedCaptureInput): AttestedCapture {
  const sourceUrl = String(input.sourceUrl ?? "").trim();
  if (!isPublicPostUrl(sourceUrl)) {
    throw new AttestationError(
      "sourceUrl",
      "A full public URL for the captured post is required (http:// or https://). Without it " +
        "the capture cannot be traced back to what it depicts.",
    );
  }

  const capturedBy = String(input.capturedBy ?? "").trim();
  if (!capturedBy) {
    throw new AttestationError(
      "capturedBy",
      "An attributed capturer is required. The analyst is the source of this record, so an " +
        "anonymous capture has no source.",
    );
  }

  const capturedAt = String(input.capturedAt ?? "").trim();
  const parsed = Date.parse(capturedAt);
  if (!capturedAt || Number.isNaN(parsed)) {
    throw new AttestationError(
      "capturedAt",
      "A valid capture time is required, and it is the time of capture — not the time the " +
        "post was published.",
    );
  }

  if (!isSha256(input.sha256)) {
    throw new AttestationError(
      "sha256",
      "A SHA-256 of the uploaded file is required. A capture stored without one cannot later " +
        "be shown to be unaltered.",
    );
  }

  return {
    id: input.id ?? `CAP-${new Date(parsed).toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${input.sha256.slice(0, 8)}`,
    platform: input.platform,
    sourceUrl,
    capturedAt: new Date(parsed).toISOString(),
    capturedBy,
    note: String(input.note ?? "").trim(),
    sha256: input.sha256,
    // Null is honest: pHash needs the image to decode, and a PDF or an
    // unsupported format legitimately has none.
    phash: input.phash ?? null,
    filename: String(input.filename ?? "").trim() || "untitled",
    fileSize: typeof input.fileSize === "number" && input.fileSize >= 0 ? input.fileSize : null,
    provenance: "analyst-attested-capture",
  };
}

// ─── Crossing to Dev 1 / Dev 2 ─────────────────────────────────────────────

/**
 * Convert a capture to the frozen `MediaAsset` contract.
 *
 * `MediaAssetSchema` requires a `phash`, so a capture without one CANNOT cross
 * the boundary and this throws rather than inventing a placeholder digest. That
 * is the intended behaviour: a synthesised perceptual hash would silently fail
 * to match anything, which reads as "no near-duplicates found" — a finding,
 * from a value that was never measured.
 *
 * `source` is the analyst's capture URL prefixed so a downstream consumer can
 * tell at a glance that this asset was asserted rather than collected. The
 * contract's own comment names "analyst upload" as an expected value here.
 */
export function attestedCaptureToMediaAsset(
  capture: AttestedCapture,
  extras: Partial<Pick<MediaAsset, "exif" | "c2pa" | "ocrText" | "gps" | "detections" | "faces">> = {},
): MediaAsset {
  if (!capture.phash) {
    throw new AttestationError(
      "phash",
      "This capture has no perceptual hash, so it cannot cross to Module 4 — MediaAsset " +
        "requires one and a fabricated hash would match nothing while looking like a result. " +
        "Re-upload as a decodable image, or keep the capture as vault-only evidence.",
    );
  }
  return {
    id: capture.id,
    sha256: capture.sha256,
    phash: capture.phash,
    source: `analyst upload — ${capture.sourceUrl}`,
    exif: extras.exif,
    c2pa: extras.c2pa,
    ocrText: extras.ocrText,
    gps: extras.gps,
    // Empty, not omitted: the contract requires both arrays, and nothing has
    // run a detector or a face model over this asset.
    detections: extras.detections ?? [],
    faces: extras.faces ?? [],
  };
}

// ─── What the analyst must be told ─────────────────────────────────────────

/**
 * The caveats that must appear on screen wherever a capture is created or read.
 *
 * These are not boilerplate. Each one names a specific wrong inference that the
 * surrounding UI would otherwise invite — a provenance panel showing "EXIF:
 * absent / C2PA: absent" beside a green hash chip reads as a failed
 * authenticity check, when in fact both absences are the expected and
 * meaningless result for a screen capture.
 */
export const CAPTURE_CAVEATS: string[] = [
  "A screenshot is not the post. It is an analyst's record of what a screen showed at a stated " +
    "time, and the analyst is the source of that record.",
  "EXIF will be absent. This is a screen capture, not a camera original, so there is no capture " +
    "device, no lens data and no GPS fix to read. Absence here is normal and is not evidence of " +
    "tampering.",
  "C2PA will be absent. Content Credentials are signed at creation by the authoring tool; a " +
    "screenshot of someone else's post has no manifest and never would. This is not a failed " +
    "verification.",
  "The SHA-256 covers the uploaded file only. It shows the file has not changed since upload. It " +
    "cannot show that the capture depicts the post faithfully, or that the post existed.",
  "Nothing here is automated collection. Instagram and Facebook are not scraped, and this record " +
    "must not be counted alongside collected posts in volume, rate or coordination signals.",
];

/**
 * Why the attribution field is free text.
 *
 * There is no authentication in this build — `demo-session.ts` is a disclosed
 * client-side demo gate and says so. `capturedBy` is therefore a claim, not an
 * identity, and the UI must not render it as though a signed-in user made it.
 * Stated here so the limitation travels with the module rather than living only
 * in a commit message.
 */
export const ATTRIBUTION_LIMITATION =
  "capturedBy is analyst-entered text, not an authenticated identity — this build has no auth. " +
  "It records who the operator says made the capture, which is a claim on the same footing as " +
  "the note. Real chain of custody needs signed, authenticated submission.";
