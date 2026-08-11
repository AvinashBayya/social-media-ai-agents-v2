/**
 * Module 4 — image and video analysis, pure layer (PS-18 §6.4).
 *
 * SCOPE HONESTY, and it drives every decision in this module:
 *
 * We do not build a deepfake classifier and we do not claim one. Detectors
 * trained on GAN-era fakes generalise poorly to diffusion models, and their
 * accuracy collapses under the recompression that social redistribution
 * applies — which is precisely the media an OSINT tool ingests. With no GPU and
 * no budget, a classifier here would be a number with the shape of a
 * measurement and none of the substance.
 *
 * PROVENANCE IS A STRONGER ANSWER THAN CLASSIFICATION. A C2PA Content
 * Credential is a cryptographic signature: it either validates or it does not,
 * with no false positives and no threshold to tune. A deepfake score is a guess.
 * So this module leads with provenance, uses forensics as triage, and states
 * plainly what it cannot determine. What is not implemented is listed in the UI
 * with what it would require.
 *
 * This file is PURE: no DOM, no network, no dynamic imports. Everything here is
 * directly testable under bun. Browser-only work — canvas, WASM, video decoding
 * — lives in imaging-client.ts, which imports this and not the reverse.
 *
 * No Math.random(). No invented confidence values. Absence of a signal is
 * reported as absence, never as a negative finding.
 */

// ─── Perceptual hashing (DCT / pHash) ──────────────────────────────────────

/** Working resolution before the DCT. 32 is the standard pHash choice. */
export const PHASH_SIZE = 32;
/** Side of the retained low-frequency block. 8 -> 64 bits -> 16 hex chars. */
export const PHASH_BLOCK = 8;

/**
 * Distance at or below which two images are treated as near-duplicates.
 *
 * On a 64-bit hash, an unrelated pair sits around 32 (half the bits differ by
 * chance). Resizes and JPEG requantisation of one image typically stay under 6.
 * 10 leaves headroom for heavy recompression and light cropping without
 * colliding with unrelated content.
 */
export const NEAR_DUPLICATE_DISTANCE = 10;
/** Below this, the images are the same picture rather than merely similar. */
export const IDENTICAL_DISTANCE = 4;

/**
 * Scene-cut threshold between consecutive video keyframes.
 *
 * Deliberately far above NEAR_DUPLICATE_DISTANCE: successive frames within one
 * shot drift as things move, so a low threshold would call every camera pan a
 * cut.
 */
export const SCENE_CUT_DISTANCE = 22;

