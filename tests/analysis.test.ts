import { describe, expect, test } from "bun:test";
import {
  buildTimeline,
  clusterFor,
  clusterStories,
  corpusTerms,
  detectLanguage,
  domainOf,
  extractKeywords,
  sourceKeyOf,
  titleSimilarity,
  SAME_STORY_THRESHOLD,
  SYNDICATION_THRESHOLD,
  type Article,
} from "../src/utils/analysis";
import { analyseCorroboration, defaultFactors, scoreCorpus } from "../src/utils/credibility";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const art = (over: Partial<Article> & { id: string }): Article => ({
  title: "Untitled",
  source: "example.com",
  url: "https://example.com/x",
  pubDate: iso(60),
  ...over,
});

// ─── Fixtures ──────────────────────────────────────────────────────────────

/**
 * One genuine event covered by three independent newsrooms, one verbatim wire
 * reprint of the Reuters copy, and one unrelated story.
 */
const CORPUS: Article[] = [
  art({
    id: "a1",
    title: "India tests hypersonic missile off Odisha coast",
    source: "Reuters",
    url: "https://www.reuters.com/world/india/a1",
    pubDate: iso(180),
    body: "India tested a hypersonic missile off the Odisha coast, the defence ministry said.",
  }),
  art({
    id: "a2",
    title: "DRDO confirms Odisha hypersonic missile test",
    source: "The Hindu",
    url: "https://www.thehindu.com/news/a2",
    pubDate: iso(150),
    body: "DRDO confirmed the hypersonic missile test conducted off Odisha.",
  }),
  art({
    id: "a3",
    title: "Hypersonic missile tested by India from Odisha coast, DRDO says",
    source: "NDTV",
    url: "https://www.ndtv.com/india-news/a3",
    pubDate: iso(120),
    body: "A hypersonic missile was tested from the Odisha coast, DRDO said.",
  }),
  // Verbatim reprint of a1 — must be collapsed as syndicated, not counted as a
  // fourth independent newsroom.
  art({
    id: "a4",
    title: "India tests hypersonic missile off Odisha coast",
    source: "Economic Times",
    url: "https://economictimes.indiatimes.com/a4",
    pubDate: iso(100),
    body: "India tested a hypersonic missile off the Odisha coast, the defence ministry said.",
  }),
  art({
    id: "b1",
    title: "Reserve Bank holds repo rate steady at policy review",
    source: "Business Standard",
    url: "https://www.business-standard.com/b1",
    pubDate: iso(90),
    body: "The Reserve Bank of India kept the repo rate unchanged.",
  }),
];

const clusterOf = (id: string) => {
  const article = CORPUS.find((a) => a.id === id)!;
  return clusterFor(article, clusterStories(CORPUS));
};

// ─── Domain and source identity ────────────────────────────────────────────

describe("domain extraction", () => {
  test("strips scheme, www, port, path and credentials", () => {
    expect(domainOf("https://www.reuters.com:443/world/india/x?y=1")).toBe("reuters.com");
    expect(domainOf("http://user@thehindu.com/a")).toBe("thehindu.com");
  });

  test("returns empty for a value that is not a domain", () => {
    expect(domainOf("Reuters")).toBe("");
    expect(domainOf("")).toBe("");
  });

  test("falls back to the publisher name so grouping never loses an article", () => {
    expect(sourceKeyOf(art({ id: "x", source: "All India Radio", url: "" }))).toBe(
      "All India Radio",
    );
  });
});

// ─── Title similarity ──────────────────────────────────────────────────────

describe("title similarity", () => {
  test("rewritten headlines about one event clear the same-story threshold", () => {
    // Regression: this pair scored 0.444 against a 0.45 threshold because the
    // preposition "off" padded the Jaccard denominator. The fix was to the
    // tokeniser, not the threshold.
    const s = titleSimilarity(
      "India tests hypersonic missile off Odisha coast",
      "DRDO confirms Odisha hypersonic missile test",
    );
    expect(s).toBeGreaterThanOrEqual(SAME_STORY_THRESHOLD);
  });

  test("unrelated stories stay well below the threshold", () => {
    const s = titleSimilarity(
      "India tests hypersonic missile off Odisha coast",
      "Reserve Bank holds repo rate steady at policy review",
    );
    expect(s).toBeLessThan(SAME_STORY_THRESHOLD);
  });

  test("identical headlines reach the syndication threshold", () => {
    const s = titleSimilarity(CORPUS[0].title, CORPUS[3].title);
    expect(s).toBeGreaterThanOrEqual(SYNDICATION_THRESHOLD);
  });

  test("an empty title scores zero rather than throwing", () => {
    expect(titleSimilarity("", "India tests missile")).toBe(0);
  });
});

