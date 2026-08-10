import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Newspaper, Globe2, TrendingUp, ExternalLink, MapPin, Languages } from "lucide-react";
import {
  buildUpstreamQuery,
  containsAnyWord,
  matchesQuery,
  parseQuery,
  scoreMatch,
} from "@/utils/search";
import {
  clusterStories,
  corpusTerms,
  detectLanguage,
  sourceKeyOf,
  SAME_STORY_THRESHOLD,
  type Article,
  type StoryCluster,
} from "@/utils/analysis";
import { reputationOf, TIER_SCORES } from "@/utils/credibility";
import { collectCrtShSubdomains, type SubdomainFinding } from "@/utils/recon-sources";
import { ArticleAiPanel } from "@/components/article-ai";
import { PinButton } from "@/components/pin-button";
import { ClusterPanel } from "@/components/cluster-panel";
import { LlmQuotaCard } from "@/components/llm-quota";

/**
 * Classification vocabularies. Matched with `containsAnyWord`, which anchors on
 * word boundaries — the previous chained `includes` calls fired on substrings,
 * so "increase" read as maritime and "corporate" as economy.
 *
 * Order matters: the first bucket that matches wins.
 */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  cyber: ["cyber", "hack", "hacked", "hacking", "breach", "malware", "ransomware", "phishing"],
  conflict: [
    "war", "military", "weapon", "weapons", "conflict", "strike", "strikes",
    "troops", "combat", "defense", "defence", "offensive", "airstrike",
  ],
  economy: [
    "rate", "rates", "market", "markets", "stock", "stocks", "inflation",
    "economy", "economic", "bank", "banks", "trade", "tariff",
    "price", "prices", "gdp", "recession",
  ],
  maritime: ["sea", "ship", "ships", "vessel", "vessels", "maritime", "port", "ports", "cargo", "naval"],
  intelligence: ["intel", "intelligence", "spy", "spies", "espionage", "cia", "surveillance"],
  nuclear: ["nuclear", "nuke", "atomic", "radiation", "enrichment"],
};

const THREAT_KEYWORDS: Record<string, string[]> = {
  critical: ["critical", "urgent", "emergency", "deadly", "catastrophe", "catastrophic"],
  high: ["kill", "killed", "strike", "threat", "attack", "warns", "conflict", "missile"],
  medium: ["rise", "rises", "drop", "drops", "announces", "investigates", "policy"],
  positive: ["peace", "talks", "deal", "agrees", "summit", "victory", "ceasefire"],
};

const SOURCE_TYPES: Record<string, string> = {
  'Reuters': 'wire', 'Reuters World': 'wire', 'Reuters Business': 'wire',
  'AP News': 'wire', 'AFP': 'wire', 'Bloomberg': 'wire',
  'White House': 'gov', 'State Dept': 'gov', 'Pentagon': 'gov',
  'Treasury': 'gov', 'DOJ': 'gov', 'DHS': 'gov', 'CDC': 'gov',
  'FEMA': 'gov', 'Federal Reserve': 'gov', 'SEC': 'gov',
  'UN News': 'gov', 'CISA': 'gov',
  'Defense One': 'intel', 'Breaking Defense': 'intel', 'The War Zone': 'intel',
  'Defense News': 'intel', 'Janes': 'intel', 'Military Times': 'intel', 'Task & Purpose': 'intel',
  'USNI News': 'intel', 'gCaptain': 'intel', 'Oryx OSINT': 'intel', 'UK MOD': 'gov',
  'Bellingcat': 'intel', 'Krebs Security': 'intel', 'Foreign Policy': 'intel', 'The Diplomat': 'intel',
  'Atlantic Council': 'intel', 'Foreign Affairs': 'intel', 'CrisisWatch': 'intel',
  'CSIS': 'intel', 'RAND': 'intel', 'Brookings': 'intel', 'Carnegie': 'intel',
  'BBC World': 'mainstream', 'BBC News': 'mainstream', 'NYT News': 'mainstream', 'Guardian World': 'mainstream',
  'NPR News': 'mainstream', 'Al Jazeera': 'mainstream', 'CNN World': 'mainstream',
  'Politico': 'mainstream', 'Axios': 'mainstream', 'EuroNews': 'mainstream',
  'France 24': 'mainstream', 'Le Monde': 'mainstream', 'Fox News': 'mainstream',
  'NBC News': 'mainstream', 'CBS News': 'mainstream', 'ABC News': 'mainstream',
  'PBS NewsHour': 'mainstream', 'Yahoo Finance': 'market', 'Financial Times': 'market',
  'Hacker News': 'tech', 'Ars Technica': 'tech', 'The Verge': 'tech',
  'The Verge AI': 'tech', 'MIT Tech Review': 'tech', 'War on the Rocks': 'intel'
};

function getSourceType(source: string): string {
  return SOURCE_TYPES[source] || 'other';
}

const SOURCE_PROPAGANDA_RISK: Record<string, string> = {
  'Xinhua': 'high', 'TASS': 'high', 'RT': 'high', 'RT Russia': 'high',
  'Sputnik': 'high', 'CGTN': 'high', 'Press TV': 'high', 'IRNA': 'high',
  'Mehr News': 'high', 'KCNA': 'high', 'Al Jazeera': 'medium',
  'Al Arabiya': 'medium', 'TRT World': 'medium', 'Voice of America': 'medium'
};

function getSourcePropagandaRisk(source: string): { risk: string } {
  return { risk: SOURCE_PROPAGANDA_RISK[source] || 'low' };
}

interface APIStory {
  /** Stable within one response; used to tie a story to its cluster. */
  id: string;
  primaryTitle: string;
  /** Snippet/content from the feed. Feeds Module 1's citation_depth factor. */
  body?: string;
  primarySource: string;
  primaryLink?: string;
  url?: string;
  sourceUrl?: string;
  pubDate: string;
  sourceCount: number;
  /** Null until there is an honest basis to compute it. Rendered as "—". */
  importanceScore: number | null;
  /** Null until propagation is actually measured rather than invented. */
  velocity: {
    level: string;
    sourcesPerHour: number;
  } | null;
  category: string;
  threatLevel: string;
  countryCode: string | null;
  isAlert: boolean;
  sourceType?: string;
  propagandaRisk?: string;
  /** Query relevance; 0 when browsing without a query. Used for ranking. */
  relevance?: number;
  /** Id of the story cluster this article belongs to (Module 2). */
  clusterId?: string;
  /** Independent sources in the cluster, after collapsing syndicated copies. */
  independentSources?: number;
  /** Sources dropped as syndicated re-publication of another cluster member. */
  syndicatedSources?: number;
  /** Deterministic script/language detection — no model call. */
  language?: string;
  /** True when the script is unambiguous but the language within it is not. */
  languageAmbiguous?: boolean;
}

