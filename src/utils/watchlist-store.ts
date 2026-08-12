import { localId } from "./local-id";

export interface WatchlistFilters {
  keywords: string[];
  organizations: string[];
  people: string[];
  countries: string[];
  domains: string[];
  emails: string[];
  phones: string[];
  hashtags: string[];
  socialAccounts: string[];
}

export interface Watchlist {
  id: string;
  name: string;
  description: string;
  filters: WatchlistFilters;
  /** Null until scored against real matches. Never randomised. */
  riskScore: number | null;
  createdAt: string;
}

export interface WatchlistMatch {
  id: string;
  /** Where the match came from, e.g. "News (Reuters)", "Telegram (@channel)". */
  source: string;
  title: string; // Headline / snippet
  matchValue: string; // The keyword or tag that triggered the match
  matchType: string; // e.g. "Keyword", "Country", "Domain"
  /**
   * When the matched item was published, as the upstream reported it.
   *
   * Null when it reported none. This was `|| new Date().toISOString()`, so a
   * match on an undated item was stamped with the moment the check ran and
   * rendered as though it had just been published.
   */
  date: string | null;
  /**
   * Severity of the matched item, where the upstream supplied one.
   *
   * Null when it did not. This defaulted to "medium" for social and "high" for
   * Telegram — an invented threat rating attached to a keyword match, which is
   * a statement about the text, not an assessment of it.
   */
  severity: "low" | "medium" | "high" | "critical" | null;
}

const DEFAULT_WATCHLISTS: Watchlist[] = [
  {
    id: "wl-1",
    name: "[SAMPLE] Global Conflict Pulse",
    description: "Monitoring critical threats, physical conflict nodes, and CIB operations.",
    filters: {
      keywords: ["leak", "surveillance", "drone", "intercept", "cyber attack"],
      organizations: ["Vector-17", "Aviation Security"],
      people: ["Chen", "Ortega"],
      countries: ["Iran", "Russia", "Ukraine", "Syria"],
      domains: ["feodotracker.abuse.ch", "anonfiles.com"],
      emails: ["analyst@sentinel.ai"],
      phones: ["+1-555"],
      hashtags: ["#ElectionIntegrity", "#OSINT", "#cybersecurity"],
      socialAccounts: ["@osint_watch", "@OSINTdefender"],
    },
    riskScore: 78,
    createdAt: new Date().toISOString(),
  },
  {
    id: "wl-2",
    name: "[SAMPLE] Enterprise Brand Protection",
    description:
      "Tracking brand risk vectors, vendor vulnerabilities, and leaks for partner entities.",
    filters: {
      keywords: ["breach", "exploit", "hack", "ransomware", "defamation"],
      organizations: ["Aster Motors", "Meridian Capital", "Northwind Logistics"],
      people: ["CEO"],
      countries: ["United States", "Germany"],
      domains: ["astermotors.com", "meridiancap.com"],
      emails: [],
      phones: [],
      hashtags: ["#AsterMotors", "#FintechBreach"],
      socialAccounts: ["@AsterMotors"],
    },
    riskScore: 42,
    createdAt: new Date().toISOString(),
  },
];

export function getWatchlists(): Watchlist[] {
  if (typeof window === "undefined") return DEFAULT_WATCHLISTS;
  const store = localStorage.getItem("sentinel_watchlists");
  if (!store) {
    localStorage.setItem("sentinel_watchlists", JSON.stringify(DEFAULT_WATCHLISTS));
    return DEFAULT_WATCHLISTS;
  }
  try {
    return JSON.parse(store);
  } catch {
    return DEFAULT_WATCHLISTS;
  }
}

export function saveWatchlists(list: Watchlist[]) {
  if (typeof window !== "undefined") {
    localStorage.setItem("sentinel_watchlists", JSON.stringify(list));
  }
}

export function createWatchlist(
  name: string,
  description: string,
  filters: WatchlistFilters,
): Watchlist {
  const list = getWatchlists();
  const newWatch: Watchlist = {
    id: localId("wl"),
    name: name || "New Watchlist",
    description: description || "Intel monitoring filter.",
    filters: filters,
    // Was Math.round(40 + Math.random() * 50) — a random risk score attached to
    // a watchlist the analyst just created, before it had matched anything.
    riskScore: null,
    createdAt: new Date().toISOString(),
  };
  list.unshift(newWatch);
  saveWatchlists(list);
  return newWatch;
}

