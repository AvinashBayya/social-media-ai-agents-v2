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
  source: string;        // e.g. "News", "Telegram", "Twitter", "Threat Feed"
  title: string;         // Headline / snippet
  matchValue: string;    // The keyword or tag that triggered the match
  matchType: string;     // e.g. "Keyword", "Country", "Domain"
  date: string;
  severity: "low" | "medium" | "high" | "critical";
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
      socialAccounts: ["@osint_watch", "@OSINTdefender"]
    },
    riskScore: 78,
    createdAt: new Date().toISOString()
  },
  {
    id: "wl-2",
    name: "[SAMPLE] Enterprise Brand Protection",
    description: "Tracking brand risk vectors, vendor vulnerabilities, and leaks for partner entities.",
    filters: {
      keywords: ["breach", "exploit", "hack", "ransomware", "defamation"],
      organizations: ["Aster Motors", "Meridian Capital", "Northwind Logistics"],
      people: ["CEO"],
      countries: ["United States", "Germany"],
      domains: ["astermotors.com", "meridiancap.com"],
      emails: [],
      phones: [],
      hashtags: ["#AsterMotors", "#FintechBreach"],
      socialAccounts: ["@AsterMotors"]
    },
    riskScore: 42,
    createdAt: new Date().toISOString()
  }
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
  filters: WatchlistFilters
): Watchlist {
  const list = getWatchlists();
  const newWatch: Watchlist = {
    id: `wl-${Math.random().toString(36).substr(2, 9)}`,
    name: name || "New Watchlist",
    description: description || "Intel monitoring filter.",
    filters: filters,
    // Was Math.round(40 + Math.random() * 50) — a random risk score attached to
    // a watchlist the analyst just created, before it had matched anything.
    riskScore: null,
    createdAt: new Date().toISOString()
  };
  list.unshift(newWatch);
  saveWatchlists(list);
  return newWatch;
}

export function deleteWatchlist(id: string) {
  const list = getWatchlists().filter(w => w.id !== id);
  saveWatchlists(list);
}

// Dynamically generate matches based on the watchlist's rules and active state logs
export function getWatchlistMatches(watchlist: Watchlist, searchData: {
  stories?: any[];
  socialMentions?: any[];
  cyberThreats?: any[];
  telegramPosts?: any[];
}): WatchlistMatch[] {
  const matches: WatchlistMatch[] = [];
  const { filters } = watchlist;

  const checkText = (text: string, list: string[], type: string, src: string, date: string, sev: any) => {
    if (!text) return;
    const txt = text.toLowerCase();
    for (const val of list) {
      if (val && txt.includes(val.toLowerCase())) {
        matches.push({
          id: `match-${Math.random().toString(36).substr(2, 9)}`,
          source: src,
          title: text.length > 80 ? `${text.substring(0, 80)}...` : text,
          matchValue: val,
          matchType: type,
          date: date,
          severity: sev
        });
        break; // Count once per source item
      }
    }
  };

  // 1. Check stories
  if (searchData.stories?.length) {
    searchData.stories.forEach(s => {
      const headline = s.primaryTitle || "";
      const source = s.primarySource || "News Wire";
      const sev = s.threatLevel || "medium";
      const date = s.pubDate || new Date().toISOString();
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
    searchData.socialMentions.forEach(m => {
      const text = m.text || "";
      const author = m.author || "User";
      const date = m.pubDate || new Date().toISOString();
      checkText(text, filters.keywords, "Keyword", `Twitter (@${author})`, date, "medium");
      checkText(text, filters.hashtags, "Hashtag", `Twitter (@${author})`, date, "medium");
      checkText(m.platform, filters.socialAccounts, "Social Account", `Twitter (@${author})`, date, "medium");
    });
  }

  // 3. Check cyber threats
  if (searchData.cyberThreats?.length) {
    searchData.cyberThreats.forEach(t => {
      const ip = t.ip || "";
      const malware = t.malware || "";
      checkText(ip, filters.domains, "Domain/IP", "Threat Feed (Feodo)", new Date().toISOString(), "critical");
      checkText(malware, filters.keywords, "Malware keyword", "Threat Feed (Feodo)", new Date().toISOString(), "high");
    });
  }

  // 4. Check telegram posts
  if (searchData.telegramPosts?.length) {
    searchData.telegramPosts.forEach(p => {
      const text = p.text || "";
      const channel = p.channel || "channel";
      const date = p.date || new Date().toISOString();
      checkText(text, filters.keywords, "Keyword", `Telegram (@${channel})`, date, "high");
      checkText(text, filters.organizations, "Organization", `Telegram (@${channel})`, date, "high");
    });
  }

  // A watchlist that matched nothing returns nothing.
  //
  // This previously invented up to three "System Tracker" telemetry alerts with
  // staggered timestamps, so an empty result looked like a live feed. The comment
  // said the quiet part out loud: "so the dashboard always has live indicators".
  // Fabricated watchlist hits are the most misleading thing this system could
  // put in front of an analyst.

  return matches.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