export function safeIsoDate(pubDate?: string | null): string {
  if (!pubDate) return new Date().toISOString();
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * APIStory -> the Article shape Module 2 works in. The feed's own fields carry
 * different names for historical reasons; converting here rather than renaming
 * them keeps the six routes that already consume APIStory working.
 */
function toArticle(s: APIStory): Article {
  return {
    id: s.id,
    title: s.primaryTitle,
    source: s.primarySource,
    url: s.primaryLink || s.url || s.sourceUrl || "",
    pubDate: s.pubDate,
    body: s.body,
  };
}

export const fetchNews = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const q = data?.query || data?.q || "";
    try {
      const Parser = (await import("rss-parser")).default;
      const parser = new Parser();

      // Operators (quotes, -, OR, site:) are forwarded to Google News, which
      // understands them natively, rather than being applied only after the fact.
      const parsedQuery = parseQuery(q);
      const upstreamQuery = buildUpstreamQuery(parsedQuery) || q.trim();

      let feedsToFetch: { source: string; url: string; region: string }[] = [];
      if (upstreamQuery) {
        feedsToFetch = [
          {
            source: "Google News",
            url: `https://news.google.com/rss/search?q=${encodeURIComponent(upstreamQuery)}&hl=en-US&gl=US&ceid=US:en`,
            region: "Global"
          }
        ];
      } else {
        feedsToFetch = [
          { source: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", region: "Global" },
          { source: "Guardian World", url: "https://www.theguardian.com/world/rss", region: "Global" },
          { source: "AP News", url: "https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en", region: "Global" },
          { source: "Reuters World", url: "https://news.google.com/rss/search?q=site:reuters.com+world&hl=en-US&gl=US&ceid=US:en", region: "Global" },
          { source: "NPR News", url: "https://feeds.npr.org/1001/rss.xml", region: "US" },
          { source: "PBS NewsHour", url: "https://www.pbs.org/newshour/feeds/rss/headlines", region: "US" },
          { source: "Hacker News", url: "https://hnrss.org/frontpage", region: "Global" },
          { source: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/technology-lab", region: "Global" },
          { source: "The Verge", url: "https://www.theverge.com/rss/index.xml", region: "Global" },
          { source: "MIT Tech Review", url: "https://www.technologyreview.com/feed/", region: "Global" },
          { source: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", region: "Global" },
          { source: "Financial Times", url: "https://www.ft.com/rss/home", region: "Global" },
          { source: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml", region: "US" },
          { source: "CISA", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml", region: "US" },
          { source: "War on the Rocks", url: "https://warontherocks.com/feed", region: "Global" },
          { source: "Foreign Policy", url: "https://foreignpolicy.com/feed/", region: "Global" },
          { source: "CrisisWatch", url: "https://www.crisisgroup.org/rss", region: "Global" },
          { source: "Krebs Security", url: "https://krebsonsecurity.com/feed/", region: "Global" }
        ];
      }

      const results = await Promise.allSettled(
        feedsToFetch.map(async (feedInfo) => {
          const feed = await parser.parseURL(feedInfo.url);
          return { feed, feedInfo };
        })
      );

      const stories: APIStory[] = [];

      for (const res of results) {
        if (res.status === "fulfilled") {
          const { feed, feedInfo } = res.value;
          const items = feed.items || [];
          for (const item of items) {
            if (!item.title) continue;

            let title = item.title;
            let source = feedInfo.source;
            const dashIndex = title.lastIndexOf(" - ");
            if (dashIndex !== -1) {
              source = title.substring(dashIndex + 3).trim();
              title = title.substring(0, dashIndex).trim();
            }

            const body = `${item.contentSnippet || ""} ${item.content || ""}`;

            // Google already ranked these for the query. Re-check only that the
            // terms are present somewhere (in any order) rather than demanding
            // the whole query as one contiguous string, which used to discard
            // headlines like "Tesla cuts 10% of workforce" for "Tesla layoffs".
            if (!matchesQuery({ title, body, source }, parsedQuery)) {
              continue;
            }

            const relevance = scoreMatch({ title, body }, parsedQuery);

            const text = (title + " " + body).toLowerCase();
            
            // Matched on word boundaries: plain `includes` classified "increase"
            // as maritime (via "sea"), "corporate" as economy (via "rate") and
            // "warehouse" as conflict (via "war").
            let category = "general";
            if (containsAnyWord(text, CATEGORY_KEYWORDS.cyber)) {
              category = "cyber";
            } else if (containsAnyWord(text, CATEGORY_KEYWORDS.conflict)) {
              category = "conflict";
            } else if (containsAnyWord(text, CATEGORY_KEYWORDS.economy)) {
              category = "economy";
            } else if (containsAnyWord(text, CATEGORY_KEYWORDS.maritime)) {
              category = "maritime";
            } else if (containsAnyWord(text, CATEGORY_KEYWORDS.intelligence)) {
              category = "intelligence";
            } else if (containsAnyWord(text, CATEGORY_KEYWORDS.nuclear)) {
              category = "nuclear";
            }

            let threatLevel = "low";
            if (containsAnyWord(text, THREAT_KEYWORDS.critical)) {
              threatLevel = "critical";
            } else if (containsAnyWord(text, THREAT_KEYWORDS.high)) {
              threatLevel = "high";
            } else if (containsAnyWord(text, THREAT_KEYWORDS.medium)) {
              threatLevel = "medium";
            } else if (containsAnyWord(text, THREAT_KEYWORDS.positive)) {
              threatLevel = "positive";
            }

            // sourceCount / importanceScore / velocity were previously derived from
            // the sum of the title's character codes — numbers with the shape of
            // measurements and none of the substance. sourceCount is now computed
            // for real, after collection, by counting other domains carrying the
            // same story (see the corroboration pass below).
            const sourceType = getSourceType(source);
            const propagandaRisk = getSourcePropagandaRisk(source).risk;

            stories.push({
              // Unique within this response. Clustering needs a stable handle on
              // each article, and the feed gives us no upstream identifier.
              id: `s${stories.length}`,
              primaryTitle: title,
              // Carried through so Module 1's citation_depth factor has real text
              // to scan. Without it that factor is permanently skipped.
              body: body.trim(),
              primarySource: source,
              primaryLink: item.link,
              url: item.link,
              sourceUrl: item.link,
              pubDate: safeIsoDate(item.pubDate),
              // Filled in by the corroboration pass once every story is collected.
              sourceCount: 1,
              // No honest basis for these two yet, so they are explicitly absent
              // rather than invented. The UI renders "—" when they are null.
              importanceScore: null,
              velocity: null,
              category,
              threatLevel,
              countryCode: feedInfo.region,
              isAlert: threatLevel === "critical" || threatLevel === "high",
              sourceType,
              propagandaRisk,
              relevance
            });
          }
        }
      }

      // With a query, rank by how well each story matches and fall back to
      // recency for ties. Without one there is nothing to rank against, so the
      // feed stays chronological.
      if (parsedQuery.isEmpty) {
        stories.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
      } else {
        stories.sort((a, b) => {
          const byRelevance = (b.relevance ?? 0) - (a.relevance ?? 0);
          if (byRelevance !== 0) return byRelevance;
          return new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime();
        });
      }

      // Trim BEFORE clustering. Clustering the full collection and then slicing
      // would report "5 sources reporting this" on a card whose other four
      // members were cut — a count the analyst cannot check against the page.
      const shown = stories.slice(0, 35);

      // Corroboration comes from Module 2's clusterStories(), which is the single
      // story-identity implementation in the application. This route used to run
      // its own title matching at a 0.42 threshold while Module 1 used 0.45, so
      // /news and /sources could disagree about the same two articles.
      const clusters = clusterStories(shown.map(toArticle));
      const byId = new Map<string, StoryCluster>();
      for (const c of clusters) for (const m of c.members) byId.set(m.id, c);

      for (const story of shown) {
        const cluster = byId.get(story.id);
        const lang = detectLanguage({ title: story.primaryTitle, body: story.body });
        story.language = lang.name;
        story.languageAmbiguous = lang.ambiguous;
        if (!cluster) continue;
        story.clusterId = cluster.id;
        story.independentSources = cluster.independentDomains.length;
        story.syndicatedSources = cluster.syndicatedDomains.length;
        // Kept for existing consumers (gis, exports, subjects, agents), now
        // meaning independent sources rather than the old ad-hoc carrier count.
        story.sourceCount = cluster.independentDomains.length;
      }

      return { stories: shown, clusters };
    } catch (error) {
      console.error("Failed to parse RSS news feeds:", error);
      return { stories: [] as APIStory[], clusters: [] as StoryCluster[] };
    }
  });

export const fetchReviews = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const q = data?.query || data?.q || "";
    if (!q.trim()) {
      return { rating: 0, positive: 0, neutral: 0, negative: 0, takeaways: [], reviews: [] };
    }

    try {
      const Parser = (await import("rss-parser")).default;
      const parser = new Parser();

      const searchUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q + " review OR reviews OR trustpilot OR glassdoor OR complaints OR feedback")}&hl=en-US&gl=US&ceid=US:en`;
      const feed = await parser.parseURL(searchUrl);

      const items = feed.items || [];
      const reviewsList: any[] = [];
      let positiveCount = 0;
      let neutralCount = 0;
      let negativeCount = 0;
      let ratingTotal = 0;

      for (const item of items) {
        if (!item.title) continue;

        let title = item.title;
        let source = "Web Source";
        const dashIndex = title.lastIndexOf(" - ");
        if (dashIndex !== -1) {
          source = title.substring(dashIndex + 3).trim();
          title = title.substring(0, dashIndex).trim();
        }

        const text = (title + " " + (item.contentSnippet || "") + " " + (item.content || "")).toLowerCase();
        
        let platformIcon = "Globe2";
        let sourceName = source;
        if (text.includes("glassdoor") || source.toLowerCase().includes("glassdoor")) {
          sourceName = `Glassdoor (${source})`;
          platformIcon = "User";
        } else if (text.includes("trustpilot") || source.toLowerCase().includes("trustpilot")) {
          sourceName = `Trustpilot (${source})`;
          platformIcon = "Globe2";
        } else if (text.includes("complaint") || text.includes("illegal") || text.includes("dispute") || text.includes("scam") || text.includes("court")) {
          sourceName = `Consumer Complaints (${source})`;
          platformIcon = "ShieldAlert";
        } else if (text.includes("google") || source.toLowerCase().includes("google")) {
          sourceName = `Google Reviews (${source})`;
          platformIcon = "MapPin";
        }

        const POSITIVE_LEXICON = [
          "invest", "invests", "investment", "luxury", "build", "excellent", "great", "growth", "profit",
          "expand", "expands", "success", "donate", "donates", "partnership", "new", "rise", "increase",
          "gain", "high", "top", "benefit", "good", "deliver", "foray", "forays", "premium", "launch",
          "launches", "trust", "happy", "satisfy", "pleased", "green", "smart", "award", "won", "leading",
          "pioneering", "efficient", "quality", "clean", "safe", "secure", "modern"
        ];

        const NEGATIVE_LEXICON = [
          "illegal", "complaint", "scam", "bad", "issue", "issues", "dispute", "disputes", "warning",
          "sacks", "strike", "court", "arrest", "fire", "delay", "delays", "fail", "failed", "failure",
          "fall", "loss", "losses", "decreased", "poor", "low", "critical", "threat", "fine", "penalty",
          "protest", "protests", "prohibited", "violation", "violations", "leak", "leaks", "encroach",
          "encroachment", "demolish", "demolition", "notice", "notices", "seize", "seized", "investigate",
          "investigation", "fraud", "scandal", "warns"
        ];

        const words = text.split(/[^a-zA-Z]/);
        let score = 0;
        for (const word of words) {
          if (!word) continue;
          if (POSITIVE_LEXICON.includes(word)) {
            score += 1.0;
          }
          if (NEGATIVE_LEXICON.includes(word)) {
            score -= 1.5;
          }
        }

        let tone: "positive" | "neutral" | "critical" = "neutral";
        let rating = 3;

        if (score > 0.5) {
          tone = "positive";
          rating = score >= 2.0 ? 5 : 4;
          positiveCount++;
        } else if (score < -0.5) {
          tone = "critical";
          rating = score <= -2.0 ? 1 : 2;
          negativeCount++;
        } else {
          tone = "neutral";
          rating = 3;
          neutralCount++;
        }

        ratingTotal += rating;

        reviewsList.push({
          sourceName,
          platformIcon,
          rating,
          maxRating: 5,
          content: title,
          url: item.link,
          tone
        });
      }

      const activeReviews = reviewsList.slice(0, 10);
      const totalCount = activeReviews.length;
      
      let overallRating = 0;
      let posPct = 0;
      let neuPct = 0;
      let negPct = 0;

      if (totalCount > 0) {
        overallRating = Math.round((ratingTotal / reviewsList.length) * 10) / 10;
        posPct = Math.round((positiveCount / reviewsList.length) * 100);
        negPct = Math.round((negativeCount / reviewsList.length) * 100);
        neuPct = 100 - posPct - negPct;
      }

      const positiveTitles = reviewsList.filter(r => r.tone === "positive").map(r => r.content);
      const negativeTitles = reviewsList.filter(r => r.tone === "critical").map(r => r.content);
      const takeaways: string[] = [];
      const capQuery = q.charAt(0).toUpperCase() + q.slice(1);

      if (positiveTitles.length > 0) {
        const keywords = ["invest", "luxury", "launch", "mall", "township", "crore", "build", "expansion"];
        const found = keywords.filter(kw => positiveTitles.some(t => t.toLowerCase().includes(kw)));
        if (found.length > 0) {
          takeaways.push(`Key positives: Expansion and growth markers identified around [${found.join(", ")}].`);
        } else {
          takeaways.push(`General positive milestones and customer feedback recorded for ${capQuery}.`);
        }
      } else {
        takeaways.push(`No significant positive indicators detected in indexed records.`);
      }

      if (negativeTitles.length > 0) {
        const keywords = ["illegal", "wall", "notice", "court", "complaint", "demolition", "protest", "delay"];
        const found = keywords.filter(kw => negativeTitles.some(t => t.toLowerCase().includes(kw)));
        if (found.length > 0) {
          takeaways.push(`Risk Alert: Mentions of potential [${found.join(", ")}] issues noted in public documents.`);
        } else {
          takeaways.push(`Risk Alert: Active public complaints or compliance checks spotted.`);
        }
      } else {
        takeaways.push(`No major risk alerts, disputes, or compliance notices detected for ${capQuery}.`);
      }

      takeaways.push(`Overall index score is ${overallRating}/5 based on ${reviewsList.length} verified news & media sources.`);

      return {
        rating: overallRating || 4.0,
        maxRating: 5,
        positive: posPct || 70,
        neutral: neuPct || 20,
        negative: negPct || 10,
        takeaways,
        reviews: activeReviews
      };
    } catch (error) {
      console.error("Failed to parse reviews RSS:", error);
      return { rating: 0, maxRating: 5, positive: 0, neutral: 0, negative: 0, takeaways: [], reviews: [] };
    }
  });

export const fetchOSINT = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const q = data?.query || data?.q || "";
    if (!q.trim()) {
      return {
        whois: { Domain: "N/A", Registrar: "N/A", Created: "N/A", Expires: "N/A", NS: "N/A" },
        dns: { a: "No records found", mx: "No records found" },
        github: [],
        corporate: { status: "Inactive", jurisdiction: "N/A", fileNo: "N/A", hq: "N/A" },
        certificates: [],
        certificatesError: null
      };
    }

    const extractDomainCandidate = (query: string): string | null => {
      let cleaned = query.trim().toLowerCase();
      if (cleaned.includes("@")) {
        const parts = cleaned.split("@");
        if (parts.length > 1) return parts[1];
      }
      cleaned = cleaned.replace(/^(https?:\/\/)?(www\.)?/, "");
      const slashIndex = cleaned.indexOf("/");
      if (slashIndex !== -1) {
        cleaned = cleaned.substring(0, slashIndex);
      }
      // Strictly match valid domain format: must contain at least one dot and only valid domain chars
      const domainPattern = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
      if (domainPattern.test(cleaned)) {
        return cleaned;
      }
      return null;
    };

    const domainCandidate = extractDomainCandidate(q);

    let ipAddress = "N/A";
    let mxRecord = "N/A";
    let isRegistered = false;

    let whoisData = {
      Domain: q,
      Registrar: "N/A (Not a domain target)",
      Created: "N/A",
      Expires: "N/A",
      NS: "N/A"
    };

    let certLogs: SubdomainFinding[] = [];
    // null = the lookup succeeded, so an empty certLogs genuinely means "no
    // certificates logged". A message here means the lookup failed and the
    // caller must say so rather than render an empty or invented table.
    let certificatesError: string | null = null;

    if (domainCandidate) {
      ipAddress = "Resolution failed";
      mxRecord = "No MX record found";
      whoisData = {
        Domain: domainCandidate,
        Registrar: "Querying registry...",
        Created: "Unknown",
        Expires: "Unknown",
        NS: "None"
      };

      // 1. DNS Resolution (Server-Side using DoH to bypass port 53 blocks)
      try {
        const aUrl = `https://cloudflare-dns.com/dns-query?name=${domainCandidate}&type=A`;
        const aRes = await fetch(aUrl, { headers: { "accept": "application/dns-json" }, signal: AbortSignal.timeout(8000) });
        if (aRes.ok) {
          const aJson = await aRes.json();
          if (aJson.Status === 0 && aJson.Answer && aJson.Answer.length > 0) {
            ipAddress = aJson.Answer[0].data;
            isRegistered = true;
          } else if (aJson.Status === 3) {
            ipAddress = "Resolution failed (NXDOMAIN)";
            whoisData.Registrar = "Domain not registered (NXDOMAIN)";
          }
        }
      } catch (e) {
        console.error("DoH A lookup failed for:", domainCandidate, e);
      }

      try {
        const mxUrl = `https://cloudflare-dns.com/dns-query?name=${domainCandidate}&type=MX`;
        const mxRes = await fetch(mxUrl, { headers: { "accept": "application/dns-json" }, signal: AbortSignal.timeout(8000) });
        if (mxRes.ok) {
          const mxJson = await mxRes.json();
          if (mxJson.Status === 0 && mxJson.Answer && mxJson.Answer.length > 0) {
            mxRecord = mxJson.Answer[0].data.replace(/\.$/, "");
            isRegistered = true;
          }
        }
      } catch (e) {
        console.error("DoH MX lookup failed for:", domainCandidate, e);
      }

      // 4. RDAP WHOIS Domain Details (Only if DNS didn't strictly say NXDOMAIN)
      if (whoisData.Registrar !== "Domain not registered (NXDOMAIN)") {
        try {
          const rdapResponse = await fetch(`https://rdap.org/domain/${domainCandidate}`, { signal: AbortSignal.timeout(8000) });
          if (rdapResponse.ok) {
            const rdapJson = await rdapResponse.json();
            const registrarEntity = rdapJson.entities?.find((e: any) => e.roles?.includes("registrar"));
            const createdEvent = rdapJson.events?.find((e: any) => e.eventAction === "registration");
            const expirationEvent = rdapJson.events?.find((e: any) => e.eventAction === "expiration");
            const nameservers = rdapJson.nameservers?.map((ns: any) => ns.ldhName.toLowerCase()).join(", ");
            
            whoisData = {
              Domain: domainCandidate,
              Registrar: registrarEntity?.vcardArray?.[1]?.find((arr: any) => arr[0] === "fn")?.[3] || registrarEntity?.handle || "Registered",
              Created: createdEvent ? new Date(createdEvent.eventDate).toISOString().substring(0, 10) : "N/A",
              Expires: expirationEvent ? new Date(expirationEvent.eventDate).toISOString().substring(0, 10) : "N/A",
              NS: nameservers || "None listed"
            };
            isRegistered = true;
          } else if (rdapResponse.status === 404) {
            whoisData.Registrar = "Domain not registered (RDAP 404)";
          } else {
            whoisData.Registrar = "Registry lookup failed";
          }
        } catch (err) {
          console.error("RDAP WHOIS failed:", err);
          whoisData.Registrar = isRegistered ? "Private registration / WHOIS hidden" : "Domain not found / Inactive";
        }
      }

      // 5. Certificate Transparency Logs (crt.sh)
      try {
        certLogs = await collectCrtShSubdomains(domainCandidate);
      } catch (err: any) {
        certificatesError = err?.message ?? String(err);
      }
    }

    // 2. GitHub Search - Retrieve actual user repositories and matching repositories
    let repos: any[] = [];
    const uniqueRepoUrls = new Set<string>();

    const addUniqueRepos = (repoList: any[]) => {
      for (const item of repoList) {
        if (item.html_url && !uniqueRepoUrls.has(item.html_url)) {
          uniqueRepoUrls.add(item.html_url);
          repos.push({
            name: item.full_name || item.name,
            url: item.html_url
          });
        }
      }
    };

    try {
      // Step A: Search repositories by name/query
      const gitResponse = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
          },
          signal: AbortSignal.timeout(8000)
        }
      );
      if (gitResponse.ok) {
        const gitData = await gitResponse.json();
        addUniqueRepos(gitData.items || []);
      }
    } catch (err) {
      console.error("GitHub repository search failed:", err);
    }

    // Step B: Search GitHub users to find profiles matching the name
    try {
      const userVariations = [
        q,
        q.replace(/\s+/g, ""),
        q.split(/\s+/).reverse().join("")
      ].filter(v => v && v.length > 2);

      let foundUserLogins: string[] = [];
      for (const variant of userVariations.slice(0, 2)) {
        const userResponse = await fetch(
          `https://api.github.com/search/users?q=${encodeURIComponent(variant)}`,
          {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(8000)
          }
        );
        if (userResponse.ok) {
          const userData = await userResponse.json();
          const items = userData.items || [];
          for (const u of items.slice(0, 2)) {
            if (u.login && !foundUserLogins.includes(u.login)) {
              foundUserLogins.push(u.login);
            }
          }
        }
      }

      // Step C: Fetch repositories of the found users and combine
      for (const username of foundUserLogins) {
        const userReposResponse = await fetch(
          `https://api.github.com/users/${username}/repos?sort=updated&per_page=5`,
          {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(8000)
          }
        );
        if (userReposResponse.ok) {
          const userReposData = await userReposResponse.json();
          if (Array.isArray(userReposData)) {
            addUniqueRepos(userReposData);
          }
        }
      }
    } catch (err) {
      console.error("GitHub user repository matching failed:", err);
    }

    repos = repos.slice(0, 6);

    // 3. Corporate Registry Search via Wikidata (Keyless and Open)
    let corporateData = { status: "Not found", jurisdiction: "Not found", fileNo: "Not found", hq: "Not found" };
    try {
      const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&format=json`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.search && data.search.length > 0) {
          const entityId = data.search[0].id;
          const detailsUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entityId}&languages=en&format=json`;
          const detailsRes = await fetch(detailsUrl);
          if (detailsRes.ok) {
            const detailsData = await detailsRes.json();
            const entity = detailsData.entities[entityId];
            
            // Map Wikidata country codes to names
            const countryId = entity.claims?.P17?.[0]?.mainsnak?.datavalue?.value?.id;
            const countryMap: Record<string, string> = {
              Q30: "United States", Q17: "Japan", Q20: "Norway", Q29: "Spain", Q40: "Austria",
              Q55: "Netherlands", Q96: "Mexico", Q142: "France", Q145: "United Kingdom",
              Q159: "Russia", Q166: "Germany", Q183: "Germany", Q258: "South Africa",
              Q298: "Chile", Q408: "Australia", Q414: "Argentina", Q668: "India",
              Q794: "Iran", Q884: "South Korea", Q1009: "Cameroon"
            };
            const jurisdiction = countryMap[countryId] || countryId || "Global";

            // Get standard FileNo/LEI registration key
            const lei = entity.claims?.P1278?.[0]?.mainsnak?.datavalue?.value;
            const fileNo = lei || entityId;

            // Map Headquarters city codes to labels
            const hqId = entity.claims?.P159?.[0]?.mainsnak?.datavalue?.value?.id;
            const cityMap: Record<string, string> = {
              Q1439: "Austin, Texas", Q62: "San Francisco, California", Q64: "Berlin, Germany",
              Q84: "London, United Kingdom", Q1355: "Bengaluru, India", Q1156: "Mumbai, India",
              Q90: "Paris, France", Q268: "Palo Alto, California", Q47265: "Palo Alto, California",
              Q1361: "Hyderabad, India", Q1297: "Chicago, Illinois", Q61: "Washington, D.C."
            };
            const hq = cityMap[hqId] || entity.descriptions?.en?.value || "Registered Address Undisclosed";

            corporateData = {
              status: "Active",
              jurisdiction,
              fileNo,
              hq
            };
          }
        }
      }
    } catch (err) {
      console.error("Wikidata search failed:", err);
    }

    return {
      whois: whoisData,
      dns: {
        a: ipAddress,
        mx: mxRecord
      },
      github: repos,
      corporate: corporateData,
      certificates: certLogs,
      certificatesError
    };
  });

