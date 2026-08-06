/**
 * FROZEN DATA CONTRACTS — the inter-developer wire format.
 *
 * Frozen 2026-08-06 (Appendix B of the Dev-3 brief). Dev 1 produces MediaAsset
 * and VideoAsset; Dev 2 produces Article, Post and Finding; Dev 3 consumes all
 * of them and owns this file. Changing a shape here breaks two other people, so
 * additive changes only — new OPTIONAL fields are fine, renames and removals are
 * not, until a joint re-freeze.
 *
 * ── What this file is, and is not ─────────────────────────────────────────
 *
 * These are BOUNDARY types: the shape of data crossing between developers. They
 * are deliberately NOT the internal working types. `src/utils/analysis.ts` has
 * its own richer `Article`, `src/utils/social.ts` its own `SocialPost`, and
 * `src/utils/imaging.ts` a whole family of report types that carry far more
 * detail than any hand-off needs. Those stay as they are; `./core-adapters.ts`
 * converts between the two worlds at exactly one place per type.
 *
 * The alternative — retyping 8,000 lines of working code onto the contract —
 * would rewrite Modules 1-5 to fix an integration seam, and would fail the
 * 31 Aug freeze.
 *
 * ── Nullability is a deliberate deviation from the brief ──────────────────
 *
 * Appendix B writes fields bare (`accountAgeDays`, `lang`, `confidence`). Every
 * one of those can genuinely fail to be determined: a Bluesky profile fetch can
 * 404, language detection can be inconclusive, a geocoder can decline a place
 * name. The project's first rule is that unavailable input produces an explicit
 * absence, never a plausible-looking placeholder — so anything that can be
 * unmeasured is typed `| null` here.
 *
 * `null` means NOT MEASURED. It never means zero. A post whose author's account
 * age could not be retrieved must not be indistinguishable from one created
 * today, because those are opposite findings.
 *
 * ── Runtime validation ───────────────────────────────────────────────────
 *
 * Every contract carries a zod schema. Data arriving from another developer is
 * parsed at the boundary and THROWS on mismatch rather than being coerced —
 * the same discipline `llm.ts` applies to model output. A silently-coerced
 * field is contract drift that surfaces days later as a wrong number in a
 * report.
 */

import { z } from "zod";

// ─── Shared primitives ─────────────────────────────────────────────────────

/**
 * Coordinate precision. Identical to `GeoPrecision` in `src/utils/geo.ts` and
 * kept in lockstep with it — the map renders `exact` as a sized point and
 * anything coarser as a dashed uncertainty circle, so this value decides
 * whether a reader sees a located event or an acknowledged approximation.
 */
export const GeoPrecisionSchema = z.enum(["exact", "city", "country"]);
export type GeoPrecision = z.infer<typeof GeoPrecisionSchema>;

/**
 * A coordinate that survived validation. `0,0` is rejected upstream as a
 * missing-value sentinel rather than plotted in the Gulf of Guinea, so any
 * GeoPoint reaching a consumer is a real fix at its stated precision.
 */
export const GeoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  precision: GeoPrecisionSchema,
});
export type GeoPoint = z.infer<typeof GeoPointSchema>;

/** Which PS-18 module produced a Finding. */
export const ModuleIdSchema = z.enum(["M1", "M2", "M3", "M4", "M5"]);
export type ModuleId = z.infer<typeof ModuleIdSchema>;

export const MODULE_LABEL: Record<ModuleId, string> = {
  M1: "Module 1 · credibility",
  M2: "Module 2 · content analysis",
  M3: "Module 3 · social",
  M4: "Module 4 · imagery",
  M5: "Module 5 · GIS",
};

/** Pixel bounding box, matching the convention Tesseract already returns. */
export const BBoxSchema = z.object({
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});
export type BBox = z.infer<typeof BBoxSchema>;

const Iso8601 = z.string().min(1);

// ─── Article — produced by Dev 2 ───────────────────────────────────────────

export const ArticleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Body or snippet. Empty string when the feed shipped none — most RSS does not. */
  body: z.string(),
  url: z.string().url(),
  /** Publisher name as the feed reports it. */
  source: z.string(),
  /** Registrable domain, lowercased, no `www.`. Module 1 rates the publisher off this. */
  domain: z.string(),
  publishedAt: Iso8601,
  /** BCP-47 tag. Null when detection was inconclusive — not defaulted to "en". */
  lang: z.string().nullable(),
  /** Absolute URLs of images carried by the article, for Dev 1 to analyse. */
  images: z.array(z.string()),
});
export type Article = z.infer<typeof ArticleSchema>;

// ─── Post — produced by Dev 2 ──────────────────────────────────────────────

