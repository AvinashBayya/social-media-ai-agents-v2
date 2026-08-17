import { describe, expect, test } from "bun:test";
import {
  buildSourceContext,
  citedSourceNumbers,
  renumber,
  sourcesFromArticles,
  sourcesFromGeo,
  sourcesFromImages,
  sourcesFromOsintEvidence,
  sourcesFromOsintRelationships,
  sourcesFromSocial,
  toMarkdown,
  validateCitations,
  AI_NOTICE,
  CLASSIFICATION,
  PRODUCT_TYPES,
  ProductSchema,
  type IntelligenceProduct,
  type ProductBody,
  type SourceRef,
} from "../src/utils/reports";
import { defaultFactors, scoreCorpus, type Article } from "../src/utils/credibility";
import { fromUsgsFeature } from "../src/utils/geo";
import { UNSCORED } from "../src/utils/collectors/result";
import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
} from "../src/utils/collectors/result";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ARTICLES: Article[] = [
  {
    id: "a1",
    title: "India tests hypersonic missile off Odisha coast",
    source: "Reuters",
    url: "https://www.reuters.com/world/india/a1",
    pubDate: "2026-07-14T08:00:00.000Z",
    body: "India tested a hypersonic missile off the Odisha coast, the defence ministry said.",
  },
  {
    id: "a2",
    title: "DRDO confirms Odisha hypersonic missile test",
    source: "The Hindu",
    url: "https://www.thehindu.com/news/a2",
    pubDate: "2026-07-14T08:30:00.000Z",
    body: "DRDO confirmed the hypersonic missile test conducted off Odisha.",
  },
  {
    id: "a3",
    title: "Reserve Bank holds repo rate steady",
    source: "Business Standard",
    url: "https://www.business-standard.com/b1",
    pubDate: "2026-07-14T09:00:00.000Z",
    body: "The Reserve Bank of India kept the repo rate unchanged.",
  },
];

const SOURCES = renumber(sourcesFromArticles(ARTICLES, scoreCorpus(ARTICLES, defaultFactors())));

const BODY: ProductBody = {
  bottomLine: "India conducted a hypersonic missile test off the Odisha coast on 14 July.",
  keyJudgements: [
    {
      judgement: "A hypersonic missile test took place off the Odisha coast.",
      confidence: "high",
      confidenceRationale: "Reported by two independent outlets including a tier-1 wire.",
      sources: [1, 2],
    },
  ],
  findings: [
    { text: "The defence ministry confirmed the test.", kind: "reported", sources: [1] },
    {
      text: "The test likely forms part of a continuing development programme.",
      kind: "assessment",
      sources: [1, 2],
    },
  ],
  gaps: [
    {
      gap: "The specific missile system was not named in any collected source.",
      why: "Neither report identifies the platform; the collection contains no technical reporting.",
    },
  ],
};

const PRODUCT: IntelligenceProduct = {
  ...BODY,
  id: "EXECUTIVE_BRIEF-test-1",
  type: "EXECUTIVE_BRIEF",
  typeLabel: "Executive Brief",
  subject: "India hypersonic programme",
  classification: CLASSIFICATION,
  sources: SOURCES,
  provenance: {
    model: "sarvam-105b",
    provider: "primary",
    cacheHit: false,
    generatedAt: "2026-08-04T10:00:00.000Z",
    modules: ["Module 1 · credibility"],
    notice: AI_NOTICE,
  },
};

// ─── Sources ───────────────────────────────────────────────────────────────