// ─── Clustering ────────────────────────────────────────────────────────────

describe("clusterStories", () => {
  test("groups the four reports of one event and leaves the unrelated story alone", () => {
    const clusters = clusterStories(CORPUS);
    expect(clusters.length).toBe(2);

    const missile = clusters.find((c) => c.members.some((m) => m.id === "a1"))!;
    expect(missile.members.map((m) => m.id).sort()).toEqual(["a1", "a2", "a3", "a4"]);

    const rbi = clusters.find((c) => c.members.some((m) => m.id === "b1"))!;
    expect(rbi.members.length).toBe(1);
  });

  test("collapses the verbatim reprint instead of counting it as a fourth source", () => {
    const missile = clusterOf("a1")!;
    expect(missile.syndicated).toBe(true);
    expect(missile.syndicatedDomains).toContain("economictimes.indiatimes.com");
    expect(missile.independentDomains).toEqual(
      expect.arrayContaining(["reuters.com", "thehindu.com", "ndtv.com"]),
    );
    // Three newsrooms, not four. This is the whole point of the syndication pass.
    expect(missile.independentDomains.length).toBe(3);
  });

  test("the representative is the earliest member, so the cluster records who broke it", () => {
    const missile = clusterOf("a1")!;
    expect(missile.id).toBe("a1");
    expect(missile.earliest).toBe(CORPUS[0].pubDate);
  });

  test("an empty corpus produces no clusters", () => {
    expect(clusterStories([])).toEqual([]);
  });

  test("clustering is transitive: A~B and B~C groups all three", () => {
    // A and C share only "missile" and fall below the threshold on their own.
    const chain: Article[] = [
      art({
        id: "c1",
        title: "Rafale squadron deployed to Ambala airbase",
        url: "https://a.com/1",
      }),
      art({
        id: "c2",
        title: "Rafale squadron deployed at Ambala airbase, IAF confirms",
        url: "https://b.com/2",
      }),
      art({ id: "c3", title: "IAF confirms Ambala airbase deployment", url: "https://c.com/3" }),
    ];
    expect(titleSimilarity(chain[0].title, chain[2].title)).toBeLessThan(SAME_STORY_THRESHOLD);
    const clusters = clusterStories(chain);
    expect(clusters.length).toBe(1);
    expect(clusters[0].members.length).toBe(3);
  });

  test("two articles from one domain count that domain once", () => {
    const dupes: Article[] = [
      art({
        id: "d1",
        title: "Cyclone warning issued for Andhra coast",
        url: "https://ndtv.com/1",
      }),
      art({
        id: "d2",
        title: "Cyclone warning issued for the Andhra coastline",
        url: "https://ndtv.com/2",
      }),
    ];
    const clusters = clusterStories(dupes);
    expect(clusters[0].independentDomains).toEqual(["ndtv.com"]);
  });
});

// ─── Shared story identity: Module 1 and Module 2 must agree ───────────────

