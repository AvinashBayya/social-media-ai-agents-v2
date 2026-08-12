import { describe, expect, test } from "bun:test";
import {
  ATTRIBUTION_LIMITATION,
  AttestationError,
  CAPTURE_CAVEATS,
  CAPTURE_PLATFORM_LABELS,
  attestedCaptureToMediaAsset,
  buildAttestedCapture,
  isPublicPostUrl,
  type AttestedCaptureInput,
} from "../src/utils/manual-evidence";
import { HASH_MEANING, isSha256 } from "../src/utils/evidence";
import { parseMediaAsset } from "../src/types/core";

/**
 * Analyst-attested capture — the only route by which Meta content enters.
 *
 * The property under test throughout is that an asserted record can never be
 * mistaken for a collected one. The v1 tree collapsed exactly that distinction:
 * `agent_scraper.py` wrote fabricated Instagram posts into the same cache the
 * real collectors used, and the page rendered them beside genuine Bluesky data
 * with no visible difference. A separate type with a fixed provenance marker and
 * mandatory attribution is what makes that collapse impossible rather than
 * merely discouraged.
 */

const SHA = "a".repeat(64);

const VALID: AttestedCaptureInput = {
  platform: "instagram",
  sourceUrl: "https://www.instagram.com/p/ABC123/",
  capturedAt: "2026-08-12T10:30:00.000Z",
  capturedBy: "analyst-07",
  note: "Public post, visible without login.",
  sha256: SHA,
  filename: "capture.png",
  fileSize: 204_800,
  id: "CAP-FIXED",
};

describe("isPublicPostUrl", () => {
  test("accepts absolute http(s) URLs on any host", () => {
    // Deliberately not platform-restricted — an analyst pasting a regional
    // mirror or threads.net should not be blocked.
    expect(isPublicPostUrl("https://www.instagram.com/p/ABC/")).toBe(true);
    expect(isPublicPostUrl("http://facebook.com/x/posts/1")).toBe(true);
    expect(isPublicPostUrl("https://www.threads.net/@x/post/1")).toBe(true);
  });

  test("rejects anything that is not a traceable address", () => {
    for (const bad of [
      "",
      "   ",
      "instagram.com/p/ABC",
      "javascript:alert(1)",
      "data:text/html,x",
    ]) {
      expect(isPublicPostUrl(bad)).toBe(false);
    }
  });
});

