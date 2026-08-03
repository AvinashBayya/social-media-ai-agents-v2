import { describe, expect, test } from "bun:test";
import {
  analyseCorroboration,
  applyProfile,
  bandFor,
  builtinProfiles,
  corroborationScoreFor,
  defaultFactors,
  domainOf,
  reputationOf,
  scoreArticle,
  scoreCorpus,
  titleSimilarity,
  SAME_STORY_THRESHOLD,
  SYNDICATION_THRESHOLD,
  type Article,
  type CredibilityFactor,
} from "../src/utils/credibility";

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

const art = (over: Partial<Article> & { id: string }): Article => ({
  title: "Untitled",
  source: "example.com",
  url: "https://example.com/x",
  pubDate: iso(1),
  ...over,
});

/** Three newsrooms on one event, plus an unrelated story. */
const CORPUS: Article[] = [
  art({
    id: "a1",
    title: "India tests hypersonic missile off Odisha coast",
    source: "Reuters",
    url: "https://www.reuters.com/world/india/a1",
    pubDate: iso(2),
  }),
  art({
    id: "a2",
    title: "Hypersonic missile tested by India off Odisha",
    source: "The Hindu",
    url: "https://www.thehindu.com/news/a2",
    pubDate: iso(3),
  }),
  art({
    id: "a3",
    title: "DRDO confirms Odisha hypersonic missile test",
    source: "Janes",
    url: "https://www.janes.com/a3",
    pubDate: iso(4),
  }),
  art({
    id: "b1",
    title: "European banks cut rates as inflation eases",
    source: "Financial Times",
    url: "https://www.ft.com/b1",
    pubDate: iso(5),
  }),
];

describe("text + reputation primitives", () => {
  test("domainOf strips scheme, www and path", () => {
    expect(domainOf("https://www.reuters.com/world/x")).toBe("reuters.com");
    expect(domainOf("Reuters")).toBe("");
  });

  test("reputationOf matches subdomains by longest suffix", () => {
    expect(reputationOf("news.bbc.co.uk")?.tier).toBe("TIER_1");
    expect(reputationOf("totally-unknown-outlet.example")).toBeNull();
  });

  test("same event matches, unrelated story does not", () => {
    expect(titleSimilarity(CORPUS[0].title, CORPUS[1].title)).toBeGreaterThanOrEqual(SAME_STORY_THRESHOLD);
    expect(titleSimilarity(CORPUS[0].title, CORPUS[3].title)).toBeLessThan(SAME_STORY_THRESHOLD);
  });

  /**
   * Regression guard for the threshold tuning. This pair is a genuine rewrite of
   * one event but shares only four significant tokens, so it sits right on the
   * boundary — it scored 0.444 and was wrongly rejected until prepositions were
   * added to the stopword list. If someone re-adds "off" or raises the
   * threshold, this fails rather than silently under-counting corroboration.
   */
  test("headline rewrite of the same event clears the threshold", () => {
    const sim = titleSimilarity(
      "India tests hypersonic missile off Odisha coast",
      "DRDO confirms Odisha hypersonic missile test",
    );
    expect(sim).toBeGreaterThanOrEqual(SAME_STORY_THRESHOLD);
  });

  test("stories sharing a topic but not an event stay separate", () => {
    // Both defence-and-India, different events. Must NOT merge.
    const sim = titleSimilarity(
      "India tests hypersonic missile off Odisha coast",
      "India signs submarine deal with France in Paris",
    );
    expect(sim).toBeLessThan(SAME_STORY_THRESHOLD);
  });
});