describe("source assembly", () => {
  test("articles become numbered sources carrying Module 1 credibility and its rationale", () => {
    expect(SOURCES.length).toBe(3);
    expect(SOURCES.map((s) => s.n)).toEqual([1, 2, 3]);
    const reuters = SOURCES.find((s) => s.outlet === "Reuters")!;
    expect(reuters.credibility).not.toBeNull();
    // The rationale is what makes the score auditable rather than an assertion.
    expect(reuters.credibilityRationale.length).toBeGreaterThan(20);
  });

  test("an unscorable item reports null credibility, not a default", () => {
    const orphan: Article[] = [{ id: "x", title: "Lone item", source: "", url: "", pubDate: "" }];
    const [s] = sourcesFromArticles(orphan, []);
    expect(s.credibility).toBeNull();
    expect(s.credibilityRationale).toContain("Not scored");
  });

  test("social, imagery and geo sources each record which module contributed them", () => {
    const social = sourcesFromSocial(
      [
        {
          id: "p1",
          author: "a.bsky.social",
          text: "post text",
          url: "u",
          createdAt: "2026-07-14T00:00:00Z",
          platform: "bluesky",
        },
      ],
      { p1: { cibScore: 0.8, maturityConcern: 0.6 } },
    );
    expect(social[0].module).toBe("Module 3 · social");
    expect(social[0].credibilityRationale).toContain("coordination signals 0.80");
    // Must never read as a verdict.
    expect(social[0].credibilityRationale).toContain("not inauthenticity");

    const imagery = sourcesFromImages([
      {
        id: "i1",
        name: "photo.jpg",
        findings: ["No C2PA manifest"],
        capturedAt: "2026-07-14T00:00:00Z",
      },
    ]);
    expect(imagery[0].module).toBe("Module 4 · imagery");

    const geo = sourcesFromGeo([
      fromUsgsFeature({
        id: "q1",
        geometry: { coordinates: [77.2, 28.6, 10] },
        properties: { mag: 4.1, place: "somewhere", time: 1785802675050, title: "M 4.1", url: "" },
      })!,
    ]);
    expect(geo[0].module).toBe("Module 5 · GIS");
    expect(geo[0].credibilityRationale).toContain("locates");
  });

  test("renumbering makes a merged list contiguous from 1", () => {
    const merged = renumber([
      ...sourcesFromArticles(ARTICLES, []),
      ...sourcesFromImages([{ id: "i", name: "n", findings: [], capturedAt: null }]),
    ]);
    expect(merged.map((s) => s.n)).toEqual([1, 2, 3, 4]);
  });

  test("the prompt context numbers every source and states its credibility", () => {
    const ctx = buildSourceContext(SOURCES);
    for (const s of SOURCES) expect(ctx).toContain(`[${s.n}]`);
    expect(ctx).toContain("Credibility:");
    expect(ctx).toContain("Contributed by:");
  });
});

// ─── Citation validation ───────────────────────────────────────────────────