export const PlatformSchema = z.enum(["bluesky", "reddit", "telegram"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const PostSchema = z.object({
  id: z.string().min(1),
  platform: PlatformSchema,
  /** Handle where resolved; the raw DID/username otherwise. */
  author: z.string(),
  text: z.string(),
  createdAt: Iso8601,
  /**
   * Age of the author's account in days at collection time.
   *
   * Null when the profile could not be fetched — which is common and must stay
   * distinguishable from a genuinely new account. Module 1's account-maturity
   * signal skips on null rather than treating the account as fresh.
   */
  accountAgeDays: z.number().nonnegative().nullable(),
  /** Canonical permalink. AT URI on Bluesky, full URL elsewhere. */
  uri: z.string().min(1),

  // ── Dev-3 additive extensions, beyond Appendix B ──────────────────────
  // Appendix B's Post carries neither a stable account id nor the post's
  // outbound links. Module 3's coordination signals need both: handle-family
  // detection keys on the stable id (a handle can change), and amplification
  // detection needs the identity of the thing being amplified. Without them,
  // contract-sourced posts silently lose two CIB signals — which under this
  // project's rules must surface as "not computed", not as a clean result.
  //
  // Both are OPTIONAL, so the freeze holds and Dev 2 can populate them when
  // convenient. Consumers must treat absent as "not collected", never as "none".

  /** Stable account identifier — DID on Bluesky, username on Reddit, channel on Telegram. */
  authorId: z.string().optional(),
  /** Language tags the author's client declared. Not our own detection. */
  langs: z.array(z.string()).optional(),
  /** External URLs and quoted/reposted URIs carried by the post. */
  links: z.array(z.string()).optional(),
});
export type Post = z.infer<typeof PostSchema>;

// ─── Entity — produced by Dev 2 / Module 2 ─────────────────────────────────

export const EntityTypeSchema = z.enum([
  "PERSON",
  "ORG",
  "LOCATION",
  "EVENT",
  "EQUIPMENT",
  "OTHER",
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const EntitySchema = z.object({
  id: z.string().min(1),
  type: EntityTypeSchema,
  name: z.string().min(1),
  /** 0-1, from the extractor. Never synthesised when the extractor gives none. */
  confidence: z.number().min(0).max(1),
  /** Ids of the Articles or Posts the entity was extracted from. Never empty. */
  sources: z.array(z.string()).min(1),
});
export type Entity = z.infer<typeof EntitySchema>;

// ─── Finding — produced by every module ────────────────────────────────────

export const FindingSchema = z.object({
  id: z.string().min(1),
  module: ModuleIdSchema,
  /** What the finding is about — an entity name, account, domain, or asset id. */
  target: z.string().min(1),
  /** Module-specific payload. Opaque to consumers other than the producing module. */
  data: z.record(z.unknown()),
  /** Module 1 score 0-1. Absent when the finding was never scored. */
  credibility: z.number().min(0).max(1).nullable().optional(),
  /** Present only for a finding with a real coordinate. Absent is not 0,0. */
  geo: GeoPointSchema.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

// ─── MediaAsset — produced by Dev 1 ────────────────────────────────────────

/**
 * EXIF summary. `present: false` is the NORMAL case for redistributed media —
 * every major platform strips the block on upload — so absence is reported as
 * absence and never as evidence of tampering.
 */
export const ExifSummarySchema = z.object({
  present: z.boolean(),
  cameraMake: z.string().nullable(),
  cameraModel: z.string().nullable(),
  /** Editing software string, where the file declares one. */
  software: z.string().nullable(),
  captureTime: Iso8601.nullable(),
});
export type ExifSummary = z.infer<typeof ExifSummarySchema>;

/**
 * C2PA Content Credential summary.
 *
 * `aiGenerated` is true only when a cryptographically signed manifest DECLARES
 * generative provenance. It is not a classifier output and must never be
 * populated by one — this system takes the position that provenance verifies
 * where a detector guesses, and a guessed value rendered in this field would be
 * read as a signature.
 */
export const C2paSummarySchema = z.object({
  status: z.enum(["valid", "invalid", "absent", "error"]),
  signedBy: z.string().nullable(),
  generator: z.string().nullable(),
  aiGenerated: z.boolean(),
  aiEvidence: z.string().nullable(),
});
export type C2paSummary = z.infer<typeof C2paSummarySchema>;

/** Object detection. Grounding DINO or RT-DETR only — YOLO is AGPL and barred. */
export const DetectionSchema = z.object({
  label: z.string().min(1),
  /** Detector's own score, 0-1. */
  confidence: z.number().min(0).max(1),
  bbox: BBoxSchema,
  /** Model that produced it, so a product can name its provenance. */
  model: z.string(),
});
export type Detection = z.infer<typeof DetectionSchema>;

/**
 * A detected face.
 *
 * Matching is scoped to an operator-supplied reference set under the DPDP Act
 * 2023 — this system does not run open-set identification. `matchedRef` is null
 * when the face matched nothing in that set, which is the common case and is
 * not a finding about the person.
 */
export const FaceSchema = z.object({
  id: z.string().min(1),
  bbox: BBoxSchema,
  /** Reference-set id this face matched, or null for no match. */
  matchedRef: z.string().nullable(),
  /** Similarity to `matchedRef`, 0-1. Null whenever `matchedRef` is null. */
  similarity: z.number().min(0).max(1).nullable(),
});
export type Face = z.infer<typeof FaceSchema>;

export const MediaAssetSchema = z.object({
  id: z.string().min(1),
  /** Content hash — the asset's identity across the system. */
  sha256: z.string().length(64),
  /** Perceptual hash, hex, for near-duplicate matching. */
  phash: z.string().min(1),
  /** Where the asset was obtained — article URL, post URI, or "analyst upload". */
  source: z.string(),
  exif: ExifSummarySchema.optional(),
  c2pa: C2paSummarySchema.optional(),
  /** Full OCR text. Absent when OCR was not run; empty string when it found none. */
  ocrText: z.string().optional(),
  /** EXIF GPS fix. Device-written, so precise and forgeable — a lead, not a fact. */
  gps: GeoPointSchema.optional(),
  detections: z.array(DetectionSchema),
  faces: z.array(FaceSchema),
  /** Caption model output, marked AI-generated wherever it is displayed. */
  caption: z.string().optional(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

// ─── VideoAsset — produced by Dev 1 ────────────────────────────────────────

export const KeyframeSchema = z.object({
  timeSeconds: z.number().nonnegative(),
  /** Perceptual hash of the frame. The frame image itself is display-only and
   *  deliberately not carried across the contract — it would dominate payloads. */
  phash: z.string().min(1),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const SceneCutSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Located to within one sampling interval, not to the frame. */
  timeSeconds: z.number().nonnegative(),
  distanceFromPrevious: z.number().nonnegative(),
});
export type SceneCut = z.infer<typeof SceneCutSchema>;

export const TranscriptSegmentSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().nonnegative(),
  text: z.string(),
  /** Language Whisper reported for the segment. Null when it gave none. */
  lang: z.string().nullable(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const FlagWordSchema = z.object({
  term: z.string().min(1),
  /** Every timestamp the term occurs at, so a reviewer can jump to each. */
  atSeconds: z.array(z.number().nonnegative()).min(1),
});
export type FlagWord = z.infer<typeof FlagWordSchema>;

export const VideoAssetSchema = MediaAssetSchema.extend({
  keyframes: z.array(KeyframeSchema),
  sceneCuts: z.array(SceneCutSchema),
  transcript: z.array(TranscriptSegmentSchema),
  flagWords: z.array(FlagWordSchema),
});
export type VideoAsset = z.infer<typeof VideoAssetSchema>;

// ─── Boundary parsing ──────────────────────────────────────────────────────

/**
 * Thrown when data crossing a developer boundary does not match the frozen
 * shape. Carries the producing side and zod's own path detail, so the message
 * names who to talk to and which field moved.
 */
export class ContractViolationError extends Error {
  constructor(
    readonly contract: string,
    readonly issues: string[],
    readonly producer: string,
  ) {
    super(
      `${contract} from ${producer} does not match the frozen contract: ${issues.join("; ")}. ` +
        `The shape was frozen 2026-08-06; a producer change needs a joint re-freeze.`,
    );
    this.name = "ContractViolationError";
  }
}

function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  contract: string,
  producer: string,
  value: unknown,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new ContractViolationError(contract, issues, producer);
}

export const parseArticle = (v: unknown, producer = "Dev 2"): Article =>
  parseWith(ArticleSchema, "Article", producer, v);

export const parsePost = (v: unknown, producer = "Dev 2"): Post =>
  parseWith(PostSchema, "Post", producer, v);

export const parseEntity = (v: unknown, producer = "Dev 2"): Entity =>
  parseWith(EntitySchema, "Entity", producer, v);

export const parseFinding = (v: unknown, producer = "a module"): Finding =>
  parseWith(FindingSchema, "Finding", producer, v);

export const parseMediaAsset = (v: unknown, producer = "Dev 1"): MediaAsset =>
  parseWith(MediaAssetSchema, "MediaAsset", producer, v);

export const parseVideoAsset = (v: unknown, producer = "Dev 1"): VideoAsset =>
  parseWith(VideoAssetSchema, "VideoAsset", producer, v);

/**
 * Parse a batch, keeping the good records and reporting the bad ones.
 *
 * A single malformed article in a feed of two hundred should not take the page
 * down, but it must not vanish either — the rejects are returned so the UI can
 * state how many items were dropped and why, in the same spirit as the map's
 * unplaceable count.
 */
export function parseMany<T>(
  values: unknown[],
  parse: (v: unknown) => T,
): { ok: T[]; rejected: { index: number; reason: string }[] } {
  const ok: T[] = [];
  const rejected: { index: number; reason: string }[] = [];
  values.forEach((v, index) => {
    try {
      ok.push(parse(v));
    } catch (err) {
      rejected.push({ index, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  return { ok, rejected };
}
