import { describe, expect, test } from "bun:test";
import {
  accountMaturity,
  amplification,
  analyseCib,
  assessCluster,
  clusterPosts,
  contentDuplication,
  contentSimilarity,
  handlePatterns,
  normaliseText,
  shingleSimilarity,
  shingles,
  temporalSynchrony,
  CIB_REVIEW_THRESHOLD,
  DUPLICATE_THRESHOLD,
} from "../src/utils/cib";
import {
  assessSpike,
  bucketise,
  eventToPost,
  monitorMatches,
  readMonitor,
  RingBuffer,
  BUCKET_MS,
  MIN_BASELINE_BUCKETS,
  PLATFORM_NOTES,
  JETSTREAM_INSTANCES,
  JetstreamClient,
  type BlueskyProfile,
  type SocialPost,
} from "../src/utils/social";
import {
  assessSocialCorpus,
  clusterAcrossModes,
  postToArticle,
  socialFactors,
} from "../src/utils/social-credibility";
import { defaultFactors, scoreCorpus } from "../src/utils/credibility";

// ─── Fixture helpers ───────────────────────────────────────────────────────

/** Fixed epoch so every test is deterministic — no Date.now() in fixtures. */
const T0 = Date.parse("2026-08-04T09:00:00.000Z");
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

let seq = 0;
const post = (over: Partial<SocialPost> & { authorId: string; text: string }): SocialPost => {
  seq += 1;
  return {
    id: `at://${over.authorId}/app.bsky.feed.post/p${seq}`,
    platform: "bluesky",
    author: over.author ?? over.authorId,
    createdAt: at(0),
    url: `https://bsky.app/profile/${over.authorId}/post/p${seq}`,
    langs: ["en"],
    links: [],
    ...over,
  };
};

const profile = (over: Partial<BlueskyProfile> & { handle: string }): BlueskyProfile => ({
  did: over.did ?? `did:plc:${over.handle}`,
  displayName: null,
  createdAt: null,
  followersCount: null,
  followsCount: null,
  postsCount: null,
  description: null,
  avatar: null,
  ...over,
});

// ─── Fixture 1: a genuinely coordinated cluster ────────────────────────────
//
// Nine accounts in a handle family, posting the same sentence within four
// minutes, all pushing one link. Every signal should fire.

const COORDINATED_TEXT =
  "Breaking urgent everyone must share this now the official report has been suppressed by the ministry and the truth is being hidden from citizens today";

const COORDINATED: SocialPost[] = Array.from({ length: 9 }, (_, i) =>
  post({
    authorId: `did:plc:coord${i}`,
    author: `citizenvoice${1200 + i}.bsky.social`,
    text: COORDINATED_TEXT,
    createdAt: at(i * 27),
    links: ["https://example-campaign.test/story?utm_source=x"],
  }),
);

const COORDINATED_PROFILES: BlueskyProfile[] = COORDINATED.map((p, i) =>
  profile({
    did: p.authorId,
    handle: p.author,
    // Three days old, 400+ posts, almost no audience.
    createdAt: new Date(T0 - 3 * 86_400_000).toISOString(),
    postsCount: 400 + i,
    followersCount: 2,
  }),
);

// ─── Fixture 2: an organic cluster on the same subject ─────────────────────
//
// THE CRITICAL FIXTURE. Nine real people reacting to one news event: same topic,
// independently written, spread over five hours, mature accounts, unrelated
// handles, no shared link. This must NOT be flagged. False positives are the
// real failure mode — a detector that flags organic discussion is worse than no
// detector, because an analyst will learn to ignore it.