export function deleteWatchlist(id: string) {
  const list = getWatchlists().filter((w) => w.id !== id);
  saveWatchlists(list);
}

// Dynamically generate matches based on the watchlist's rules and active state logs
export function getWatchlistMatches(
  watchlist: Watchlist,
  searchData: {
    stories?: any[];
    socialMentions?: any[];
    cyberThreats?: any[];
    telegramPosts?: any[];
  },
): WatchlistMatch[] {
  const matches: WatchlistMatch[] = [];
  const { filters } = watchlist;

  const checkText = (
    text: string,
    list: string[],
    type: string,
    src: string,
    date: string | null,
    sev: WatchlistMatch["severity"],
  ) => {
    if (!text) return;
    const txt = text.toLowerCase();
    for (const val of list) {
      if (val && txt.includes(val.toLowerCase())) {
        matches.push({
          id: localId("match"),
          source: src,
          title: text.length > 80 ? `${text.substring(0, 80)}...` : text,
          matchValue: val,
          matchType: type,
          date: date,
          severity: sev,
        });
        break; // Count once per source item
      }
    }
  };

  // 1. Check stories
  if (searchData.stories?.length) {
    searchData.stories.forEach((s) => {
      const headline = s.primaryTitle || "";
      // "News Wire" invented an outlet name, "medium" invented a threat rating
      // and new Date() invented a publication time — three fabrications on one
      // record, all rendered together as though collected.
      const source = s.primarySource || "publisher not reported";
      const sev = s.threatLevel ?? null;
      const date = s.pubDate ?? null;
      checkText(headline, filters.keywords, "Keyword", `News (${source})`, date, sev);
      checkText(headline, filters.organizations, "Organization", `News (${source})`, date, sev);
      checkText(headline, filters.people, "Person", `News (${source})`, date, sev);
      if (s.countryCode) {
        checkText(s.countryCode, filters.countries, "Country", `News (${source})`, date, sev);
      }
    });
  }

  // 2. Check social mentions
  if (searchData.socialMentions?.length) {
    searchData.socialMentions.forEach((m) => {
      const text = m.text || "";
      const author = m.author || "author not reported";
      const date = m.pubDate ?? null;
      checkText(
        text,
        filters.keywords,
        "Keyword",
        `${m.platform || "social"} (@${author})`,
        date,
        null,
      );
      checkText(
        text,
        filters.hashtags,
        "Hashtag",
        `${m.platform || "social"} (@${author})`,
        date,
        null,
      );
      checkText(
        m.platform,
        filters.socialAccounts,
        "Social Account",
        `${m.platform || "social"} (@${author})`,
        date,
        null,
      );
    });
  }

  // 3. Check cyber threats
  if (searchData.cyberThreats?.length) {
    searchData.cyberThreats.forEach((t) => {
      const ip = t.ip || "";
      const malware = t.malware || "";
      // The blocklist rows parsed here carry no per-entry timestamp, and a
      // keyword match against one is not a severity assessment. Both were
      // invented: every IP match was stamped "critical" and dated to the moment
      // the watchlist ran.
      checkText(ip, filters.domains, "Domain/IP", "Threat Feed (Feodo)", t.date ?? null, null);
      checkText(
        malware,
        filters.keywords,
        "Malware keyword",
        "Threat Feed (Feodo)",
        t.date ?? null,
        null,
      );
    });
  }

  // 4. Check telegram posts
  if (searchData.telegramPosts?.length) {
    searchData.telegramPosts.forEach((p) => {
      const text = p.text || "";
      const channel = p.channel || "channel not reported";
      const date = p.date ?? null;
      checkText(text, filters.keywords, "Keyword", `Telegram (@${channel})`, date, null);
      checkText(text, filters.organizations, "Organization", `Telegram (@${channel})`, date, null);
    });
  }

  // A watchlist that matched nothing returns nothing.
  //
  // This previously invented up to three "System Tracker" telemetry alerts with
  // staggered timestamps, so an empty result looked like a live feed. The comment
  // said the quiet part out loud: "so the dashboard always has live indicators".
  // Fabricated watchlist hits are the most misleading thing this system could
  // put in front of an analyst.

  // Undated matches sort last rather than being coerced to the epoch, which
  // would rank every unreported date as the oldest hit in the list.
  const ts = (v: string | null) => {
    const t = v ? new Date(v).getTime() : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  return matches.sort((a, b) => ts(b.date) - ts(a.date));
}
