/**
 * Google dork construction and execution.
 *
 * Two classes of dork, and the distinction matters:
 *
 *   scope: "news"  — executable by us. Google News RSS
 *                    (news.google.com/rss/search) accepts the standard operators
 *                    and returns real results, free and without an API key.
 *                    Verified working: site:, "phrase", -exclude, intitle:, OR.
 *
 *   scope: "web"   — NOT executable by us. These target the full web index
 *                    (filetype:, inurl:, "index of", pastebin, github...), which
 *                    News RSS does not cover — it indexes news articles only, so
 *                    these return nothing there. Google has no free web-search
 *                    API (Custom Search is 100 queries/day and keyed), and
 *                    scraping google.com/search violates their ToS and gets the
 *                    egress IP blocked. So we build the query string and hand it
 *                    to the analyst to run in their own browser.
 *
 * We never synthesise results for a dork we cannot execute. A "web" dork returns
 * a URL to open, not rows that look like findings.
 */

import { createServerFn } from "@tanstack/react-start";
import { buildUpstreamQuery, parseQuery } from "./search";

export type DorkScope = "news" | "web";

export interface DorkTemplate {
  id: string;
  label: string;
  category: string;
  scope: DorkScope;
  /** What an analyst learns from running it. */
  purpose: string;
  /** `{target}` is substituted; `{domain}` gets scheme/path stripped. */
  pattern: string;
}

export const DORK_TEMPLATES: DorkTemplate[] = [
  // ── Executable against Google News RSS ───────────────────────────────────
  {
    id: "news-coverage",
    label: "Baseline news coverage",
    category: "Coverage",
    scope: "news",
    purpose: "All indexed reporting on the target, opinion and sponsored content removed.",
    pattern: `"{target}" -opinion -sponsored -advertorial`,
  },
  {
    id: "news-outlet",
    label: "Coverage from a single outlet",
    category: "Coverage",
    scope: "news",
    purpose: "Isolate how one publisher frames the target — the basis of a bias comparison.",
    pattern: `"{target}" site:{outlet}`,
  },
  {
    id: "news-indian",
    label: "Indian outlet coverage",
    category: "Coverage",
    scope: "news",
    purpose: "Domestic reporting, for comparison against foreign framing of the same event.",
    pattern: `"{target}" (site:thehindu.com OR site:indianexpress.com OR site:timesofindia.indiatimes.com)`,
  },
  {
    id: "news-statemedia",
    label: "State-media framing",
    category: "Credibility",
    scope: "news",
    purpose: "Surface state-affiliated coverage — a direct input to source-credibility scoring.",
    pattern: `"{target}" (site:rt.com OR site:tass.com OR site:globaltimes.cn OR site:presstv.ir)`,
  },
  {
    id: "news-security",
    label: "Security and defence angle",
    category: "Threat",
    scope: "news",
    purpose: "Breach, intrusion and defence-related reporting on the target.",
    pattern: `"{target}" (breach OR hacked OR ransomware OR intrusion OR espionage OR "data leak")`,
  },
  {
    id: "news-title",
    label: "Target named in headline",
    category: "Coverage",
    scope: "news",
    purpose: "Higher-salience hits — the target is the subject, not a passing mention.",
    pattern: `intitle:"{target}"`,
  },
  {
    id: "news-social",
    label: "Social platform references",
    category: "Social",
    scope: "news",
    purpose: "Indexed articles pointing at social profiles or posts about the target.",
    pattern: `"{target}" (site:twitter.com OR site:linkedin.com OR site:reddit.com)`,
  },

  // ── Full-web dorks: generated, executed by the analyst ───────────────────
  {
    id: "web-documents",
    label: "Published documents",
    category: "Documents",
    scope: "web",
    purpose: "PDFs, spreadsheets and slide decks published on the target's own domain.",
    pattern: `site:{domain} (filetype:pdf OR filetype:xlsx OR filetype:docx OR filetype:pptx)`,
  },
  {
    id: "web-dirlist",
    label: "Open directory listings",
    category: "Exposure",
    scope: "web",
    purpose: "Unprotected directory indexes — a common accidental-disclosure route.",
    pattern: `site:{domain} intitle:"index of"`,
  },
  {
    id: "web-config",
    label: "Exposed configuration files",
    category: "Exposure",
    scope: "web",
    purpose: "Config and environment files reachable over HTTP.",
    pattern: `site:{domain} (ext:env OR ext:cfg OR ext:ini OR ext:yaml OR ext:bak)`,
  },
  {
    id: "web-subdomains",
    label: "Subdomain discovery",
    category: "Infrastructure",
    scope: "web",
    purpose: "Indexed subdomains — pairs with the attack-surface lookup on this page.",
    pattern: `site:*.{domain} -www`,
  },
  {
    id: "web-login",
    label: "Login and admin portals",
    category: "Infrastructure",
    scope: "web",
    purpose: "Authentication surfaces exposed to the public internet.",
    pattern: `site:{domain} (inurl:login OR inurl:admin OR inurl:signin OR intitle:"log in")`,
  },
  {
    id: "web-paste",
    label: "Paste-site mentions",
    category: "Leaks",
    scope: "web",
    purpose: "Target appearing on paste sites — often the first sign of a dump.",
    pattern: `"{target}" (site:pastebin.com OR site:ghostbin.com OR site:controlc.com)`,
  },
  {
    id: "web-code",
    label: "Source-code mentions",
    category: "Leaks",
    scope: "web",
    purpose: "Hardcoded references to the target in public repositories.",
    pattern: `"{target}" (site:github.com OR site:gitlab.com OR site:bitbucket.org)`,
  },
  {
    id: "web-procurement",
    label: "Tenders and procurement",
    category: "Documents",
    scope: "web",
    purpose: "Contract and tender documents naming the target.",
    pattern: `"{target}" (tender OR procurement OR "request for proposal") filetype:pdf`,
  },
  {
    id: "web-email",
    label: "Corporate email exposure",
    category: "Exposure",
    scope: "web",
    purpose:
      "Indexed pages publishing addresses at the target's domain — the identity surface behind " +
      "phishing and credential-stuffing, and an input to the entity module.",
    pattern: `site:{domain} intext:"@{domain}"`,
  },
  {
    id: "web-backups",
    label: "Backups and database dumps",
    category: "Exposure",
    scope: "web",
    purpose:
      "Archived copies reachable over HTTP. Distinct from the configuration dork: an old dump " +
      "often survives a config fix and still carries the credentials that fix rotated.",
    pattern: `site:{domain} (ext:sql OR ext:bak OR ext:dump OR ext:old OR ext:backup)`,
  },
  {
    id: "web-apidocs",
    label: "API and interface documentation",
    category: "Infrastructure",
    scope: "web",
    purpose:
      "Published API surface — swagger and OpenAPI definitions enumerate endpoints and " +
      "parameters, extending the attack-surface picture beyond the ports InternetDB observed.",
    pattern: `site:{domain} (inurl:swagger OR inurl:openapi OR inurl:api-docs OR intitle:"api documentation")`,
  },
  {
    id: "web-buckets",
    label: "Public cloud storage",
    category: "Exposure",
    scope: "web",
    purpose:
      "Object-storage buckets naming the target. Misconfigured buckets sit outside the target's " +
      "own domain, so no site:-scoped dork and no subdomain enumeration will surface them.",
    pattern: `"{target}" (site:s3.amazonaws.com OR site:blob.core.windows.net OR site:storage.googleapis.com)`,
  },
];

