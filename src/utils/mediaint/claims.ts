/**
 * Deterministic MEDIAINT claim extraction (2026-08-30, ported from the
 * teammate's fork).
 *
 * MEDIAINT is **Media Intelligence**, not medical: news articles, press releases,
 * public statements, publisher pages, historical media.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY DETERMINISTIC, AND WHY BEFORE THE LLM.
 *
 * `analysis-llm.ts`'s `summariseCluster()` already asks a model for
 * `disagreements[].positions[{source, claim}]`. That is useful and it stays — but
 * it is inference over prose: it cannot be reproduced, it costs a call, it needs
 * a configured provider, and it can propose a claim nobody made. Everything in
 * this file is a pure function over the article text a publisher actually
 * printed. The model may later summarise or explain these claims; it does not
 * create them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS MODULE EXISTS TO ENFORCE.
 *
 * "According to X, Y happened" must never become "Y happened."
 *
 * So **every claim extracted from an article is at minimum `REPORTED`**. Nothing
 * from a news story is `OBSERVED` in this system's sense: we observed a publisher
 * asserting something, not the thing itself. A claim attributed to a government
 * or military body is `OFFICIAL_STATEMENT` — a stronger *statement*, still not
 * independent verification of the underlying fact. There is no code path here
 * that produces a bare unattributed fact from an article.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NOT DO.
 *
 * It extracts a subject/predicate/object triple ONLY where a documented pattern
 * actually yields one. When no pattern matches, subject/predicate/object are
 * `null` and only `claimText` — the publisher's own words — is kept. A partially
 * guessed triple would read as structure the source never provided, which is the
 * string-literal-as-measurement failure in a new costume.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REUSE, NOT REBUILD. Syndication detection, story clustering, title similarity
 * and the corroboration curve already exist and are used here rather than
 * reimplemented:
 *   - `clusterStories()` / `SYNDICATION_THRESHOLD` (`analysis.ts`) — one wire
 *     story republished by five outlets is one source, not five.
 *   - `titleTokens()` (`analysis.ts`) — the stemmed, stopworded token set used
 *     for matching claims across articles.
 *   - `corroborationScoreFor()` (`credibility.ts`) — the project's existing
 *     independent-source confidence curve.
 *   - `isAggregatorUrl()` (`rss-source.ts`) — never report the aggregator as the
 *     publisher.
 */

import type { Article, StoryCluster } from "../analysis";
import { SYNDICATION_THRESHOLD, domainOf, titleSimilarity, titleTokens } from "../analysis";
import { corroborationScoreFor } from "../credibility";
import { isAggregatorUrl } from "../rss-source";
import type { ClaimClass, ConfidenceScore } from "../collectors/result";

// ─── The claim ──────────────────────────────────────────────────────────────

/** Whether the claim asserts something or denies it. Drives conflict detection; never a truth judgement. */
export type ClaimPolarity = "assert" | "deny";

export interface MediaClaim {
  /** Deterministic and stable: same article + same sentence yields the same id across runs. */
  claimId: string;

  /** The article this came from. */
  articleId: string;
  /** The `CollectorEvidence` this article arrived as, when one is known. Null otherwise — never minted. */
  evidenceRef: string | null;

  /** Publisher name as the feed reported it. */
  source: string;
  /** The article URL. Null when the feed gave none. */
  sourceUrl: string | null;
  /** Publisher domain, or null when only an aggregator redirect was available. Never the aggregator. */
  publisher: string | null;
  /** ISO 8601, or null when the feed carried no date. Never back-filled. */
  publishedAt: string | null;
  /** Byline, when the source carried one. Null otherwise. */
  author: string | null;

  /** Who the claim is attributed to, when the text names them. Null for a publisher's own assertion. */
  attributedTo: string | null;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  /** The publisher's own words for this claim. Always present — this is the thing actually printed. */
  claimText: string;

  claimClass: ClaimClass;
  polarity: ClaimPolarity;

  /** Injected, never read from a clock inside this module — see `extractClaims`. */
  extractedAt: string;
  confidence: ConfidenceScore;

  /** True when this article was collapsed as a syndicated copy of another. */
  syndicated: boolean;
  /** Independent (non-syndicated) publishers carrying a matching claim, including this one. */
  independentSources: number;
}

// ─── Vocabulary — closed, documented, and deliberately small ────────────────

