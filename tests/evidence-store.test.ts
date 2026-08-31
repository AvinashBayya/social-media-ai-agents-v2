import { describe, expect, test } from "bun:test";
import {
  buildDetectionEvidenceRecord,
  getEvidenceForCase,
  getUnlinkedEvidence,
  nextEvidenceId,
  withoutSeeded,
  type EvidenceRecord,
} from "../src/utils/evidence-store";

function rec(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: "EVID-0401",
    title: "analyst upload",
    type: "Image",
    timestamp: "2026-08-17 09:00:00 UTC",
    source: "Local drag & drop upload",
    hash: "a".repeat(64),
    geo: "not recorded",
    entities: [],
    caseId: "",
    risk: null,
    tags: [],
    ...over,
  };
}

describe("withoutSeeded", () => {
  test("drops the seeded demonstration records", () => {
    // The three that shipped carried caseId INV-2041 / INV-2038 — ids
    // createInvestigation can never mint, since it numbers from INV-1001 up.
    const out = withoutSeeded([
      rec({ id: "EVID-0402", caseId: "INV-2041", seeded: true }),
      rec({ id: "EVID-0391", caseId: "INV-2038", seeded: true }),
    ]);
    expect(out).toEqual([]);
  });

  test("keeps analyst uploads sharing the same key", () => {
    const mine = rec({ id: "EVID-0410" });
    const out = withoutSeeded([rec({ id: "EVID-0402", seeded: true }), mine]);
    expect(out).toEqual([mine]);
  });

  test("keeps manual attested captures, which are written by a different component", () => {
    const capture = rec({ id: "EVID-0500", source: "analyst-attested-capture" });
    expect(withoutSeeded([capture])).toEqual([capture]);
  });

  test("junk is dropped rather than producing a record with no id", () => {
    expect(withoutSeeded([null, 7, {}, "x", { id: 5 }])).toEqual([]);
    expect(withoutSeeded("not an array")).toEqual([]);
    expect(withoutSeeded(undefined)).toEqual([]);
  });
});

describe("nextEvidenceId", () => {
  test("starts at EVID-0401 on an empty vault", () => {
    expect(nextEvidenceId([])).toBe("EVID-0401");
  });

  test("never reuses an id after a delete", () => {
    // The route computed `EVID-0${400 + list.length + 1}`, so deleting one
    // record and adding another produced a duplicate identifier — in the one
    // store whose entire purpose is identifying exhibits.
    const list = [rec({ id: "EVID-0401" }), rec({ id: "EVID-0402" }), rec({ id: "EVID-0403" })];
    const afterDelete = list.filter((e) => e.id !== "EVID-0402");
    const next = nextEvidenceId(afterDelete);
    expect(next).toBe("EVID-0404");
    expect(afterDelete.map((e) => e.id)).not.toContain(next);
  });

  test("ignores ids it cannot parse rather than colliding with them", () => {
    expect(nextEvidenceId([rec({ id: "custom-id" })])).toBe("EVID-0401");
    expect(nextEvidenceId([rec({ id: "custom-id" }), rec({ id: "EVID-0450" })])).toBe("EVID-0451");
  });

  test("ids stay zero-padded and sortable", () => {
    expect(nextEvidenceId([rec({ id: "EVID-0009" })])).toBe("EVID-0010");
  });
});

describe("getEvidenceForCase / getUnlinkedEvidence", () => {
  // Both read through getEvidence(), which is SSR-safe by returning [] when
  // `window` doesn't exist (bun test has no window/localStorage) — the same
  // convention every other store in this project relies on. This proves
  // these two new filters inherit that safety rather than throwing.
  test("getEvidenceForCase never throws outside a browser and returns an honest empty list", () => {
    expect(getEvidenceForCase("INV-1001")).toEqual([]);
  });

  test("getEvidenceForCase with no caseId returns [] without even reading storage", () => {
    expect(getEvidenceForCase("")).toEqual([]);
  });

  test("getUnlinkedEvidence never throws outside a browser and returns an honest empty list", () => {
    expect(getUnlinkedEvidence()).toEqual([]);
  });
});

describe("buildDetectionEvidenceRecord", () => {
  const base = {
    label: "a vehicle license plate",
    score: 0.87,
    sourceName: "photo.jpg",
    reportType: "Image Intelligence",
    previewDataUrl: "data:image/png;base64,AAAA",
    hash: "b".repeat(64),
    existing: [] as EvidenceRecord[],
  };

  test("carries the real detection fields through, never inventing a fabricated finding", () => {
    const r = buildDetectionEvidenceRecord(base);
    expect(r.previewUrl).toBe(base.previewDataUrl);
    expect(r.hash).toBe(base.hash);
    expect(r.source).toBe("Image Intelligence: photo.jpg");
    expect(r.tags).toEqual(["detected-object", "a vehicle license plate"]);
  });

  test("the title keeps stating this is an unverified candidate, not a confirmed finding — it must survive into the saved record, not just the live detection UI", () => {
    const r = buildDetectionEvidenceRecord(base);
    expect(r.title).toContain("87%");
    expect(r.title.toLowerCase()).toContain("unverified candidate");
    expect(r.title.toLowerCase()).toContain("not a confirmed finding");
  });

  test("type is 'Image' so the vault grid picks the same icon as any other image record", () => {
    expect(buildDetectionEvidenceRecord(base).type).toBe("Image");
  });

  test("a null hash (the crop could not be hashed) is preserved as null, never coerced to a placeholder", () => {
    const r = buildDetectionEvidenceRecord({ ...base, hash: null });
    expect(r.hash).toBeNull();
  });

  test("id numbering follows the same sequential rule as every other evidence record", () => {
    const existing = [rec({ id: "EVID-0401" }), rec({ id: "EVID-0402" })];
    const r = buildDetectionEvidenceRecord({ ...base, existing });
    expect(r.id).toBe("EVID-0403");
  });
});