const ORGANIC: SocialPost[] = [
  post({ authorId: "did:plc:org1", author: "meera.bsky.social", text: "The ministry report on the suppressed findings is out today and the coverage of it has been remarkably thin across the wires", createdAt: at(0) }),
  post({ authorId: "did:plc:org2", author: "ravi-kumar.bsky.social", text: "Reading the ministry report now. Thin coverage of the suppressed findings today, which is odd given how much noise there was last week", createdAt: at(1800) }),
  post({ authorId: "did:plc:org3", author: "anitanews.bsky.social", text: "Anyone else find it strange the ministry findings report got almost no coverage today? The suppressed sections are the interesting part", createdAt: at(4200) }),
  post({ authorId: "did:plc:org4", author: "d-sharma.bsky.social", text: "The suppressed findings in the ministry report today deserve far more coverage than they are getting from the wires", createdAt: at(7200) }),
  post({ authorId: "did:plc:org5", author: "kavya.bsky.social", text: "Coverage of the ministry report is thin today. The suppressed findings section is the one that actually matters here", createdAt: at(9600) }),
  post({ authorId: "did:plc:org6", author: "arjun-writes.bsky.social", text: "Ministry report today: the suppressed findings got no coverage at all and that is the story, not the report itself", createdAt: at(12600) }),
  post({ authorId: "did:plc:org7", author: "priyareads.bsky.social", text: "Thin coverage today of the ministry report. Those suppressed findings should be front page across every outlet", createdAt: at(14400) }),
  post({ authorId: "did:plc:org8", author: "sanjay.bsky.social", text: "Today the ministry report landed with thin coverage. The suppressed findings are what everyone should be reading", createdAt: at(16200) }),
  post({ authorId: "did:plc:org9", author: "lakshmi-n.bsky.social", text: "The ministry report and its suppressed findings got thin coverage today across the wires, which is telling", createdAt: at(18000) }),
];

const ORGANIC_PROFILES: BlueskyProfile[] = ORGANIC.map((p) =>
  profile({
    did: p.authorId,
    handle: p.author,
    // Two years old, ordinary output, real audience.
    createdAt: new Date(T0 - 730 * 86_400_000).toISOString(),
    postsCount: 1400,
    followersCount: 620,
  }),
);

// ─── Fixture 3: one account posting rapidly ────────────────────────────────

const SINGLE_ACCOUNT_BURST: SocialPost[] = Array.from({ length: 6 }, (_, i) =>
  post({
    authorId: "did:plc:busywire",
    author: "wireservice.bsky.social",
    text: "Live updates from the ministry press conference continuing now with further detail on the report findings",
    createdAt: at(i * 20),
    links: ["https://wire.test/live"],
  }),
);

// ─── Text primitives ───────────────────────────────────────────────────────

describe("text normalisation", () => {
  test("strips URLs, mentions, punctuation and casing", () => {
    expect(normaliseText("Check @someone https://x.test/a?b=1 — URGENT!!!")).toBe("check urgent");
  });

  test("two posts differing only in a tracking parameter normalise identically", () => {
    const a = "Read this https://x.test/story?utm_source=twitter";
    const b = "Read this https://x.test/story?utm_source=telegram";
    expect(normaliseText(a)).toBe(normaliseText(b));
  });

  test("empty input yields an empty string rather than throwing", () => {
    expect(normaliseText("")).toBe("");
  });
});

describe("shingles", () => {
  test("produces overlapping 5-word phrases", () => {
    const s = shingles("one two three four five six", 5);
    expect(Array.from(s)).toEqual(["one two three four five", "two three four five six"]);
  });

  test("text shorter than k becomes a single shingle rather than none", () => {
    expect(Array.from(shingles("one two", 5))).toEqual(["one two"]);
  });

  test("identical text scores 1, unrelated text scores 0", () => {
    expect(shingleSimilarity(COORDINATED_TEXT, COORDINATED_TEXT)).toBe(1);
    expect(shingleSimilarity("alpha beta gamma delta epsilon", "one two three four five")).toBe(0);
  });

  test("same-topic paraphrases stay below the duplicate threshold", () => {
    // This is the distinction the whole module rests on: shared subject is not
    // shared text. Every organic pair must fall under it.
    for (let i = 0; i < ORGANIC.length; i += 1) {
      for (let j = i + 1; j < ORGANIC.length; j += 1) {
        expect(shingleSimilarity(ORGANIC[i].text, ORGANIC[j].text)).toBeLessThan(DUPLICATE_THRESHOLD);
      }
    }
  });

  test("unigram similarity still groups the organic posts as one topic", () => {
    expect(contentSimilarity(ORGANIC[0].text, ORGANIC[4].text)).toBeGreaterThan(0.3);
  });
});

// ─── Signal: temporal synchrony ────────────────────────────────────────────