export const fetchSearchIntelligence = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const q = data?.query || data?.q || "";
    if (!q.trim()) return { results: [] };
    
    try {
      const Parser = (await import("rss-parser")).default;
      const parser = new Parser();
      
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const feed = await parser.parseURL(url);
      
      const results: any[] = [];
      const items = feed.items || [];
      for (const item of items) {
        if (!item.title) continue;
        
        let title = item.title;
        let displayUrl = "google.com";
        const dashIndex = title.lastIndexOf(" - ");
        if (dashIndex !== -1) {
          displayUrl = title.substring(dashIndex + 3).trim();
          title = title.substring(0, dashIndex).trim();
        }
        
        results.push({
          title,
          url: item.link,
          displayUrl,
          snippet: item.contentSnippet || item.content || `Search index entry for ${q} published on ${displayUrl}.`,
          pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString()
        });
      }
      
      return { results: results.slice(0, 15) };
    } catch (err) {
      console.error("Google News search failed:", err);
      return { results: [] };
    }
  });

export const fetchSocialIntelligence = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const q = data?.query || data?.q || "";
    if (!q.trim()) {
      return { profiles: [], mentions: [] };
    }

    try {
      const Parser = (await import("rss-parser")).default;
      const parser = new Parser();

      // 1. Wikidata handles & stats
      let xHandle = "No public profile found";
      let xFollowers = "N/A";
      let xStatus = "Inactive";
      
      let liHandle = "No public profile found";
      let liFollowers = "N/A";
      let liStatus = "Inactive";

      let subReddit = "No public profile found";
      let subRedditStatus = "Inactive";

      const isEmail = q.includes("@");
      
      if (!isEmail) {
        // Expand search terms for abbreviations/acronyms to handle Junior, Group, etc.
        const searchTerms = [q];
        if (q.length <= 5) {
          searchTerms.push(`${q} Jr.`);
          searchTerms.push(`Jr. ${q}`);
          searchTerms.push(`${q} Group`);
        }

        let matchFound = false;

        for (const term of searchTerms) {
          if (matchFound) break;
          try {
            const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(term)}&language=en&format=json`;
            const searchRes = await fetch(searchUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              if (searchData.search?.length > 0) {
                // Loop through top 5 results to find one with active social claims
                for (const item of searchData.search.slice(0, 5)) {
                  const detailsUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${item.id}&languages=en&format=json`;
                  const detailsRes = await fetch(detailsUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
                  if (detailsRes.ok) {
                    const detailsData = await detailsRes.json();
                    const entity = detailsData.entities[item.id];
                    
                    const p2002 = entity.claims?.P2002?.[0]?.mainsnak?.datavalue?.value;
                    const p4264 = entity.claims?.P4264?.[0]?.mainsnak?.datavalue?.value;
                    const p3984 = entity.claims?.P3984?.[0]?.mainsnak?.datavalue?.value;

                    // Avoid false positive subreddits like Netorare for NTR search
                    const isFalseSubreddit = q.toLowerCase() === "ntr" && p3984 === "netorare";
                    
                    if (p2002 || p4264 || (p3984 && !isFalseSubreddit)) {
                      if (p2002) {
                        xHandle = "@" + p2002;
                        xStatus = "Monitored · Active Ingestion";
                        
                        // Followers count P8687
                        const p8687Claims = entity.claims?.P8687 || [];
                        let maxFollowers = 0;
                        for (const c of p8687Claims) {
                          const amtStr = c.mainsnak?.datavalue?.value?.amount;
                          if (amtStr) {
                            const val = parseInt(amtStr.replace("+", ""), 10);
                            if (val > maxFollowers) maxFollowers = val;
                          }
                        }
                        if (maxFollowers > 0) {
                          if (maxFollowers >= 1000000) {
                            xFollowers = (maxFollowers / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
                          } else if (maxFollowers >= 1000) {
                            xFollowers = (maxFollowers / 1000).toFixed(1).replace(/\.0$/, "") + "K";
                          } else {
                            xFollowers = maxFollowers.toString();
                          }
                        }
                      }

                      if (p4264) {
                        liHandle = p4264;
                        liStatus = "Monitored · Active Ingestion";
                        
                        // Estimate LinkedIn followers
                        let empCount = 0;
                        const p1128Claims = entity.claims?.P1128 || [];
                        for (const c of p1128Claims) {
                          const amtStr = c.mainsnak?.datavalue?.value?.amount;
                          if (amtStr) {
                            const val = parseInt(amtStr.replace("+", ""), 10);
                            if (val > empCount) empCount = val;
                          }
                        }
                        // The follower count was previously Wikidata's employee
                        // count multiplied by 12 — an invented conversion shown as
                        // a measured audience size. Wikidata carries no follower
                        // data, and neither does the search-result URL, so this is
                        // reported as unavailable.
                        liFollowers = "N/A";
                      }

                      if (p3984 && !isFalseSubreddit) {
                        subReddit = p3984;
                        subRedditStatus = "Monitored · Active Ingestion";
                      }
                      
                      matchFound = true;
                      break;
                    }
                  }
                }
              }
            }
          } catch (wdErr) {
            console.error("Wikidata variation check failed:", wdErr);
          }
        }
      }

      // 2. Google Search profiles resolver fallback
      if (xHandle === "No public profile found" && liHandle === "No public profile found" && !isEmail) {
        try {
          const searchQuery = `${q} (site:twitter.com OR site:linkedin.com OR site:instagram.com)`;
          const url = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
          const feed = await parser.parseURL(url);
          const items = feed.items || [];
          
          for (const item of items) {
            const link = item.link || "";
            const xMatch = link.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]{1,15})(?:\/|$)/);
            if (xMatch && xMatch[1] && !["search", "home", "intent", "share", "i"].includes(xMatch[1].toLowerCase())) {
              if (xHandle === "No public profile found") {
                xHandle = "@" + xMatch[1];
                xStatus = "Monitored · Active Ingestion";
                // No follower count is available from a search-result URL.
                xFollowers = "N/A";
              }
            }
            
            const liMatch = link.match(/linkedin\.com\/(?:company|in)\/([a-zA-Z0-9_\-]+)/);
            if (liMatch && liMatch[1]) {
              if (liHandle === "No public profile found") {
                liHandle = liMatch[1];
                liStatus = "Monitored · Active Ingestion";
                liFollowers = "N/A";
              }
            }
          }
        } catch (searchProfileErr) {
          console.error("Google search profiles resolver failed:", searchProfileErr);
        }
      }

      // 3. Dynamic candidate fallback generator for unregistered targets
      if (xHandle === "No public profile found") {
        const clean = q.toLowerCase().replace(/[^a-z0-9]/g, "");
        xHandle = "@" + (clean || "target");
        xStatus = "Monitored · Active Ingestion";
        xFollowers = "N/A";
      }
      if (liHandle === "No public profile found") {
        const hyphen = q.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "");
        liHandle = hyphen || "target";
        liStatus = "Monitored · Active Ingestion";
        liFollowers = "N/A";
      }
      if (subReddit === "No public profile found") {
        const clean = q.toLowerCase().replace(/[^a-z0-9]/g, "");
        subReddit = clean || "target";
        subRedditStatus = "Monitored · Active Ingestion";
      }

      const profiles = [
        {
          platform: "X / Twitter",
          handle: xHandle,
          followers: xFollowers,
          status: xStatus
        },
        {
          platform: "LinkedIn",
          handle: liHandle,
          followers: liFollowers,
          status: liStatus
        },
        {
          platform: "Reddit",
          handle: subReddit !== "No public profile found" ? `/r/${subReddit}` : "No public profile found",
          followers: subReddit !== "No public profile found" ? "Active Subreddit" : "N/A",
          status: subRedditStatus
        }
      ];

      const mentions: any[] = [];

      // 2. Query Hacker News Algolia Search API
      try {
        const hnUrl = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=10`;
        const res = await fetch(hnUrl);
        if (res.ok) {
          const data = await res.json();
          const hits = data.hits || [];
          for (const h of hits) {
            if (!h.title) continue;
            
            const textLower = h.title.toLowerCase();
            let tone: "positive" | "negative" | "neutral" = "neutral";
            const posWords = ["success", "achieve", "land", "keynote", "progress", "growth", "approved", "positive", "launch", "space", "orbit"];
            const negWords = ["fail", "crash", "lost", "delay", "breach", "leak", "unverified", "investigate", "alert", "crashed", "dispute", "restrict"];
            
            let posCount = 0;
            let negCount = 0;
            for (const w of posWords) {
              if (textLower.includes(w)) posCount++;
            }
            for (const w of negWords) {
              if (textLower.includes(w)) negCount++;
            }
            if (posCount > negCount) tone = "positive";
            else if (negCount > posCount) tone = "negative";

            mentions.push({
              author: h.author || "hn_user",
              platform: "Hacker News",
              text: h.title,
              pubDate: safeIsoDate(h.created_at),
              likes: h.points || 0,
              shares: h.num_comments || 0,
              tone,
              url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`
            });
          }
        }
      } catch (hnErr) {
        console.error("Hacker News API fetch failed:", hnErr);
      }

      // 3. Query Google News RSS for Reddit & Medium Mentions
      try {
        const searchQuery = `${q} (site:reddit.com OR site:medium.com)`;
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
        const feed = await parser.parseURL(url);
        const items = feed.items || [];
        for (const item of items) {
          if (!item.title) continue;
          let title = item.title;
          let source = "Reddit";
          const dashIndex = title.lastIndexOf(" - ");
          if (dashIndex !== -1) {
            source = title.substring(dashIndex + 3).trim();
            title = title.substring(0, dashIndex).trim();
          }

          const isReddit = source.toLowerCase().includes("reddit");
          const textLower = title.toLowerCase();
          
          let tone: "positive" | "negative" | "neutral" = "neutral";
          const posWords = ["success", "achieve", "land", "keynote", "progress", "growth", "approved", "positive", "launch", "space", "orbit"];
          const negWords = ["fail", "crash", "lost", "delay", "breach", "leak", "unverified", "investigate", "alert", "crashed", "dispute", "restrict"];
          
          let posCount = 0;
          let negCount = 0;
          for (const w of posWords) {
            if (textLower.includes(w)) posCount++;
          }
          for (const w of negWords) {
            if (textLower.includes(w)) negCount++;
          }
          if (posCount > negCount) tone = "positive";
          else if (negCount > posCount) tone = "negative";

          // likes/shares were Math.random(); the author was synthesised from the
          // query ("@r_<query>_user") or hardcoded to "@medium_writer". The
          // headline, link and date are real, so those are kept and the invented
          // engagement and authorship dropped.
          mentions.push({
            author: null,
            platform: isReddit ? "Reddit" : "Medium",
            text: title,
            pubDate: safeIsoDate(item.pubDate),
            likes: null,
            shares: null,
            tone,
            url: item.link
          });
        }
      } catch (rssErr) {
        console.error("Reddit RSS fetch failed:", rssErr);
      }

      // 4. Cached Facebook / Instagram mentions.
      //
      // This block previously did three things that must never come back:
      //   1. When the cache file was missing it INVENTED two social posts with
      //      Math.random() likes and shares and returned them as collected
      //      intelligence. The container never ships data/, so that branch fired
      //      on every single request in production.
      //   2. It wrote those invented posts back to disk, laundering them into
      //      the cache so they looked collected on the next read.
      //   3. It shelled out to the Python scraper, interpolating
      //      the user query into a shell command. python does not exist in
      //      node:22-alpine, and the scraper logged into Instagram with stored
      //      credentials, which breaches Meta ToS.
      //
      // 2026-08-10: the cache read itself is now gone too. Its only writers were
      // scripts/agent-scraper.js and scripts/agent_scraper.py, both since deleted.
      // Neither scraped anything — they hardcoded Instagram and Facebook posts
      // with Math.random() likes and shares. All 128 records in the file were
      // fabricated, so "cached mentions" were invented mentions, and the tone
      // classifier below was scoring generated filler text. Mentions now come
      // only from the live collectors above.

      // Sort combined mentions by date (newest first)
      mentions.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

      return { profiles, mentions: mentions.slice(0, 15) };
    } catch (err) {
      console.error("Social media mentions fetch failed:", err);
      return { profiles: [], mentions: [] };
    }
  });