/**
 * Verbs that mark a statement as attributed reporting.
 *
 * A closed list on purpose. Widening it should be a deliberate edit with a test,
 * not a regex that happens to catch more — a loose pattern invents attributions.
 */
export const ATTRIBUTION_VERBS = [
  "said",
  "says",
  "stated",
  "states",
  "announced",
  "announces",
  "confirmed",
  "confirms",
  "reported",
  "reports",
  "claimed",
  "claims",
  "alleged",
  "alleges",
  "warned",
  "warns",
  "admitted",
  "admits",
  "denied",
  "denies",
  "rejected",
  "rejects",
  "refuted",
  "refutes",
  "dismissed",
  "dismisses",
  "disputed",
  "disputes",
  "told",
  "tells",
  "urged",
  "urges",
  "accused",
  "accuses",
] as const;

/** The subset that negates. Drives `polarity`, which conflict detection reads. */
export const DENIAL_VERBS: ReadonlySet<string> = new Set([
  "denied",
  "denies",
  "rejected",
  "rejects",
  "refuted",
  "refutes",
  "dismissed",
  "dismisses",
  "disputed",
  "disputes",
]);

/**
 * Markers that make an attributed source an official body.
 *
 * Matched as whole words against the attributed source only — never against the
 * article body, where "police said" inside a quote would otherwise promote an
 * unrelated claim.
 */
export const OFFICIAL_SOURCE_MARKERS = [
  "ministry",
  "minister",
  "government",
  "govt",
  "police",
  "army",
  "navy",
  "air force",
  "iaf",
  "defence",
  "defense",
  "spokesperson",
  "spokesman",
  "spokeswoman",
  "official",
  "officials",
  "president",
  "prime minister",
  "embassy",
  "cabinet",
  "parliament",
  "regulator",
  "authority",
  "commission",
] as const;

export function isOfficialSource(attributedTo: string | null): boolean {
  if (!attributedTo) return false;
  const lower = ` ${attributedTo.toLowerCase()} `;
  return OFFICIAL_SOURCE_MARKERS.some((m) => lower.includes(` ${m} `) || lower.includes(`${m} `));
}

// ─── Extraction patterns ────────────────────────────────────────────────────

const MAX_ACTOR = 60;

interface Parsed {
  attributedTo: string | null;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  claimText: string;
  polarity: ClaimPolarity;
}

const VERB_ALT = ATTRIBUTION_VERBS.join("|");

/**
 * Ordered, documented patterns. First match wins.
 *
 * Each returns only what its capture groups actually contain. Nothing is
 * inferred to fill a slot the pattern did not produce.
 */
const PATTERNS: { name: string; re: RegExp; build: (m: RegExpMatchArray) => Parsed }[] = [
  {
    // "According to Reuters, the plant closed."
    name: "according-to",
    re: new RegExp(`^according to ([^,]{2,${MAX_ACTOR}}),\\s*(.+)$`, "i"),
    build: (m) => ({
      attributedTo: clean(m[1]),
      subject: null,
      predicate: null,
      object: null,
      claimText: clean(m[2]),
      polarity: "assert",
    }),
  },
  {
    // "Company X denied acquisition discussions."  → subject/predicate/object
    name: "actor-verb-object",
    re: new RegExp(`^(.{2,${MAX_ACTOR}}?)\\s+(${VERB_ALT})\\s+(?:that\\s+)?(.+)$`, "i"),
    build: (m) => {
      const verb = m[2]!.toLowerCase();
      return {
        attributedTo: clean(m[1]),
        subject: clean(m[1]),
        predicate: verb,
        object: clean(m[3]),
        claimText: clean(m[0]),
        polarity: DENIAL_VERBS.has(verb) ? "deny" : "assert",
      };
    },
  },
  {
    // "The plant has closed, Reuters said."
    name: "trailing-attribution",
    re: new RegExp(`^(.+?),\\s*(.{2,${MAX_ACTOR}}?)\\s+(${VERB_ALT})\\.?$`, "i"),
    build: (m) => ({
      attributedTo: clean(m[2]),
      subject: null,
      predicate: m[3]!.toLowerCase(),
      object: null,
      claimText: clean(m[1]),
      polarity: DENIAL_VERBS.has(m[3]!.toLowerCase()) ? "deny" : "assert",
    }),
  },
  {
    // "Defence Ministry: no incursion took place"  — headline colon attribution.
    name: "colon-attribution",
    re: new RegExp(`^([^:]{2,${MAX_ACTOR}}):\\s*(.+)$`),
    build: (m) => ({
      attributedTo: clean(m[1]),
      subject: null,
      predicate: null,
      object: null,
      claimText: clean(m[2]),
      polarity: "assert",
    }),
  },
];