describe("temporal synchrony", () => {
  test("scores high for many accounts inside a tight window", () => {
    const s = temporalSynchrony(COORDINATED);
    expect(s.score).not.toBeNull();
    expect(s.score!).toBeGreaterThan(0.9);
    expect(s.evidence).toContain("9 accounts");
    expect(s.evidence).toContain("standard deviation");
  });

  test("scores low for the same content spread over hours", () => {
    const s = temporalSynchrony(ORGANIC);
    expect(s.score).not.toBeNull();
    expect(s.score!).toBeLessThan(0.1);
  });

  test("is SKIPPED, not scored, for a single account posting rapidly", () => {
    // The most important exclusion in the file: a busy wire account posting six
    // times a minute is not coordination and must not be scored as if it were.
    const s = temporalSynchrony(SINGLE_ACCOUNT_BURST);
    expect(s.score).toBeNull();
    expect(s.skipped).toContain("1 distinct account");
  });

  test("is skipped when timestamps are unusable rather than assumed", () => {
    const undated = [
      post({ authorId: "a", text: "one", createdAt: "" }),
      post({ authorId: "b", text: "two", createdAt: "not-a-date" }),
    ];
    const s = temporalSynchrony(undated);
    expect(s.score).toBeNull();
    expect(s.skipped).toContain("timestamp");
  });

  test("evidence names specific accounts and times", () => {
    const s = temporalSynchrony(COORDINATED);
    expect(s.evidence).toContain("citizenvoice1200.bsky.social");
    expect(s.evidence).toContain("2026-08-04 09:00:00Z");
  });
});

// ─── Signal: content duplication ───────────────────────────────────────────

describe("content duplication", () => {
  test("detects the near-duplicate group and names its members", () => {
    const { signal, groups } = contentDuplication(COORDINATED);
    expect(signal.score).toBe(1);
    expect(groups.length).toBe(1);
    expect(groups[0].members.length).toBe(9);
    expect(signal.evidence).toContain("9 accounts posting the same text");
  });

  test("scores zero for independently written posts on one topic", () => {
    const { signal, groups } = contentDuplication(ORGANIC);
    expect(signal.score).toBe(0);
    expect(groups).toEqual([]);
    expect(signal.evidence).toContain("independently written");
  });

  test("does not count one account repeating itself as duplication", () => {
    const { signal, groups } = contentDuplication(SINGLE_ACCOUNT_BURST);
    expect(signal.score).toBeNull();
    expect(groups).toEqual([]);
    expect(signal.skipped).toContain("distinct account");
  });

  test("a near-duplicate pair split across two accounts is caught", () => {
    const pair = [
      post({ authorId: "x", text: COORDINATED_TEXT }),
      post({ authorId: "y", text: `${COORDINATED_TEXT} today` }),
    ];
    const { groups } = contentDuplication(pair);
    expect(groups.length).toBe(1);
    expect(groups[0].members.map((m) => m.account).sort()).toEqual(["x", "y"]);
  });
});

// ─── Signal: account maturity ──────────────────────────────────────────────