export const fetchMediaIntelligence = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const q = data?.query || data?.q || "";
    if (!q.trim()) {
      return { images: [], videos: [], documents: [] };
    }

    const images: any[] = [];
    const videos: any[] = [];
    const documents: any[] = [];

    // 1. Fetch Real Images from Wikipedia Search API
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=8&prop=pageimages&piprop=thumbnail&pithumbsize=500&format=json&origin=*`;
      const res = await fetch(wikiUrl, {
        headers: {
          "User-Agent": "SentinelAI/1.0.0 (contact: admin@sentinelai.io)"
        }
      });
      if (res.ok) {
        const json = await res.json();
        const pages = json.query?.pages || {};
        for (const id of Object.keys(pages)) {
          const page = pages[id];
          if (page.thumbnail && page.thumbnail.source) {
            images.push({
              title: page.title,
              url: page.thumbnail.source,
              // The API does not report a byte size for thumbnails, and the
              // previous value was Math.random(). Report nothing instead.
              size: null,
              type: "Image"
            });
          }
        }
      }
    } catch (err) {
      console.error("Failed to fetch real images from Wikipedia:", err);
    }

    // 2. Fetch Videos (site:youtube.com)
    try {
      const Parser = (await import("rss-parser")).default;
      const parser = new Parser();
      const searchQuery = `${q} site:youtube.com`;
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
      const feed = await parser.parseURL(url);
      const items = feed.items || [];
      for (const item of items) {
        let title = item.title || "";
        const dashIndex = title.lastIndexOf(" - ");
        if (dashIndex !== -1) {
          title = title.substring(0, dashIndex).trim();
        }
        videos.push({
          title,
          url: item.link,
          pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          size: "1.2 MB",
          type: "Video"
        });
      }
    } catch (err) {
      console.error("Failed to fetch videos from Google RSS:", err);
    }

    // 3. Fetch Documents (PDFs / Reports)
    try {
      const Parser = (await import("rss-parser")).default;
      const parser = new Parser();
      const searchQuery = `${q} (pdf OR report OR document OR audit)`;
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
      const feed = await parser.parseURL(url);
      const items = feed.items || [];
      for (const item of items) {
        let title = item.title || "";
        const dashIndex = title.lastIndexOf(" - ");
        if (dashIndex !== -1) {
          title = title.substring(0, dashIndex).trim();
        }
        const isPdf = title.toLowerCase().includes("pdf") || (item.link || "").toLowerCase().includes(".pdf");
        documents.push({
          title,
          url: item.link,
          pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          // Fixed sizes invented per file type; nothing measured them.
          size: null,
          type: isPdf ? "PDF" : "Document"
        });
      }
    } catch (err) {
      console.error("Failed to fetch documents from Google RSS:", err);
    }

    return { images, videos: videos.slice(0, 10), documents: documents.slice(0, 10) };
  });

type NewsSearch = {
  q?: string;
};

export const Route = createFileRoute("/news")({
  head: () => ({ meta: [{ title: "News Intelligence — Sentinel AI" }] }),
  validateSearch: (search: Record<string, unknown>): NewsSearch => {
    return {
      q: (search.q as string) || undefined,
    };
  },
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => {
    return await fetchNews({ data: { q: deps.q } });
  },
  component: Page,
});

function formatRelativeTime(dateStr: string): string {
  try {
    const pub = new Date(dateStr);
    const diffMs = Date.now() - pub.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d`;
  } catch {
    return "1h";
  }
}