describe("Module 1 and Module 2 agree on cluster membership", () => {
  test("corroboration for an article lists exactly its cluster's other independent domains", () => {
    const clusters = clusterStories(CORPUS);
    const a1 = CORPUS[0];
    const corr = analyseCorroboration(a1, CORPUS, clusters);
    const cluster = clusterFor(a1, clusters)!;

    const expected = cluster.independentDomains.filter((d) => d !== sourceKeyOf(a1));
    expect(corr.domains.sort()).toEqual(expected.sort());
    expect(corr.syndicated).toContain("economictimes.indiatimes.com");
  });

  test("the syndicated reprint gets zero independent corroboration", () => {
    // a4 is a verbatim copy of a1. It was collapsed, so from its own point of
    // view no INDEPENDENT newsroom corroborates it — every other member either
    // is the copy source or was itself collapsed.
    const clusters = clusterStories(CORPUS);
    const a4 = CORPUS[3];
    const corr = analyseCorroboration(a4, CORPUS, clusters);
    expect(corr.domains).toEqual(
      clusters.find((c) => c.members.some((m) => m.id === "a4"))!.independentDomains,
    );
    expect(corr.domains).not.toContain("economictimes.indiatimes.com");
  });

  test("passing precomputed clusters gives the same answer as computing them inline", () => {
    const withClusters = analyseCorroboration(CORPUS[1], CORPUS, clusterStories(CORPUS));
    const without = analyseCorroboration(CORPUS[1], CORPUS);
    expect(withClusters).toEqual(without);
  });

  test("scoreCorpus honours clusters supplied by the caller", () => {
    const clusters = clusterStories(CORPUS);
    const a = scoreCorpus(CORPUS, defaultFactors(), { clusters });
    const b = scoreCorpus(CORPUS, defaultFactors());
    expect(a.map((s) => [s.article.id, s.score])).toEqual(b.map((s) => [s.article.id, s.score]));
  });

  test("an article outside the corpus has no cluster and so no corroboration", () => {
    const stranger = art({ id: "zz", title: "Something else entirely about penguins" });
    const corr = analyseCorroboration(stranger, CORPUS, clusterStories(CORPUS));
    expect(corr.domains).toEqual([]);
    expect(corr.syndicated).toEqual([]);
  });
});

// ─── Language detection ────────────────────────────────────────────────────

describe("language detection across Indic scripts", () => {
  const cases: { script: string; code: string; title: string }[] = [
    {
      script: "devanagari",
      code: "deva",
      title: "भारत ने ओडिशा तट से हाइपरसोनिक मिसाइल का परीक्षण किया",
    },
    {
      script: "tamil",
      code: "ta",
      title: "ஒடிசா கடற்கரையில் இந்தியா ஹைப்பர்சோனிக் ஏவுகணையை சோதித்தது",
    },
    {
      script: "telugu",
      code: "te",
      title: "ఒడిశా తీరంలో భారత్ హైపర్‌సోనిక్ క్షిపణిని పరీక్షించింది",
    },
    {
      script: "bengali",
      code: "bn",
      title: "ওড়িশা উপকূলে ভারত হাইপারসনিক ক্ষেপণাস্ত্র পরীক্ষা করেছে",
    },
    {
      script: "kannada",
      code: "kn",
      title: "ಒಡಿಶಾ ಕರಾವಳಿಯಲ್ಲಿ ಭಾರತ ಹೈಪರ್‌ಸಾನಿಕ್ ಕ್ಷಿಪಣಿ ಪರೀಕ್ಷಿಸಿತು",
    },
    {
      script: "malayalam",
      code: "ml",
      title: "ഒഡീഷ തീരത്ത് ഇന്ത്യ ഹൈപ്പർസോണിക് മിസൈൽ പരീക്ഷിച്ചു",
    },
    {
      script: "gujarati",
      code: "gu",
      title: "ઓડિશા કિનારે ભારતે હાઇપરસોનિક મિસાઇલનું પરીક્ષણ કર્યું",
    },
    {
      script: "gurmukhi",
      code: "pa",
      title: "ਭਾਰਤ ਨੇ ਓਡੀਸ਼ਾ ਤੱਟ ਤੋਂ ਹਾਈਪਰਸੋਨਿਕ ਮਿਜ਼ਾਈਲ ਦਾ ਪ੍ਰੀਖਣ ਕੀਤਾ",
    },
    {
      script: "odia",
      code: "or",
      title: "ଓଡ଼ିଶା ଉପକୂଳରୁ ଭାରତ ହାଇପରସୋନିକ୍ କ୍ଷେପଣାସ୍ତ୍ର ପରୀକ୍ଷା କଲା",
    },
  ];

  for (const c of cases) {
    test(`identifies ${c.script}`, () => {
      const res = detectLanguage({ title: c.title });
      expect(res.script).toBe(c.script as any);
      expect(res.code).toBe(c.code);
      expect(res.confidence).toBeGreaterThan(0.5);
    });
  }

  test("covers more than four distinct Indic scripts", () => {
    const scripts = new Set(cases.map((c) => detectLanguage({ title: c.title }).script));
    expect(scripts.size).toBeGreaterThanOrEqual(4);
  });

  test("Devanagari is reported as ambiguous rather than guessing Hindi over Marathi", () => {
    const res = detectLanguage({ title: cases[0].title });
    expect(res.ambiguous).toBe(true);
    expect(res.name).toContain("Marathi");
  });

  test("Tamil is unambiguous — the script maps to one language", () => {
    expect(detectLanguage({ title: cases[1].title }).ambiguous).toBe(false);
  });

  test("English is identified from stopword markers", () => {
    const res = detectLanguage({ title: "India tests hypersonic missile off the Odisha coast" });
    expect(res.script).toBe("latin");
    expect(res.code).toBe("en");
  });

  test("empty text is undetermined, not defaulted to English", () => {
    const res = detectLanguage({ title: "", body: "" });
    expect(res.code).toBe("und");
    expect(res.confidence).toBe(0);
  });

  test("a stray Devanagari glyph in English text does not flip the detection", () => {
    const res = detectLanguage({
      title: "India tests hypersonic missile off the Odisha coast",
      body:
        "The programme is known locally as अग्नि but the report is in English and the " +
        "remainder of the body text carries no further Devanagari characters at all.",
    });
    expect(res.script).toBe("latin");
  });
});

