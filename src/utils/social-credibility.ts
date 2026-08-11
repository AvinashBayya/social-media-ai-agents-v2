/**
 * Module 3 → Module 1 / Module 2 bridge.
 *
 * Three integrations, all of which exist so that a social post is a first-class
 * corpus member rather than a separate universe:
 *
 *   1. Social posts are scored by Module 1's engine, with domain_tier bypassed
 *      (bsky.app is a host, not a publisher) and two social-specific factors in
 *      its place: account maturity and CIB signals.
 *   2. Module 2's extractEntities() runs over social posts unchanged, because a
 *      post converted by postToArticle() IS an Article.
 *   3. clusterStories() groups social posts alongside news covering the same
 *      event. Cross-modal corroboration — a claim appearing on Bluesky forty
 *      minutes before any outlet carries it, or a viral post with no reporting
 *      behind it at all — is the strongest single output of the three.
 *
 * Nothing here invents a value. Where Module 3 could not measure something, the
 * corresponding factor is skipped with a stated reason rather than defaulted.
 */

import type { Article } from "./analysis";
import { clusterStories, sourceKeyOf, type StoryCluster } from "./analysis";
import { accountMaturity, analyseCib, type AnalyseOptions, type CibCluster } from "./cib";
import type { BlueskyProfile, SocialPost } from "./social";
import type {
  CredibilityFactor,
  FactorOptions,
  FactorResult,
  SocialSignalContext,
} from "./credibility";

// ─── Post → Article ────────────────────────────────────────────────────────

/** How much of a post's text stands in as its "headline" for clustering. */
const TITLE_CHARS = 160;

/**
 * A social post as Module 1 and Module 2 see it.
 *
 * `title` is the leading text rather than a real headline, because a post has
 * none. Clustering compares titles, so this is what a post is matched on — which
 * is right: the opening of a post carries its claim, the same way a headline does.
 * Full text stays in `body` so entity extraction and citation scanning see all of it.
 */
export function postToArticle(post: SocialPost): Article {
  const text = (post.text || "").replace(/\s+/g, " ").trim();
  return {
    id: post.id,
    title: text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS)}…` : text,
    source: post.author || post.authorId,
    url: post.url,
    pubDate: post.createdAt,
    body: text,
  };
}

export function postsToArticles(posts: SocialPost[]): Article[] {
  return posts.map(postToArticle).filter((a) => a.title);
}

// ─── Building the social context Module 1 consumes ─────────────────────────

/**
 * Assemble per-post context from a CIB pass and whatever profiles were fetched.
 *
 * A post that ended up in no assessed cluster still gets an entry — its presence
 * is what tells Module 1 to bypass domain_tier — but with cibScore null, so the
 * CIB factor is skipped for it rather than scored as clean.
 */
export function buildSocialContext(
  posts: SocialPost[],
  clusters: CibCluster[],
  profiles: BlueskyProfile[] = [],
  now = Date.now(),
): Record<string, SocialSignalContext> {
  const clusterOf = new Map<string, CibCluster>();
  for (const c of clusters) for (const p of c.posts) clusterOf.set(p.id, c);

  const out: Record<string, SocialSignalContext> = {};
  for (const post of posts) {
    const cluster = clusterOf.get(post.id);

    // Maturity is per-ACCOUNT, so it is computed from this post alone rather
    // than inherited from the cluster mean: a mature account inside a young
    // cluster must not be tarred with the cluster's average.
    const { signal: maturity } = accountMaturity([post], profiles, now);

    out[post.id] = {
      platform: post.platform,
      account: post.author || post.authorId,
      maturityConcern: maturity.score,
      maturityEvidence: maturity.score === null ? (maturity.skipped ?? "") : maturity.evidence,
      cibScore: cluster?.compositeScore ?? null,
      cibEvidence: cluster
        ? `Cluster of ${cluster.posts.length} posts from ${cluster.accounts.length} accounts; ` +
          `${cluster.signalsComputed} of 5 signals computed` +
          `${cluster.signalsSkipped ? `, ${cluster.signalsSkipped} skipped` : ""}. ` +
          cluster.signals
            .filter((s) => s.score !== null && s.score > 0)
            .map((s) => `${s.label} ${s.score!.toFixed(2)}`)
            .join(", ")
        : "",
      cibSignalsComputed: cluster?.signalsComputed ?? 0,
    };
  }
  return out;
}

// ─── Social-specific credibility factors ───────────────────────────────────

function computeAccountMaturity(article: Article, options?: FactorOptions): FactorResult | null {
  const social = options?.social?.[article.id];
  if (!social || social.maturityConcern === null) return null;

  // Concern inverts into credibility: a three-day-old account posting 400 times
  // to two followers is not evidence the claim is false, but it is a weaker
  // provenance than an established account, and this is where that goes.
  const score = 1 - social.maturityConcern;
  return {
    score,
    evidence: `${social.account}: ${social.maturityEvidence}`,
    // Account age is a fact; what it implies about a specific claim is not, so
    // this factor never asserts high confidence.
    confidence: 0.6,
  };
}

function computeCibSignals(article: Article, options?: FactorOptions): FactorResult | null {
  const social = options?.social?.[article.id];
  if (!social || social.cibScore === null) return null;

  const score = 1 - social.cibScore;
  return {
    score,
    evidence:
      `Coordination signals for this post's cluster score ${social.cibScore.toFixed(2)}. ` +
      `${social.cibEvidence} Coordinated is not the same as inauthentic — treat as a prompt ` +
      `to review, not a verdict.`,
    // Deliberately low. Coordination is a real observation, but the inference
    // from "coordinated" to "less credible" is exactly the leap the module warns
    // against, so this factor is not allowed to speak with authority.
    confidence: 0.45,
  };
}