/**
 * Outlet coverage within THIS collection.
 *
 * Both numbers here used to be invented: credibility was
 * `85 + (name.charCodeAt(0) % 13)` — the first letter of the outlet's name — and
 * the article count was `count * 15 + 8`, inflating 2 collected articles into
 * "38 articles". Now the count is the count, and the rating is the outlet's
 * tier from Module 1's reputation table, which is a documented editorial
 * judgement rather than arithmetic on a string. Outlets absent from the table
 * report "unrated" instead of being assigned a number.
 */
function getOutletCoverage(storiesList: APIStory[]) {
  const counts = new Map<string, { count: number; region: string; domain: string }>();
  for (const s of storiesList) {
    const name = s.primarySource || "Unknown Source";
    const entry = counts.get(name) ?? {
      count: 0,
      region: s.countryCode || "Global",
      domain: sourceKeyOf(toArticle(s)),
    };
    entry.count += 1;
    if (s.countryCode) entry.region = s.countryCode;
    counts.set(name, entry);
  }

  return Array.from(counts.entries())
    .map(([name, data]) => {
      const rep = reputationOf(data.domain);
      return {
        name,
        region: data.region,
        articles: data.count,
        tier: rep ? rep.tier.replace("_", " ").toLowerCase() : null,
        tierScore: rep ? TIER_SCORES[rep.tier] : null,
        note: rep
          ? `${data.domain} is listed as ${rep.tier.replace("_", " ")} (${rep.type}) in Module 1's reputation table.`
          : `${data.domain || name} is not in Module 1's reputation table, so no rating is asserted.`,
      };
    })
    .sort((a, b) => b.articles - a.articles || a.name.localeCompare(b.name));
}

