import { describe, expect, test } from "bun:test";
import {
  BASIS_DETAIL,
  BASIS_LABELS,
  COLLECTION_POLICIES,
  MODE_LABELS,
  allowsAutomatedCollection,
  policyById,
  policyFor,
  policySummary,
} from "../src/utils/collection-policy";
import { PLATFORM_NOTES } from "../src/utils/social";

/**
 * The collection-policy matrix.
 *
 * This model exists because `PLATFORM_NOTES.available` is a boolean, and a
 * boolean cannot say "YouTube text yes, frames no" or "Meta not automated, but
 * an analyst may capture". The assertions below pin the three properties that
 * make the model worth having over the boolean it supplements:
 *
 *  1. Meta can never read as automated, whatever else changes.
 *  2. An unknown source is never treated as permitted — absence of a policy is
 *     a gap, not a licence.
 *  3. Legal prohibition and commercial unavailability stay distinguishable.
 */

describe("policy rows", () => {
  test("ids are unique and every row is fully populated", () => {
    const ids = COLLECTION_POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of COLLECTION_POLICIES) {
      expect(p.sources.length).toBeGreaterThan(0);
      expect(p.basis.length).toBeGreaterThan(0);
      expect(p.rationale.length).toBeGreaterThan(40);
      expect(p.ingestionRoute.length).toBeGreaterThan(20);
      expect(p.implementedBy.length).toBeGreaterThan(10);
    }
  });

  test("Meta is manual-only and can never read as automated", () => {
    const meta = policyById("meta")!;
    expect(meta.mode).toBe("manual-only");
    expect(meta.manualUploadAllowed).toBe(true);
    expect(meta.basis).toContain("platform-tos");
    expect(meta.basis).toContain("dpdp-act-2023");
    // The v1 tree shipped a scraper behind these exact sources. Nothing about
    // this row may imply automated collection is available.
    expect(meta.mode).not.toBe("automated");
    expect(meta.mode).not.toBe("partial");
    expect(meta.implementedBy).toMatch(/No collector exists/i);
  });

  test("YouTube is partial, and names both halves", () => {
    const yt = policyById("youtube")!;
    expect(yt.mode).toBe("partial");
    // Partial is meaningless without both lists — that is the whole point of
    // the mode.
    expect(yt.permitted.length).toBeGreaterThan(0);
    expect(yt.withheld.length).toBeGreaterThan(0);
    expect(yt.permitted.join(" ")).toMatch(/Comments/i);
    expect(yt.withheld.join(" ")).toMatch(/frame/i);
  });

  test("only a partial row carries permitted/withheld lists", () => {
    for (const p of COLLECTION_POLICIES.filter((x) => x.mode !== "partial")) {
      expect(p.permitted).toEqual([]);
      expect(p.withheld).toEqual([]);
    }
  });

  test("a legal prohibition and a missing free tier are different bases", () => {
    // Both were a flat red "unavailable" badge before. One is fixed by money,
    // the other cannot be.
    expect(policyById("x-twitter")!.basis).toEqual(["no-free-tier"]);
    expect(policyById("meta")!.basis).not.toContain("no-free-tier");
  });

  test("every basis used has both a label and an explanation", () => {
    for (const p of COLLECTION_POLICIES) {
      for (const b of p.basis) {
        expect(BASIS_LABELS[b]).toBeTruthy();
        expect(BASIS_DETAIL[b].length).toBeGreaterThan(40);
      }
    }
  });
});

describe("policyFor", () => {
  test("matches a source name however it is written", () => {
    for (const name of ["Instagram", "instagram", " INSTAGRAM ", "Facebook"]) {
      expect(policyFor(name)?.id).toBe("meta");
    }
    expect(policyFor("X / Twitter")?.id).toBe("x-twitter");
    expect(policyFor("x/twitter")?.id).toBe("x-twitter");
    expect(policyFor("Bluesky")?.id).toBe("open-social");
  });

  test("an unwritten source returns null rather than a default", () => {
    expect(policyFor("Threads")).toBeNull();
    expect(policyFor("")).toBeNull();
  });
});

describe("allowsAutomatedCollection", () => {
  test("true only for automated and partial sources", () => {
    expect(allowsAutomatedCollection("Reddit")).toBe(true);
    expect(allowsAutomatedCollection("YouTube")).toBe(true);
    expect(allowsAutomatedCollection("Instagram")).toBe(false);
    expect(allowsAutomatedCollection("X / Twitter")).toBe(false);
  });

  test("an unknown source is NOT permitted — absence of a policy is not a licence", () => {
    // The dangerous inversion: defaulting unknown to allowed is how an
    // unreviewed source ends up collected.
    expect(allowsAutomatedCollection("Threads")).toBe(false);
    expect(allowsAutomatedCollection("some-new-network")).toBe(false);
  });
});

describe("policySummary", () => {
  test("names the mode and the basis together", () => {
    // Either alone misleads: "Partial" reads as a capability gap, and "DPDP Act
    // 2023" alone reads as a blanket prohibition.
    const s = policySummary(policyById("meta")!);
    expect(s).toContain(MODE_LABELS["manual-only"]);
    expect(s).toContain(BASIS_LABELS["dpdp-act-2023"]);
  });
});

describe("PLATFORM_NOTES ↔ policy consistency", () => {
  test("every policyId on a platform note resolves to a real row", () => {
    for (const note of PLATFORM_NOTES) {
      if (!note.policyId) continue;
      expect(policyById(note.policyId)).not.toBeNull();
    }
  });

  test("a note under a manual-only or none policy is never marked available", () => {
    // The contradiction this pairing exists to prevent: a platform declaring
    // itself collected while its policy forbids collection.
    for (const note of PLATFORM_NOTES) {
      const policy = note.policyId ? policyById(note.policyId) : null;
      if (!policy) continue;
      if (policy.mode === "manual-only" || policy.mode === "none") {
        expect(note.available).toBe(false);
      }
    }
  });

  test("YouTube is declared, and under the partial policy", () => {
    // It was absent from PLATFORM_NOTES entirely — a platform the system
    // genuinely collects from, undeclared, because the boolean had no room for
    // "text yes, frames no".
    const yt = PLATFORM_NOTES.find((p) => p.platform === "YouTube");
    expect(yt).toBeDefined();
    expect(yt!.policyId).toBe("youtube");
    expect(yt!.limitation).toMatch(/frame/i);
  });

  test("every platform note carries a policy id", () => {
    for (const note of PLATFORM_NOTES) {
      expect(note.policyId, `${note.platform} has no policyId`).toBeTruthy();
    }
  });
});
