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

/**
 * Fixed creation date for the seeded filters.
 *
 * This was `new Date().toISOString()` evaluated at MODULE SCOPE, so both sample
 * watchlists always claimed to have been created the moment the page loaded —
 * a demonstration record asserting it was made seconds ago, every single load.
 */
const SEED_CREATED_AT = "2026-08-06T00:00:00.000Z";

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
    // Was 78. Nothing computes a watchlist risk score — `createWatchlist` sets
    // null for exactly that reason — so a seeded 78 asserted a measurement the
    // system has no way to produce.
    riskScore: null,
    createdAt: SEED_CREATED_AT,
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
    // Was 42, for the same reason as above.
    riskScore: null,
    createdAt: SEED_CREATED_AT,
  },
];

export const WATCHLIST_KEY = "sentinel_watchlists";

/**
 * Bumped when the shape changes. v2 removes the invented risk scores.
 *
 * Changing `DEFAULT_WATCHLISTS` alone was NOT enough, and this is why: the
 * defaults are written to storage on the first ever load and read back from
 * storage on every load after. So a fresh browser picked up the corrected
 * `riskScore: null`, while every browser that had already opened the app — the
 * demo machine included — kept the seeded 78 and 42 and went on rendering
 * "78/100" and "42/100" on /subjects and /watchlists. The fabrication survived
 * exactly where it mattered.
 */
const WATCHLIST_VERSION_KEY = "sentinel_watchlists_version";
const WATCHLIST_VERSION = "2";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Bring stored watchlists onto v2.
 *
 * **Migrates, never wipes** — analyst-created watchlists live under the same key
 * and must survive. The only field touched is `riskScore`, and it is nulled
 * unconditionally rather than only for the two seeded ids: nothing in this
 * system has ever computed a watchlist risk score, so any non-null value in
 * storage is by definition invented, whatever record it sits on.
 *
 * Exported so the migration is testable without a browser, matching
 * `withoutSeeded` in evidence-store.ts and `migrateBookmarks` in
 * bookmark-store.ts.
 */
export function migrateWatchlists(raw: unknown): Watchlist[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w): w is Watchlist => isRecord(w) && typeof w.id === "string")
    .map((w) => (w.riskScore === null ? w : { ...w, riskScore: null }));
}

export function getWatchlists(): Watchlist[] {
  if (typeof window === "undefined") return DEFAULT_WATCHLISTS;
  const store = localStorage.getItem(WATCHLIST_KEY);
  if (!store) {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(DEFAULT_WATCHLISTS));
    localStorage.setItem(WATCHLIST_VERSION_KEY, WATCHLIST_VERSION);
    return DEFAULT_WATCHLISTS;
  }
  try {
    const parsed = JSON.parse(store);
    if (localStorage.getItem(WATCHLIST_VERSION_KEY) !== WATCHLIST_VERSION) {
      const migrated = migrateWatchlists(parsed);
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(migrated));
      localStorage.setItem(WATCHLIST_VERSION_KEY, WATCHLIST_VERSION);
      return migrated;
    }
    return Array.isArray(parsed) ? parsed : DEFAULT_WATCHLISTS;
  } catch {
    return DEFAULT_WATCHLISTS;
  }
}

export function saveWatchlists(list: Watchlist[]) {
  if (typeof window !== "undefined") {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
    localStorage.setItem(WATCHLIST_VERSION_KEY, WATCHLIST_VERSION);
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

// ─── Match timeline ────────────────────────────────────────────────────────

export interface MatchHourBucket {
  /** ISO timestamp of the start of this hour. */
  hourStart: string;
  /** Axis label, e.g. "14:00". */
  label: string;
  /** Matches whose reported publication time falls in this hour. */
  matches: number;
}

export interface MatchTimeline {
  buckets: MatchHourBucket[];
  /** Matches carrying a parseable date. Only these can be plotted. */
  dated: number;
  /** Matches with no reported date. They appear in no bucket, by design. */
  undated: number;
  /** Dated, but published outside the plotted window. */
  outsideWindow: number;
  total: number;
}

const HOUR_MS = 3_600_000;

/**
 * Real hourly distribution of watchlist matches.
 *
 * This replaces a fabricated series. The previous chart was seven fixed labels
 * ("12:00" … "18:00") whose values came from the loop index —
 * `threats: Math.max(2, Math.round(baseVal * 0.4 + ((idx * 2) % 5)))` and
 * `scans: Math.round(150 + idx * 12 + ((idx * idx * 3) % 25))` — with a floor of
 * 5 so the chart never rendered empty even when nothing had matched. Its own
 * comment called it "chart mock trend points". Nothing in this system performs
 * "scans", so that second series measured nothing at all.
 *
 * Here every column is a count of real matches at the time the upstream reported
 * publishing them. Matches with no reported date are counted separately and
 * plotted nowhere — an unreported time is not a time.
 */
export function bucketMatchesByHour(
  matches: WatchlistMatch[],
  nowMs: number,
  hours = 24,
): MatchTimeline {
  const span = Math.max(1, Math.floor(hours));
  // Align to the top of the hour containing `now` so bucket edges are stable
  // across renders within the same hour.
  const end = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  const start = end - span * HOUR_MS;

  const counts = new Array<number>(span).fill(0);
  let dated = 0;
  let undated = 0;
  let outsideWindow = 0;

  for (const m of matches) {
    const t = m.date ? new Date(m.date).getTime() : NaN;
    if (!Number.isFinite(t)) {
      undated += 1;
      continue;
    }
    dated += 1;
    const idx = Math.floor((t - start) / HOUR_MS);
    if (idx < 0 || idx >= span) {
      outsideWindow += 1;
      continue;
    }
    counts[idx] += 1;
  }

  const buckets: MatchHourBucket[] = counts.map((n, i) => {
    const at = new Date(start + i * HOUR_MS);
    return {
      hourStart: at.toISOString(),
      label: `${String(at.getHours()).padStart(2, "0")}:00`,
      matches: n,
    };
  });

  return { buckets, dated, undated, outsideWindow, total: matches.length };
}
