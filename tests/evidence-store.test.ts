import { describe, expect, test } from "bun:test";
import { nextEvidenceId, withoutSeeded, type EvidenceRecord } from "../src/utils/evidence-store";

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
