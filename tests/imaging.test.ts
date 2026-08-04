import { describe, expect, test } from "bun:test";
import exifr from "exifr";
import {
  assessProvenance,
  detectSceneCuts,
  dct2d,
  findNearDuplicates,
  hammingDistance,
  hashRgba,
  interpretC2pa,
  interpretExif,
  interpretOcr,
  pHash,
  rgbaToGrayscale,
  C2PA_ABSENCE_NOTE,
  IDENTICAL_DISTANCE,
  NEAR_DUPLICATE_DISTANCE,
  NOT_IMPLEMENTED,
  OCR_LANGUAGES,
  PHASH_SIZE,
  SCENE_CUT_DISTANCE,
  type HashedImage,
} from "../src/utils/imaging";
import {
  buildJpegWithExif,
  buildJpegWithoutExif,
  requantise,
  resample,
  syntheticImage,
} from "./helpers/jpeg-fixture";

// ─── Deterministic test images ─────────────────────────────────────────────
// Every pattern is a pure function of (x, y). A perceptual-hash test that cannot
// be reproduced byte for byte is not a test.
//
// The patterns are deliberately LOW-FREQUENCY and non-clipping, because that is
// what photographs are: most of their energy sits well below the 32x32 grid the
// hash samples on. An earlier version of these fixtures used a near-Nyquist
// pattern and measured a distance of 30 after a 256->200 resize while measuring
// 0 at 256->128 — the hash was fine, the fixture was aliasing. See the
// documented-limitation test at the end of this block for that case, kept
// deliberately rather than hidden.

const SCENE = syntheticImage(256, 256, (x, y) =>
  128 + 50 * Math.sin(x / 40) + 30 * Math.cos(y / 55) + 15 * Math.sin((x + y) / 70),
);
const OTHER_SCENE = syntheticImage(256, 256, (x, y) =>
  128 + 70 * Math.sin(x / 48) * Math.cos(y / 64) + 30 * Math.cos((x * x + y * y) / 9000),
);
const THIRD_SCENE = syntheticImage(256, 256, (x, y) =>
  128 + 55 * Math.cos((x - y) / 52) - 45 * Math.sin(y / 36),
);
const FLAT = syntheticImage(256, 256, () => 128);
/** High-frequency content, at the edge of what a 32x32 hash can represent. */
const NEAR_NYQUIST = syntheticImage(256, 256, (x, y) =>
  128 + 90 * Math.sin(x / 18) * Math.cos(y / 27) + 40 * Math.sin((x + y) / 9),
);

// ─── DCT ───────────────────────────────────────────────────────────────────

describe("DCT", () => {
  test("a constant signal puts all energy in the DC coefficient", () => {
    const n = 8;
    const flat = new Float64Array(n * n).fill(50);
    const out = dct2d(flat, n);
    expect(Math.abs(out[0])).toBeGreaterThan(1);
    for (let i = 1; i < out.length; i += 1) expect(Math.abs(out[i])).toBeLessThan(1e-9);
  });

  test("is deterministic across calls", () => {
    const n = 8;
    const input = Float64Array.from({ length: n * n }, (_, i) => (i * 37) % 255);
    expect(Array.from(dct2d(input, n))).toEqual(Array.from(dct2d(input, n)));
  });
});

// ─── Grayscale conversion ──────────────────────────────────────────────────

describe("rgbaToGrayscale", () => {
  test("produces exactly size x size samples regardless of source dimensions", () => {
    const wide = syntheticImage(640, 120, (x) => x % 255);
    expect(rgbaToGrayscale(wide.data, 640, 120).length).toBe(PHASH_SIZE * PHASH_SIZE);
  });

  test("box-averages rather than point-sampling, so a half-black image reads mid-grey", () => {
    // Nearest-neighbour sampling would return 0 or 255 depending on grid luck.
    const striped = syntheticImage(64, 64, (x) => (x % 2 === 0 ? 0 : 255));
    const gray = rgbaToGrayscale(striped.data, 64, 64, 8);
    for (const v of gray) expect(v).toBeGreaterThan(100);
    for (const v of gray) expect(v).toBeLessThan(160);
  });

  test("rejects a buffer too small for the stated dimensions", () => {
    expect(() => rgbaToGrayscale(new Uint8ClampedArray(16), 100, 100)).toThrow();
  });
});

// ─── pHash stability ───────────────────────────────────────────────────────