/** Strip scheme, credentials, port, path and leading www. from a target. */
export function toDomain(target: string): string {
  return (target || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
}

export interface BuiltDork {
  template: DorkTemplate;
  query: string;
  /** Only set for scope "web" — the URL the analyst opens themselves. */
  manualUrl?: string;
}

/**
 * Substitute the target into a template.
 *
 * `outlet` is only consumed by templates containing `{outlet}`; when one of
 * those is built without an outlet the placeholder would survive into the query
 * and match nothing, so we reject it rather than run a silently broken search.
 */
export function buildDork(template: DorkTemplate, target: string, outlet?: string): BuiltDork {
  const clean = (target || "").trim();
  if (!clean) throw new Error("A target is required to build a dork.");

  if (template.pattern.includes("{outlet}") && !outlet?.trim()) {
    throw new Error(`"${template.label}" needs an outlet domain (e.g. reuters.com).`);
  }

  const query = template.pattern
    .replace(/\{target\}/g, clean)
    .replace(/\{domain\}/g, toDomain(clean))
    .replace(/\{outlet\}/g, toDomain(outlet || ""));

  const built: BuiltDork = { template, query };
  if (template.scope === "web") {
    built.manualUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }
  return built;
}

export interface DorkHit {
  title: string;
  source: string;
  url: string;
  pubDate: string;
}

/**
 * Execute a news-scoped dork against Google News RSS.
 *
 * Throws on transport failure or on a web-scoped dork. It does not return
 * placeholder rows — an empty result set means the query genuinely matched
 * nothing, and the caller must be able to tell those two states apart.
 *
 * Plain function so it is callable from a collector adapter (and from tests)
 * without the Start runtime `runNewsDork` below requires — same pattern as
 * `llm.ts`'s core functions vs. their `createServerFn` wrappers.
 */
export async function fetchNewsDorkHits(
  query: string,
  limit?: number,
): Promise<{ query: string; hits: DorkHit[] }> {
  const raw = (query || "").trim();
  if (!raw) throw new Error("Empty dork query.");

  // Normalise through the shared search core so operator handling matches the
  // rest of the app rather than diverging into a second dialect.
  const parsed = parseQuery(raw);
  const upstream = buildUpstreamQuery(parsed) || raw;

  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(upstream)}` +
    `&hl=en-US&gl=US&ceid=US:en`;

  let feed: any;
  try {
    const Parser = (await import("rss-parser")).default;
    const parser = new Parser();
    feed = await parser.parseURL(url);
  } catch (err: any) {
    throw new Error(`Google News RSS request failed: ${err?.message ?? String(err)}`);
  }

  const cappedLimit = Math.min(Math.max(limit ?? 25, 1), 100);
  const hits: DorkHit[] = [];

  for (const item of (feed?.items ?? []).slice(0, cappedLimit)) {
    let title = item.title || "";
    let source = item.creator || item.author || "";

    // Google News appends " - Publisher" to the headline; split it back out
    // instead of showing the publisher glued onto the title.
    const dash = title.lastIndexOf(" - ");
    if (dash !== -1) {
      if (!source) source = title.slice(dash + 3).trim();
      title = title.slice(0, dash).trim();
    }

    hits.push({
      title,
      source: source || "Unknown publisher",
      url: item.link || "",
      pubDate: item.isoDate || item.pubDate || "",
    });
  }

  return { query: upstream, hits };
}

export const runNewsDork = createServerFn({ method: "POST" })
  .validator((d: { query: string; limit?: number }) => d)
  .handler(
    async ({ data }): Promise<{ query: string; hits: DorkHit[] }> =>
      fetchNewsDorkHits(data?.query, data?.limit),
  );
