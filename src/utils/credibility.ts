/**
 * Module 1 — Source credibility (PS-18 §6.1).
 *
 * The requirement is "definition of credibility based on user defined
 * factors/criterion", so CONFIGURABILITY is the deliverable, not the number.
 * Every factor carries an analyst-controlled weight and an on/off switch, and
 * every score returns a per-factor breakdown with human-readable evidence. An
 * unexplained score is unauditable, which in a defence context makes it useless.
 *
 * Six of the seven factors are deterministic: no LLM calls, no API keys, no
 * cost. The seventh (linguistic markers) is model-backed and ships DISABLED —
 * it is opt-in per article, because assessing a whole feed is one model call
 * per item against a free tier. Its input arrives pre-computed through
 * `FactorOptions.language`; the call itself lives in credibility-llm.ts, so
 * this file has no runtime dependency on the model and keeps scoring when the
 * provider is unreachable.
 *
 * Rules that must not regress:
 *   - No Math.random(). Every number derives from a real article property.
 *   - No fallback scores. A factor that cannot compute returns null and is
 *     EXCLUDED from the weighted mean; it is never defaulted to a neutral value,
 *     because a default is an invented measurement.
 *   - All compute functions are pure, so they are testable in isolation.
 */

// ─── Article and story identity ────────────────────────────────────────────

// Article, tokenisation, similarity and clustering all live in analysis.ts —
// Module 2 owns the definition of "the same story" and this module consumes it.
// Re-exported here so existing importers keep working.
import {
  clusterFor, clusterStories, domainOf, sourceKeyOf,
  type Article, type StoryCluster,
} from "./analysis";

// TYPE-ONLY, and deliberately so. This import is erased at compile time, so the
// deterministic layer keeps the property that it works with the model
// unreachable — there is no runtime edge from this file to llm.ts. The call
// itself lives in credibility-llm.ts, which imports this file and not the
// reverse, mirroring how analysis-llm.ts sits above analysis.ts.
import type { LanguageAssessment } from "./llm";

export type { Article, StoryCluster };
export {
  domainOf, titleTokens, titleSimilarity, sourceKeyOf,
  clusterStories, clusterFor,
  SAME_STORY_THRESHOLD, SYNDICATION_THRESHOLD,
} from "./analysis";

export interface FactorResult {
  /** 0-1. */
  score: number;
  /** Human-readable justification shown to the analyst. */
  evidence: string;
  /** 0-1 — how sure we are of THIS factor's own score. */
  confidence: number;
}

/**
 * `compute` returns null when the factor cannot be evaluated for this article
 * (no body to scan, no corroborators to compare, no criterion defined). Null
 * means "skipped", never "zero".
 */
export interface CredibilityFactor {
  id: string;
  name: string;
  description: string;
  weight: number;
  enabled: boolean;
  requiresLlm: boolean;
  compute(article: Article, corpus: Article[], options?: FactorOptions): FactorResult | null;
}

export interface FactorOptions {
  /** Analyst-defined criterion for the custom_keyword factor. */
  customKeywords?: { raise: string[]; lower: string[] };
  /**
   * Story clusters for the corpus, computed once by scoreCorpus. Clustering is
   * O(n^2) in the corpus; recomputing it per article would make scoring the
   * feed O(n^3). Optional so scoreArticle still works standalone.
   */
  clusters?: StoryCluster[];
  /**
   * Module 3 context, keyed by article id, for corpus members that are social
   * posts rather than published articles. Presence of an entry is what marks an
   * article as social: it bypasses domain_tier and enables the two social
   * factors. Absent for a news corpus, which therefore behaves exactly as before.
   */
  social?: Record<string, SocialSignalContext>;
  /**
   * Language assessments keyed by article id, pre-computed by
   * `assessLanguageFor()` in credibility-llm.ts.
   *
   * Pre-computed rather than fetched inside `compute` because the factor
   * interface is SYNCHRONOUS and must stay that way: making it async would make
   * scoreArticle, scoreCorpus and the scoring useMemo in sources.tsx all async,
   * for one of seven factors. This mirrors how `clusters` and `social` are
   * threaded in above.
   *
   * An absent entry means NOT ASSESSED, and the factor skips. It never means
   * the language was assessed and found clean.
   */
  language?: Record<string, LanguageAssessment>;
}

