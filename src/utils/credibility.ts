/**
 * Module 1 — source credibility, scored on user-defined factors.
 *
 * PS-18 §6.1 asks for credibility "based on user defined factors", so the
 * configurability is the requirement — not the number. Every factor carries a
 * weight the analyst controls, and every score returns a per-factor breakdown
 * explaining itself. An unexplained score is useless to an analyst and
 * unauditable in a defence context.
 *
 * Five of the six factors are deterministic, free and instant. Only
 * `linguistic_markers` costs an LLM call, and it is opt-in per article so a
 * free-tier quota is not burned scoring an entire feed.
 *
 * A factor that cannot be computed returns `score: null` and is EXCLUDED from
 * the weighted mean — it is never silently treated as 0.5, because a neutral
 * default is an invented measurement. Articles scored without every factor are
 * marked `partial` so the UI can say so.
 */

import { createServerFn } from "@tanstack/react-start";

// ─── Domain reputation ─────────────────────────────────────────────────────
// Starter list. Tiers reflect editorial model, not political alignment:
//   1.0  international wire services — correction policies, named bylines
//   0.8  major outlets with published editorial standards
//   0.6  established national press
//   0.3  state-controlled or state-funded outlets (editorial independence is
//        structurally constrained; this is a documented fact about ownership,
//        not a judgement about any individual article)
//   0.2  aggregators and content farms with no original reporting
// Analysts should edit this for their own theatre — it is a starting point.

export const DOMAIN_TIERS: Record<string, number> = {
  "reuters.com": 1.0, "apnews.com": 1.0, "afp.com": 1.0, "pti.in": 1.0,
  "bbc.com": 0.9, "bbc.co.uk": 0.9, "ft.com": 0.85, "economist.com": 0.85,
  "wsj.com": 0.85, "nytimes.com": 0.8, "washingtonpost.com": 0.8,
  "theguardian.com": 0.8, "bloomberg.com": 0.8, "aljazeera.com": 0.75,
  "cnn.com": 0.7, "nbcnews.com": 0.7, "cbsnews.com": 0.7, "abcnews.go.com": 0.7,
  "npr.org": 0.8, "politico.com": 0.7, "axios.com": 0.7,
  "thehindu.com": 0.8, "indianexpress.com": 0.75,
  "timesofindia.indiatimes.com": 0.65, "hindustantimes.com": 0.7,
  "livemint.com": 0.7, "thewire.in": 0.65, "scroll.in": 0.65,
  "theprint.in": 0.65, "ndtv.com": 0.65, "news18.com": 0.55,
  "defensenews.com": 0.8, "janes.com": 0.85, "breakingdefense.com": 0.75,
  "thediplomat.com": 0.7, "warontherocks.com": 0.75,
  "bellingcat.com": 0.75, "krebsonsecurity.com": 0.8,
  "bleepingcomputer.com": 0.7, "therecord.media": 0.75,
  "rt.com": 0.3, "tass.com": 0.3, "sputniknews.com": 0.3,
  "globaltimes.cn": 0.3, "xinhuanet.com": 0.3, "presstv.ir": 0.3,
  "msn.com": 0.2, "news.google.com": 0.2,
};

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ScorableArticle {
  id: string;
  title: string;
  source: string;
  url: string;
  pubDate: string;
  body?: string;
}

export interface FactorResult {
  id: string;
  name: string;
  /** 0-1, or null when the factor could not be computed for this article. */
  score: number | null;
  weight: number;
  /** Analyst-facing explanation of how this score was reached. */
  detail: string;
}

export interface ScoredArticle {
  article: ScorableArticle;
  /** Weighted mean of available factors, 0-1. Null if nothing could be computed. */
  score: number | null;
  factors: FactorResult[];
  /** True when at least one factor could not be computed. */
  partial: boolean;
}

export interface FactorDefinition {
  id: string;
  name: string;
  description: string;
  defaultWeight: number;
  requiresLlm: boolean;
}