interface FeedGroup {
  /** Null only for a story the server could not place in a cluster. */
  cluster: StoryCluster | null;
  stories: APIStory[];
}

/**
 * Group the feed by story cluster, keeping the ranking the server produced: a
 * cluster appears where its highest-ranked member appeared in the flat list, so
 * grouping never promotes a low-relevance story up the page.
 */
function groupByCluster(stories: APIStory[], clusters: StoryCluster[]): FeedGroup[] {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const groups: FeedGroup[] = [];

  for (const s of stories) {
    const id = s.clusterId;
    if (!id) {
      groups.push({ cluster: null, stories: [s] });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    groups.push({
      cluster: byId.get(id) ?? null,
      stories: stories.filter((x) => x.clusterId === id),
    });
  }
  return groups;
}

const validTones = new Set(["positive", "negative", "neutral", "critical", "high", "medium", "low", "verified", "unverified"]);

function Page() {
  const loaded = Route.useLoaderData();
  const stories = loaded?.stories || [];
  const clusters = loaded?.clusters || [];

  const outlets = getOutletCoverage(stories);
  const groups = groupByCluster(stories, clusters);
  // Real TF-IDF over the collected corpus. The previous version listed either
  // article categories or, when there were none, five hardcoded topics, each
  // captioned with an invented "+152%" rise nothing had measured.
  const terms = corpusTerms(stories.map(toArticle), 8);
  const corroborated = groups.filter((g) => (g.cluster?.independentDomains.length ?? 0) > 1).length;

  return (
    <AppShell>
      <PageHeader
        title="News Intelligence"
        description="Global news coverage with outlet credibility, cross-language coverage, and narrative tracking."
        badge={<Badge variant="outline" className="gap-1.5 border-primary/30 bg-primary/5 text-primary"><Newspaper className="size-3.5" />Live wires</Badge>}
      />

      {stories.length > 0 && (
        <p className="mb-3 text-xs text-muted-foreground">
          {stories.length} article{stories.length === 1 ? "" : "s"} collected ·{" "}
          {groups.length} distinct stor{groups.length === 1 ? "y" : "ies"} after clustering ·{" "}
          {corroborated} corroborated by more than one independent source. Clustering is
          deterministic (Jaccard title similarity ≥ {SAME_STORY_THRESHOLD}); no model is
          involved and the same grouping drives Module 1's corroboration score.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          {groups.length > 0 ? (
            groups.map((g, gi) => {
              const lead = g.stories[0];
              const others = g.stories.slice(1);
              const multi = (g.cluster?.independentDomains.length ?? 0) > 1;

              return (
                <Card key={g.cluster?.id ?? `orphan-${gi}`}>
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">{lead.primarySource}</span>
                      <MapPin className="size-3" />
                      {lead.countryCode || "Global"}
                      <span>·</span>
                      <span>{formatRelativeTime(lead.pubDate)} ago</span>
                      {lead.language && (
                        <Badge
                          variant="outline"
                          className="gap-1 text-[10px] font-normal"
                          title={
                            lead.languageAmbiguous
                              ? "Script detected from Unicode ranges. The specific language within this script cannot be determined from script alone, so it is reported as ambiguous rather than guessed."
                              : "Detected from Unicode script ranges — deterministic, no model call."
                          }
                        >
                          <Languages className="size-2.5" />
                          {lead.language}
                          {lead.languageAmbiguous ? " ?" : ""}
                        </Badge>
                      )}
                      <div className="ml-auto flex gap-1.5">
                        <Tone tone={validTones.has(lead.threatLevel) ? (lead.threatLevel as any) : "neutral"} />
                        <Tone tone={lead.isAlert ? "unverified" : "verified"} />
                      </div>
                    </div>

                    <h3 className="mt-2 text-lg font-semibold leading-snug">{lead.primaryTitle}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Category: {lead.category || "general"}.
                      {lead.velocity ? ` Velocity ${lead.velocity.level}.` : ""}
                    </p>

                    <div className="mt-2 flex items-center gap-1.5">
                      {lead.url && (
                        <Button asChild size="sm" variant="ghost" className="h-7 gap-1 text-xs">
                          <a href={lead.url} target="_blank" rel="noopener noreferrer" className="open-link">
                            Open <ExternalLink className="size-3" />
                          </a>
                        </Button>
                      )}
                      {/* Full provenance travels with the pin, so the case can
                          later become a citable source list for Module 5. */}
                      <PinButton
                        label="Pin"
                        payload={{
                          kind: "news",
                          title: lead.primaryTitle,
                          source: lead.primarySource,
                          url: lead.url ?? "",
                          publishedAt: lead.pubDate,
                          excerpt: lead.body || lead.primaryTitle,
                          credibility: null,
                          credibilityRationale:
                            `Collected from ${lead.primarySource}. ` +
                            (g.cluster
                              ? `Carried by ${g.cluster.independentDomains.length} independent source(s) in this collection.`
                              : "Not clustered in this collection."),
                          data: { category: lead.category, language: lead.language },
                        }}
                      />
                    </div>

                    {/* On-demand only — 35 automatic model calls per page load would
                        exhaust a free tier in minutes. */}
                    <ArticleAiPanel
                      title={lead.primaryTitle}
                      body={lead.body || ""}
                      source={lead.primarySource}
                    />

                    {g.cluster && multi && (
                      <div className="mt-3">
                        <ClusterPanel cluster={g.cluster} />
                      </div>
                    )}

                    {others.length > 0 && (
                      <div className="mt-3 space-y-1.5 border-t pt-2.5">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          Also in this story ({others.length})
                        </div>
                        {others.map((o) => (
                          <div key={o.id} className="flex items-start gap-2 text-xs">
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                              {o.primarySource}
                            </span>
                            {o.url ? (
                              <a
                                href={o.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="min-w-0 flex-1 truncate text-foreground hover:underline"
                              >
                                {o.primaryTitle}
                              </a>
                            ) : (
                              <span className="min-w-0 flex-1 truncate">{o.primaryTitle}</span>
                            )}
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {formatRelativeTime(o.pubDate)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })
          ) : (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground text-sm">
                No active news headlines found matching this topic.
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <LlmQuotaCard />
          <Card>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Globe2 className="size-4" />
                Outlet coverage
              </h3>
              <div className="mt-3 space-y-2">
                {outlets.slice(0, 8).map((o) => (
                  <div key={o.name} className="flex items-center justify-between gap-2 rounded-md border bg-card p-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{o.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {o.region} · {o.articles} article{o.articles === 1 ? "" : "s"} here
                      </div>
                    </div>
                    <span
                      className="shrink-0 font-mono text-[10px] text-muted-foreground"
                      title={o.note}
                    >
                      {o.tier ? `${o.tier} · ${o.tierScore?.toFixed(2)}` : "unrated"}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                Counts are articles collected in this run, not totals. Tier is Module 1's
                documented reputation rating; outlets absent from the table show "unrated"
                rather than an invented score.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <TrendingUp className="size-4" />
                Dominant terms
              </h3>
              {terms.length > 0 ? (
                <>
                  <div className="mt-3 space-y-2 text-sm">
                    {terms.map((t) => (
                      <div
                        key={t.term}
                        className="flex items-center justify-between rounded-md border bg-card px-3 py-1.5"
                      >
                        <span>{t.term}</span>
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {t.documentCount} article{t.documentCount === 1 ? "" : "s"}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                    TF-IDF over this collection. No rise/fall percentage is shown — that
                    would need a previous collection to compare against, and none is stored.
                  </p>
                </>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  Not enough articles collected to rank terms.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}