describe("buildAttestedCapture", () => {
  test("builds a complete record from valid input", () => {
    const c = buildAttestedCapture(VALID);
    expect(c.provenance).toBe("analyst-attested-capture");
    expect(c.sourceUrl).toBe(VALID.sourceUrl);
    expect(c.capturedBy).toBe("analyst-07");
    expect(c.capturedAt).toBe("2026-08-12T10:30:00.000Z");
    expect(isSha256(c.sha256)).toBe(true);
    // Never guessed — pHash needs the image decoded, which happens in Module 4.
    expect(c.phash).toBeNull();
  });

  test("provenance is a fixed marker, so one field identifies an assertion", () => {
    // A consumer must be able to tell asserted from collected without knowing
    // which platforms happen to be manual this month.
    for (const platform of Object.keys(
      CAPTURE_PLATFORM_LABELS,
    ) as (keyof typeof CAPTURE_PLATFORM_LABELS)[]) {
      expect(buildAttestedCapture({ ...VALID, platform }).provenance).toBe(
        "analyst-attested-capture",
      );
    }
  });

  test("refuses a capture with no source URL", () => {
    // An unattributable screenshot is not evidence — it is an image of unknown
    // origin that will nonetheless sit in a case file looking official.
    const err = (() => {
      try {
        buildAttestedCapture({ ...VALID, sourceUrl: "" });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AttestationError);
    expect((err as AttestationError).field).toBe("sourceUrl");
  });

  test("refuses a capture with no capturer", () => {
    const err = (() => {
      try {
        buildAttestedCapture({ ...VALID, capturedBy: "  " });
      } catch (e) {
        return e;
      }
    })();
    expect((err as AttestationError).field).toBe("capturedBy");
    expect((err as Error).message).toMatch(/source/i);
  });

  test("refuses an unparseable capture time, and says it is capture not publication", () => {
    const err = (() => {
      try {
        buildAttestedCapture({ ...VALID, capturedAt: "recently" });
      } catch (e) {
        return e;
      }
    })();
    expect((err as AttestationError).field).toBe("capturedAt");
    expect((err as Error).message).toMatch(/not the time the/i);
  });

  test("refuses a capture whose file was never hashed", () => {
    for (const bad of ["", "abc", "A".repeat(64)]) {
      const err = (() => {
        try {
          buildAttestedCapture({ ...VALID, sha256: bad });
        } catch (e) {
          return e;
        }
      })();
      expect((err as AttestationError).field).toBe("sha256");
    }
  });

  test("accepts a raw datetime-local value and converts it from LOCAL time", () => {
    // The panel hands the input's value straight through. A bare
    // `YYYY-MM-DDTHH:mm` has no offset, so Date.parse reads it as local and the
    // stored instant is correct. The panel used to pre-convert with
    // `new Date(v).toISOString()` on a default seeded from a UTC wall clock,
    // which subtracted the offset twice — every IST capture stamped 5h30m early
    // and then labelled "UTC".
    const c = buildAttestedCapture({ ...VALID, capturedAt: "2026-08-12T10:30" });
    expect(c.capturedAt).toBe(new Date("2026-08-12T10:30").toISOString());
  });

  test("an empty capture time raises the field error, not a RangeError", () => {
    // `new Date("").toISOString()` throws RangeError. When the panel converted
    // before validating, that escaped as a generic "Invalid time value" with no
    // field attached, and this message was unreachable dead code.
    const err = (() => {
      try {
        buildAttestedCapture({ ...VALID, capturedAt: "" });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AttestationError);
    expect((err as AttestationError).field).toBe("capturedAt");
  });

  test("a missing file size is null, never 0", () => {
    const c = buildAttestedCapture({ ...VALID, fileSize: undefined });
    expect(c.fileSize).toBeNull();
  });
});

describe("attestedCaptureToMediaAsset", () => {
  test("produces a record that satisfies the frozen contract", () => {
    const c = { ...buildAttestedCapture(VALID), phash: "ffee0011" };
    const asset = attestedCaptureToMediaAsset(c);
    // Must survive the boundary parser, not merely look right.
    expect(() => parseMediaAsset(asset)).not.toThrow();
    expect(asset.detections).toEqual([]);
    expect(asset.faces).toEqual([]);
  });

  test("source marks the asset as an analyst upload and keeps the origin URL", () => {
    // MediaAssetSchema's own comment names "analyst upload" as an expected
    // source value; this is what makes the capture legible downstream without
    // widening the frozen Post platform enum.
    const c = { ...buildAttestedCapture(VALID), phash: "ffee0011" };
    const asset = attestedCaptureToMediaAsset(c);
    expect(asset.source).toContain("analyst upload");
    expect(asset.source).toContain(VALID.sourceUrl);
  });

  test("throws rather than inventing a perceptual hash", () => {
    // A synthesised pHash matches nothing, which renders as "no near-duplicates
    // found" — a finding produced from a value that was never measured.
    const c = buildAttestedCapture(VALID); // phash: null
    const err = (() => {
      try {
        attestedCaptureToMediaAsset(c);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AttestationError);
    expect((err as AttestationError).field).toBe("phash");
    expect((err as Error).message).toMatch(/fabricated hash would match nothing/i);
  });

  test("carries through analysis extras when Module 4 supplies them", () => {
    const c = { ...buildAttestedCapture(VALID), phash: "ffee0011" };
    const asset = attestedCaptureToMediaAsset(c, { ocrText: "READ ME" });
    expect(asset.ocrText).toBe("READ ME");
    expect(() => parseMediaAsset(asset)).not.toThrow();
  });
});

describe("what the analyst is told", () => {
  test("each caveat names a specific wrong inference, not boilerplate", () => {
    expect(CAPTURE_CAVEATS.length).toBeGreaterThanOrEqual(4);
    for (const c of CAPTURE_CAVEATS) expect(c.length).toBeGreaterThan(60);
    const all = CAPTURE_CAVEATS.join(" ");
    // The three absences a provenance panel would otherwise render as a failed
    // authenticity check.
    expect(all).toMatch(/EXIF will be absent/i);
    expect(all).toMatch(/C2PA will be absent/i);
    expect(all).toMatch(/not.*automated collection/i);
  });

  test("the hash caveat refuses the authentication reading", () => {
    expect(HASH_MEANING).toMatch(/does not authenticate/i);
    expect(HASH_MEANING).toMatch(/faithfully depicts/i);
  });

  test("attribution is disclosed as a claim, not an identity", () => {
    // There is no auth in this build; rendering capturedBy as a signed-in user
    // would overstate it.
    expect(ATTRIBUTION_LIMITATION).toMatch(/not an authenticated identity/i);
  });
});