/**
 * What Module 3 knows about one social post, as Module 1 consumes it.
 *
 * Every field is nullable and every null means "not measured", never "measured
 * as zero". A post whose author's profile could not be fetched must not score
 * the same as one whose author is demonstrably established.
 */
export interface SocialSignalContext {
  platform: string;
  /** Account handle or id, for evidence strings. */
  account: string;
  /** 0-1 concern from account age, output rate and audience. Null when no profile. */
  maturityConcern: number | null;
  /** The real numbers behind maturityConcern. */
  maturityEvidence: string;
  /** Composite CIB score for the cluster this post sits in. Null when unassessed. */
  cibScore: number | null;
  cibEvidence: string;
  /** How many CIB signals could actually be computed for that cluster. */
  cibSignalsComputed: number;
}

// ─── Domain reputation table ───────────────────────────────────────────────
// Editable without touching scoring logic. Tiers describe the EDITORIAL MODEL
// (corrections policy, named bylines, original reporting), not political
// alignment. `type` drives the source_diversity factor.

export type SourceTier = "TIER_1" | "TIER_2" | "TIER_3" | "SPECIALIST" | "LOW";
export type SourceType = "wire" | "broadsheet" | "government" | "specialist" | "blog" | "aggregator";

export const TIER_SCORES: Record<SourceTier, number> = {
  TIER_1: 0.9,
  SPECIALIST: 0.85,
  TIER_2: 0.7,
  /** Unknown/unlisted — neutral. Explicitly NOT a penalty. */
  TIER_3: 0.5,
  LOW: 0.25,
};

export interface DomainEntry {
  tier: SourceTier;
  type: SourceType;
}

export const DOMAIN_REPUTATION: Record<string, DomainEntry> = {
  // TIER_1 — wire services and national papers of record
  "reuters.com": { tier: "TIER_1", type: "wire" },
  "apnews.com": { tier: "TIER_1", type: "wire" },
  "afp.com": { tier: "TIER_1", type: "wire" },
  "ptinews.com": { tier: "TIER_1", type: "wire" },
  "bbc.co.uk": { tier: "TIER_1", type: "broadsheet" },
  "bbc.com": { tier: "TIER_1", type: "broadsheet" },
  "thehindu.com": { tier: "TIER_1", type: "broadsheet" },
  "indianexpress.com": { tier: "TIER_1", type: "broadsheet" },

  // SPECIALIST — narrow remit, deep domain expertise, primary-source heavy
  "cisa.gov": { tier: "SPECIALIST", type: "government" },
  "krebsonsecurity.com": { tier: "SPECIALIST", type: "specialist" },
  "ucdp.uu.se": { tier: "SPECIALIST", type: "specialist" },
  "janes.com": { tier: "SPECIALIST", type: "specialist" },
  "bellingcat.com": { tier: "SPECIALIST", type: "specialist" },
  "therecord.media": { tier: "SPECIALIST", type: "specialist" },
  "defensenews.com": { tier: "SPECIALIST", type: "specialist" },
  "breakingdefense.com": { tier: "SPECIALIST", type: "specialist" },
  "warontherocks.com": { tier: "SPECIALIST", type: "specialist" },
  "nist.gov": { tier: "SPECIALIST", type: "government" },
  "mod.gov.in": { tier: "SPECIALIST", type: "government" },
  "pib.gov.in": { tier: "SPECIALIST", type: "government" },
  "drdo.gov.in": { tier: "SPECIALIST", type: "government" },
  "isro.gov.in": { tier: "SPECIALIST", type: "government" },
  "un.org": { tier: "SPECIALIST", type: "government" },
  "who.int": { tier: "SPECIALIST", type: "government" },

  // TIER_2 — established outlets, broader remit
  "theguardian.com": { tier: "TIER_2", type: "broadsheet" },
  "cnbc.com": { tier: "TIER_2", type: "broadsheet" },
  "aljazeera.com": { tier: "TIER_2", type: "broadsheet" },
  "dw.com": { tier: "TIER_2", type: "broadsheet" },
  "scmp.com": { tier: "TIER_2", type: "broadsheet" },
  "npr.org": { tier: "TIER_2", type: "broadsheet" },
  "ft.com": { tier: "TIER_2", type: "broadsheet" },
  "bloomberg.com": { tier: "TIER_2", type: "wire" },
  "nytimes.com": { tier: "TIER_2", type: "broadsheet" },
  "washingtonpost.com": { tier: "TIER_2", type: "broadsheet" },
  "hindustantimes.com": { tier: "TIER_2", type: "broadsheet" },
  "livemint.com": { tier: "TIER_2", type: "broadsheet" },
  "thewire.in": { tier: "TIER_2", type: "broadsheet" },
  "scroll.in": { tier: "TIER_2", type: "broadsheet" },
  "theprint.in": { tier: "TIER_2", type: "broadsheet" },
  "timesofindia.indiatimes.com": { tier: "TIER_2", type: "broadsheet" },

  // LOW — aggregators and user-generated platforms. This rates the PUBLISHING
  // MODEL (no editorial layer of its own), not the truth of any given item.
  "msn.com": { tier: "LOW", type: "aggregator" },
  "news.google.com": { tier: "LOW", type: "aggregator" },
  "news.yahoo.com": { tier: "LOW", type: "aggregator" },
  "flipboard.com": { tier: "LOW", type: "aggregator" },
  "newsbreak.com": { tier: "LOW", type: "aggregator" },
  "medium.com": { tier: "LOW", type: "blog" },
  "blogspot.com": { tier: "LOW", type: "blog" },
  "wordpress.com": { tier: "LOW", type: "blog" },
  "substack.com": { tier: "LOW", type: "blog" },
};