// ─── TF-IDF ────────────────────────────────────────────────────────────────

describe("TF-IDF keyword extraction", () => {
  test("ranks a term distinctive to the article above one common to the corpus", () => {
    const kws = extractKeywords(CORPUS[4], CORPUS);
    const terms = kws.map((k) => k.term);
    expect(terms).toContain("repo");
    // "missile" appears in four of five articles and in none of this one.
    expect(terms).not.toContain("missile");
  });

  test("carries the document count so the ranking is auditable", () => {
    const kws = extractKeywords(CORPUS[0], CORPUS);
    const missile = kws.find((k) => k.term === "missile");
    expect(missile).toBeDefined();
    expect(missile!.documentCount).toBe(4);
    expect(missile!.score).toBeGreaterThan(0);
  });

  test("a single-article corpus yields nothing rather than a list of meaningless ties", () => {
    expect(extractKeywords(CORPUS[0], [CORPUS[0]])).toEqual([]);
  });

  test("an article with no usable tokens yields nothing", () => {
    expect(extractKeywords(art({ id: "e", title: "", body: "" }), CORPUS)).toEqual([]);
  });

  test("ranking is deterministic across repeated calls", () => {
    const a = extractKeywords(CORPUS[0], CORPUS).map((k) => k.term);
    const b = extractKeywords(CORPUS[0], CORPUS).map((k) => k.term);
    expect(a).toEqual(b);
  });
});

describe("corpus-level term ranking", () => {
  test("surfaces terms shared across the collection", () => {
    const terms = corpusTerms(CORPUS, 10).map((t) => t.term);
    expect(terms).toContain("missile");
  });

  test("drops terms appearing in only one article", () => {
    const terms = corpusTerms(CORPUS, 20);
    expect(terms.every((t) => t.documentCount > 1)).toBe(true);
    expect(terms.map((t) => t.term)).not.toContain("repo");
  });

  test("a corpus too small to compare yields nothing", () => {
    expect(corpusTerms([CORPUS[0]])).toEqual([]);
    expect(corpusTerms([])).toEqual([]);
  });
});

// ─── Timeline ──────────────────────────────────────────────────────────────

describe("timeline", () => {
  test("names the source that published first and measures the gap", () => {
    const t = buildTimeline(clusterOf("a1")!);
    expect(t.brokenBy).toBe("reuters.com");
    expect(t.entries[0].isFirst).toBe(true);
    expect(t.entries[0].minutesAfterFirst).toBe(0);
    expect(t.entries[1].minutesAfterFirst).toBe(30);
    expect(t.spanMinutes).toBe(80);
    expect(t.summary).toContain("reuters.com");
  });

  test("a single-source story says so instead of implying pickup", () => {
    const t = buildTimeline(clusterOf("b1")!);
    expect(t.summary).toContain("no pickup");
  });

  test("undated members produce an explicit statement, not a fabricated ordering", () => {
    const undated = clusterStories([
      art({ id: "u1", title: "Undated report on border movement", pubDate: "not-a-date" }),
      art({
        id: "u2",
        title: "Undated report on border movements",
        pubDate: "",
        url: "https://x.com/2",
      }),
    ]);
    const t = buildTimeline(undated[0]);
    expect(t.brokenBy).toBeNull();
    expect(t.spanMinutes).toBeNull();
    expect(t.summary).toContain("No member");
  });
});