describe("citation validation", () => {
  test("a well-sourced product passes", () => {
    expect(validateCitations(BODY, SOURCES)).toEqual([]);
  });

  /*
   * Citation-number validation alone let a false corroboration claim through.
   * Both observed generation runs produced a judgement whose confidence basis
   * asserted corroboration — "Corroborated by two sources (both 38%
   * credibility)" — while citing only [3]. Every number was in range, so the
   * check passed, and the finished product asserted corroboration its own
   * source list contradicted.
   */
  test("a corroboration claim citing one source is rejected", () => {
    const bad: ProductBody = {
      ...BODY,
      keyJudgements: [
        {
          judgement: "The test took place.",
          confidence: "moderate",
          confidenceRationale: "Corroborated by two sources reporting the same milestone.",
          sources: [1],
        },
      ],
    };
    const problems = validateCitations(bad, SOURCES);
    expect(problems.length).toBe(1);
    expect(problems[0].problem).toContain("claims corroboration");
    expect(problems[0].problem).toContain("only source [1]");
  });

  test("the same claim backed by two distinct sources passes", () => {
    const good: ProductBody = {
      ...BODY,
      keyJudgements: [
        {
          judgement: "The test took place.",
          confidence: "moderate",
          confidenceRationale: "Corroborated by two sources reporting the same milestone.",
          sources: [1, 2],
        },
      ],
    };
    expect(validateCitations(good, SOURCES)).toEqual([]);
  });

  test("a single-source judgement that claims no corroboration is untouched", () => {
    const fine: ProductBody = {
      ...BODY,
      keyJudgements: [
        {
          judgement: "The test took place.",
          confidence: "low",
          confidenceRationale: "A single outlet reported this and nothing else carries it.",
          sources: [1],
        },
      ],
    };
    expect(validateCitations(fine, SOURCES)).toEqual([]);
  });

  test("repeating the same source number twice is not corroboration", () => {
    const bad: ProductBody = {
      ...BODY,
      keyJudgements: [
        {
          judgement: "The test took place.",
          confidence: "high",
          confidenceRationale: "Multiple sources independently confirm the event.",
          sources: [2, 2],
        },
      ],
    };
    const problems = validateCitations(bad, SOURCES);
    expect(problems.length).toBe(1);
    expect(problems[0].problem).toContain("only source [2]");
  });

  test("a citation outside the supplied range is rejected", () => {
    // The failure mode the check exists for: a model citing [7] when six
    // sources were supplied is a fabricated attribution.
    const bad: ProductBody = {
      ...BODY,
      findings: [{ text: "Claim", kind: "reported", sources: [9] }],
    };
    const problems = validateCitations(bad, SOURCES);
    expect(problems.length).toBe(1);
    expect(problems[0].problem).toContain("does not exist");
    expect(problems[0].problem).toContain("valid range 1-3");
  });

  test("an unattributed judgement is rejected", () => {
    const bad: ProductBody = {
      ...BODY,
      keyJudgements: [{ ...BODY.keyJudgements[0], sources: [] }],
    };
    const problems = validateCitations(bad, SOURCES);
    expect(problems[0].problem).toContain("no source citation");
  });

  test("an empty gaps section is rejected", () => {
    const problems = validateCitations({ ...BODY, gaps: [] }, SOURCES);
    expect(problems.some((p) => p.where === "Intelligence gaps")).toBe(true);
  });

  test("problems name the specific judgement or finding at fault", () => {
    const bad: ProductBody = {
      ...BODY,
      findings: [
        {
          text: "A very specific unattributed claim about something",
          kind: "reported",
          sources: [42],
        },
      ],
    };
    expect(validateCitations(bad, SOURCES)[0].where).toContain(
      "A very specific unattributed claim",
    );
  });

  test("the schema itself rejects an empty citation array before validation runs", () => {
    const parsed = ProductSchema.safeParse({
      ...BODY,
      findings: [{ text: "x", kind: "reported", sources: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  test("the schema rejects a product with no gaps", () => {
    expect(ProductSchema.safeParse({ ...BODY, gaps: [] }).success).toBe(false);
  });

  test("cited numbers are reported so unused sources can be identified", () => {
    const used = citedSourceNumbers(BODY);
    expect(Array.from(used).sort()).toEqual([1, 2]);
    // Source 3 (the unrelated RBI story) was supplied but never cited.
    expect(used.has(3)).toBe(false);
  });
});

// ─── Product structure ─────────────────────────────────────────────────────

describe("product structure", () => {
  test("all five product types are defined with a brief and a token budget", () => {
    expect(PRODUCT_TYPES.map((p) => p.id).sort()).toEqual([
      "DAILY_SUMMARY",
      "EVENT_TIMELINE",
      "EXECUTIVE_BRIEF",
      "TARGET_DOSSIER",
      "THREAT_ASSESSMENT",
    ]);
    for (const p of PRODUCT_TYPES) {
      expect(p.brief.length).toBeGreaterThan(80);
      // Reasoning models spend budget before writing; a thin budget returns
      // finish_reason "length" with empty content.
      expect(p.maxTokens).toBeGreaterThanOrEqual(2000);
    }
  });

  test("the threat assessment forbids a numeric risk score", () => {
    const spec = PRODUCT_TYPES.find((p) => p.id === "THREAT_ASSESSMENT")!;
    expect(spec.brief).toContain("Do not assign a numeric risk score");
  });

  test("the classification marking carries no US caveat", () => {
    expect(CLASSIFICATION).toBe("UNCLASSIFIED // DEMONSTRATOR");
    expect(CLASSIFICATION).not.toContain("NOFORN");
    expect(CLASSIFICATION).not.toContain("SECRET");
  });

  test("findings distinguish reported fact from analyst assessment", () => {
    const kinds = new Set(BODY.findings.map((f) => f.kind));
    expect(kinds.has("reported")).toBe(true);
    expect(kinds.has("assessment")).toBe(true);
  });

  test("the AI notice states the product is unverified and needs review", () => {
    expect(AI_NOTICE).toContain("not a verified assessment");
    expect(AI_NOTICE).toContain("requires analyst review");
  });
});

// ─── Markdown rendering ────────────────────────────────────────────────────

describe("markdown rendering", () => {
  const md = toMarkdown(PRODUCT);

  test("contains every required section", () => {
    for (const section of [
      "## Bottom Line",
      "## Key Judgements",
      "## Findings",
      "## Intelligence Gaps",
      "## Sources",
    ]) {
      expect(md).toContain(section);
    }
  });

  test("every numbered citation in the body resolves to a listed source", () => {
    const cited = Array.from(md.matchAll(/\[(\d+)\]/g)).map((m) => Number(m[1]));
    const listed = new Set(PRODUCT.sources.map((s) => s.n));
    expect(cited.length).toBeGreaterThan(0);
    for (const n of cited) expect(listed.has(n)).toBe(true);
  });

  test("every source line carries its credibility and contributing module", () => {
    for (const s of PRODUCT.sources) {
      expect(md).toContain(`${s.n}. **${s.title}**`);
    }
    expect(md).toContain("Credibility:");
    expect(md).toContain("Contributed by:");
  });

  test("the provenance footer names the model and marks the content AI-generated", () => {
    expect(md).toContain("sarvam-105b");
    expect(md).toContain("Provenance.");
    expect(md).toContain(AI_NOTICE);
  });

  test("an assessment is visibly marked as not reported fact", () => {
    expect(md).toContain("analyst assessment, not reported fact");
  });

  test("confidence qualifiers and their basis are both rendered", () => {
    expect(md).toContain("HIGH confidence");
    expect(md).toContain("Confidence basis:");
  });
});

// ─── Failure behaviour ─────────────────────────────────────────────────────

describe("generation failure produces an error, never partial output", () => {
  test("no sources refuses rather than generating from nothing", async () => {
    const { generateProduct } = await import("../src/utils/reports");
    await expect(
      generateProduct({ type: "EXECUTIVE_BRIEF", subject: "X", sources: [] }),
    ).rejects.toThrow(/Refusing to generate/);
  });

  test("an unknown product type throws", async () => {
    const { generateProduct } = await import("../src/utils/reports");
    await expect(
      generateProduct({ type: "NOT_A_TYPE" as any, subject: "X", sources: SOURCES }),
    ).rejects.toThrow(/Unknown product type/);
  });

  test("with no provider configured, generation throws rather than emitting placeholder text", async () => {
    // Guards the constraint that matters most: a report that looks complete but
    // was invented is worse than a visible failure.
    const saved = { ...process.env };
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_FALLBACK_BASE_URL;
    delete process.env.LLM_FALLBACK_KEY;
    delete process.env.LLM_FALLBACK_MODEL;
    try {
      const { generateProduct } = await import("../src/utils/reports");
      const result = await generateProduct({
        type: "EXECUTIVE_BRIEF",
        subject: "India hypersonic programme",
        sources: SOURCES,
      }).then(
        (p) => ({ threw: false, product: p as IntelligenceProduct | null }),
        () => ({ threw: true, product: null }),
      );
      expect(result.threw).toBe(true);
      expect(result.product).toBeNull();
    } finally {
      Object.assign(process.env, saved);
    }
  });
});

// ─── Every citation in a rendered product resolves ─────────────────────────

describe("end-to-end sourcing guarantee", () => {
  test("every citation number in the product body resolves to a real source object", () => {
    const listed = new Map(PRODUCT.sources.map((s) => [s.n, s]));
    const all = [
      ...PRODUCT.keyJudgements.flatMap((k) => k.sources),
      ...PRODUCT.findings.flatMap((f) => f.sources),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const n of all) {
      const source = listed.get(n);
      expect(source).toBeDefined();
      // Not just present — a real record with a real outlet behind it.
      expect(source!.outlet.length).toBeGreaterThan(0);
      expect(source!.title.length).toBeGreaterThan(0);
    }
  });
});

// ─── OSINT collector evidence/relationships as citable sources ─────────────

const osintEntity = (over: Partial<CollectorEntity> & { id: string }): CollectorEntity => ({
  type: "domain",
  value: over.id,
  displayName: over.id,
  source: "dns",
  confidence: UNSCORED,
  metadata: {},
  ...over,
});

const osintEvidence = (over: Partial<CollectorEvidence> = {}): CollectorEvidence => ({
  source: "Cloudflare DNS-over-HTTPS",
  sourceUrl: null,
  collector: "dns",
  collectedAt: "2026-08-14T10:00:00.000Z",
  rawValue: { hostname: "example.com", ip: "93.184.216.34" },
  normalizedValue: { hostname: "example.com", ip: "93.184.216.34" },
  confidence: null,
  metadata: {},
  ...over,
});

const osintRelationship = (over: Partial<CollectorRelationship> = {}): CollectorRelationship => ({
  sourceEntity: "dns:domain:example.com",
  relationshipType: "RESOLVES_TO",
  targetEntity: "dns:ip:93.184.216.34",
  confidence: UNSCORED,
  source: "dns",
  ...over,
});

describe("sourcesFromOsintEvidence", () => {
  test("converts collector evidence into numbered, citable sources", () => {
    const sources = sourcesFromOsintEvidence([osintEvidence()]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.n).toBe(1);
    expect(sources[0]!.module).toBe("Module 2 · content analysis");
    expect(sources[0]!.publishedAt).toBe("2026-08-14T10:00:00.000Z");
    expect(sources[0]!.outlet).toBe("Cloudflare DNS-over-HTTPS");
  });

  test("the title and excerpt are built from the real normalized value, not invented", () => {
    const sources = sourcesFromOsintEvidence([
      osintEvidence({ collector: "crtsh", normalizedValue: { subdomain: "mail.example.com" } }),
    ]);
    expect(sources[0]!.title).toContain("crtsh");
    expect(sources[0]!.title).toContain("mail.example.com");
    expect(sources[0]!.excerpt).toContain("mail.example.com");
  });

  test("unscored evidence reports 'not scored', never a fabricated number", () => {
    const sources = sourcesFromOsintEvidence([osintEvidence({ confidence: null })]);
    expect(sources[0]!.credibility).toBeNull();
    expect(sources[0]!.credibilityRationale).toContain("Not scored");
  });

  test("a scored evidence item carries its real confidence value and reasons", () => {
    const sources = sourcesFromOsintEvidence([
      osintEvidence({ confidence: { value: 0.9, reasons: ["signed C2PA manifest"] } }),
    ]);
    expect(sources[0]!.credibility).toBe(0.9);
    expect(sources[0]!.credibilityRationale).toBe("signed C2PA manifest");
  });

  test("external-tool evidence (theHarvester/SpiderFoot) converts identically — no separate path", () => {
    const sources = sourcesFromOsintEvidence([
      osintEvidence({ collector: "theharvester", source: "theHarvester passive search" }),
      osintEvidence({ collector: "spiderfoot", source: "SpiderFoot scan" }),
    ]);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.title)).toEqual([
      expect.stringContaining("theharvester"),
      expect.stringContaining("spiderfoot"),
    ]);
  });

  test("startAt offsets numbering for merging into an existing source list", () => {
    const sources = sourcesFromOsintEvidence([osintEvidence(), osintEvidence()], 5);
    expect(sources.map((s) => s.n)).toEqual([5, 6]);
  });

  test("an empty evidence list produces an empty source list", () => {
    expect(sourcesFromOsintEvidence([])).toEqual([]);
  });
});

describe("sourcesFromOsintRelationships", () => {
  const entities = [
    osintEntity({ id: "dns:domain:example.com", type: "domain", displayName: "example.com" }),
    osintEntity({ id: "dns:ip:93.184.216.34", type: "ip", displayName: "93.184.216.34" }),
  ];

  test("renders a real relationship as a readable, non-fabricated title", () => {
    const sources = sourcesFromOsintRelationships([osintRelationship()], entities);
    expect(sources[0]!.title).toBe("example.com resolves to 93.184.216.34");
  });

  test("falls back to the raw entity id when the entity is not in the supplied list, never inventing a name", () => {
    const sources = sourcesFromOsintRelationships(
      [osintRelationship({ sourceEntity: "dns:domain:unknown-entity" })],
      entities,
    );
    expect(sources[0]!.title).toContain("dns:domain:unknown-entity");
  });

  test("carries the real confidence score from entity resolution, or an honest 'not scored'", () => {
    const scored = sourcesFromOsintRelationships(
      [osintRelationship({ confidence: { value: 0.82, reasons: ["same public email"] } })],
      entities,
    );
    expect(scored[0]!.credibility).toBe(0.82);
    expect(scored[0]!.credibilityRationale).toBe("same public email");

    const unscored = sourcesFromOsintRelationships([osintRelationship()], entities);
    expect(unscored[0]!.credibility).toBeNull();
    expect(unscored[0]!.credibilityRationale).toContain("Not scored");
  });

  test("relationships carry no timestamp of their own — publishedAt is honestly empty, not invented", () => {
    const sources = sourcesFromOsintRelationships([osintRelationship()], entities);
    expect(sources[0]!.publishedAt).toBe("");
  });

  test("an empty relationship list produces an empty source list", () => {
    expect(sourcesFromOsintRelationships([], entities)).toEqual([]);
  });
});

describe("merging OSINT sources alongside existing ones preserves prior citation numbers", () => {
  test("appending OSINT sources after existing ones keeps earlier numbers stable through renumber()", () => {
    const existing = renumber(
      sourcesFromArticles(ARTICLES, scoreCorpus(ARTICLES, defaultFactors())),
    );
    const merged = renumber([...existing, ...sourcesFromOsintEvidence([osintEvidence()])]);
    // Every existing source keeps the exact same number after the merge.
    existing.forEach((s, i) => expect(merged[i]!.n).toBe(s.n));
    expect(merged).toHaveLength(existing.length + 1);
    expect(merged[merged.length - 1]!.n).toBe(existing.length + 1);
  });
});