describe("corroboration", () => {
  test("counts other independent domains, naming them", () => {
    const c = analyseCorroboration(CORPUS[0], CORPUS);
    expect(c.domains.sort()).toEqual(["janes.com", "thehindu.com"]);
    expect(c.syndicated).toEqual([]);
  });

  /**
   * Verbatim re-publication provides NO corroboration for the originating
   * outlet. Reuters breaks a story and three aggregators reprint the identical
   * headline: that is one newsroom, not four.
   *
   * The pre-refactor implementation returned 1 independent + 2 syndicated here,
   * because it removed the article's own domain BEFORE collapsing and so
   * compared the syndicators only against each other — arbitrarily promoting
   * whichever one it saw first to "independent". Sharing clusterStories() with
   * Module 2 fixed that: everything now collapses against the origin article.
   */
  test("verbatim re-publication yields zero independent corroboration", () => {
    const wire = "India tests hypersonic missile off Odisha coast";
    const syndicated: Article[] = [
      CORPUS[0], // reuters.com, published earliest — the origin
      art({ id: "s1", title: wire, source: "MSN", url: "https://www.msn.com/s1", pubDate: iso(1) }),
      art({ id: "s2", title: wire, source: "Yahoo", url: "https://news.yahoo.com/s2", pubDate: iso(1) }),
      art({ id: "s3", title: wire, source: "Flipboard", url: "https://flipboard.com/s3", pubDate: iso(1) }),
    ];
    const c = analyseCorroboration(syndicated[0], syndicated);

    expect(c.domains).toHaveLength(0);
    expect(c.syndicated.sort()).toEqual(["flipboard.com", "msn.com", "news.yahoo.com"]);
    expect(titleSimilarity(wire, wire)).toBeGreaterThanOrEqual(SYNDICATION_THRESHOLD);
  });

  /** A genuine rewrite by a second newsroom IS corroboration, not syndication. */
  test("rewritten coverage still counts as independent", () => {
    const c = analyseCorroboration(CORPUS[0], CORPUS);
    expect(c.domains.length).toBeGreaterThan(0);
    expect(c.syndicated).toHaveLength(0);
  });

  test("score mapping follows the specified curve", () => {
    expect(corroborationScoreFor(0)).toBe(0.2);
    expect(corroborationScoreFor(1)).toBe(0.45);
    expect(corroborationScoreFor(2)).toBe(0.65);
    expect(corroborationScoreFor(3)).toBe(0.85);
    expect(corroborationScoreFor(4)).toBe(0.85);
    expect(corroborationScoreFor(9)).toBe(0.95);
  });

  test("evidence string names the corroborating domains", () => {
    const s = scoreArticle(CORPUS[0], CORPUS, defaultFactors());
    const corr = s.breakdown.find((b) => b.id === "corroboration");
    expect(corr).toBeDefined();
    expect(corr!.evidence).toContain("thehindu.com");
    expect(corr!.evidence).toContain("janes.com");
  });
});

describe("empty and degenerate corpora", () => {
  test("single-article corpus does not divide by zero and still scores", () => {
    const only = [CORPUS[0]];
    const s = scoreArticle(CORPUS[0], only, defaultFactors());
    expect(Number.isFinite(s.score!)).toBe(true);
    expect(s.skipped.map((x) => x.id)).toContain("corroboration");
    expect(s.skipped.map((x) => x.id)).toContain("source_diversity");
  });

  test("empty corpus returns an empty ranking rather than throwing", () => {
    expect(scoreCorpus([], defaultFactors())).toEqual([]);
  });

  test("article with every factor unavailable scores null, not zero", () => {
    const orphan = art({ id: "o1", title: "x", source: "", url: "", pubDate: "not-a-date" });
    const s = scoreArticle(orphan, [orphan], defaultFactors());
    expect(s.score).toBeNull();
    expect(s.breakdown).toHaveLength(0);
    expect(s.explanation).toContain("Not scored");
  });
});