export const FACTORS: FactorDefinition[] = [
  {
    id: "domain_tier",
    name: "Domain reputation",
    description: "Editorial model of the publishing domain, from an editable reputation list.",
    defaultWeight: 0.25,
    requiresLlm: false,
  },
  {
    id: "corroboration",
    name: "Cross-source corroboration",
    description: "How many other independent domains in the current feed carry the same story.",
    defaultWeight: 0.3,
    requiresLlm: false,
  },
  {
    id: "domain_age",
    name: "Domain age",
    description: "Age of the domain registration via RDAP. Newly registered domains are weaker sources.",
    defaultWeight: 0.1,
    requiresLlm: false,
  },
  {
    id: "citation_depth",
    name: "Citation depth",
    description: "Outbound links to primary sources in the article body.",
    defaultWeight: 0.1,
    requiresLlm: false,
  },
  {
    id: "recency",
    name: "Recency",
    description: "Freshness of the report. Older items are not less true, only less current.",
    defaultWeight: 0.1,
    requiresLlm: false,
  },
  {
    id: "linguistic_markers",
    name: "Linguistic markers",
    description: "Emotive load, hedging, absolutism and sensationalism, assessed by the LLM.",
    defaultWeight: 0.15,
    requiresLlm: true,
  },
];

export type Weights = Record<string, number>;

export const DEFAULT_WEIGHTS: Weights = Object.fromEntries(
  FACTORS.map((f) => [f.id, f.defaultWeight]),
);

export interface WeightProfile {
  id: string;
  name: string;
  weights: Weights;
}