function clean(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "");
}

/**
 * Parses one sentence into its claim parts, or returns null when no documented
 * pattern matches.
 *
 * **Returning null is a real and common outcome** — a headline like
 * "Markets rally" carries no attribution and no parseable triple. The caller
 * still records it as a REPORTED claim with `claimText` only, which is honest:
 * the publisher asserted it and we captured exactly that.
 */
export function parseClaimSentence(sentence: string): Parsed | null {
  const text = clean(sentence);
  if (text.length < 8) return null;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) return p.build(m);
  }
  return null;
}

/** Split an article body into candidate sentences. Deliberately simple — over-splitting costs nothing, since each candidate is independently parsed. */
export function candidateSentences(text: string): string[] {
  return (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

// ─── Stable ids ─────────────────────────────────────────────────────────────

/**
 * Deterministic id from the article and the claim text.
 *
 * A hash, not a counter: two runs over the same corpus must mint the same
 * `claimId` so a stored claim reference stays valid. Small non-cryptographic
 * hash — this is an identity key, not a security boundary.
 */
export function claimIdFor(articleId: string, claimText: string): string {
  const input = `${articleId}::${claimText}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `claim:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

// ─── Matching claims across articles ────────────────────────────────────────

/**
 * A normalised key for "is this the same assertion?", built from the stemmed,
 * stopworded tokens `analysis.ts` already computes for story clustering.
 *
 * Polarity is deliberately NOT part of the key: an assertion and its denial must
 * land on the same key so they can be compared, which is exactly the
 * "X announced acquisition" vs "X denied acquisition" case.
 */
export function claimKey(claim: MediaClaim): string {
  return [...claimTokens(claim)].sort().join("|");
}

/** The stemmed, stopworded token set a claim is matched on. */
export function claimTokens(claim: MediaClaim): Set<string> {
  const basis = [claim.subject ?? "", claim.object ?? "", claim.object ? "" : claim.claimText]
    .join(" ")
    .trim();
  return titleTokens(basis);
}

/**
 * How alike two claims are, 0–1, over their token sets.
 *
 * Exact key equality was tried first and is too brittle for prose: "announced
 * acquisition of Beta Ltd" and "confirmed the acquisition of Beta Ltd today"
 * are plainly the same assertion but differ by one token, and treating them as
 * unrelated silently under-reports corroboration — which in this system means
 * under-reporting how well attested a claim is.
 */
export function claimSimilarity(a: MediaClaim, b: MediaClaim): number {
  const ta = claimTokens(a);
  const tb = claimTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Above this, two claims are treated as the same assertion.
 *
 * Tuned against the cases below rather than picked round. 0.5 merged "Acme Corp
 * announced acquisition" with "Acme Corp announced layoffs" — both share
 * {acme, corp} and nothing else that matters, scoring 0.5, and merging them
 * would manufacture corroboration between two unrelated stories. 0.6 separates
 * them while still matching a genuine reword (0.83 in the acquisition case).
 *
 * Deliberately stricter than `SAME_STORY_THRESHOLD` (0.45): that decides whether
 * two articles cover one event, which is a looser question than whether two
 * sentences assert the same thing.
 */
export const CLAIM_MATCH_THRESHOLD = 0.6;

export function claimsMatch(a: MediaClaim, b: MediaClaim): boolean {
  return claimSimilarity(a, b) >= CLAIM_MATCH_THRESHOLD;
}

// ─── Extraction ─────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /**
   * Injected so this module never reads a clock — a function that consults
   * `Date.now()` could not be tested for determinism, which is the property this
   * module exists to provide.
   */
  extractedAt: string;
  /** Pre-computed story clusters, so syndication is judged with the same logic `/news` uses. */
  clusters?: StoryCluster[];
  /** Article id → the `CollectorEvidence` id it arrived as. */
  evidenceRefs?: Record<string, string>;
  /** Article id → byline, where the caller has one. Absent means unknown, never guessed. */
  authors?: Record<string, string>;
  /** Cap per article, so one long body cannot flood the set. */
  maxPerArticle?: number;
}

const DEFAULT_MAX_PER_ARTICLE = 5;

/**
 * True when `article` is a syndicated copy of an earlier member of its cluster.
 *
 * Reuses `SYNDICATION_THRESHOLD` and `titleSimilarity` rather than
 * reimplementing: above 0.9 two headlines are the same text, not two newsrooms.
 */
export function isSyndicatedCopy(article: Article, corpus: readonly Article[]): boolean {
  const mine = domainOf(article.url || "");
  for (const other of corpus) {
    if (other.id === article.id) continue;
    if (domainOf(other.url || "") === mine) continue;
    if (titleSimilarity(article.title, other.title) < SYNDICATION_THRESHOLD) continue;
    // The earlier publication is the original; later identical copies are the
    // syndication. Ties break on id so the choice is deterministic.
    const a = article.pubDate || "";
    const b = other.pubDate || "";
    if (b < a || (b === a && other.id < article.id)) return true;
  }
  return false;
}

/**
 * Extract every claim the corpus deterministically supports.
 *
 * Pure. No network, no clock, no storage.
 */
export function extractClaims(corpus: readonly Article[], options: ExtractOptions): MediaClaim[] {
  const maxPer = options.maxPerArticle ?? DEFAULT_MAX_PER_ARTICLE;
  const claims: MediaClaim[] = [];

  for (const article of corpus) {
    if (!article) continue;
    const syndicated = isSyndicatedCopy(article, corpus);
    const publisherDomain = article.url && !isAggregatorUrl(article.url) ? domainOf(article.url) : "";

    // The headline is always a candidate; the body adds more where present.
    const sentences = [article.title, ...candidateSentences(article.body ?? "")]
      .map((s) => clean(s))
      .filter(Boolean);

    const seen = new Set<string>();
    let taken = 0;

    for (const sentence of sentences) {
      if (taken >= maxPer) break;
      const parsed = parseClaimSentence(sentence);

      // No pattern matched. The publisher still asserted the sentence, so it is
      // recorded as a REPORTED claim carrying only its own words — never dropped,
      // never given an invented triple.
      const parts: Parsed = parsed ?? {
        attributedTo: null,
        subject: null,
        predicate: null,
        object: null,
        claimText: sentence,
        polarity: "assert",
      };

      if (!parts.claimText || parts.claimText.length < 8) continue;
      const claimId = claimIdFor(article.id, parts.claimText);
      if (seen.has(claimId)) continue;
      seen.add(claimId);
      taken += 1;

      claims.push({
        claimId,
        articleId: article.id,
        evidenceRef: options.evidenceRefs?.[article.id] ?? null,
        source: article.source || "(publisher not reported)",
        sourceUrl: article.url || null,
        publisher: publisherDomain || null,
        // An absent feed date stays absent. Never `new Date()`.
        publishedAt: article.pubDate || null,
        author: options.authors?.[article.id] ?? null,
        attributedTo: parts.attributedTo,
        subject: parts.subject,
        predicate: parts.predicate,
        object: parts.object,
        claimText: parts.claimText,
        // The floor is REPORTED, always. See the header.
        claimClass: isOfficialSource(parts.attributedTo) ? "OFFICIAL_STATEMENT" : "REPORTED",
        polarity: parts.polarity,
        extractedAt: options.extractedAt,
        confidence: { value: null, reasons: [] },
        syndicated,
        independentSources: 0,
      });
    }
  }

  return scoreCorroboration(claims);
}

/**
 * Fills `independentSources` and `confidence` across the extracted set.
 *
 * **Syndicated copies do not count.** One wire story republished by five outlets
 * is one source; counting it as five is the classic way to make a single claim
 * look corroborated. `corroborationScoreFor()` — the project's existing curve —
 * converts the independent count into the score, and the reasons name the count
 * so no reader has to trust a bare number.
 */
function scoreCorroboration(claims: MediaClaim[]): MediaClaim[] {
  for (const c of claims) {
    // Matched by SIMILARITY, not key equality — see `CLAIM_MATCH_THRESHOLD`.
    // Same polarity only: a denial does not corroborate an assertion.
    const group = claims.filter(
      (other) =>
        other.polarity === c.polarity &&
        claimTokens(other).size > 0 &&
        (other.claimId === c.claimId || claimsMatch(c, other)),
    );
    const independentPublishers = new Set(
      group.filter((g) => !g.syndicated).map((g) => g.publisher ?? g.source),
    );
    const count = independentPublishers.size;
    c.independentSources = count;

    const reasons: string[] = [];
    reasons.push(
      count <= 1
        ? "Single independent source — uncorroborated."
        : `${count} independent publishers carry a matching claim.`,
    );
    if (c.syndicated) {
      reasons.push("This article is a syndicated copy; it does not add independent corroboration.");
    }
    if (group.length > count) {
      reasons.push(
        `${group.length - count} further cop${group.length - count === 1 ? "y" : "ies"} were syndicated and excluded from the count.`,
      );
    }
    reasons.push("Score reflects corroboration of the REPORTING, not verification of the claim.");

    c.confidence = { value: corroborationScoreFor(count - 1), reasons } satisfies ConfidenceScore;
  }

  return claims;
}

// ─── Bridge from collector evidence ─────────────────────────────────────────

/**
 * Projects the article-shaped subset of an investigation's evidence into
 * `Article`s, so claim extraction runs on live collected data.
 *
 * Only evidence that actually carries a title AND a url is taken — the news and
 * dorks collectors emit `{title, source, url, …}`. DNS, RDAP and Shodan evidence
 * is skipped rather than coerced: an A record is not an article, and forcing one
 * through would manufacture a "claim" nobody published.
 *
 * Returns the articles and the evidence-ref map together, so `extractClaims` can
 * preserve the link back to the exact evidence record each claim came from.
 */
export function articlesFromEvidence(
  // `normalizedValue` is optional here because `z.unknown()` infers as optional
  // on `CollectorEvidence`. Structural, so any evidence-shaped record fits
  // without this module importing the collector contract.
  evidence: readonly {
    collector: string;
    source: string;
    sourceUrl: string | null;
    normalizedValue?: unknown;
    evidenceId?: string;
  }[],
): { articles: Article[]; evidenceRefs: Record<string, string> } {
  const articles: Article[] = [];
  const evidenceRefs: Record<string, string> = {};

  evidence.forEach((ev, index) => {
    const nv = ev.normalizedValue;
    if (!nv || typeof nv !== "object" || Array.isArray(nv)) return;
    const rec = nv as Record<string, unknown>;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!title || !url) return;

    const id = `${ev.collector}#${index}`;
    const publishedAt = [rec.publishedAt, rec.pubDate, rec.publishedTime, rec.date].find(
      (v): v is string => typeof v === "string" && v.length >= 10,
    );

    articles.push({
      id,
      title,
      // The feed's own publisher name where it gave one; otherwise the
      // collector's source label. Never an invented outlet.
      source: typeof rec.source === "string" && rec.source.trim() ? rec.source.trim() : ev.source,
      url,
      // Absent stays absent — `extractClaims` turns "" into a null publishedAt.
      pubDate: publishedAt ?? "",
      body: typeof rec.body === "string" ? rec.body : undefined,
    });
    evidenceRefs[id] = ev.evidenceId ?? id;
  });

  return { articles, evidenceRefs };
}

// ─── Summary, for a UI header ───────────────────────────────────────────────

export interface ClaimSetSummary {
  total: number;
  attributed: number;
  officialStatements: number;
  syndicated: number;
  corroborated: number;
  publishers: number;
  undated: number;
}

export const CLAIM_CAVEATS: string[] = [
  "Every claim here is REPORTED or an OFFICIAL STATEMENT. It records what a source said, not that it is true.",
  "Corroboration counts independent publishers only. Syndicated copies of one wire story are collapsed and excluded.",
  "Social-media discussion of a story is never counted as confirmation of it.",
  "A subject/predicate/object is shown only where the text explicitly supplied one; blanks are gaps in the source, not omissions here.",
];

export function summariseClaims(claims: readonly MediaClaim[]): ClaimSetSummary {
  return {
    total: claims.length,
    attributed: claims.filter((c) => c.attributedTo !== null).length,
    officialStatements: claims.filter((c) => c.claimClass === "OFFICIAL_STATEMENT").length,
    syndicated: claims.filter((c) => c.syndicated).length,
    corroborated: claims.filter((c) => c.independentSources > 1).length,
    publishers: new Set(claims.map((c) => c.publisher ?? c.source)).size,
    undated: claims.filter((c) => c.publishedAt === null).length,
  };
}