describe("pHash", () => {
  const base = hashRgba(SCENE.data, SCENE.width, SCENE.height);

  test("is 16 hex characters — 64 bits", () => {
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is stable under downscaling", () => {
    // The core property: an image redistributed at a different size must still
    // match. Without it, cross-article duplicate detection finds nothing.
    for (const size of [512, 200, 128, 64]) {
      const scaled = resample(SCENE, size, size);
      const d = hammingDistance(base, hashRgba(scaled.data, scaled.width, scaled.height));
      expect(d).toBeLessThanOrEqual(NEAR_DUPLICATE_DISTANCE);
    }
  });

  test("survives a non-square rescale that changes aspect ratio slightly", () => {
    const squashed = resample(SCENE, 240, 200);
    const d = hammingDistance(base, hashRgba(squashed.data, squashed.width, squashed.height));
    expect(d).toBeLessThanOrEqual(NEAR_DUPLICATE_DISTANCE);
  });

  test("survives recompression", () => {
    for (const strength of [0.3, 0.6, 0.9]) {
      const lossy = requantise(SCENE, strength);
      const d = hammingDistance(base, hashRgba(lossy.data, lossy.width, lossy.height));
      expect(d).toBeLessThanOrEqual(NEAR_DUPLICATE_DISTANCE);
    }
  });

  test("survives resize AND recompression together — the real redistribution path", () => {
    const chain = requantise(resample(requantise(SCENE, 0.5), 320, 320), 0.6);
    const d = hammingDistance(base, hashRgba(chain.data, chain.width, chain.height));
    expect(d).toBeLessThanOrEqual(NEAR_DUPLICATE_DISTANCE);
  });

  test("is unchanged by a uniform brightness shift", () => {
    // The DC coefficient is excluded precisely so exposure changes do not move
    // the hash. If this fails, that exclusion has been lost. The pattern must
    // not clip at 0 or 255 — a clipped shift changes structure, not just level.
    const brighter = syntheticImage(256, 256, (x, y) =>
      153 + 50 * Math.sin(x / 40) + 30 * Math.cos(y / 55) + 15 * Math.sin((x + y) / 70),
    );
    const d = hammingDistance(base, hashRgba(brighter.data, brighter.width, brighter.height));
    expect(d).toBeLessThanOrEqual(IDENTICAL_DISTANCE);
  });

  test("KNOWN LIMITATION: near-Nyquist detail is not hashed stably across scales", () => {
    // Documented rather than hidden. A pattern with most of its energy at the
    // 32x32 sampling limit — fine repeated texture, dense screenshot text, a
    // moire target — re-samples differently at non-integer ratios and the hash
    // moves with it. Photographs are dominated by lower frequencies, which is
    // why the signal works in practice, but an analyst matching a screenshot of
    // dense text should know this is where it degrades.
    const base2 = hashRgba(NEAR_NYQUIST.data, 256, 256);
    const awkward = resample(NEAR_NYQUIST, 200, 200);
    const d = hammingDistance(base2, hashRgba(awkward.data, awkward.width, awkward.height));
    expect(d).toBeGreaterThan(NEAR_DUPLICATE_DISTANCE);
  });

  test("separates different images well beyond the duplicate threshold", () => {
    for (const other of [OTHER_SCENE, THIRD_SCENE]) {
      const d = hammingDistance(base, hashRgba(other.data, other.width, other.height));
      expect(d).toBeGreaterThan(NEAR_DUPLICATE_DISTANCE);
    }
  });

  test("rejects a grayscale buffer of the wrong length instead of guessing", () => {
    expect(() => pHash(new Float64Array(10))).toThrow(/expects/);
  });

  test("hashes a featureless image without throwing", () => {
    expect(hashRgba(FLAT.data, FLAT.width, FLAT.height)).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ─── Hamming distance ──────────────────────────────────────────────────────

describe("hammingDistance", () => {
  test("counts differing bits", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });

  test("is symmetric", () => {
    expect(hammingDistance("a3f9012048bd7e6c", "1c07fedfb7428193"))
      .toBe(hammingDistance("1c07fedfb7428193", "a3f9012048bd7e6c"));
  });

  test("satisfies the triangle inequality on a sample triple", () => {
    const a = "0000000000000000", b = "00000000000000ff", c = "000000000000ffff";
    expect(hammingDistance(a, c)).toBeLessThanOrEqual(
      hammingDistance(a, b) + hammingDistance(b, c),
    );
  });

  test("refuses to compare hashes of different lengths", () => {
    expect(() => hammingDistance("abcd", "abcdef")).toThrow(/different lengths/);
  });

  test("refuses a non-hex character rather than scoring it as zero", () => {
    expect(() => hammingDistance("zzzz", "0000")).toThrow(/non-hex/);
  });
});

// ─── Near-duplicate detection ──────────────────────────────────────────────

describe("findNearDuplicates", () => {
  const sceneHash = hashRgba(SCENE.data, SCENE.width, SCENE.height);
  const resized = resample(SCENE, 128, 128);
  const otherHash = hashRgba(OTHER_SCENE.data, OTHER_SCENE.width, OTHER_SCENE.height);

  const corpus: HashedImage[] = [
    {
      id: "old-1",
      hash: hashRgba(resized.data, resized.width, resized.height),
      source: "thehindu.com",
      url: "https://www.thehindu.com/a",
      seenAt: "2026-06-20T08:00:00.000Z",
      context: "Original reporting, 14 days earlier",
    },
    {
      id: "old-2",
      hash: hashRgba(requantise(SCENE, 0.7).data, 256, 256),
      source: "ndtv.com",
      url: "https://www.ndtv.com/b",
      seenAt: "2026-06-22T08:00:00.000Z",
    },
    {
      id: "unrelated",
      hash: otherHash,
      source: "reuters.com",
      url: "https://www.reuters.com/c",
      seenAt: "2026-07-01T08:00:00.000Z",
    },
  ];

  const report = findNearDuplicates(
    { hash: sceneHash, seenAt: "2026-07-04T08:00:00.000Z", id: "query" },
    corpus,
  );

  test("finds the recycled image and excludes the unrelated one", () => {
    // Old photographs recaptioned for new events are the most common form of
    // visual disinformation, and this is what catches them — with no ML at all.
    expect(report.matches.map((m) => m.image.id).sort()).toEqual(["old-1", "old-2"]);
  });

  test("reports how much earlier the image first appeared", () => {
    expect(report.firstSeen).toBe("2026-06-20T08:00:00.000Z");
    expect(report.firstSeenDaysEarlier).toBeCloseTo(14, 0);
    expect(report.summary).toContain("14 day(s) earlier");
  });

  test("wording states reuse as a fact and does not assert intent", () => {
    expect(report.summary).toContain("Reuse is not itself evidence of anything");
    expect(report.summary).not.toMatch(/fake|manipulated|disinformation campaign/i);
  });

  test("excludes the query image itself by id", () => {
    const self = findNearDuplicates(
      { hash: corpus[0].hash, seenAt: corpus[0].seenAt, id: "old-1" },
      corpus,
    );
    expect(self.matches.some((m) => m.image.id === "old-1")).toBe(false);
  });

  test("no match is reported as absence of collection, not as originality", () => {
    const none = findNearDuplicates({ hash: otherHash, id: "q" }, [corpus[0]]);
    expect(none.matches).toEqual([]);
    expect(none.summary).toContain("not that it is original");
  });

  test("states its method and its limits", () => {
    expect(report.method).toContain("does NOT survive heavy cropping");
  });

  test("ranks closer matches first", () => {
    const distances = report.matches.map((m) => m.distance);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  test("handles an undated query without inventing a time gap", () => {
    const undated = findNearDuplicates({ hash: sceneHash, id: "q" }, corpus);
    expect(undated.matches.length).toBe(2);
    expect(undated.matches.every((m) => m.daysEarlier === null)).toBe(true);
    expect(undated.firstSeenDaysEarlier).toBeNull();
  });
});

// ─── EXIF ──────────────────────────────────────────────────────────────────

describe("EXIF parsing — fixture with GPS", () => {
  const jpeg = buildJpegWithExif({
    make: "Canon",
    model: "EOS R5",
    software: "Adobe Photoshop 25.0",
    lens: "RF24-70mm F2.8 L IS USM",
    serial: "032041000123",
    dateTimeOriginal: "2026:07:14 09:12:33",
    modifyDate: "2026:07:20 18:04:01",
    gps: { lat: [28, 36, 50.4], latRef: "N", lon: [77, 12, 32.4], lonRef: "E", altitude: 216 },
  });

  test("parses camera, lens and serial from real bytes", async () => {
    const report = interpretExif(await exifr.parse(jpeg, true));
    expect(report.present).toBe(true);
    expect(report.camera.make).toBe("Canon");
    expect(report.camera.model).toBe("EOS R5");
    expect(report.camera.lens).toContain("RF24-70mm");
    expect(report.camera.serial).toBe("032041000123");
  });

  test("extracts GPS as decimal degrees ready for the map", async () => {
    const report = interpretExif(await exifr.parse(jpeg, true));
    expect(report.gps).not.toBeNull();
    expect(report.gps!.latitude).toBeCloseTo(28.614, 3);
    expect(report.gps!.longitude).toBeCloseTo(77.209, 3);
    expect(report.gps!.altitude).toBeCloseTo(216, 0);
  });

  test("flags the capture-versus-modification gap with the real interval", async () => {
    const report = interpretExif(await exifr.parse(jpeg, true));
    const gap = report.findings.find((f) => f.id === "timestamp_gap");
    expect(gap).toBeDefined();
    expect(gap!.value).toContain("days apart");
    expect(gap!.note).toContain("Expected whenever an image has been exported or edited");
  });

  test("reports processing software as processing, not as manipulation", async () => {
    const report = interpretExif(await exifr.parse(jpeg, true));
    const sw = report.findings.find((f) => f.id === "software");
    expect(sw!.value).toContain("Photoshop");
    expect(sw!.note).toContain("indicates processing, not manipulation");
  });

  test("treats a body serial number as a notable device link", async () => {
    const report = interpretExif(await exifr.parse(jpeg, true));
    const serial = report.findings.find((f) => f.id === "serial");
    expect(serial!.severity).toBe("notable");
    expect(serial!.note).toContain("share a camera");
  });

  test("states that metadata is self-reported and editable", async () => {
    const report = interpretExif(await exifr.parse(jpeg, true));
    expect(report.method).toContain("treat them as claims, not proof");
  });
});

describe("EXIF parsing — fixture without GPS", () => {
  const jpeg = buildJpegWithExif({
    make: "Nikon",
    model: "Z8",
    dateTimeOriginal: "2026:01:02 03:04:05",
  });

  test("parses the camera but reports no GPS rather than a zero coordinate", async () => {
    const report = interpretExif(await exifr.parse(jpeg, true));
    expect(report.present).toBe(true);
    expect(report.camera.make).toBe("Nikon");
    // 0,0 is a real place in the Gulf of Guinea. Absent must not become a fix.
    expect(report.gps).toBeNull();
    expect(report.findings.some((f) => f.id === "gps")).toBe(false);
  });

  test("does not invent a timestamp gap when only one timestamp exists", async () => {
    const report = interpretExif(await exifr.parse(jpeg, true));
    expect(report.findings.some((f) => f.id === "timestamp_gap")).toBe(false);
  });
});

describe("EXIF parsing — image with no metadata at all", () => {
  test("exifr returns nothing for a bare JPEG", async () => {
    const parsed = await exifr.parse(buildJpegWithoutExif(), true);
    expect(parsed).toBeUndefined();
  });

  test("absence is handled gracefully and is NOT reported as manipulation", async () => {
    // The failure mode this guards against: an analyst reading stripped metadata
    // as evidence of tampering. Every major platform strips EXIF on upload.
    const report = interpretExif(await exifr.parse(buildJpegWithoutExif(), true));
    expect(report.present).toBe(false);
    expect(report.gps).toBeNull();
    expect(report.camera.make).toBeNull();
    expect(report.findings.length).toBe(1);
    expect(report.findings[0].note).toContain("NOT a sign of manipulation");
    expect(report.findings[0].note).toMatch(/Instagram|Facebook/);
    expect(report.findings[0].severity).toBe("info");
  });

  test("null and empty input are handled the same way as a stripped file", () => {
    for (const input of [null, undefined, {}]) {
      const report = interpretExif(input as any);
      expect(report.present).toBe(false);
      expect(report.findings[0].id).toBe("exif_absent");
    }
  });
});

// ─── C2PA ──────────────────────────────────────────────────────────────────

describe("C2PA interpretation", () => {
  const signed = {
    manifestStore: {
      validationStatus: [],
      activeManifest: {
        claimGenerator: "Adobe Photoshop 25.0 (Windows)",
        signatureInfo: { issuer: "Adobe Inc.", time: "2026-07-14T09:20:00.000Z" },
        assertions: {
          data: [
            {
              label: "c2pa.actions",
              data: {
                actions: [
                  { action: "c2pa.created", softwareAgent: "Canon EOS R5", when: "2026-07-14T09:12:33.000Z" },
                  { action: "c2pa.color_adjustments", softwareAgent: "Adobe Photoshop 25.0" },
                ],
              },
            },
          ],
        },
      },
    },
  };

  test("a valid manifest reports its signer and provenance chain", () => {
    const report = interpretC2pa(signed);
    expect(report.status).toBe("valid");
    expect(report.signedBy).toBe("Adobe Inc.");
    expect(report.generator).toContain("Adobe Photoshop");
    expect(report.actions.length).toBe(2);
    expect(report.actions[0].agent).toBe("Canon EOS R5");
    expect(report.aiGenerated).toBe(false);
    expect(report.summary).toContain("cryptographically verified");
  });

  test("a declared AI generation is a HIGH-CONFIDENCE finding, not an inference", () => {
    const ai = JSON.parse(JSON.stringify(signed));
    ai.manifestStore.activeManifest.assertions.data.push({
      label: "c2pa.actions",
      data: { actions: [{ action: "c2pa.created", digitalSourceType: "trainedAlgorithmicMedia" }] },
    });
    const report = interpretC2pa(ai);
    expect(report.aiGenerated).toBe(true);
    expect(report.aiEvidence).toContain("trainedAlgorithmicMedia");
    expect(report.summary).toContain("DECLARE this asset as AI-generated");
    expect(report.summary).toContain("not inferred from the pixels");
  });

  test("a failed signature check is reported as a hard finding", () => {
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.manifestStore.validationStatus = [
      { code: "assertion.dataHash.mismatch", explanation: "Asset data does not match the claim hash" },
    ];
    const report = interpretC2pa(tampered);
    expect(report.status).toBe("invalid");
    expect(report.validationIssues[0]).toContain("does not match");
    expect(report.summary).toContain("DID NOT validate");
    expect(report.summary).toContain("not an estimate");
  });

  test("absence is explicitly NOT evidence of fakery", () => {
    const report = interpretC2pa({ manifestStore: null });
    expect(report.status).toBe("absent");
    expect(report.aiGenerated).toBe(false);
    expect(report.summary).toContain("NOT evidence of fakery");
    expect(C2PA_ABSENCE_NOTE).toContain("proves nothing when absent");
  });

  test("a toolkit error is surfaced as an error, not as absence", () => {
    // "We could not read it" and "there is nothing there" are different findings.
    const report = interpretC2pa(null, "WASM failed to initialise");
    expect(report.status).toBe("error");
    expect(report.summary).toContain("could not be read");
  });
});

// ─── OCR ───────────────────────────────────────────────────────────────────

describe("OCR interpretation", () => {
  const raw = {
    data: {
      text: "प्रवेश निषेध\nRESTRICTED AREA",
      words: [
        { text: "प्रवेश", confidence: 71.2, bbox: { x0: 10, y0: 10, x1: 90, y1: 40 } },
        { text: "निषेध", confidence: 44.8, bbox: { x0: 95, y0: 10, x1: 160, y1: 40 } },
        { text: "RESTRICTED", confidence: 93.5, bbox: { x0: 10, y0: 50, x1: 140, y1: 78 } },
        { text: "AREA", confidence: 96.1, bbox: { x0: 145, y0: 50, x1: 200, y1: 78 } },
      ],
    },
  };

  test("reports Tesseract's own per-word confidences unmodified", () => {
    const report = interpretOcr(raw, ["hin", "eng"]);
    expect(report.words.map((w) => w.confidence)).toEqual([71.2, 44.8, 93.5, 96.1]);
    expect(report.meanConfidence).toBeCloseTo((71.2 + 44.8 + 93.5 + 96.1) / 4, 4);
  });

  test("counts words Tesseract itself scored as unreliable", () => {
    expect(interpretOcr(raw, ["hin", "eng"]).lowConfidenceCount).toBe(1);
  });

  test("carries the Indic accuracy caveat for the languages actually used", () => {
    const report = interpretOcr(raw, ["hin", "eng"]);
    expect(report.accuracyNotes.some((n) => n.includes("Devanagari"))).toBe(true);
    expect(report.accuracyNotes.some((n) => n.includes("materially less accurate"))).toBe(true);
  });

  test("an empty result yields a null mean rather than zero", () => {
    // Zero confidence and no measurement are different claims.
    const report = interpretOcr({ data: { text: "", words: [] } }, ["eng"]);
    expect(report.meanConfidence).toBeNull();
    expect(report.words).toEqual([]);
  });

  test("covers the nine Indic scripts the language layer detects", () => {
    const scripts = new Set(OCR_LANGUAGES.map((l) => l.script));
    for (const s of ["Devanagari", "Tamil", "Telugu", "Bengali", "Kannada", "Malayalam", "Gujarati", "Gurmukhi", "Odia"]) {
      expect(scripts.has(s)).toBe(true);
    }
  });

  test("every Indic language carries an accuracy warning", () => {
    for (const l of OCR_LANGUAGES.filter((x) => x.script !== "Latin")) {
      expect(l.accuracyNote.length).toBeGreaterThan(40);
    }
  });
});

// ─── Video scene cuts ──────────────────────────────────────────────────────

describe("scene cut detection", () => {
  const frames = [
    { time: 0, hash: hashRgba(SCENE.data, 256, 256) },
    { time: 2, hash: hashRgba(requantise(SCENE, 0.4).data, 256, 256) },
    { time: 4, hash: hashRgba(OTHER_SCENE.data, 256, 256) },
    { time: 6, hash: hashRgba(requantise(OTHER_SCENE, 0.4).data, 256, 256) },
  ];

  test("finds the cut and ignores within-shot drift", () => {
    const report = detectSceneCuts(frames);
    expect(report.cuts.length).toBe(1);
    expect(report.cuts[0].time).toBe(4);
    expect(report.cuts[0].distanceFromPrevious).toBeGreaterThanOrEqual(SCENE_CUT_DISTANCE);
  });

  test("states that a cut is located only to within one sampling interval", () => {
    expect(detectSceneCuts(frames).method).toContain("within one sampling interval");
  });

  test("fewer than two frames yields no cuts and a null mean", () => {
    const report = detectSceneCuts([frames[0]]);
    expect(report.cuts).toEqual([]);
    expect(report.meanDistance).toBeNull();
  });
});

// ─── Overall assessment ────────────────────────────────────────────────────

describe("provenance assessment", () => {
  test("is a summary of findings and carries no authenticity score", () => {
    const a = assessProvenance({
      exif: interpretExif(null),
      c2pa: interpretC2pa({ manifestStore: null }),
      duplicates: null,
    });
    expect(a).not.toHaveProperty("score");
    expect(a).not.toHaveProperty("probability");
    expect(a.summary).toContain("not a finding that the image is either authentic or fabricated");
  });

  test("always states what could not be determined", () => {
    const a = assessProvenance({ exif: null, c2pa: null, duplicates: null });
    expect(a.cannotDetermine.length).toBeGreaterThanOrEqual(4);
    expect(a.cannotDetermine.join(" ")).toContain("No deepfake classifier is deployed");
    expect(a.cannotDetermine.join(" ")).toContain("No object detection model is deployed");
  });

  test("separates cryptographically verified findings from observed signals", () => {
    const a = assessProvenance({
      exif: null,
      c2pa: interpretC2pa({
        manifestStore: {
          validationStatus: [],
          activeManifest: { signatureInfo: { issuer: "Truepic" }, assertions: { data: [] } },
        },
      }),
      duplicates: null,
    });
    expect(a.findings[0].strength).toBe("verified");
    expect(a.summary).toContain("carry no false-positive rate");
  });

  test("absent signals are labelled absent, never counted against the image", () => {
    const a = assessProvenance({
      exif: interpretExif(null),
      c2pa: interpretC2pa({ manifestStore: null }),
      duplicates: null,
    });
    expect(a.findings.every((f) => f.strength === "absent")).toBe(true);
  });
});

// ─── Declared gaps ─────────────────────────────────────────────────────────

describe("documented gaps", () => {
  test("deepfake detection is listed as not implemented, with the reason", () => {
    const gap = NOT_IMPLEMENTED.find((g) => g.capability.includes("Deepfake"))!;
    expect(gap.limitation).toContain("diffusion");
    expect(gap.limitation).toContain("recompression");
    expect(gap.requires).toContain("GPU");
  });

  test("object detection records the AGPL licence trap", () => {
    // Ultralytics YOLO is AGPL-3.0 — using it would force open-sourcing the
    // whole system. The warning belongs in the code, not in someone's memory.
    const gap = NOT_IMPLEMENTED.find((g) => g.capability.includes("Object"))!;
    expect(gap.licence).toContain("Apache 2.0");
    expect(gap.licence).toContain("AGPL-3.0");
    expect(gap.licence).toContain("must NOT");
  });

  test("every declared gap states both what it needs and what it would still get wrong", () => {
    for (const gap of NOT_IMPLEMENTED) {
      expect(gap.requires.length).toBeGreaterThan(30);
      expect(gap.limitation.length).toBeGreaterThan(40);
    }
  });
});