/**
 * The two factors that replace domain_tier for social sources.
 *
 * Weights are deliberately modest. A post is not less true because its author is
 * new, and organised campaigning is legal and common; these are provenance
 * signals, not truth signals, and the corroboration factor — which works
 * identically for social posts, since clusterStories() spans both — should
 * remain the dominant term.
 */
export function socialFactors(): CredibilityFactor[] {
  return [
    {
      id: "account_maturity",
      name: "Account maturity",
      description:
        "Account age against posting volume and audience, from the platform's own profile data. " +
        "Reports the real numbers as evidence. Skipped when no profile could be retrieved — " +
        "an unfetched profile is not a mature account.",
      weight: 0.15,
      enabled: true,
      requiresLlm: false,
      compute: (a, _c, o) => computeAccountMaturity(a, o),
    },
    {
      id: "cib_signals",
      name: "Coordination signals",
      description:
        "Composite of the five CIB signals for this post's cluster: temporal synchrony, content " +
        "duplication, account maturity, handle patterns and amplification. Lowers provenance " +
        "confidence, never asserts inauthenticity.",
      weight: 0.15,
      enabled: true,
      requiresLlm: false,
      compute: (a, _c, o) => computeCibSignals(a, o),
    },
  ];
}

// ─── Cross-modal clustering ────────────────────────────────────────────────

export interface CrossModalCluster {
  cluster: StoryCluster;
  newsMembers: Article[];
  socialMembers: Article[];
  /** True when the cluster contains both a social post and a published article. */
  crossModal: boolean;
  /**
   * Minutes by which social chatter preceded the first published report.
   * Positive means social was first. Null when either side is undated or absent.
   */
  socialLeadMinutes: number | null;
  /** One-line analyst-facing reading of the above. */
  summary: string;
}

const timeOf = (a: Article): number => {
  const t = new Date(a.pubDate).getTime();
  return Number.isFinite(t) ? t : NaN;
};

/**
 * Cluster news and social together and report where the two modes meet.
 *
 * Three readings come out of this, and all three matter to an analyst:
 *   - social AND news → the claim is corroborated across modes
 *   - social only     → a claim circulating with no reporting behind it
 *   - social first    → chatter preceding coverage, which is either an early
 *                       indicator or a seeded narrative, and the timing is the
 *                       first thing you would want to know either way
 */
export function clusterAcrossModes(news: Article[], posts: SocialPost[]): CrossModalCluster[] {
  const socialArticles = postsToArticles(posts);
  const socialIds = new Set(socialArticles.map((a) => a.id));
  const clusters = clusterStories([...news, ...socialArticles]);

  return clusters.map((cluster) => {
    const socialMembers = cluster.members.filter((m) => socialIds.has(m.id));
    const newsMembers = cluster.members.filter((m) => !socialIds.has(m.id));
    const crossModal = socialMembers.length > 0 && newsMembers.length > 0;

    const firstSocial = socialMembers
      .map(timeOf)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    const firstNews = newsMembers
      .map(timeOf)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    const socialLeadMinutes =
      firstSocial !== undefined && firstNews !== undefined
        ? Math.round((firstNews - firstSocial) / 60_000)
        : null;

    let summary: string;
    if (crossModal && socialLeadMinutes !== null && socialLeadMinutes > 0) {
      summary =
        `Social chatter preceded the first published report by ${socialLeadMinutes} minute(s). ` +
        `${socialMembers.length} post(s) and ${newsMembers.length} article(s) from ` +
        `${cluster.independentDomains.length} distinct source(s).`;
    } else if (crossModal && socialLeadMinutes !== null && socialLeadMinutes < 0) {
      summary =
        `Reporting came first; social pickup followed ${Math.abs(socialLeadMinutes)} minute(s) later. ` +
        `${newsMembers.length} article(s), ${socialMembers.length} post(s).`;
    } else if (crossModal) {
      summary = `Carried by both social (${socialMembers.length}) and published reporting (${newsMembers.length}).`;
    } else if (socialMembers.length > 0) {
      summary =
        `Circulating on ${socialMembers.length === 1 ? "one account" : `${socialMembers.length} posts`} ` +
        `with NO published reporting in this corpus. Uncorroborated by any outlet collected.`;
    } else {
      summary = `Published reporting only — no matching social traffic in the collected window.`;
    }

    return { cluster, newsMembers, socialMembers, crossModal, socialLeadMinutes, summary };
  });
}

// ─── One-call pipeline ─────────────────────────────────────────────────────

export interface SocialAssessment {
  cibClusters: CibCluster[];
  context: Record<string, SocialSignalContext>;
  articles: Article[];
  /** Accounts appearing in flagged clusters — the set worth fetching profiles for. */
  accountsWorthResolving: string[];
}

/**
 * Run the CIB pass and build everything Module 1 needs, in one call.
 *
 * `accountsWorthResolving` exists because profile lookups are rate-limited: the
 * accounts inside a flagged cluster are the ones where a profile changes the
 * assessment, so those are fetched rather than every account in the buffer.
 */
export function assessSocialCorpus(
  posts: SocialPost[],
  options: AnalyseOptions = {},
): SocialAssessment {
  const cibClusters = analyseCib(posts, options);
  const context = buildSocialContext(posts, cibClusters, options.profiles ?? [], options.now);
  const accountsWorthResolving = Array.from(
    new Set(cibClusters.filter((c) => c.flagged).flatMap((c) => c.accounts)),
  );
  return {
    cibClusters,
    context,
    articles: postsToArticles(posts),
    accountsWorthResolving,
  };
}

/** Convenience: source key for a social post, matching Module 2's convention. */
export function socialSourceKey(post: SocialPost): string {
  return sourceKeyOf(postToArticle(post));
}