describe("account maturity", () => {
  test("scores high for young high-output accounts and reports the real numbers", () => {
    const { signal, findings } = accountMaturity(COORDINATED, COORDINATED_PROFILES, T0);
    expect(signal.score).not.toBeNull();
    expect(signal.score!).toBeGreaterThan(0.6);
    expect(findings.length).toBe(9);
    expect(findings[0].ageDays).toBeCloseTo(3, 1);
    expect(signal.evidence).toContain("3.0 days old");
    expect(signal.evidence).toMatch(/\d+ posts \(\d+/);
    expect(signal.evidence).toContain("2 followers");
    expect(signal.evidence).toContain("citizenvoice");
  });

  test("scores low for established accounts with an ordinary posting rate", () => {
    const { signal } = accountMaturity(ORGANIC, ORGANIC_PROFILES, T0);
    expect(signal.score).not.toBeNull();
    expect(signal.score!).toBeLessThan(0.2);
  });

  test("is SKIPPED when no profiles were fetched, not scored zero", () => {
    // Scoring 0 here would read as "these accounts are mature", quietly
    // suppressing the composite on the strength of data we never had.
    const { signal } = accountMaturity(COORDINATED, [], T0);
    expect(signal.score).toBeNull();
    expect(signal.skipped).toContain("No profile data");
  });

  test("accounts without a resolvable createdAt are excluded and the count stated", () => {
    const partial = [COORDINATED_PROFILES[0], profile({ handle: "x", did: "did:plc:coord1", createdAt: null })];
    const { signal, findings } = accountMaturity(COORDINATED, partial, T0);
    expect(findings.length).toBe(1);
    expect(signal.evidence).toContain("1 of 9 accounts");
    expect(signal.evidence).toContain("8 unresolved");
  });
});

// ─── Signal: handle patterns ───────────────────────────────────────────────

describe("handle patterns", () => {
  test("detects a sequential handle family", () => {
    const { signal, families } = handlePatterns(COORDINATED);
    expect(signal.score).not.toBeNull();
    expect(signal.score!).toBeGreaterThan(0.9);
    expect(families.length).toBe(1);
    expect(families[0].stem).toBe("citizenvoice");
    expect(families[0].sequential).toBe(true);
    expect(signal.evidence).toContain("contiguous range");
  });

  test("scores zero for independently chosen handles", () => {
    const { signal, families } = handlePatterns(ORGANIC);
    expect(signal.score).toBe(0);
    expect(families).toEqual([]);
    expect(signal.evidence).toContain("independently chosen");
  });

  test("is SKIPPED on unresolved DIDs rather than flagging the whole network", () => {
    // Every DID ends in a long random-looking string. Scoring them would mark
    // every cluster on Bluesky as a handle family.
    const dids = COORDINATED.map((p) => ({ ...p, author: p.authorId }));
    const { signal } = handlePatterns(dids);
    expect(signal.score).toBeNull();
    expect(signal.skipped).toContain("Jetstream carries DIDs");
  });

  test("two similar handles are not enough to call a family", () => {
    const two = [
      post({ authorId: "a", author: "voice101.bsky.social", text: "one" }),
      post({ authorId: "b", author: "voice102.bsky.social", text: "two" }),
    ];
    const { signal } = handlePatterns(two);
    expect(signal.score).toBeNull();
    expect(signal.skipped).toContain("at least 3");
  });
});

// ─── Signal: amplification ─────────────────────────────────────────────────

describe("amplification", () => {
  test("detects one URI pushed by many accounts in a short window", () => {
    const { signal, targets } = amplification(COORDINATED);
    expect(signal.score).toBe(1);
    expect(targets.length).toBe(1);
    expect(targets[0].accounts.length).toBe(9);
    expect(signal.evidence).toContain("9 of 9 accounts shared");
  });

  test("normalises tracking parameters so one target is not split into variants", () => {
    const varied = COORDINATED.map((p, i) => ({
      ...p,
      links: [`https://example-campaign.test/story?utm_source=src${i}`],
    }));
    const { targets } = amplification(varied);
    expect(targets.length).toBe(1);
    expect(targets[0].accounts.length).toBe(9);
  });

  test("is skipped when no post carries a link", () => {
    const { signal } = amplification(ORGANIC);
    expect(signal.score).toBeNull();
    expect(signal.skipped).toContain("No post in this group carries");
  });

  test("ignores a link shared over a window wider than the amplification window", () => {
    const slow = [
      post({ authorId: "a", text: "one", createdAt: at(0), links: ["https://x.test/a"] }),
      post({ authorId: "b", text: "two", createdAt: at(7200), links: ["https://x.test/a"] }),
    ];
    const { signal, targets } = amplification(slow);
    expect(targets).toEqual([]);
    expect(signal.score).toBe(0);
  });

  test("one account sharing its own link repeatedly is not amplification", () => {
    const { signal, targets } = amplification(SINGLE_ACCOUNT_BURST);
    expect(targets).toEqual([]);
    expect(signal.score).toBe(0);
  });
});

// ─── Clustering and composite assessment ───────────────────────────────────

describe("clusterPosts", () => {
  test("separates the coordinated and organic sets even though both are on one subject", () => {
    const clusters = clusterPosts([...COORDINATED, ...ORGANIC]);
    const coord = clusters.find((c) => c.some((p) => p.authorId === "did:plc:coord0"))!;
    expect(coord.every((p) => p.authorId.startsWith("did:plc:coord"))).toBe(true);
  });

  test("an empty input yields no clusters", () => {
    expect(clusterPosts([])).toEqual([]);
  });
});

describe("assessCluster — coordinated fixture", () => {
  const cluster = assessCluster(COORDINATED, { profiles: COORDINATED_PROFILES, now: T0 });

  test("is flagged for review", () => {
    expect(cluster.compositeScore).not.toBeNull();
    expect(cluster.compositeScore!).toBeGreaterThanOrEqual(CIB_REVIEW_THRESHOLD);
    expect(cluster.flagged).toBe(true);
  });

  test("all five signals were computed", () => {
    expect(cluster.signalsComputed).toBe(5);
    expect(cluster.signalsSkipped).toBe(0);
  });

  test("every computed signal carries non-empty evidence", () => {
    for (const s of cluster.signals) {
      if (s.score !== null) expect(s.evidence.length).toBeGreaterThan(20);
      else expect(s.skipped!.length).toBeGreaterThan(10);
    }
  });

  test("reports the accounts involved so the finding can be audited", () => {
    expect(cluster.accounts.length).toBe(9);
    expect(cluster.duplicateGroups[0].members.length).toBe(9);
  });
});

describe("assessCluster — organic fixture (false-positive guard)", () => {
  const cluster = assessCluster(ORGANIC, { profiles: ORGANIC_PROFILES, now: T0 });

  test("is NOT flagged", () => {
    // The single most important assertion in this file. Nine real people
    // discussing one news story must not be reported as a coordinated network.
    expect(cluster.flagged).toBe(false);
    expect(cluster.compositeScore!).toBeLessThan(CIB_REVIEW_THRESHOLD);
  });

  test("stays unflagged even with no profile data available", () => {
    // Profiles are the strongest exonerating evidence here, so the fixture has
    // to survive losing them — otherwise the result depends on a lucky fetch.
    const noProfiles = assessCluster(ORGANIC, { now: T0 });
    expect(noProfiles.flagged).toBe(false);
  });

  test("synchrony and duplication both score near zero", () => {
    const sync = cluster.signals.find((s) => s.id === "temporal_synchrony")!;
    const dup = cluster.signals.find((s) => s.id === "content_duplication")!;
    expect(sync.score!).toBeLessThan(0.1);
    expect(dup.score).toBe(0);
  });

  test("skipped signals are excluded from the composite, and the count is reported", () => {
    expect(cluster.signalsComputed + cluster.signalsSkipped).toBe(5);
    // Amplification is skipped: no links. It must not be counted as a zero.
    expect(cluster.signals.find((s) => s.id === "amplification")!.score).toBeNull();
  });
});

describe("assessCluster — single account posting rapidly", () => {
  const cluster = assessCluster(SINGLE_ACCOUNT_BURST, { now: T0 });

  test("is NOT flagged", () => {
    expect(cluster.flagged).toBe(false);
  });

  test("synchrony, duplication and handles are all skipped by construction", () => {
    const skipped = cluster.signals.filter((s) => s.score === null).map((s) => s.id);
    expect(skipped).toContain("temporal_synchrony");
    expect(skipped).toContain("content_duplication");
    expect(cluster.accounts.length).toBe(1);
  });
});

describe("analyseCib", () => {
  test("ranks the coordinated cluster above the organic one", () => {
    const clusters = analyseCib([...ORGANIC, ...COORDINATED], {
      profiles: [...ORGANIC_PROFILES, ...COORDINATED_PROFILES],
      now: T0,
    });
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(clusters[0].accounts[0]).toContain("coord");
    expect(clusters[0].flagged).toBe(true);
    expect(clusters.filter((c) => c.flagged).length).toBe(1);
  });

  test("drops groups below the minimum cluster size", () => {
    const lone = [post({ authorId: "solo", text: "an entirely unrelated observation about weather" })];
    const clusters = analyseCib([...COORDINATED, ...lone], { now: T0 });
    expect(clusters.some((c) => c.posts.some((p) => p.authorId === "solo"))).toBe(false);
  });

  test("an empty post set yields no clusters rather than an empty finding", () => {
    expect(analyseCib([], { now: T0 })).toEqual([]);
  });
});

// ─── Ingestion layer ───────────────────────────────────────────────────────

describe("RingBuffer", () => {
  test("bounds memory and counts what it discarded", () => {
    const r = new RingBuffer<number>(3);
    for (let i = 0; i < 10; i += 1) r.push(i);
    expect(r.size).toBe(3);
    expect(r.toArray()).toEqual([7, 8, 9]);
    expect(r.dropped).toBe(7);
  });

  test("rejects a capacity that would make it useless", () => {
    expect(() => new RingBuffer<number>(0)).toThrow();
  });
});

describe("eventToPost", () => {
  const commit = {
    did: "did:plc:abc",
    kind: "commit",
    time_us: T0 * 1000,
    commit: {
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3kabc",
      record: {
        text: "Test post about the ministry report",
        createdAt: at(0),
        langs: ["en"],
        facets: [{ features: [{ uri: "https://x.test/a" }] }],
      },
    },
  };

  test("maps a create commit to a post with a resolvable URL", () => {
    const p = eventToPost(commit)!;
    expect(p.id).toBe("at://did:plc:abc/app.bsky.feed.post/3kabc");
    expect(p.url).toBe("https://bsky.app/profile/did:plc:abc/post/3kabc");
    expect(p.links).toEqual(["https://x.test/a"]);
    expect(p.authorId).toBe("did:plc:abc");
  });

  test("ignores deletes, non-post collections and non-commit events", () => {
    expect(eventToPost({ ...commit, commit: { ...commit.commit, operation: "delete" } })).toBeNull();
    expect(eventToPost({ ...commit, commit: { ...commit.commit, collection: "app.bsky.graph.follow" } })).toBeNull();
    expect(eventToPost({ ...commit, kind: "identity" })).toBeNull();
  });

  test("ignores a malformed record rather than substituting a placeholder", () => {
    expect(eventToPost({ ...commit, commit: { ...commit.commit, record: {} } })).toBeNull();
  });
});

describe("keyword monitors", () => {
  const p = (text: string) => post({ authorId: "a", text });

  test("matches on word boundaries, not substrings", () => {
    expect(monitorMatches(p("The IAF confirmed the deployment"), "IAF")).toBe(true);
    expect(monitorMatches(p("chiaroscuro lighting"), "iaf")).toBe(false);
  });

  test("matches a multi-word term as a phrase", () => {
    expect(monitorMatches(p("A hypersonic missile test off Odisha"), "hypersonic missile")).toBe(true);
    expect(monitorMatches(p("A missile that is hypersonic"), "hypersonic missile")).toBe(false);
  });

  test("an empty term never matches", () => {
    expect(monitorMatches(p("anything at all"), "   ")).toBe(false);
  });
});

describe("spike detection", () => {
  test("refuses to judge before a baseline exists", () => {
    const a = assessSpike([5, 5, 40]);
    expect(a.spiking).toBeNull();
    expect(a.reason).toContain(`${MIN_BASELINE_BUCKETS} completed minutes`);
  });

  test("flags a genuine surge against the term's own history", () => {
    const history = [2, 3, 2, 4, 3, 2, 3, 4, 2, 3, 3, 2];
    const a = assessSpike([...history, 40]);
    expect(a.spiking).toBe(true);
    expect(a.z!).toBeGreaterThan(3);
    expect(a.reason).toContain("baseline of");
  });

  test("does not flag ordinary variation", () => {
    const a = assessSpike([2, 3, 2, 4, 3, 2, 3, 4, 2, 3, 3, 2, 4]);
    expect(a.spiking).toBe(false);
  });

  test("high but STEADY volume is not a spike — the baseline is the term's own", () => {
    // A hardcoded threshold would fire on every one of these buckets.
    const a = assessSpike([500, 505, 498, 502, 499, 501, 503, 497, 500, 502, 504, 500]);
    expect(a.spiking).toBe(false);
  });

  test("a flat zero baseline needs more than a single hit to count", () => {
    const zeros = new Array(12).fill(0);
    expect(assessSpike([...zeros, 1]).spiking).toBe(false);
    expect(assessSpike([...zeros, 9]).spiking).toBe(true);
  });
});

describe("bucketise", () => {
  test("counts posts into per-minute buckets ending at now", () => {
    const now = T0 + 3 * BUCKET_MS;
    const posts = [
      post({ authorId: "a", text: "x", createdAt: new Date(T0).toISOString() }),
      post({ authorId: "a", text: "x", createdAt: new Date(T0 + BUCKET_MS).toISOString() }),
      post({ authorId: "a", text: "x", createdAt: new Date(T0 + BUCKET_MS + 5000).toISOString() }),
    ];
    const buckets = bucketise(posts, now, 5);
    expect(buckets).toEqual([0, 1, 2, 0, 0]);
  });

  test("a minute with no matches is a real zero, not missing data", () => {
    expect(bucketise([], T0, 4)).toEqual([0, 0, 0, 0]);
  });

  test("undated posts are dropped rather than assigned to now", () => {
    const buckets = bucketise([post({ authorId: "a", text: "x", createdAt: "" })], T0, 3);
    expect(buckets).toEqual([0, 0, 0]);
  });
});

describe("readMonitor", () => {
  test("filters, buckets and assesses in one pass", () => {
    const monitor = { id: "m1", term: "missile", createdAt: at(0) };
    const posts = [
      post({ authorId: "a", text: "A missile test today", createdAt: new Date(T0).toISOString() }),
      post({ authorId: "b", text: "Unrelated weather chatter", createdAt: new Date(T0).toISOString() }),
    ];
    const reading = readMonitor(monitor, posts, T0);
    expect(reading.matches.length).toBe(1);
    expect(reading.ratePerMinute).toBe(1);
    expect(reading.spike.spiking).toBeNull();
  });
});

describe("platform availability", () => {
  test("states Instagram and Facebook as unavailable with the reason", () => {
    const ig = PLATFORM_NOTES.find((p) => p.platform === "Instagram")!;
    const fb = PLATFORM_NOTES.find((p) => p.platform === "Facebook")!;
    expect(ig.available).toBe(false);
    expect(fb.available).toBe(false);
    expect(ig.limitation).toContain("Graph API");
    expect(fb.limitation).toContain("CrowdTangle");
  });

  test("every note explains its limitation", () => {
    for (const note of PLATFORM_NOTES) {
      expect(note.limitation.length).toBeGreaterThan(30);
    }
  });
});

// ─── Integration with Modules 1 and 2 ──────────────────────────────────────

describe("Module 3 → Module 1 integration", () => {
  const assessment = assessSocialCorpus(COORDINATED, { profiles: COORDINATED_PROFILES, now: T0 });
  const factors = [...defaultFactors(), ...socialFactors()];
  const articles = assessment.articles;
  const scored = scoreCorpus(articles, factors, { social: assessment.context });

  test("a post converts to an Article that Module 2 can consume unchanged", () => {
    const a = postToArticle(COORDINATED[0]);
    expect(a.id).toBe(COORDINATED[0].id);
    expect(a.source).toBe("citizenvoice1200.bsky.social");
    expect(a.body).toBe(COORDINATED_TEXT);
    expect(a.pubDate).toBe(COORDINATED[0].createdAt);
  });

  test("domain_tier is BYPASSED for social sources, with the reason stated", () => {
    // bsky.app would otherwise rate every account on the network identically,
    // and would be the single largest term for a post with no editorial model.
    const skip = scored[0].skipped.find((s) => s.id === "domain_tier");
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain("hosting platform, not the");
  });

  test("account maturity and CIB signals contribute in its place", () => {
    const ids = scored[0].breakdown.map((b) => b.id);
    expect(ids).toContain("account_maturity");
    expect(ids).toContain("cib_signals");
  });

  test("a young coordinated account scores lower than an established organic one", () => {
    const organic = assessSocialCorpus(ORGANIC, { profiles: ORGANIC_PROFILES, now: T0 });
    const organicScored = scoreCorpus(organic.articles, factors, { social: organic.context });
    expect(scored[0].score).not.toBeNull();
    expect(organicScored[0].score).not.toBeNull();
    expect(organicScored[0].score!).toBeGreaterThan(scored[0].score!);
  });

  test("both social factors are SKIPPED, not zeroed, when no profile was fetched", () => {
    const blind = assessSocialCorpus(COORDINATED, { now: T0 });
    const blindScored = scoreCorpus(blind.articles, factors, { social: blind.context });
    const maturity = blindScored[0].skipped.find((s) => s.id === "account_maturity");
    expect(maturity).toBeDefined();
    expect(maturity!.reason).toContain("No profile was retrieved");
    // CIB still computes — it needs no profile data.
    expect(blindScored[0].breakdown.map((b) => b.id)).toContain("cib_signals");
  });

  test("the social factors do not fire on a published article", () => {
    const news = [{
      id: "n1",
      title: "Ministry publishes report on suppressed findings",
      source: "Reuters",
      url: "https://www.reuters.com/world/india/n1",
      pubDate: at(0),
      body: "The ministry published its report.",
    }];
    const newsScored = scoreCorpus(news, factors, {});
    const ids = newsScored[0].breakdown.map((b) => b.id);
    expect(ids).toContain("domain_tier");
    expect(ids).not.toContain("account_maturity");
    const skip = newsScored[0].skipped.find((s) => s.id === "cib_signals");
    expect(skip!.reason).toContain("published article");
  });

  test("flagged clusters name the accounts worth resolving profiles for", () => {
    expect(assessment.accountsWorthResolving.length).toBe(9);
    const clean = assessSocialCorpus(ORGANIC, { profiles: ORGANIC_PROFILES, now: T0 });
    expect(clean.accountsWorthResolving).toEqual([]);
  });
});

describe("cross-modal clustering", () => {
  const NEWS = [{
    id: "n1",
    title: "Ministry report on suppressed findings receives thin coverage",
    source: "The Hindu",
    url: "https://www.thehindu.com/news/n1",
    pubDate: at(20000),
    body: "The ministry report and its suppressed findings received thin coverage.",
  }];

  test("groups social posts alongside news covering the same event", () => {
    const clusters = clusterAcrossModes(NEWS, ORGANIC);
    const cross = clusters.find((c) => c.crossModal);
    expect(cross).toBeDefined();
    expect(cross!.newsMembers.length).toBe(1);
    expect(cross!.socialMembers.length).toBeGreaterThan(0);
  });

  test("reports how far social chatter preceded the first published report", () => {
    const cross = clusterAcrossModes(NEWS, ORGANIC).find((c) => c.crossModal)!;
    expect(cross.socialLeadMinutes).not.toBeNull();
    expect(cross.socialLeadMinutes!).toBeGreaterThan(0);
    expect(cross.summary).toContain("preceded the first published report");
  });

  test("says explicitly when a claim circulates with no reporting behind it", () => {
    const orphan = clusterAcrossModes([], COORDINATED).find((c) => c.socialMembers.length > 1)!;
    expect(orphan.crossModal).toBe(false);
    expect(orphan.summary).toContain("NO published reporting");
  });

  test("a news-only story says so rather than implying absent social traffic was measured", () => {
    const newsOnly = clusterAcrossModes(NEWS, []).find((c) => c.newsMembers.length === 1)!;
    expect(newsOnly.summary).toContain("Published reporting only");
  });
});

describe("Jetstream instance failover", () => {
  /** Minimal fake socket: records the URL, lets the test drive open/close. */
  class FakeSocket {
    onopen: (() => void) | null = null;
    onclose: ((e: any) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: any) => void) | null = null;
    closed = false;
    constructor(readonly url: string) {}
    close() { this.closed = true; }
  }

  test("rotates to a different instance after a failed connection", () => {
    // Not hypothetical: verified 2026-08-04, both us-east hosts refused TCP
    // while both us-west hosts served the firehose. A pinned instance means a
    // dead host costs all collection rather than one backoff interval.
    const opened: string[] = [];
    const sockets: FakeSocket[] = [];
    const client = new JetstreamClient({
      socketFactory: (url) => {
        opened.push(url);
        const s = new FakeSocket(url);
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    });

    client.connect();
    expect(opened.length).toBe(1);
    expect(opened[0]).toContain(JETSTREAM_INSTANCES[0]);
    expect(opened[0]).toContain("wantedCollections=app.bsky.feed.post");

    // Drop the connection; the client should target a different host next.
    sockets[0].onclose?.({ code: 1006, reason: "" });
    const status = client.getStatus();
    expect(status.state).toBe("reconnecting");
    expect(status.endpoint).not.toBe(JETSTREAM_INSTANCES[0]);
    expect(JETSTREAM_INSTANCES).toContain(status.endpoint);
    expect(status.retryInMs).toBeGreaterThan(0);

    client.disconnect();
    expect(client.getStatus().state).toBe("closed");
  });

  test("more than one instance is configured", () => {
    expect(JETSTREAM_INSTANCES.length).toBeGreaterThan(1);
    expect(new Set(JETSTREAM_INSTANCES).size).toBe(JETSTREAM_INSTANCES.length);
  });

  test("disconnect stops reconnection rather than looping", () => {
    const opened: string[] = [];
    const sockets: FakeSocket[] = [];
    const client = new JetstreamClient({
      socketFactory: (url) => {
        opened.push(url);
        const s = new FakeSocket(url);
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    });
    client.connect();
    client.disconnect();
    sockets[0].onclose?.({ code: 1000, reason: "" });
    expect(opened.length).toBe(1);
    expect(client.getStatus().state).toBe("closed");
  });
});