describe("weight normalisation", () => {
  test("normalised weights sum to 1 when factors are disabled", () => {
    const factors = defaultFactors().map((f) =>
      f.id === "domain_tier" || f.id === "recency" ? { ...f, enabled: false } : f,
    );
    const s = scoreArticle(CORPUS[0], CORPUS, factors);
    const sum = s.breakdown.reduce((acc, b) => acc + b.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(s.breakdown.map((b) => b.id)).not.toContain("domain_tier");
  });

  test("disabling a factor changes the score (weights genuinely renormalise)", () => {
    const all = defaultFactors();
    const withoutCorroboration = all.map((f) =>
      f.id === "corroboration" ? { ...f, enabled: false } : f,
    );
    const a = scoreArticle(CORPUS[0], CORPUS, all).score!;
    const b = scoreArticle(CORPUS[0], CORPUS, withoutCorroboration).score!;
    expect(a).not.toBeCloseTo(b, 6);
  });

  test("zero-weight factor is skipped with a stated reason", () => {
    const factors = defaultFactors().map((f) => (f.id === "recency" ? { ...f, weight: 0 } : f));
    const s = scoreArticle(CORPUS[0], CORPUS, factors);
    expect(s.skipped.find((x) => x.id === "recency")?.reason).toBe("Weight set to zero.");
  });
});

describe("contributions reconcile with the overall score", () => {
  test("per-factor contributions sum to the total", () => {
    for (const a of CORPUS) {
      const s = scoreArticle(a, CORPUS, defaultFactors());
      const sum = s.breakdown.reduce((acc, b) => acc + b.contribution, 0);
      expect(sum).toBeCloseTo(s.score!, 10);
    }
  });

  test("each contribution equals weight * rawScore", () => {
    const s = scoreArticle(CORPUS[0], CORPUS, defaultFactors());
    for (const b of s.breakdown) expect(b.contribution).toBeCloseTo(b.weight * b.rawScore, 10);
  });

  test("score and confidence stay within 0-1", () => {
    for (const s of scoreCorpus(CORPUS, defaultFactors())) {
      expect(s.score!).toBeGreaterThanOrEqual(0);
      expect(s.score!).toBeLessThanOrEqual(1);
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("custom criterion", () => {
  const enableCustom = (): CredibilityFactor[] =>
    defaultFactors().map((f) => (f.id === "custom_keyword" ? { ...f, enabled: true } : f));

  test("skipped when enabled but no criterion is defined", () => {
    const s = scoreArticle(CORPUS[0], CORPUS, enableCustom());
    expect(s.skipped.find((x) => x.id === "custom_keyword")?.reason).toBe("No keyword criterion defined.");
  });

  test("lowering keywords reduce the factor score below neutral", () => {
    const hedged = art({
      id: "h1",
      title: "Unconfirmed reports of a breach, sources say",
      source: "Reuters",
      url: "https://www.reuters.com/h1",
    });
    const s = scoreArticle(hedged, [hedged, ...CORPUS], enableCustom(), {
      customKeywords: { raise: [], lower: ["unconfirmed", "sources say"] },
    });
    const ck = s.breakdown.find((b) => b.id === "custom_keyword")!;
    expect(ck.rawScore).toBeLessThan(0.5);
    expect(ck.evidence).toContain("unconfirmed");
  });
});

describe("no-fabrication guarantees", () => {
  test("linguistic_markers is registered, LLM-flagged, and never contributes", () => {
    const f = defaultFactors().find((x) => x.id === "linguistic_markers")!;
    expect(f.requiresLlm).toBe(true);
    expect(f.enabled).toBe(false);
    expect(f.compute(CORPUS[0], CORPUS)).toBeNull();
  });

  test("citation_depth is skipped, not zeroed, when the feed gives no body", () => {
    const s = scoreArticle(CORPUS[0], CORPUS, defaultFactors());
    expect(s.breakdown.map((b) => b.id)).not.toContain("citation_depth");
    expect(s.skipped.find((x) => x.id === "citation_depth")?.reason).toBe(
      "Feed supplied no body text to scan.",
    );
  });

  test("scoring is deterministic — identical inputs give identical output", () => {
    const a = scoreArticle(CORPUS[0], CORPUS, defaultFactors());
    const b = scoreArticle(CORPUS[0], CORPUS, defaultFactors());
    expect(a.score).toBe(b.score);
    expect(a.explanation).toBe(b.explanation);
  });

  test("unlisted domains are neutral, never penalised below a listed low-tier one", () => {
    const unknown = art({ id: "u1", title: CORPUS[0].title, source: "x", url: "https://obscure-outlet.example/u1" });
    const s = scoreArticle(unknown, [unknown, ...CORPUS], defaultFactors());
    const dt = s.breakdown.find((b) => b.id === "domain_tier")!;
    expect(dt.rawScore).toBe(0.5);
    expect(dt.evidence).toContain("not in the reputation table");
  });
});

describe("profiles", () => {
  test("three built-ins ship and are marked builtin", () => {
    const p = builtinProfiles();
    expect(p.map((x) => x.id).sort()).toEqual(["breaking", "default", "longform"]);
    expect(p.every((x) => x.builtin)).toBe(true);
  });

  test("applying a profile overrides weights and enabled flags", () => {
    const breaking = builtinProfiles().find((p) => p.id === "breaking")!;
    const applied = applyProfile(defaultFactors(), breaking);
    expect(applied.find((f) => f.id === "corroboration")!.weight).toBe(0.4);
    expect(applied.find((f) => f.id === "recency")!.weight).toBe(0.25);
  });

  test("breaking-news profile ranks a fresh corroborated story above a stale one", () => {
    const stale = art({
      id: "old",
      title: CORPUS[0].title,
      source: "Reuters",
      url: "https://www.reuters.com/old",
      pubDate: iso(24 * 20),
    });
    const corpus = [...CORPUS, stale];
    const breaking = applyProfile(defaultFactors(), builtinProfiles().find((p) => p.id === "breaking")!);
    const fresh = scoreArticle(CORPUS[0], corpus, breaking).score!;
    const old = scoreArticle(stale, corpus, breaking).score!;
    expect(fresh).toBeGreaterThan(old);
  });
});

describe("bands", () => {
  test("map scores to analyst-facing labels", () => {
    expect(bandFor(null).label).toBe("Unscored");
    expect(bandFor(0.85).label).toBe("High");
    expect(bandFor(0.5).label).toBe("Moderate");
    expect(bandFor(0.2).label).toBe("Low");
  });
});