/** Starting profiles. Analysts can add their own; these are only defaults. */
export const BUILTIN_PROFILES: WeightProfile[] = [
  { id: "balanced", name: "Balanced", weights: { ...DEFAULT_WEIGHTS } },
  {
    id: "breaking",
    name: "Breaking news",
    // Corroboration and recency dominate; a single uncorroborated first report
    // is exactly the risk case here.
    weights: {
      domain_tier: 0.2, corroboration: 0.4, domain_age: 0.05,
      citation_depth: 0.05, recency: 0.2, linguistic_markers: 0.1,
    },
  },
  {
    id: "longform",
    name: "Long-form analysis",
    // Recency barely matters; sourcing discipline matters most.
    weights: {
      domain_tier: 0.3, corroboration: 0.15, domain_age: 0.1,
      citation_depth: 0.25, recency: 0.0, linguistic_markers: 0.2,
    },
  },
  {
    id: "social",
    name: "Social / low-trust",
    // Unknown domains and manipulative language are the dominant signals.
    weights: {
      domain_tier: 0.2, corroboration: 0.25, domain_age: 0.2,
      citation_depth: 0.05, recency: 0.05, linguistic_markers: 0.25,
    },
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

export function domainOf(value: string): string {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return "";
  // Accept either a URL or a bare publisher name that happens to be a domain.
  const withoutScheme = raw.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  const host = withoutScheme.split(/[/?#]/)[0];
  return host.includes(".") ? host : "";
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "to", "for", "with", "at",
  "by", "from", "as", "is", "are", "was", "were", "be", "after", "over",
  "says", "said", "amid", "new",
]);

/**
 * Very light suffix stripping. Without it "India tests missile" and "missile
 * test confirmed" score 0.30 and read as different stories, which is wrong.
 * Length guards keep short words intact ("news" stays "news", "gas" stays
 * "gas") — this is deliberately cruder and safer than a real stemmer.
 */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function titleTokens(title: string): Set<string> {
  return new Set(
    (title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
      .map(stem),
  );
}

/** Jaccard overlap of significant title tokens. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

const SAME_STORY_THRESHOLD = 0.42;

// ─── Factor computation ────────────────────────────────────────────────────

export interface ScoringContext {
  /** Every article currently ingested — needed for corroboration. */
  all: ScorableArticle[];
  /** domain -> registration ISO date. Absent entries are simply unknown. */
  domainAges?: Record<string, string | null>;
  /** articleId -> language assessment, only for articles the analyst expanded. */
  language?: Record<string, { emotiveLoad: number; hedging: number; absolutism: number; sensationalism: number; rationale: string }>;
}

function scoreDomainTier(a: ScorableArticle): FactorResult {
  const base = { id: "domain_tier", name: "Domain reputation", weight: 0 };
  const domain = domainOf(a.url) || domainOf(a.source);

  if (!domain) {
    return { ...base, score: null, detail: `No resolvable domain for "${a.source}".` };
  }
  // Longest suffix match, so news.bbc.co.uk matches bbc.co.uk.
  const key = Object.keys(DOMAIN_TIERS)
    .filter((d) => domain === d || domain.endsWith(`.${d}`))
    .sort((x, y) => y.length - x.length)[0];

  if (!key) {
    return { ...base, score: null, detail: `${domain} is not in the reputation list — unrated, not penalised.` };
  }
  return { ...base, score: DOMAIN_TIERS[key], detail: `${domain} rated ${DOMAIN_TIERS[key].toFixed(2)} in the reputation list.` };
}

function scoreCorroboration(a: ScorableArticle, ctx: ScoringContext): FactorResult {
  const base = { id: "corroboration", name: "Cross-source corroboration", weight: 0 };
  const own = domainOf(a.url) || domainOf(a.source) || a.source;

  const others = new Set<string>();
  for (const other of ctx.all) {
    if (other.id === a.id) continue;
    const d = domainOf(other.url) || domainOf(other.source) || other.source;
    if (!d || d === own) continue;
    if (titleSimilarity(a.title, other.title) >= SAME_STORY_THRESHOLD) others.add(d);
  }

  const n = others.size;
  // Saturating: 3+ independent outlets is strong corroboration.
  const score = Math.min(n / 3, 1);
  const detail =
    n === 0
      ? "No other domain in the current feed carries this story."
      : `${n} independent domain${n === 1 ? "" : "s"} carry this story: ${[...others].slice(0, 4).join(", ")}${n > 4 ? "…" : ""}.`;
  return { ...base, score, detail };
}

function scoreDomainAge(a: ScorableArticle, ctx: ScoringContext): FactorResult {
  const base = { id: "domain_age", name: "Domain age", weight: 0 };
  const domain = domainOf(a.url) || domainOf(a.source);
  const registered = domain ? ctx.domainAges?.[domain] : undefined;

  if (!registered) {
    return { ...base, score: null, detail: domain ? `Registration date for ${domain} not retrieved.` : "No resolvable domain." };
  }
  const years = (Date.now() - new Date(registered).getTime()) / (365.25 * 24 * 3600 * 1000);
  if (!Number.isFinite(years) || years < 0) {
    return { ...base, score: null, detail: `Unusable registration date for ${domain}.` };
  }
  // Saturates at 10 years — beyond that, age adds little signal.
  const score = Math.min(years / 10, 1);
  return { ...base, score, detail: `${domain} registered ${years.toFixed(1)} years ago (${registered.slice(0, 10)}).` };
}

function scoreCitationDepth(a: ScorableArticle): FactorResult {
  const base = { id: "citation_depth", name: "Citation depth", weight: 0 };
  const body = a.body ?? "";
  if (!body.trim()) {
    // RSS frequently gives no body. Guessing would invent a measurement.
    return { ...base, score: null, detail: "No article body available from the feed to count citations." };
  }
  const own = domainOf(a.url);
  const links = Array.from(body.matchAll(/https?:\/\/([^\s"'<>)]+)/g))
    .map((m) => domainOf(m[1]))
    .filter((d) => d && d !== own);
  const unique = new Set(links);
  const score = Math.min(unique.size / 4, 1);
  return {
    ...base,
    score,
    detail: unique.size === 0
      ? "No outbound citations to other domains in the body."
      : `${unique.size} outbound citation${unique.size === 1 ? "" : "s"}: ${[...unique].slice(0, 3).join(", ")}.`,
  };
}

function scoreRecency(a: ScorableArticle): FactorResult {
  const base = { id: "recency", name: "Recency", weight: 0 };
  const t = new Date(a.pubDate).getTime();
  if (!Number.isFinite(t)) {
    return { ...base, score: null, detail: "No usable publication date on this item." };
  }
  const hours = (Date.now() - t) / 3600000;
  if (hours < 0) {
    return { ...base, score: null, detail: "Publication date is in the future — treated as unusable." };
  }
  // Full marks under 6h, decaying to zero at one week.
  const score = hours <= 6 ? 1 : Math.max(0, 1 - (hours - 6) / (168 - 6));
  return { ...base, score, detail: `Published ${hours < 1 ? "under an hour" : `${Math.round(hours)}h`} ago.` };
}

function scoreLinguistic(a: ScorableArticle, ctx: ScoringContext): FactorResult {
  const base = { id: "linguistic_markers", name: "Linguistic markers", weight: 0 };
  const assessment = ctx.language?.[a.id];
  if (!assessment) {
    return { ...base, score: null, detail: "Not assessed — expand this article to run the language check." };
  }
  // Hedging is a positive signal (appropriate uncertainty); the rest are negative.
  const negative = (assessment.emotiveLoad + assessment.absolutism + assessment.sensationalism) / 3;
  const score = Math.max(0, Math.min(1, 1 - negative + assessment.hedging * 0.15));
  return { ...base, score, detail: assessment.rationale };
}

// ─── Scoring engine ────────────────────────────────────────────────────────

export function scoreArticle(
  article: ScorableArticle,
  ctx: ScoringContext,
  weights: Weights,
): ScoredArticle {
  const results: FactorResult[] = [
    scoreDomainTier(article),
    scoreCorroboration(article, ctx),
    scoreDomainAge(article, ctx),
    scoreCitationDepth(article),
    scoreRecency(article),
    scoreLinguistic(article, ctx),
  ].map((r) => ({ ...r, weight: weights[r.id] ?? 0 }));

  // Only factors that produced a value AND carry weight contribute. Renormalising
  // over available weight avoids penalising an article for a factor we simply
  // could not compute.
  const usable = results.filter((r) => r.score !== null && r.weight > 0);
  const totalWeight = usable.reduce((s, r) => s + r.weight, 0);
  const score = totalWeight > 0
    ? usable.reduce((s, r) => s + (r.score as number) * r.weight, 0) / totalWeight
    : null;

  return {
    article,
    score,
    factors: results,
    partial: results.some((r) => r.score === null && r.weight > 0),
  };
}

export function scoreAll(
  articles: ScorableArticle[],
  ctx: ScoringContext,
  weights: Weights,
): ScoredArticle[] {
  return articles
    .map((a) => scoreArticle(a, ctx, weights))
    .sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
}

export function bandFor(score: number | null): { label: string; tone: "high" | "medium" | "low" | "unknown" } {
  if (score === null) return { label: "Unscored", tone: "unknown" };
  if (score >= 0.75) return { label: "High", tone: "high" };
  if (score >= 0.5) return { label: "Medium", tone: "medium" };
  return { label: "Low", tone: "low" };
}

// ─── Domain age lookup (RDAP) ──────────────────────────────────────────────

/**
 * Batch RDAP registration lookup. Free, no key, no account.
 * A domain that cannot be resolved maps to null — the factor then reports
 * itself as uncomputable rather than contributing a fabricated age.
 */
export const fetchDomainAges = createServerFn({ method: "POST" })
  .validator((d: { domains: string[] }) => d)
  .handler(async ({ data }): Promise<Record<string, string | null>> => {
    const domains = Array.from(new Set((data?.domains ?? []).filter(Boolean))).slice(0, 25);
    const out: Record<string, string | null> = {};

    await Promise.all(
      domains.map(async (domain) => {
        try {
          const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
            headers: { accept: "application/rdap+json" },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) {
            out[domain] = null;
            return;
          }
          const json: any = await res.json();
          const events: any[] = Array.isArray(json?.events) ? json.events : [];
          const reg = events.find((e) => e?.eventAction === "registration");
          out[domain] = typeof reg?.eventDate === "string" ? reg.eventDate : null;
        } catch {
          out[domain] = null;
        }
      }),
    );

    return out;
  });