/** Longest-suffix lookup, so news.bbc.co.uk resolves to bbc.co.uk. */
export function reputationOf(domain: string): DomainEntry | null {
  if (!domain) return null;
  const key = Object.keys(DOMAIN_REPUTATION)
    .filter((d) => domain === d || domain.endsWith(`.${d}`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? DOMAIN_REPUTATION[key] : null;
}

// ─── Corroboration, derived from Module 2's clusters ──────────────────────

export interface Corroboration {
  /** One entry per INDEPENDENT source, after collapsing syndicated copies. */
  domains: string[];
  /** Domains dropped as syndicated duplicates of another corroborator. */
  syndicated: string[];
  types: SourceType[];
}

/**
 * Corroboration for one article, read off the shared story cluster.
 *
 * This used to run its own title matching. It now delegates to
 * clusterStories() so a corroboration count here and a "N sources reporting
 * this" group on the news feed can never disagree — there is exactly one
 * definition of story identity in the application.
 */
export function analyseCorroboration(
  article: Article,
  corpus: Article[],
  clusters?: StoryCluster[],
): Corroboration {
  const own = sourceKeyOf(article);
  const cluster = clusterFor(article, clusters ?? clusterStories(corpus));
  if (!cluster) return { domains: [], syndicated: [], types: [] };

  const domains = cluster.independentDomains.filter((d) => d !== own);
  const syndicated = cluster.syndicatedDomains.filter((d) => d !== own);
  const types = Array.from(
    new Set(domains.map((d) => reputationOf(d)?.type).filter(Boolean) as SourceType[]),
  );
  return { domains, syndicated, types };
}

const listOf = (items: string[], max = 4): string => {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
};

// ─── Factor implementations (pure) ─────────────────────────────────────────

function computeDomainTier(article: Article, options?: FactorOptions): FactorResult | null {
  // BYPASSED FOR SOCIAL SOURCES (Module 3). bsky.app and reddit.com are the
  // hosting platform, not the publisher: rating a post by the domain it sits on
  // would give every account on Bluesky an identical score and would make that
  // score the single largest term for a post carrying no editorial model at all.
  // Account maturity and CIB signals take its place for these sources.
  if (options?.social?.[article.id]) return null;

  const domain = domainOf(article.url) || domainOf(article.source);
  if (!domain) {
    return null; // no resolvable domain — cannot rate the publisher
  }
  const entry = reputationOf(domain);
  if (!entry) {
    return {
      score: TIER_SCORES.TIER_3,
      evidence: `${domain} is not in the reputation table — treated as neutral (unrated), not penalised.`,
      // We are confident the domain is unlisted; less confident that neutral is right for it.
      confidence: 0.5,
    };
  }
  return {
    score: TIER_SCORES[entry.tier],
    evidence: `${domain} is listed as ${entry.tier.replace("_", " ")} (${entry.type}), scoring ${TIER_SCORES[entry.tier].toFixed(2)}.`,
    confidence: 0.9,
  };
}

/** 0 others → 0.2 · 1 → 0.45 · 2 → 0.65 · 3-4 → 0.85 · 5+ → 0.95 */
export function corroborationScoreFor(count: number): number {
  if (count <= 0) return 0.2;
  if (count === 1) return 0.45;
  if (count === 2) return 0.65;
  if (count <= 4) return 0.85;
  return 0.95;
}

function computeCorroboration(
  article: Article,
  corpus: Article[],
  options?: FactorOptions,
): FactorResult | null {
  // An empty or single-item corpus offers nothing to corroborate against; that
  // is an absence of evidence, not evidence of absence.
  if (corpus.length <= 1) return null;

  const { domains, syndicated } = analyseCorroboration(article, corpus, options?.clusters);
  const n = domains.length;

  let evidence =
    n === 0
      ? "No other domain in the current corpus carries this story."
      : `${n} independent domain${n === 1 ? "" : "s"} carry this story: ${listOf(domains)}.`;

  if (syndicated.length > 0) {
    evidence +=
      ` ${syndicated.length} further cop${syndicated.length === 1 ? "y" : "ies"} ` +
      `(${listOf(syndicated, 3)}) had near-identical headlines and were counted as ` +
      `syndicated re-publication of the same wire copy, not independent reporting.`;
  }

  return {
    score: corroborationScoreFor(n),
    evidence,
    // Confidence rises with corpus size — a 3-article corpus proves little.
    confidence: Math.min(0.9, 0.4 + corpus.length / 50),
  };
}

const PRIMARY_SOURCE_PATTERNS = [
  /\.gov(\.[a-z]{2})?\//i,
  /\.mil\//i,
  /\.edu\//i,
  /\.int\//i,
  /\bdoi\.org\//i,
  /\b10\.\d{4,}\//,
  /\bun\.org\//i,
  /\bwho\.int\//i,
];

/** 0 links → 0.3 · 1 → 0.5 · 2 → 0.65 · 3 → 0.8 · 4+ → 0.9 */
export function citationScoreFor(count: number): number {
  if (count <= 0) return 0.3;
  if (count === 1) return 0.5;
  if (count === 2) return 0.65;
  if (count === 3) return 0.8;
  return 0.9;
}

function computeCitationDepth(article: Article): FactorResult | null {
  const body = article.body ?? "";
  // Most RSS feeds ship no body. Guessing a citation count would be inventing a
  // measurement, so this is a skip rather than a zero.
  if (!body.trim()) return null;

  const own = domainOf(article.url);
  const urls = Array.from(body.matchAll(/https?:\/\/[^\s"'<>)]+/g)).map((m) => m[0]);
  const primary = urls.filter(
    (u) => PRIMARY_SOURCE_PATTERNS.some((re) => re.test(u)) && domainOf(u) !== own,
  );
  const uniquePrimary = Array.from(new Set(primary.map((u) => domainOf(u)))).filter(Boolean);

  return {
    score: citationScoreFor(uniquePrimary.length),
    evidence:
      uniquePrimary.length === 0
        ? `No primary-source citations found in the body (${urls.length} outbound link${urls.length === 1 ? "" : "s"} scanned).`
        : `${uniquePrimary.length} primary-source citation${uniquePrimary.length === 1 ? "" : "s"}: ${listOf(uniquePrimary)}.`,
    confidence: 0.8,
  };
}

const FULL_SCORE_HOURS = 6;
const DECAY_END_HOURS = 168; // 7 days
const RECENCY_FLOOR = 0.3;

function computeRecency(article: Article, _corpus: Article[], now = Date.now()): FactorResult | null {
  const t = new Date(article.pubDate).getTime();
  if (!Number.isFinite(t)) return null;

  const hours = (now - t) / 3_600_000;
  if (hours < 0) return null; // future-dated: unusable, not "very fresh"

  let score: number;
  if (hours <= FULL_SCORE_HOURS) score = 1;
  else if (hours >= DECAY_END_HOURS) score = RECENCY_FLOOR;
  else {
    const t01 = (hours - FULL_SCORE_HOURS) / (DECAY_END_HOURS - FULL_SCORE_HOURS);
    score = 1 - t01 * (1 - RECENCY_FLOOR);
  }

  const age =
    hours < 1 ? "under an hour" : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)} days`;
  return {
    score,
    evidence: `Published ${age} ago. For a monitoring tool, stale sourcing is itself a credibility signal.`,
    confidence: 0.95,
  };
}

/** 1 type → 0.3 · 2 → 0.55 · 3 → 0.75 · 4+ → 0.9 */
export function diversityScoreFor(typeCount: number): number {
  if (typeCount <= 1) return 0.3;
  if (typeCount === 2) return 0.55;
  if (typeCount === 3) return 0.75;
  return 0.9;
}

function computeSourceDiversity(
  article: Article,
  corpus: Article[],
  options?: FactorOptions,
): FactorResult | null {
  if (corpus.length <= 1) return null;

  const { domains, types } = analyseCorroboration(article, corpus, options?.clusters);
  // With no corroborators there is nothing to be diverse ACROSS. Reporting 0.3
  // here would double-count the corroboration penalty, so skip instead.
  if (domains.length === 0) return null;

  const ownType = reputationOf(domainOf(article.url) || domainOf(article.source))?.type;
  const all = Array.from(new Set([...(ownType ? [ownType] : []), ...types]));

  if (all.length === 0) return null; // every source unrated — cannot classify

  return {
    score: diversityScoreFor(all.length),
    evidence:
      all.length === 1
        ? `All corroborating sources are the same type (${all[0]}). Five outlets of one kind is weaker corroboration than two of different kinds.`
        : `Corroboration spans ${all.length} source types: ${all.join(", ")}.`,
    confidence: 0.7,
  };
}

function computeCustomKeyword(
  article: Article,
  _corpus: Article[],
  options?: FactorOptions,
): FactorResult | null {
  const raise = (options?.customKeywords?.raise ?? []).map((k) => k.toLowerCase().trim()).filter(Boolean);
  const lower = (options?.customKeywords?.lower ?? []).map((k) => k.toLowerCase().trim()).filter(Boolean);

  // Enabled but with no criterion defined is a configuration gap, not a score.
  if (raise.length === 0 && lower.length === 0) return null;

  const haystack = `${article.title} ${article.body ?? ""}`.toLowerCase();
  const hitsUp = raise.filter((k) => haystack.includes(k));
  const hitsDown = lower.filter((k) => haystack.includes(k));

  const score = Math.max(0, Math.min(1, 0.5 + hitsUp.length * 0.1 - hitsDown.length * 0.15));

  const parts: string[] = [];
  if (hitsUp.length) parts.push(`raised by ${listOf(hitsUp, 5)}`);
  if (hitsDown.length) parts.push(`lowered by ${listOf(hitsDown, 5)}`);

  return {
    score,
    evidence: parts.length
      ? `Analyst criterion: ${parts.join("; ")}.`
      : "Analyst criterion defined, but none of the keywords appear in this article.",
    confidence: 0.6,
  };
}

/**
 * The one model-backed factor (PS-18 §6.1 requires exactly one).
 *
 * SCORING DECISION — three of the four dimensions are scored, one is not.
 *
 * `emotiveLoad`, `absolutism` and `sensationalism` all point the same way: more
 * of each is weaker sourcing, so the score is one minus their mean.
 *
 * `hedging` is deliberately EXCLUDED from the arithmetic and reported as
 * evidence instead, because its direction is genuinely ambiguous. "Officials
 * said" and "according to two people familiar" are careful attribution and a
 * mark of good practice; "reportedly", "sources suggest" and "it is understood"
 * throughout are a piece with no sourcing at all. The assessment returns a
 * single number that cannot distinguish those, and a factor that cannot tell
 * which direction a signal points must not move the score. The analyst sees the
 * figure and judges it.
 *
 * Confidence is 0.55 — materially below every deterministic factor. This is a
 * model's reading of tone, not a measurement of a document property, and the
 * confidence value is where that difference is recorded.
 */
function computeLinguisticMarkers(article: Article, options?: FactorOptions): FactorResult | null {
  const a = options?.language?.[article.id];
  // Not assessed. Assessment is on request per article — sending the whole feed
  // would burn free-tier quota — so absence is the DEFAULT state, not a fault.
  if (!a) return null;

  const scored = [a.emotiveLoad, a.absolutism, a.sensationalism];
  const concern = scored.reduce((s, x) => s + x, 0) / scored.length;
  const score = Math.max(0, Math.min(1, 1 - concern));

  const pct = (x: number) => `${Math.round(x * 100)}%`;

  return {
    score,
    evidence:
      `Model assessment of tone — emotive load ${pct(a.emotiveLoad)}, absolutism ` +
      `${pct(a.absolutism)}, sensationalism ${pct(a.sensationalism)}; these three set the ` +
      `score. Hedging ${pct(a.hedging)} is reported but NOT scored, because careful ` +
      `attribution and vagueness both raise it and this assessment cannot tell them apart. ` +
      `${a.rationale}`,
    confidence: 0.55,
  };
}

// ─── Factor registry ───────────────────────────────────────────────────────

export function defaultFactors(): CredibilityFactor[] {
  return [
    {
      id: "domain_tier",
      name: "Domain reputation",
      description:
        "Rates the publishing domain's editorial model from an editable reputation table — corrections policy, named bylines, original reporting. Unlisted domains are neutral, never penalised.",
      weight: 0.2,
      enabled: true,
      requiresLlm: false,
      compute: (a, _c, o) => computeDomainTier(a, o),
    },
    {
      id: "corroboration",
      name: "Cross-source corroboration",
      description:
        "How many OTHER independent domains in the ingested corpus carry the same story, matched on headline token overlap. Syndicated copies of one wire story are collapsed and counted once.",
      weight: 0.3,
      enabled: true,
      requiresLlm: false,
      compute: (a, c, o) => computeCorroboration(a, c, o),
    },
    {
      id: "citation_depth",
      name: "Citation depth",
      description:
        "Outbound links in the body to primary sources — government, military, academic, treaty-body domains and DOIs. Skipped when the feed supplies no body text.",
      weight: 0.15,
      enabled: true,
      requiresLlm: false,
      compute: (a) => computeCitationDepth(a),
    },
    {
      id: "recency",
      name: "Recency",
      description:
        "Freshness of the report. Full score under 6 hours, decaying to a 0.3 floor beyond 7 days. Old reporting is not less true, only less current.",
      weight: 0.15,
      enabled: true,
      requiresLlm: false,
      compute: (a, c) => computeRecency(a, c),
    },
    {
      id: "source_diversity",
      name: "Source diversity",
      description:
        "Whether corroborating sources span different TYPES — wire, broadsheet, government, specialist, blog — rather than just different domains. Skipped when there are no corroborators.",
      weight: 0.2,
      enabled: true,
      requiresLlm: false,
      compute: (a, c, o) => computeSourceDiversity(a, c, o),
    },
    {
      id: "custom_keyword",
      name: "Custom criterion",
      description:
        "Analyst-defined keyword lists that raise or lower the score, e.g. lower on 'unconfirmed' or 'sources say'. Ships empty and disabled — define your own criterion in the panel.",
      weight: 0.1,
      enabled: false,
      requiresLlm: false,
      compute: (a, c, o) => computeCustomKeyword(a, c, o),
    },
    {
      id: "linguistic_markers",
      name: "Linguistic markers",
      description:
        "Emotive load, absolutism and sensationalism, assessed by the LLM, scored as one minus their mean. Hedging is reported alongside but not scored — attribution and vagueness both raise it. Assessed per article on request, never across the whole feed.",
      weight: 0.15,
      enabled: false,
      requiresLlm: true,
      compute: (a, _c, o) => computeLinguisticMarkers(a, o),
    },
  ];
}

// ─── Scoring engine ────────────────────────────────────────────────────────

export interface FactorBreakdown {
  id: string;
  name: string;
  /** Weight after normalisation across the factors that actually contributed. */
  weight: number;
  rawScore: number;
  /** weight * rawScore — these sum to the overall score. */
  contribution: number;
  evidence: string;
  confidence: number;
}

export interface SkippedFactor {
  id: string;
  name: string;
  reason: string;
}

export interface CredibilityScore {
  article: Article;
  /** 0-1, or null when no factor could be computed. */
  score: number | null;
  /** Weighted mean of contributing factors' own confidences. */
  confidence: number;
  breakdown: FactorBreakdown[];
  skipped: SkippedFactor[];
  explanation: string;
}

function skipReason(
  factor: CredibilityFactor,
  article: Article,
  corpus: Article[],
  options?: FactorOptions,
): string {
  if (!factor.enabled) return "Disabled by the analyst.";
  if (factor.requiresLlm && !options?.language?.[article.id]) {
    return (
      "Language not yet assessed for this article. Assessment is requested per article " +
      "rather than run across the feed, so this reads as not-yet-measured — not as an " +
      "article whose language was checked and found unremarkable."
    );
  }

  const social = options?.social?.[article.id];
  if (social) {
    if (factor.id === "domain_tier") {
      return (
        `Bypassed for social sources: ${social.platform} is the hosting platform, not the ` +
        `publisher, so a domain rating would say the same thing about every account on it. ` +
        `Account maturity and CIB signals carry this weight instead.`
      );
    }
    if (factor.id === "account_maturity") {
      return "No profile was retrieved for this account, so its age and output are unknown.";
    }
    if (factor.id === "cib_signals") {
      return "This post was not part of an assessed cluster, so no CIB signal applies to it.";
    }
  }
  if (factor.id === "account_maturity" || factor.id === "cib_signals") {
    return "Applies only to social posts; this is a published article.";
  }
  if (factor.id === "citation_depth" && !article.body?.trim()) return "Feed supplied no body text to scan.";
  if (factor.id === "corroboration" && corpus.length <= 1) return "Corpus has no other articles to compare against.";
  if (factor.id === "source_diversity") return "No corroborating sources to measure diversity across.";
  if (factor.id === "custom_keyword") return "No keyword criterion defined.";
  if (factor.id === "recency") return "Article has no usable publication date.";
  if (factor.id === "domain_tier") return "No resolvable domain for this article.";
  return "Factor returned no value for this article.";
}

export function bandFor(score: number | null): { label: string; tone: "high" | "medium" | "low" | "unknown" } {
  if (score === null) return { label: "Unscored", tone: "unknown" };
  if (score >= 0.7) return { label: "High", tone: "high" };
  if (score >= 0.45) return { label: "Moderate", tone: "medium" };
  return { label: "Low", tone: "low" };
}

/** One sentence an analyst can act on, naming the strongest driver each way. */
function explain(score: number | null, breakdown: FactorBreakdown[], skipped: SkippedFactor[]): string {
  if (score === null) {
    return "Not scored — no factor could be computed for this article.";
  }
  const band = bandFor(score).label.toLowerCase();
  const ranked = [...breakdown].sort((a, b) => b.rawScore - a.rawScore);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  const clauses: string[] = [];
  if (best && best.rawScore >= 0.6) clauses.push(best.evidence.replace(/\.$/, ""));
  if (worst && worst !== best && worst.rawScore < 0.5) clauses.push(`but ${worst.evidence.replace(/\.$/, "").toLowerCase()}`);

  const skippedNote = skipped.length ? ` ${skipped.length} factor${skipped.length === 1 ? "" : "s"} skipped.` : "";
  const body = clauses.length ? `: ${clauses.join(", ")}` : "";
  return `${band.charAt(0).toUpperCase() + band.slice(1)} credibility (${score.toFixed(2)})${body}.${skippedNote}`;
}

export function scoreArticle(
  article: Article,
  corpus: Article[],
  factors: CredibilityFactor[],
  options?: FactorOptions,
): CredibilityScore {
  const computed: { factor: CredibilityFactor; result: FactorResult }[] = [];
  const skipped: SkippedFactor[] = [];

  for (const factor of factors) {
    if (!factor.enabled || factor.weight <= 0) {
      skipped.push({
        id: factor.id,
        name: factor.name,
        reason: factor.weight <= 0 && factor.enabled ? "Weight set to zero." : skipReason(factor, article, corpus, options),
      });
      continue;
    }
    const result = factor.compute(article, corpus, options);
    if (result === null) {
      skipped.push({ id: factor.id, name: factor.name, reason: skipReason(factor, article, corpus, options) });
      continue;
    }
    computed.push({ factor, result });
  }

  const totalWeight = computed.reduce((s, c) => s + c.factor.weight, 0);
  if (computed.length === 0 || totalWeight <= 0) {
    return {
      article,
      score: null,
      confidence: 0,
      breakdown: [],
      skipped,
      explanation: explain(null, [], skipped),
    };
  }

  // Normalise so weights always sum to 1 regardless of which factors are off.
  const breakdown: FactorBreakdown[] = computed.map(({ factor, result }) => {
    const weight = factor.weight / totalWeight;
    return {
      id: factor.id,
      name: factor.name,
      weight,
      rawScore: result.score,
      contribution: weight * result.score,
      evidence: result.evidence,
      confidence: result.confidence,
    };
  });

  const score = breakdown.reduce((s, b) => s + b.contribution, 0);
  const confidence = breakdown.reduce((s, b) => s + b.weight * b.confidence, 0);

  return { article, score, confidence, breakdown, skipped, explanation: explain(score, breakdown, skipped) };
}

export function scoreCorpus(
  corpus: Article[],
  factors: CredibilityFactor[],
  options?: FactorOptions,
): CredibilityScore[] {
  // Cluster once for the whole corpus, then reuse. Without this each article
  // would re-cluster the entire feed.
  const withClusters: FactorOptions = {
    ...options,
    clusters: options?.clusters ?? clusterStories(corpus),
  };
  return corpus
    .map((a) => scoreArticle(a, corpus, factors, withClusters))
    .sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
}

// ─── Weight profiles ───────────────────────────────────────────────────────

export interface FactorSetting {
  weight: number;
  enabled: boolean;
}

export interface WeightProfile {
  id: string;
  name: string;
  settings: Record<string, FactorSetting>;
  customKeywords: { raise: string[]; lower: string[] };
  /** Built-ins cannot be renamed or deleted. */
  builtin?: boolean;
}

const settingsFrom = (f: CredibilityFactor[]): Record<string, FactorSetting> =>
  Object.fromEntries(f.map((x) => [x.id, { weight: x.weight, enabled: x.enabled }]));

export function builtinProfiles(): WeightProfile[] {
  const base = defaultFactors();
  return [
    {
      id: "default",
      name: "Default",
      settings: settingsFrom(base),
      customKeywords: { raise: [], lower: [] },
      builtin: true,
    },
    {
      id: "breaking",
      name: "Breaking news",
      // A single uncorroborated first report is the risk case; recency matters
      // because a day-old "breaking" item has already been overtaken.
      settings: {
        domain_tier: { weight: 0.15, enabled: true },
        corroboration: { weight: 0.4, enabled: true },
        citation_depth: { weight: 0.05, enabled: true },
        recency: { weight: 0.25, enabled: true },
        source_diversity: { weight: 0.15, enabled: true },
        custom_keyword: { weight: 0.1, enabled: false },
        linguistic_markers: { weight: 0.15, enabled: false },
      },
      customKeywords: { raise: [], lower: ["unconfirmed", "sources say", "reportedly", "rumour"] },
      builtin: true,
    },
    {
      id: "longform",
      name: "Long-form analysis",
      // Recency is nearly irrelevant; sourcing discipline dominates.
      settings: {
        domain_tier: { weight: 0.3, enabled: true },
        corroboration: { weight: 0.15, enabled: true },
        citation_depth: { weight: 0.35, enabled: true },
        recency: { weight: 0.05, enabled: true },
        source_diversity: { weight: 0.15, enabled: true },
        custom_keyword: { weight: 0.1, enabled: false },
        linguistic_markers: { weight: 0.15, enabled: false },
      },
      customKeywords: { raise: [], lower: [] },
      builtin: true,
    },
  ];
}

export function applyProfile(factors: CredibilityFactor[], profile: WeightProfile): CredibilityFactor[] {
  return factors.map((f) => {
    const s = profile.settings[f.id];
    return s ? { ...f, weight: s.weight, enabled: s.enabled } : f;
  });
}

const PROFILE_KEY = "sentinel_credibility_profiles";

export function loadCustomProfiles(): WeightProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => p && !p.builtin) : [];
  } catch {
    // A corrupt profile store must not take the page down.
    return [];
  }
}

export function saveCustomProfiles(profiles: WeightProfile[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles.filter((p) => !p.builtin)));
}