/** Precomputed DCT-II basis. Built once — the naive form is O(n^4) per image. */
function dctBasis(n: number): Float64Array {
  const basis = new Float64Array(n * n);
  for (let u = 0; u < n; u += 1) {
    for (let x = 0; x < n; x += 1) {
      basis[u * n + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
    }
  }
  return basis;
}

const BASIS_CACHE = new Map<number, Float64Array>();
function basisFor(n: number): Float64Array {
  let b = BASIS_CACHE.get(n);
  if (!b) {
    b = dctBasis(n);
    BASIS_CACHE.set(n, b);
  }
  return b;
}

/** Separable 2-D DCT-II: rows then columns. */
export function dct2d(input: Float64Array | number[], n: number): Float64Array {
  const basis = basisFor(n);
  const rows = new Float64Array(n * n);

  for (let y = 0; y < n; y += 1) {
    for (let u = 0; u < n; u += 1) {
      let sum = 0;
      for (let x = 0; x < n; x += 1) sum += input[y * n + x] * basis[u * n + x];
      rows[y * n + u] = sum;
    }
  }

  const out = new Float64Array(n * n);
  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      let sum = 0;
      for (let y = 0; y < n; y += 1) sum += rows[y * n + u] * basis[v * n + y];
      out[v * n + u] = sum;
    }
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * pHash over a square grayscale buffer.
 *
 * The DC coefficient is excluded before taking the median: it encodes overall
 * brightness, so keeping it would make the hash shift on a simple exposure
 * change. Thresholding the remaining low-frequency coefficients against their
 * own median is what makes the hash survive resizing and requantisation while
 * still separating different pictures.
 */
export function pHash(gray: Float64Array | number[], size = PHASH_SIZE): string {
  if (gray.length !== size * size) {
    throw new Error(`pHash expects ${size * size} grayscale samples, received ${gray.length}.`);
  }

  const freq = dct2d(gray, size);

  const block: number[] = [];
  for (let v = 0; v < PHASH_BLOCK; v += 1) {
    for (let u = 0; u < PHASH_BLOCK; u += 1) {
      block.push(freq[v * size + u]);
    }
  }

  // block[0] is the DC term — brightness, not structure.
  const med = median(block.slice(1));

  let hex = "";
  for (let i = 0; i < block.length; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b += 1) {
      if (block[i + b] > med) nibble |= 1 << (3 - b);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

const POPCOUNT = Array.from(
  { length: 16 },
  (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1),
);

/** Bits that differ between two hex-encoded hashes of equal length. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare hashes of different lengths (${a.length} vs ${b.length}).`);
  }
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = parseInt(a[i], 16);
    const y = parseInt(b[i], 16);
    if (Number.isNaN(x) || Number.isNaN(y)) throw new Error(`Hash contains a non-hex character.`);
    distance += POPCOUNT[x ^ y];
  }
  return distance;
}

/**
 * Box-filter downscale of RGBA pixels to a square grayscale buffer.
 *
 * Averaging over each source region rather than sampling a single pixel is what
 * makes the hash stable across resizes — nearest-neighbour sampling would make
 * the result depend on which pixels happened to land on the grid.
 *
 * Rec. 601 luma weights; the exact coefficients matter less than using the same
 * ones everywhere, since the hash only ever compares against itself.
 */
export function rgbaToGrayscale(
  rgba: Uint8ClampedArray | Uint8Array | number[],
  width: number,
  height: number,
  size = PHASH_SIZE,
): Float64Array {
  if (width < 1 || height < 1) throw new Error("Image dimensions must be positive.");
  if (rgba.length < width * height * 4) {
    throw new Error(`RGBA buffer too small for ${width}x${height} (${rgba.length} bytes).`);
  }

  const out = new Float64Array(size * size);
  for (let ty = 0; ty < size; ty += 1) {
    const y0 = Math.floor((ty * height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / size));
    for (let tx = 0; tx < size; tx += 1) {
      const x0 = Math.floor((tx * width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / size));

      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < height; y += 1) {
        for (let x = x0; x < x1 && x < width; x += 1) {
          const i = (y * width + x) * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          count += 1;
        }
      }
      out[ty * size + tx] = count ? sum / count : 0;
    }
  }
  return out;
}

/** Convenience: RGBA straight to a perceptual hash. */
export function hashRgba(
  rgba: Uint8ClampedArray | Uint8Array | number[],
  width: number,
  height: number,
): string {
  return pHash(rgbaToGrayscale(rgba, width, height));
}

// ─── Near-duplicate matching ───────────────────────────────────────────────

export interface HashedImage {
  /** Stable identifier — article id, post id, or an uploaded file name. */
  id: string;
  hash: string;
  /** Where the image was seen. */
  source: string;
  url: string;
  /** ISO 8601 publication or capture time, when known. */
  seenAt: string;
  /** Article or post the image appeared in. */
  context?: string;
  /**
   * EXIF GPS fix, when the file carried one. Present so Module 5's map can plot
   * analysed imagery — omitted entirely when absent, never zeroed, because 0,0
   * is a real place and a missing fix must not become one.
   */
  gps?: GpsFix;
  /** Camera as reported by EXIF, for the map popup. */
  camera?: string;
}

export interface DuplicateMatch {
  image: HashedImage;
  distance: number;
  /** True below IDENTICAL_DISTANCE — the same picture, not merely similar. */
  identical: boolean;
  /** Days between this match and the query image, when both are dated. */
  daysEarlier: number | null;
}

export interface DuplicateReport {
  matches: DuplicateMatch[];
  /** Earliest dated appearance among the matches, or null. */
  firstSeen: string | null;
  /** Days between the earliest match and the query image. */
  firstSeenDaysEarlier: number | null;
  /** Analyst-facing reading. Never a verdict about intent. */
  summary: string;
  method: string;
}

const DAY_MS = 86_400_000;

/**
 * Find earlier appearances of an image in the corpus.
 *
 * This is the highest-value part of the module and it uses no ML at all.
 * Recycling an old photograph for a new event is the single most common form of
 * visual disinformation, and a perceptual hash catches it exactly — an image
 * that survives being resized, recompressed and recaptioned still hashes the
 * same. The finding is a fact about where the image has appeared before; it
 * says nothing about intent, and the summary is worded so it cannot be read as
 * if it did.
 */
export function findNearDuplicates(
  query: { hash: string; seenAt?: string; id?: string },
  corpus: HashedImage[],
  maxDistance = NEAR_DUPLICATE_DISTANCE,
): DuplicateReport {
  const method =
    `DCT perceptual hash (${PHASH_BLOCK * PHASH_BLOCK}-bit), Hamming distance <= ${maxDistance}. ` +
    `Survives resizing and recompression; does NOT survive heavy cropping, mirroring or rotation.`;

  const queryTime = query.seenAt ? new Date(query.seenAt).getTime() : NaN;

  const matches: DuplicateMatch[] = [];
  for (const image of corpus) {
    if (query.id && image.id === query.id) continue;
    if (image.hash.length !== query.hash.length) continue;
    const distance = hammingDistance(query.hash, image.hash);
    if (distance > maxDistance) continue;

    const t = new Date(image.seenAt).getTime();
    const daysEarlier =
      Number.isFinite(t) && Number.isFinite(queryTime) ? (queryTime - t) / DAY_MS : null;

    matches.push({
      image,
      distance,
      identical: distance <= IDENTICAL_DISTANCE,
      daysEarlier,
    });
  }

  matches.sort((a, b) => a.distance - b.distance || (b.daysEarlier ?? 0) - (a.daysEarlier ?? 0));

  const dated = matches
    .map((m) => ({ m, t: new Date(m.image.seenAt).getTime() }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);

  const firstSeen = dated.length ? dated[0].m.image.seenAt : null;
  const firstSeenDaysEarlier =
    dated.length && Number.isFinite(queryTime) ? (queryTime - dated[0].t) / DAY_MS : null;

  let summary: string;
  if (matches.length === 0) {
    summary =
      "No near-duplicate of this image was found in the corpus. That means it has not been " +
      "seen in what we collected — not that it is original.";
  } else {
    const sources = Array.from(new Set(matches.map((m) => m.image.source)));
    const when =
      firstSeenDaysEarlier !== null && firstSeenDaysEarlier > 0.5
        ? `, first ${firstSeenDaysEarlier.toFixed(0)} day(s) earlier`
        : firstSeen
          ? ", first appearance around the same time"
          : "";
    summary =
      `This image also appears in ${matches.length} other item(s) across ` +
      `${sources.length} source(s)${when}. Reuse is not itself evidence of anything — ` +
      `check whether the earlier context matches the claim now attached to it.`;
  }

  return { matches, firstSeen, firstSeenDaysEarlier, summary, method };
}

// ─── EXIF interpretation ───────────────────────────────────────────────────

/** Raw parsed EXIF as exifr returns it. Kept loose — the tag set varies by device. */
export type RawExif = Record<string, any>;

export interface ExifFinding {
  id: string;
  label: string;
  value: string;
  /** What this observation does and does not support. */
  note: string;
  severity: "info" | "notable";
}

export interface GpsFix {
  latitude: number;
  longitude: number;
  /** Metres above sea level where recorded. */
  altitude: number | null;
}

export interface ExifReport {
  /** False when the file carried no EXIF at all. */
  present: boolean;
  camera: { make: string | null; model: string | null; lens: string | null; serial: string | null };
  software: string | null;
  captureTime: string | null;
  modifyTime: string | null;
  gps: GpsFix | null;
  findings: ExifFinding[];
  /** Every tag parsed, for the raw dump. */
  raw: RawExif;
  method: string;
}

const str = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/**
 * Turn parsed EXIF into analyst-facing findings.
 *
 * The single most important behaviour here is how ABSENCE is reported. Every
 * major social platform strips EXIF on upload, so a missing block is the normal
 * case for anything redistributed — it is not evidence of tampering, and an
 * analyst reading it that way is a real and predictable failure. That statement
 * is attached to the finding itself rather than left to a footnote.
 */
export function interpretExif(raw: RawExif | null | undefined): ExifReport {
  const method =
    "EXIF/TIFF/XMP tags parsed from the file with exifr. Values are self-reported by the " +
    "writing device or software and can be edited with ordinary tools — treat them as claims, " +
    "not proof.";

  if (!raw || Object.keys(raw).length === 0) {
    return {
      present: false,
      camera: { make: null, model: null, lens: null, serial: null },
      software: null,
      captureTime: null,
      modifyTime: null,
      gps: null,
      findings: [
        {
          id: "exif_absent",
          label: "No EXIF metadata",
          value: "absent",
          note:
            "NOT a sign of manipulation. Facebook, Instagram, X, WhatsApp and Telegram all strip " +
            "EXIF on upload, so absence is the expected state for any image that has been " +
            "redistributed. It means the metadata channel carries no information either way.",
          severity: "info",
        },
      ],
      raw: {},
      method,
    };
  }

  const camera = {
    make: str(raw.Make),
    model: str(raw.Model),
    lens: str(raw.LensModel ?? raw.Lens ?? raw.LensInfo),
    serial: str(raw.SerialNumber ?? raw.BodySerialNumber ?? raw.InternalSerialNumber),
  };
  const software = str(raw.Software ?? raw.ProcessingSoftware ?? raw.CreatorTool);
  const captureTime = iso(raw.DateTimeOriginal ?? raw.CreateDate ?? raw.DateTimeDigitized);
  const modifyTime = iso(raw.ModifyDate ?? raw.DateTime);

  const lat = typeof raw.latitude === "number" ? raw.latitude : null;
  const lon = typeof raw.longitude === "number" ? raw.longitude : null;
  const gps =
    lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon)
      ? {
          latitude: lat,
          longitude: lon,
          altitude: typeof raw.GPSAltitude === "number" ? raw.GPSAltitude : null,
        }
      : null;

  const findings: ExifFinding[] = [];

  if (camera.make || camera.model) {
    findings.push({
      id: "camera",
      label: "Capture device",
      value: [camera.make, camera.model].filter(Boolean).join(" "),
      note:
        "Self-reported by the writing device. Consistent with camera capture, but the field is " +
        "trivially editable and is preserved by some editing software after heavy alteration.",
      severity: "info",
    });
  }

  if (camera.serial) {
    findings.push({
      id: "serial",
      label: "Body serial number",
      value: camera.serial,
      note:
        "A serial number links this file to a specific physical device. Where other images " +
        "carry the same serial, they share a camera — one of the strongest links EXIF offers.",
      severity: "notable",
    });
  }

  if (gps) {
    findings.push({
      id: "gps",
      label: "GPS fix",
      value: `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}${
        gps.altitude !== null ? ` at ${gps.altitude.toFixed(0)}m` : ""
      }`,
      note:
        "Geotagged EXIF is among the highest-value signals in image OSINT: it places the " +
        "capture device. The coordinate is written by the device and can be forged, so treat " +
        "it as a strong lead rather than a fact.",
      severity: "notable",
    });
  }

  if (software) {
    // Naming specific editors would go stale and would imply a judgement about
    // tools that have entirely legitimate uses. The presence of the field is the
    // observation; what it implies is left to the analyst.
    findings.push({
      id: "software",
      label: "Processing software",
      value: software,
      note:
        "The file was written by software rather than straight off a camera. Editing is " +
        "routine — cropping, colour correction and export all set this field — so this " +
        "indicates processing, not manipulation.",
      severity: "notable",
    });
  }

  if (captureTime && modifyTime) {
    const gapMinutes =
      Math.abs(new Date(modifyTime).getTime() - new Date(captureTime).getTime()) / 60_000;
    if (gapMinutes > 1) {
      findings.push({
        id: "timestamp_gap",
        label: "Capture and modification times differ",
        value:
          `captured ${captureTime}, modified ${modifyTime} ` +
          `(${gapMinutes < 1440 ? `${gapMinutes.toFixed(0)} min` : `${(gapMinutes / 1440).toFixed(1)} days`} apart)`,
        note:
          "The file was written after it was captured. Expected whenever an image has been " +
          "exported or edited; worth checking against the timeline of the event it is said to show.",
        severity: "notable",
      });
    }
  }

  if (!captureTime) {
    findings.push({
      id: "no_capture_time",
      label: "No original capture timestamp",
      value: "absent",
      note:
        "DateTimeOriginal is missing. Common in exported or re-encoded files. It means the " +
        "capture time cannot be read here, not that it was concealed.",
      severity: "info",
    });
  }

  return { present: true, camera, software, captureTime, modifyTime, gps, findings, raw, method };
}

// ─── C2PA interpretation ───────────────────────────────────────────────────

export type C2paStatus = "valid" | "invalid" | "absent" | "error";

export interface C2paAction {
  action: string;
  /** Software agent that performed it, where declared. */
  agent: string | null;
  when: string | null;
}

export interface C2paReport {
  status: C2paStatus;
  /** Organisation whose certificate signed the manifest. */
  signedBy: string | null;
  signedAt: string | null;
  /** Device or application that produced the asset, as declared. */
  generator: string | null;
  actions: C2paAction[];
  /**
   * True when the signed manifest DECLARES the asset was AI-generated. This is
   * the only high-confidence AI finding this system produces, precisely because
   * it is declared and cryptographically signed rather than inferred.
   */
  aiGenerated: boolean;
  aiEvidence: string | null;
  /** Validation problems reported by the toolkit, verbatim. */
  validationIssues: string[];
  summary: string;
  method: string;
}

const C2PA_METHOD =
  "C2PA Content Credentials read and cryptographically validated in-browser by the " +
  "contentauth WASM toolkit. A valid manifest is a signature check, not an estimate: it " +
  "either verifies against the signing certificate or it does not.";

export const C2PA_ABSENCE_NOTE =
  "Absence of Content Credentials is NOT evidence of fakery. Adoption is still partial, most " +
  "cameras and editors do not yet write them, every social platform that strips metadata " +
  "strips these too, and an adversary simply will not attach one. C2PA proves provenance when " +
  "present; it proves nothing when absent.";

/** Assertion labels that indicate generative AI in a C2PA manifest. */
const AI_ACTION_HINTS = [
  "c2pa.created",
  "com.adobe.generative",
  "trainedAlgorithmicMedia",
  "compositeWithTrainedAlgorithmicMedia",
  "digitalSourceType",
];

/**
 * Reduce a parsed c2pa read result to a report.
 *
 * Takes the already-parsed manifest store rather than a file, so the mapping
 * logic is testable without loading WASM.
 */
export function interpretC2pa(result: any, error?: string): C2paReport {
  if (error) {
    return {
      status: "error",
      signedBy: null,
      signedAt: null,
      generator: null,
      actions: [],
      aiGenerated: false,
      aiEvidence: null,
      validationIssues: [error],
      summary: `Content Credentials could not be read: ${error}`,
      method: C2PA_METHOD,
    };
  }

  const active = result?.manifestStore?.activeManifest;
  if (!active) {
    return {
      status: "absent",
      signedBy: null,
      signedAt: null,
      generator: null,
      actions: [],
      aiGenerated: false,
      aiEvidence: null,
      validationIssues: [],
      summary: `No C2PA manifest is attached to this file. ${C2PA_ABSENCE_NOTE}`,
      method: C2PA_METHOD,
    };
  }

  const validationIssues: string[] = (result?.manifestStore?.validationStatus ?? [])
    .map((v: any) => str(v?.explanation) ?? str(v?.code) ?? "unspecified validation failure")
    .filter(Boolean);

  const signedBy = str(active.signatureInfo?.issuer);
  const signedAt = iso(active.signatureInfo?.time);
  const generator = str(active.claimGenerator?.split("(")[0]);

  const actions: C2paAction[] = [];
  for (const assertion of active.assertions?.data ?? active.assertions ?? []) {
    const label = str(assertion?.label) ?? "";
    if (!label.includes("action")) continue;
    for (const a of assertion?.data?.actions ?? []) {
      actions.push({
        action: str(a?.action) ?? "unspecified",
        agent: str(a?.softwareAgent) ?? str(a?.parameters?.["com.adobe.tool"]),
        when: iso(a?.when),
      });
    }
  }

  // Serialising the manifest and searching it is deliberate: the C2PA generative
  // assertions live at several different paths depending on which tool wrote
  // them, and missing an AI declaration because it sat one key deeper than
  // expected is a worse failure than matching broadly.
  const serialised = (() => {
    try {
      return JSON.stringify(active);
    } catch {
      return "";
    }
  })();
  const aiHit = AI_ACTION_HINTS.find((h) => serialised.includes(h) && h !== "c2pa.created");
  const aiGenerated = Boolean(aiHit);

  const status: C2paStatus = validationIssues.length > 0 ? "invalid" : "valid";

  let summary: string;
  if (status === "invalid") {
    summary =
      `A C2PA manifest is present but DID NOT validate (${validationIssues.length} issue(s)). ` +
      `The file has been altered since it was signed, or the signature does not match its ` +
      `contents. This is a hard finding, not an estimate.`;
  } else if (aiGenerated) {
    summary =
      `Validated Content Credentials DECLARE this asset as AI-generated or AI-modified` +
      `${signedBy ? `, signed by ${signedBy}` : ""}. This is high-confidence: it is declared ` +
      `by the producing tool and cryptographically signed, not inferred from the pixels.`;
  } else {
    summary =
      `Content Credentials are present and validate` +
      `${signedBy ? `, signed by ${signedBy}` : ""}` +
      `${actions.length ? `, recording ${actions.length} edit action(s)` : ""}. ` +
      `The provenance chain below is cryptographically verified.`;
  }

  return {
    status,
    signedBy,
    signedAt,
    generator,
    actions,
    aiGenerated,
    aiEvidence: aiHit ? `Manifest carries the "${aiHit}" assertion.` : null,
    validationIssues,
    summary,
    method: C2PA_METHOD,
  };
}

// ─── OCR support ───────────────────────────────────────────────────────────

export interface OcrLanguage {
  /** Tesseract traineddata code. */
  code: string;
  label: string;
  script: string;
  /**
   * Honest accuracy note. Indic-script recognition is materially weaker than
   * Latin, and an analyst who does not know that will over-trust the output.
   */
  accuracyNote: string;
}

const INDIC_NOTE =
  "Indic-script OCR is materially less accurate than Latin: conjunct consonants, matras and " +
  "reph forms are frequently mis-segmented, and accuracy falls further on low-resolution or " +
  "screenshot text. Treat the output as a lead to be read against the image, not a transcript.";

/**
 * Languages offered for OCR.
 *
 * The nine Indic scripts here match the detection ranges in analysis.ts and the
 * 15-language UI, so text lifted from an image lands in the same language layer
 * as text collected from a feed.
 */
export const OCR_LANGUAGES: OcrLanguage[] = [
  {
    code: "eng",
    label: "English",
    script: "Latin",
    accuracyNote: "Highest accuracy. Reliable on printed text at reasonable resolution.",
  },
  { code: "hin", label: "Hindi", script: "Devanagari", accuracyNote: INDIC_NOTE },
  { code: "mar", label: "Marathi", script: "Devanagari", accuracyNote: INDIC_NOTE },
  { code: "san", label: "Sanskrit", script: "Devanagari", accuracyNote: INDIC_NOTE },
  { code: "tam", label: "Tamil", script: "Tamil", accuracyNote: INDIC_NOTE },
  { code: "tel", label: "Telugu", script: "Telugu", accuracyNote: INDIC_NOTE },
  { code: "ben", label: "Bengali", script: "Bengali", accuracyNote: INDIC_NOTE },
  { code: "kan", label: "Kannada", script: "Kannada", accuracyNote: INDIC_NOTE },
  { code: "mal", label: "Malayalam", script: "Malayalam", accuracyNote: INDIC_NOTE },
  { code: "guj", label: "Gujarati", script: "Gujarati", accuracyNote: INDIC_NOTE },
  { code: "pan", label: "Punjabi", script: "Gurmukhi", accuracyNote: INDIC_NOTE },
  { code: "ori", label: "Odia", script: "Odia", accuracyNote: INDIC_NOTE },
  { code: "urd", label: "Urdu", script: "Arabic", accuracyNote: INDIC_NOTE },
  {
    code: "ara",
    label: "Arabic",
    script: "Arabic",
    accuracyNote: "Lower than Latin. Cursive joining and diacritics are frequently mis-segmented.",
  },
];

export interface OcrWord {
  text: string;
  /** Tesseract's own per-word confidence, 0-100. Never synthesised here. */
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface OcrReport {
  text: string;
  words: OcrWord[];
  languages: string[];
  /** Mean of Tesseract's per-word confidences. Null when no word was returned. */
  meanConfidence: number | null;
  /** Words Tesseract itself scored below the usable threshold. */
  lowConfidenceCount: number;
  method: string;
  accuracyNotes: string[];
}

/** Below this, Tesseract's own score says the word is unreliable. */
export const OCR_LOW_CONFIDENCE = 60;

/** Build a report from Tesseract's raw output. Pure, so it is testable. */
export function interpretOcr(raw: any, languages: string[]): OcrReport {
  const rawWords: any[] = raw?.data?.words ?? raw?.words ?? [];
  const words: OcrWord[] = rawWords
    .filter((w) => str(w?.text))
    .map((w) => ({
      text: String(w.text).trim(),
      confidence: typeof w.confidence === "number" ? w.confidence : 0,
      bbox: w.bbox ?? null,
    }));

  const notes = OCR_LANGUAGES.filter((l) => languages.includes(l.code)).map(
    (l) => `${l.label} (${l.script}): ${l.accuracyNote}`,
  );

  return {
    text: str(raw?.data?.text ?? raw?.text) ?? "",
    words,
    languages,
    meanConfidence: words.length
      ? words.reduce((s, w) => s + w.confidence, 0) / words.length
      : null,
    lowConfidenceCount: words.filter((w) => w.confidence < OCR_LOW_CONFIDENCE).length,
    method:
      `Tesseract ${languages.join("+")} traineddata, run as WebAssembly in the browser. ` +
      `Confidence values are Tesseract's own per-word scores, reported unmodified.`,
    accuracyNotes: notes,
  };
}

// ─── Video: scene cuts from keyframe hashes ────────────────────────────────

export interface Keyframe {
  /** Seconds into the video. */
  time: number;
  hash: string;
  /** Data URL of the extracted frame, for display. */
  dataUrl?: string;
}

export interface SceneCut {
  /** Index of the frame that begins the new shot. */
  index: number;
  time: number;
  distanceFromPrevious: number;
}

export interface SceneReport {
  cuts: SceneCut[];
  /** Mean Hamming distance between consecutive frames. */
  meanDistance: number | null;
  method: string;
}

/**
 * Scene cuts from consecutive keyframe hash distance.
 *
 * Sampling at a fixed interval means a cut is located to within one interval,
 * not to the frame — stated in the method string rather than implied away.
 */
export function detectSceneCuts(frames: Keyframe[], threshold = SCENE_CUT_DISTANCE): SceneReport {
  const method =
    `Hamming distance between perceptual hashes of consecutive sampled frames, cut at >= ` +
    `${threshold} of 64 bits. Frames are sampled at a fixed interval, so a cut is located to ` +
    `within one sampling interval rather than to the exact frame.`;

  if (frames.length < 2) {
    return { cuts: [], meanDistance: null, method };
  }

  const distances: number[] = [];
  const cuts: SceneCut[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const d = hammingDistance(frames[i - 1].hash, frames[i].hash);
    distances.push(d);
    if (d >= threshold) {
      cuts.push({ index: i, time: frames[i].time, distanceFromPrevious: d });
    }
  }

  return {
    cuts,
    meanDistance: distances.reduce((s, d) => s + d, 0) / distances.length,
    method,
  };
}

// ─── Overall assessment ────────────────────────────────────────────────────

export interface ProvenanceAssessment {
  /** Ordered findings, strongest evidence first. */
  findings: { label: string; detail: string; strength: "verified" | "observed" | "absent" }[];
  /** Explicit statement of what this system cannot determine about this file. */
  cannotDetermine: string[];
  summary: string;
}

/**
 * Summarise everything known about one image.
 *
 * This is a SUMMARY OF FINDINGS and never a verdict. There is deliberately no
 * score: any single number here would be read as an authenticity rating, and we
 * have no basis for one. What we can say, we say; what we cannot, is listed
 * explicitly under cannotDetermine.
 */
export function assessProvenance(input: {
  exif: ExifReport | null;
  c2pa: C2paReport | null;
  duplicates: DuplicateReport | null;
}): ProvenanceAssessment {
  const findings: ProvenanceAssessment["findings"] = [];

  if (input.c2pa) {
    if (input.c2pa.status === "valid") {
      findings.push({
        label: input.c2pa.aiGenerated
          ? "Declared AI-generated (signed)"
          : "Content Credentials validate",
        detail: input.c2pa.summary,
        strength: "verified",
      });
    } else if (input.c2pa.status === "invalid") {
      findings.push({
        label: "Content Credentials FAILED validation",
        detail: input.c2pa.summary,
        strength: "verified",
      });
    } else if (input.c2pa.status === "absent") {
      findings.push({
        label: "No Content Credentials",
        detail: C2PA_ABSENCE_NOTE,
        strength: "absent",
      });
    }
  }

  if (input.exif) {
    if (!input.exif.present) {
      findings.push({
        label: "No EXIF metadata",
        detail: input.exif.findings[0]?.note ?? "",
        strength: "absent",
      });
    } else {
      for (const f of input.exif.findings.filter((x) => x.severity === "notable")) {
        findings.push({ label: f.label, detail: `${f.value}. ${f.note}`, strength: "observed" });
      }
    }
  }

  if (input.duplicates && input.duplicates.matches.length > 0) {
    findings.push({
      label: "Image seen previously in this corpus",
      detail: input.duplicates.summary,
      strength: "observed",
    });
  }

  const cannotDetermine = [
    "Whether faces in this image were swapped or synthesised. No deepfake classifier is " +
      "deployed: detectors trained on GAN-era fakes generalise poorly to diffusion models, and " +
      "their accuracy collapses under the recompression social platforms apply.",
    "Whether the image was generated by a diffusion model, unless a signed C2PA manifest " +
      "declares it. Undeclared generative output is not detectable here.",
    "What objects, vehicles or materiel are present. No object detection model is deployed.",
    "Whether unsigned metadata is truthful. EXIF fields are self-reported and editable.",
  ];

  const verified = findings.filter((f) => f.strength === "verified").length;
  const observed = findings.filter((f) => f.strength === "observed").length;

  const summary =
    verified > 0
      ? `${verified} cryptographically verified finding(s) and ${observed} observed signal(s). ` +
        `Verified findings are signature checks and carry no false-positive rate; observed ` +
        `signals are self-reported metadata or corpus matches and are leads, not proof.`
      : observed > 0
        ? `No cryptographic provenance is attached to this file, so nothing here is verified. ` +
          `${observed} observed signal(s) from self-reported metadata and corpus matching — ` +
          `treat each as a lead to check, not as a finding about authenticity.`
        : `Nothing was recovered from this file: no Content Credentials, no usable metadata, ` +
          `and no match in the collected corpus. This is an absence of information, not a ` +
          `finding that the image is either authentic or fabricated.`;

  return { findings, cannotDetermine, summary };
}

// ─── What is explicitly NOT implemented ────────────────────────────────────

export interface Gap {
  capability: string;
  requires: string;
  limitation: string;
  licence?: string;
}

/**
 * Rendered verbatim in the UI.
 *
 * Documenting the gap accurately is a stronger position than shipping a
 * classifier we cannot stand behind: an evaluator who knows this field will
 * trust the rest of the system more because it did not overclaim here.
 */
export const NOT_IMPLEMENTED: Gap[] = [
  {
    capability: "Deepfake / face-swap detection",
    requires:
      "GPU inference over an ensemble trained on FaceForensics++, Celeb-DF and OpenFake. No GPU " +
      "quota is held and the workload is not free-tier.",
    limitation:
      "Even fully deployed, published accuracy degrades sharply out of distribution: models " +
      "trained on GAN-era manipulations transfer poorly to diffusion-based face synthesis, and " +
      "performance falls further after the JPEG recompression that social redistribution " +
      "applies — which is exactly the media this system ingests. A score would look like a " +
      "measurement and behave like a guess.",
  },
  {
    capability: "Diffusion-generated image detection",
    requires: "A trained detector plus GPU inference, retrained as each new generator is released.",
    limitation:
      "Detectors are generator-specific in practice and lag new models by months. Where a C2PA " +
      "manifest declares generative provenance we report it with high confidence, because that " +
      "is a signature rather than an inference.",
  },
  {
    capability: "Object and materiel recognition",
    requires: "Grounding DINO (Apache 2.0) for open-vocabulary detection, with GPU inference.",
    licence:
      "Grounding DINO is Apache 2.0 and usable here. Ultralytics YOLO is AGPL-3.0 and must NOT " +
      "be used: it would force open-sourcing the entire system unless a commercial licence is " +
      "purchased.",
    limitation:
      "Open-vocabulary detection is strong on common classes and materially weaker on specific " +
      "military platforms, which is the case that would actually matter here.",
  },
  {
    capability: "Face matching against a watchlist",
    requires: "A face recognition model, a curated reference set, and a lawful basis to hold it.",
    limitation:
      "Beyond the technical requirement, holding biometric templates of identifiable individuals " +
      "engages the DPDP Act 2023. Not a gap to close without a legal basis first.",
  },
  {
    capability: "Audio transcription and voice-clone detection",
    requires: "Whisper (MIT) for transcription, plus GPU inference for anti-spoofing models.",
    limitation:
      "Whisper would run on the same GPU quota as the LLM work. Voice-clone detection has the " +
      "same out-of-distribution problem as visual deepfake detection.",
  },
];
