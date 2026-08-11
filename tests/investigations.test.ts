import { describe, expect, test } from "bun:test";
import {
  caseMetrics,
  sourcesFromEvidence,
  type Investigation,
  type PinnedEvidence,
} from "../src/utils/investigations-store";
import { validateCitations, type ProductBody } from "../src/utils/reports";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ev = (over: Partial<PinnedEvidence> & { id: string }): PinnedEvidence => ({
  pinnedAt: "2026-08-04T10:00:00.000Z",
  kind: "news",
  title: "Untitled",
  source: "example.com",
  url: `https://example.com/${over.id}`,
  publishedAt: "2026-07-14T08:00:00.000Z",
  note: "",
  credibility: null,
  credibilityRationale: "No credibility score was carried with this item.",
  excerpt: "excerpt",
  ...over,
});

const investigation = (evidence: PinnedEvidence[]): Investigation => ({
  id: "INV-1001",
  target: "Test subject",
  title: "Test case",
  description: "",
  status: "Active",
  owner: "",
  keywords: [],
  evidence,
  notes: "",
  createdAt: "2026-08-04T09:00:00.000Z",
});

// ─── The central guarantee ─────────────────────────────────────────────────

describe("no invented case scores", () => {
  test("metrics expose no risk or threat score at all", () => {
    // The page rendered risk 78% and threat 82/100 with progress bars, and new
    // cases were created with risk 50 / threat 50. Nothing computes either.
    const m = caseMetrics(investigation([ev({ id: "a", credibility: 0.9 })]));
    expect(m).not.toHaveProperty("risk");
    expect(m).not.toHaveProperty("threatScore");
    expect(m).not.toHaveProperty("threat");
  });

  test("an empty case reports nothing rather than a default", () => {
    const m = caseMetrics(investigation([]));
    expect(m.evidenceCount).toBe(0);
    expect(m.distinctSources).toBe(0);
    // Null, not 0 and not 50 — no evidence means no measurement.
    expect(m.meanCredibility).toBeNull();
    expect(m.earliest).toBeNull();
    expect(m.latest).toBeNull();
    expect(m.summary).toContain("No evidence pinned");
  });

  test("credibility is the mean of scored items only, with the denominator reported", () => {
    const m = caseMetrics(
      investigation([
        ev({ id: "a", credibility: 0.9 }),
        ev({ id: "b", credibility: 0.5 }),
        ev({ id: "c", credibility: null }),
      ]),
    );
    expect(m.meanCredibility).toBeCloseTo(0.7, 5);
    // The unscored item must not be counted as a zero, which would drag the mean
    // to 0.467 and read as a much weaker case than the evidence supports.
    expect(m.scoredCount).toBe(2);
    expect(m.evidenceCount).toBe(3);
    expect(m.summary).toContain("2 of 3 items");
  });

  test("a case whose evidence is all one source says so explicitly", () => {
    const m = caseMetrics(
      investigation([
        ev({ id: "a", source: "onlyoutlet.com", credibility: 0.9 }),
        ev({ id: "b", source: "onlyoutlet.com", credibility: 0.9 }),
      ]),
    );
    expect(m.distinctSources).toBe(1);
    expect(m.summary).toContain("nothing here is corroborated");
  });

  test("counts evidence by kind", () => {
    const m = caseMetrics(
      investigation([
        ev({ id: "a", kind: "news" }),
        ev({ id: "b", kind: "social" }),
        ev({ id: "c", kind: "social" }),
        ev({ id: "d", kind: "image" }),
      ]),
    );
    expect(m.byKind.news).toBe(1);
    expect(m.byKind.social).toBe(2);
    expect(m.byKind.image).toBe(1);
    expect(m.byKind.geo).toBe(0);
  });

  test("undated evidence yields no span rather than a fabricated one", () => {
    const m = caseMetrics(investigation([ev({ id: "a", publishedAt: "" })]));
    expect(m.earliest).toBeNull();
    expect(m.latest).toBeNull();
  });

  test("the evidence span reflects the real earliest and latest publication", () => {
    const m = caseMetrics(
      investigation([
        ev({ id: "a", publishedAt: "2026-07-20T00:00:00.000Z" }),
        ev({ id: "b", publishedAt: "2026-07-01T00:00:00.000Z" }),
        ev({ id: "c", publishedAt: "2026-07-10T00:00:00.000Z" }),
      ]),
    );
    expect(m.earliest).toBe("2026-07-01T00:00:00.000Z");
    expect(m.latest).toBe("2026-07-20T00:00:00.000Z");
  });
});

// ─── Bridge into Module 5 ──────────────────────────────────────────────────

describe("pinned evidence becomes a citable source list", () => {
  const evidence = [
    ev({
      id: "a",
      title: "Reuters report",
      source: "reuters.com",
      credibility: 0.9,
      credibilityRationale: "TIER_1 wire.",
    }),
    ev({
      id: "b",
      kind: "social",
      title: "A post",
      source: "@handle (bluesky)",
      credibility: null,
    }),
    ev({ id: "c", kind: "image", title: "photo.jpg", source: "Canon EOS R5" }),
  ];
  const sources = sourcesFromEvidence(evidence);

  test("numbers sources contiguously from 1", () => {
    expect(sources.map((s) => s.n)).toEqual([1, 2, 3]);
  });

  test("carries credibility and its rationale through unchanged", () => {
    expect(sources[0].credibility).toBe(0.9);
    expect(sources[0].credibilityRationale).toBe("TIER_1 wire.");
    // Unscored stays null — never defaulted on the way into a product.
    expect(sources[1].credibility).toBeNull();
  });

  test("maps each evidence kind to the module that produced it", () => {
    expect(sources[0].module).toBe("Module 1 · credibility");
    expect(sources[1].module).toBe("Module 3 · social");
    expect(sources[2].module).toBe("Module 4 · imagery");
  });

  test("an analyst note is marked as such so it is not read as source text", () => {
    const [s] = sourcesFromEvidence([ev({ id: "a", note: "I think this is the key item." })]);
    expect(s.excerpt).toContain("Analyst note:");
  });

  test("a product citing these sources validates against them", () => {
    const body: ProductBody = {
      bottomLine: "Bottom line.",
      keyJudgements: [
        {
          judgement: "A judgement.",
          confidence: "moderate",
          confidenceRationale: "Two sources.",
          sources: [1, 2],
        },
      ],
      findings: [{ text: "A finding.", kind: "reported", sources: [3] }],
      gaps: [{ gap: "Something unknown.", why: "Not covered by the pinned evidence." }],
    };
    expect(validateCitations(body, sources)).toEqual([]);
  });

  test("a citation beyond the pinned evidence is rejected", () => {
    // The case IS the citation list. A claim citing [9] when three items are
    // pinned is attributing to evidence the analyst never approved.
    const body: ProductBody = {
      bottomLine: "Bottom line.",
      keyJudgements: [
        {
          judgement: "A judgement.",
          confidence: "low",
          confidenceRationale: "Thin.",
          sources: [9],
        },
      ],
      findings: [{ text: "A finding.", kind: "assessment", sources: [1] }],
      gaps: [{ gap: "Unknown.", why: "Not covered." }],
    };
    const problems = validateCitations(body, sources);
    expect(problems.length).toBe(1);
    expect(problems[0].problem).toContain("valid range 1-3");
  });

  test("an empty case produces an empty source list, which Module 5 refuses", async () => {
    expect(sourcesFromEvidence([])).toEqual([]);
    const { generateProduct } = await import("../src/utils/reports");
    await expect(
      generateProduct({ type: "TARGET_DOSSIER", subject: "X", sources: sourcesFromEvidence([]) }),
    ).rejects.toThrow(/Refusing to generate/);
  });
});
