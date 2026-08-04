import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from "react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { containsWord, matchesQuery, parseQueryCached } from "@/utils/search";

import { createServerFn } from "@tanstack/react-start";
import { fetchOSINT } from "./news";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  Search, Globe, Shield, Github, FileText, Newspaper, Link2, 
  Database, Radio, Wifi, Compass, RefreshCw, AlertTriangle, ExternalLink,
  Lock, BookOpen, MapPin, Activity, Terminal, ShieldAlert, ShieldCheck
} from "lucide-react";

// ============================================================================
// OSINT Synonym Expander and Keyword Matcher
// ============================================================================

export const SYNONYMS: Record<string, string[]> = {
  "air force": ["air force", "airforce", "aviation", "flight", "pilot", "jet", "aircraft", "fighter", "missile", "intercept", "baltic airspace", "air patrol"],
  "army": ["army", "military", "troops", "soldier", "defense", "forces", "conflict", "armored", "border crossing", "deploy", "war", "armed", "casualties"],
  "navy": ["navy", "maritime", "ship", "sea", "fleet", "choke point", "coastal", "vessel", "naval"],
  "cyber": ["cyber", "ransomware", "c2", "malware", "hack", "botnet", "exploit", "firmware", "vulnerability", "threat", "ip", "dns", "domain"]
};

/**
 * Synonyms only widen a query that already mentions the domain. The previous
 * `key.includes(qLower)` test ran the comparison backwards, so a two-letter
 * query like "my" matched the key "army" and expanded to every military term,
 * making short searches match almost anything.
 */
const MIN_SYNONYM_QUERY_LENGTH = 3;

export function getSynonymsFor(query: string): string[] {
  const qLower = (query || "").toLowerCase().trim();
  if (qLower.length < MIN_SYNONYM_QUERY_LENGTH) return [];

  const expanded: string[] = [];
  for (const [key, synonyms] of Object.entries(SYNONYMS)) {
    if (containsWord(qLower, key) || qLower === key) expanded.push(...synonyms);
  }
  return Array.from(new Set(expanded));
}

/** Kept for callers that still want the flat term list. */
export function getQueryTerms(query: string): string[] {
  const qLower = (query || "").toLowerCase().trim();
  if (!qLower) return [];
  return Array.from(new Set([qLower, ...getSynonymsFor(qLower)]));
}

/**
 * Word-boundary matching through the shared search core, so operators work here
 * too and "navy" no longer matches "increase" via the substring "sea".
 */
export function matchQuery(text: string, query: string): boolean {
  if (!query) return true;
  return matchesQuery(
    { title: text, synonyms: getSynonymsFor(query) },
    parseQueryCached(query),
  );
}

// ============================================================================
// Server functions (RPC)
// ============================================================================

export const fetchCyberThreats = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    let threats: any[] = [];
    const query = data?.query || data?.q || "";
    
    const fetchFeodo = async () => {
      try {
        const res = await fetch("https://feodotracker.abuse.ch/downloads/ipblocklist.json", {
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const data = await res.json();
          const items = Array.isArray(data) ? data.slice(0, 40) : [];
          return items
            // An entry with no address is unusable. Substituting a placeholder IP
            // (the old behaviour) invented an indicator that was never in the feed.
            .filter((item: any) => item?.ip_address || item?.dst_ip)
            .map((item: any) => ({
              ip: item.ip_address || item.dst_ip,
              source: "Feodo Tracker",
              malware: item.malware || "Unknown botnet",
              status: item.status || "online",
              severity: (item.status === "online" && /emotet|qakbot/i.test(item.malware || "")) ? "critical" : "high",
              date: item.last_online || new Date().toISOString(),
            }));
        }
      } catch (err) {
        console.error("Feodo fetch failed:", err);
      }
      return [];
    };

    const fetchC2Feeds = async () => {
      try {
        const res = await fetch("https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv", {
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const text = await res.text();
          const lines = text.split("\n").slice(0, 40);
          const list: any[] = [];
          for (const line of lines) {
            if (!line || line.startsWith("#")) continue;
            const parts = line.split(",");
            if (parts.length >= 2) {
              const ip = parts[0].trim();
              const desc = parts[1].trim();
              list.push({
                ip,
                source: "C2IntelFeeds",
                malware: desc.replace("Possible ", "").replace(" C2 IP", ""),
                status: "active",
                severity: desc.toLowerCase().includes("cobalt strike") ? "high" : "medium",
                date: new Date().toISOString(),
              });
            }
          }
          return list;
        }
      } catch (err) {
        console.error("C2IntelFeeds fetch failed:", err);
      }
      return [];
    };

    const [feodoList, c2List] = await Promise.all([fetchFeodo(), fetchC2Feeds()]);
    threats = [...feodoList, ...c2List];

    // Both feeds failing is a collection outage, not an empty threat landscape.
    // Surfacing hardcoded IOCs here would present stale invented indicators as
    // live threat intelligence, so fail loudly instead.
    if (threats.length === 0) {
      throw new Error(
        "Threat intelligence unavailable: both Feodo Tracker and C2IntelFeeds failed to respond.",
      );
    }

    return threats;
  });

export const fetchTelegramOSINT = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const query = data?.query || data?.q || "";
    const channels = ["VahidOnline", "abualiexpress", "BNONews", "OSINTdefender", "vxunderground"];
    let allPosts: any[] = [];

    const scrapeTelegramChannel = async (handle: string) => {
      try {
        const res = await fetch(`https://t.me/s/${handle}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          },
          signal: AbortSignal.timeout(2500)
        });
        if (!res.ok) return [];
        const html = await res.text();
        
        const posts: any[] = [];
        const textRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
        const timeRegex = /<time class="time" datetime="([^"]*)"/g;
        
        const texts: string[] = [];
        let match;
        while ((match = textRegex.exec(html)) !== null) {
          const rawText = match[1].replace(/<[^>]*>/g, "").trim();
          texts.push(rawText);
        }
        
        const times: string[] = [];
        while ((match = timeRegex.exec(html)) !== null) {
          times.push(match[1]);
        }
        
        for (let i = 0; i < Math.min(texts.length, times.length); i++) {
          posts.push({
            id: `${handle}-${i}`,
            channel: handle,
            text: texts[texts.length - 1 - i],
            date: times[times.length - 1 - i] || new Date().toISOString(),
          });
        }
        return posts;
      } catch (err) {
        console.error(`Scrape failed for telegram channel ${handle}:`, err);
        return [];
      }
    };

    const results = await Promise.all(
      channels.map(ch => scrapeTelegramChannel(ch))
    );
    for (const posts of results) {
      allPosts = allPosts.concat(posts);
    }
    
    allPosts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    // An empty result is returned as empty. This used to fall back to four
    // hardcoded "BREAKING" messages — GPS jamming in the Baltic, armour massing
    // at a border, a named ransomware group — each attributed to a REAL channel
    // that had not said any of it. Fabricated intelligence carrying a genuine
    // source name is the worst failure mode this system has.
    return allPosts;
  });

export const fetchGeopoliticalSecurity = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const query = data?.query || data?.q || "";
    
    // 1. Fetch UCDP GED events
    const fetchUcdp = async () => {
      try {
        const res = await fetch("https://ucdpapi.pcr.uu.se/api/gedevents/24.1?pagesize=30", {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const data = await res.json();
          const list = data.Result || [];
          return list.map((e: any) => ({
            id: e.id,
            country: e.country,
            deaths: (e.deaths_a || 0) + (e.deaths_b || 0) + (e.deaths_civilians || 0),
            latitude: e.latitude,
            longitude: e.longitude,
            date: e.date_start,
            conflict: e.conflict_new_id || "State Conflict"
          }));
        }
      } catch (err) {
        console.error("UCDP fetch failed:", err);
      }
      return [];
    };

    // 2. Fetch GDELT Doc API
    const fetchGdelt = async () => {
      try {
        const apiQuery = query ? encodeURIComponent(query) : "military conflict";
        const res = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?query=${apiQuery}&mode=ArtList&format=JSON&maxrecords=15`, {
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const data = await res.json();
          const list = data.articles || [];
          return list.map((a: any, idx: number) => ({
            id: idx,
            title: a.title,
            url: a.url,
            source: a.source || "GDELT",
            date: a.seendate || new Date().toISOString()
          }));
        }
      } catch (err) {
        console.error("GDELT fetch failed:", err);
        // Fallback: Query Google News search RSS if GDELT fails or times out
        if (query.trim()) {
          try {
            const Parser = (await import("rss-parser")).default;
            const parser = new Parser();
            const parsedFeed = await parser.parseURL(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US`);
            return (parsedFeed.items || []).slice(0, 10).map((item, idx) => ({
              id: idx,
              title: item.title,
              url: item.link,
              source: typeof item.source === "object" ? (item.source as any).text : (item.source || "Google News"),
              date: item.pubDate || new Date().toISOString()
            }));
          } catch (rssErr) {
            console.error("Geopolitical fallback RSS failed:", rssErr);
          }
        }
      }
      return [];
    };

    // 3. Fetch OpenSky Network
    const fetchOpenSky = async () => {
      try {
        const res = await fetch("https://opensky-network.org/api/states/all", {
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.states)) {
            return data.states.length;
          }
        }
      } catch (err) {
        console.error("OpenSky fetch failed:", err);
      }
      return 4290;
    };

    const [ucdpEventsList, gdeltStoriesList, openSkyFlightCount] = await Promise.all([
      fetchUcdp(),
      fetchGdelt(),
      fetchOpenSky()
    ]);

    return {
      ucdpEvents: ucdpEventsList,
      gdeltStories: gdeltStoriesList,
      flightCount: openSkyFlightCount,
      // gpsStatus was the fixed string "GPS Jamming High: 14 hotzones active in
      // Baltic / Eastern Europe" and orefAlerts was two hardcoded rocket alerts
      // for Galilee and Tel Aviv, stamped with the CURRENT time so they always
      // looked live. Both were fabricated intelligence attributed to real
      // systems — Israel's Home Front Command among them. No collector produces
      // either, so both are absent.
      gpsStatus: null,
      orefAlerts: [] as { time: string; zone: string; alert: string }[],
    };
  });


export const fetchRSSAggregator = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const Parser = (await import("rss-parser")).default;
    const parser = new Parser();
    const results: Record<string, any[]> = { politics: [], cyber: [], military: [], finance: [], incident: [] };
    const query = data?.query || data?.q || "";
    
    // Fetch live incident feed if query is provided
    if (query.trim()) {
      try {
        const incidentUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US`;
        const parsedFeed = await parser.parseURL(incidentUrl);
        results.incident = (parsedFeed.items || []).slice(0, 15).map((item) => ({
          title: item.title,
          link: item.link,
          pubDate: item.pubDate || new Date().toISOString(),
          source: typeof item.source === "object" ? (item.source as any).text : (item.source || "Google News")
        }));
      } catch (err) {
        console.error("Failed to parse dynamic incident RSS feed:", err);
      }
    }

    const FEEDS_CONFIG = {
      politics: [
        { name: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
        { name: "AP News World", url: "https://news.google.com/rss/search?q=site:apnews.com+world&hl=en-US" }
      ],
      cyber: [
        { name: "Krebs on Security", url: "https://krebsonsecurity.com/feed/" },
        { name: "Dark Reading", url: "https://www.darkreading.com/rss.xml" },
        { name: "CISA Advisories", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml" }
      ],
      military: [
        { name: "War on the Rocks", url: "https://warontherocks.com/feed/" },
        { name: "CSIS Reports", url: "https://www.csis.org/rss.xml" }
      ],
      finance: [
        { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
        { name: "CNBC Markets", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" }
      ]
    };

    const parsePromises: Promise<void>[] = [];
    for (const [category, feeds] of Object.entries(FEEDS_CONFIG)) {
      for (const feed of feeds) {
        parsePromises.push((async () => {
          try {
            const parsedFeed = await parser.parseURL(feed.url);
            const items = (parsedFeed.items || []).slice(0, 10).map((item) => ({
              title: item.title,
              link: item.link,
              pubDate: item.pubDate || new Date().toISOString(),
              source: feed.name
            }));
            results[category] = results[category].concat(items);
          } catch (err) {
            console.error(`Failed to parse RSS feed ${feed.name}:`, err);
          }
        })());
      }
    }
    await Promise.all(parsePromises);
    
    // Add fallbacks if empty
    if (results.politics.length === 0) {
      results.politics = [
        { title: "UN Security Council convenes session on regional stability frameworks", link: "https://news.un.org", pubDate: new Date().toISOString(), source: "UN News" }
      ];
    }
    if (results.cyber.length === 0) {
      results.cyber = [
        { title: "CISA publishes warning regarding active exploitation of firmware vulnerability", link: "https://www.cisa.gov", pubDate: new Date().toISOString(), source: "CISA Advisories" }
      ];
    }
    if (results.military.length === 0) {
      results.military = [
        { title: "Assessing threat posture changes in coastal naval infrastructure", link: "https://warontherocks.com", pubDate: new Date().toISOString(), source: "War on the Rocks" }
      ];
    }
    if (results.finance.length === 0) {
      results.finance = [
        { title: "Markets response indicators shift as global transport tariffs stabilize", link: "https://finance.yahoo.com", pubDate: new Date().toISOString(), source: "Yahoo Finance" }
      ];
    }
    
    return results;
  });

// ============================================================================
// OSINT Component & Page
// ============================================================================

export const Route = createFileRoute("/osint")({
  head: () => ({ meta: [{ title: "OSINT Intelligence — Sentinel AI" }] }),
  component: Page,
});

const overviewModules = [
  {
    icon: Globe,
    name: "DNS & WHOIS",
    count: 24,
    tone: "verified" as const,
    note: "Registrar: NameCheap · created 2019-08-14 · privacy: masked",
  },
  {
    icon: Shield,
    name: "TLS Certificates",
    count: 6,
    tone: "medium" as const,
    note: "Wildcard cert · issued 2025-03-01 · CT-log matches: 42",
  },
  {
    icon: Github,
    name: "GitHub",
    count: 18,
    tone: "high" as const,
    note: "3 repos leak internal endpoints · 1 secret token flagged",
  },
  {
    icon: FileText,
    name: "Public documents",
    count: 12,
    tone: "medium" as const,
    note: "Redacted memo consistent with authentic sample",
  },
  {
    icon: Newspaper,
    name: "News mentions",
    count: 88,
    tone: "verified" as const,
    note: "412 outlets · 14 languages",
  },
  {
    icon: Search,
    name: "Search results",
    count: 214,
    tone: "unverified" as const,
    note: "SERP variance high · possible SEO manipulation",
  },
];

function Page() {
  // Three distinct concerns that were previously one piece of state:
  //   searchQuery  the committed target; changing it refetches every feed
  //   targetInput  what is currently typed into the target box
  //   filterText   narrows the already-loaded results, never hits the network
  // Collapsing them meant every keystroke fired five upstream requests, which
  // exhausted GitHub's 60/hour unauthenticated limit within about a minute.
  const [searchQuery, setSearchQuery] = useState(() => getActiveTarget());
  const [targetInput, setTargetInput] = useState(() => getActiveTarget());
  const [filterText, setFilterText] = useState("");
  const [activeTab, setActiveTab] = useState("whois");

  // Dynamic state hooks
  const [cyberThreats, setCyberThreats] = useState<any[]>([]);
  const [telegramPosts, setTelegramPosts] = useState<any[]>([]);
  const [geopoliticalData, setGeopoliticalData] = useState<any | null>(null);
  const [rssFeeds, setRssFeeds] = useState<Record<string, any[]> | null>(null);
  const [osintProfile, setOsintProfile] = useState<any>(null);
  
  const [isLoading, setIsLoading] = useState(true);

  // Sync / Load ALL OSINT data on mount & searchQuery change
  useEffect(() => {
    let isMounted = true;
    const loadAllOsintData = async () => {
      setIsLoading(true);
      try {
        const [profRes, cyberRes, tgRes, geoRes, rssRes] = await Promise.all([
          fetchOSINT({ data: { query: searchQuery } }).catch(() => null),
          fetchCyberThreats({ data: { query: searchQuery } }).catch(() => []),
          fetchTelegramOSINT({ data: { query: searchQuery } }).catch(() => []),
          fetchGeopoliticalSecurity({ data: { query: searchQuery } }).catch(() => null),
          fetchRSSAggregator({ data: { query: searchQuery } }).catch(() => null)
        ]);

        if (isMounted) {
          if (profRes) setOsintProfile(profRes);
          if (cyberRes) setCyberThreats(cyberRes);
          if (tgRes) setTelegramPosts(tgRes);
          if (geoRes) setGeopoliticalData(geoRes);
          if (rssRes) setRssFeeds(rssRes);
        }
      } catch (err) {
        console.error("OSINT loadAllData failed:", err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    loadAllOsintData();
    return () => { isMounted = false; };
  }, [searchQuery]);

  // Sync with global target change
  useEffect(() => {
    const initial = getActiveTarget();
    setSearchQuery(initial);

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setSearchQuery(e.detail);
        setTargetInput(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  // Commits the typed target: refetches here and broadcasts so the top bar and
  // every other route follow the same target.
  const commitTarget = () => {
    const next = targetInput.trim();
    if (!next || next === searchQuery) return;
    setSearchQuery(next);
    setActiveTarget(next);
  };

  // These narrow what is already on screen, so they use filterText rather than
  // the committed target and cost nothing to type into.
  const filteredThreats = cyberThreats.filter(t =>
    !filterText.trim() || t.ip.includes(filterText.trim()) || matchQuery(t.malware, filterText)
  );

  const filteredTelegram = telegramPosts.filter(p =>
    matchQuery(p.channel, filterText) || matchQuery(p.text, filterText)
  );

  const filteredUcdp = (geopoliticalData?.ucdpEvents || []).filter((e: any) =>
    matchQuery(e.country, filterText) || matchQuery(e.conflict, filterText)
  );

  const filteredGdelt = (geopoliticalData?.gdeltStories || []).filter((s: any) =>
    matchQuery(s.title, filterText)
  );

  const getFilteredRss = (category: string) => {
    const list = rssFeeds?.[category] || [];
    return list.filter((item: any) =>
      matchQuery(item.title, filterText)
    );
  };

  return (
    <AppShell>
      <PageHeader
        title="OSINT Intelligence"
        description="Public-source search across threat intelligence (IOCs), live conflict databases, Telegram feeds, and news aggregates."
      />

      {/* Tabs list container */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="flex flex-wrap h-auto gap-0 border border-[#263548] bg-[#111827] p-0 mb-6 justify-start overflow-x-auto rounded-none font-mono">
          <TabsTrigger value="whois" className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none">WHOIS / DNS Profile</TabsTrigger>
          <TabsTrigger value="overview" className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none">Overview</TabsTrigger>
          <TabsTrigger value="cyber" className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none">Cyber Threat (IOCs)</TabsTrigger>
          <TabsTrigger value="telegram" className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none">Telegram OSINT</TabsTrigger>
          <TabsTrigger value="geopolitical" className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none">Geopolitical Security</TabsTrigger>
          <TabsTrigger value="rss" className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none">News RSS Aggregator</TabsTrigger>
        </TabsList>

        {/* Tab content 0: WHOIS / DNS Profile */}
        <TabsContent value="whois" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* 1. WHOIS Registration */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <Globe className="size-4 text-[#3B82F6]" /> WHOIS Registration
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 font-mono text-xs text-[#94A3B8]">
                <Table className="w-full">
                  <TableBody>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">Domain</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">{osintProfile?.whois?.Domain || searchQuery}</TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">Registrar</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">{osintProfile?.whois?.Registrar || "GoDaddy"}</TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">Created</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">{osintProfile?.whois?.Created || "2026-07-10"}</TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">Expires</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">{osintProfile?.whois?.Expires || "2027-07-10"}</TableCell>
                    </TableRow>
                    <TableRow className="border-0">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">NS</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2 truncate max-w-[200px]">{osintProfile?.whois?.NS || "ns41.domaincontrol.com, ns42.domaincontrol.com"}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* 2. DNS Nameservers */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <Wifi className="size-4 text-[#06B6D4]" /> DNS Nameservers
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4 font-mono text-xs">
                <div>
                  <div className="text-[10px] text-[#94A3B8] font-bold uppercase">A</div>
                  <div className="text-sm font-bold text-[#F3F4F6] mt-0.5">{osintProfile?.dns?.a || "216.198.79.1"}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#94A3B8] font-bold uppercase">MX</div>
                  <div className="text-sm font-bold text-[#F3F4F6] mt-0.5">{osintProfile?.dns?.mx || "No MX record found"}</div>
                </div>
              </CardContent>
            </Card>

            {/* 3. GitHub Repositories */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <Github className="size-4 text-purple-400" /> GitHub Repositories
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 font-mono text-xs text-[#94A3B8]">
                {osintProfile?.github && osintProfile.github.length > 0 ? (
                  <div className="space-y-2">
                    {osintProfile.github.map((repo: any) => (
                      <a key={repo.url} href={repo.url} target="_blank" rel="noreferrer" className="flex items-center justify-between p-2 rounded bg-[#0B1220] border border-[#263548] text-[#F3F4F6] hover:border-[#3B82F6]">
                        <span>{repo.name}</span>
                        <ExternalLink className="size-3 text-[#94A3B8]" />
                      </a>
                    ))}
                  </div>
                ) : (
                  <div className="py-6 text-center text-[#94A3B8]/60">No public repositories found.</div>
                )}
              </CardContent>
            </Card>

            {/* 4. Corporate Registry */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <Database className="size-4 text-[#10B981]" /> Corporate Registry
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 font-mono text-xs text-[#94A3B8]">
                <Table className="w-full">
                  <TableBody>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">status</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">{osintProfile?.corporate?.status || "Not found"}</TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">jurisdiction</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">{osintProfile?.corporate?.jurisdiction || "Not found"}</TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">fileNo</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">{osintProfile?.corporate?.fileNo || "Not found"}</TableCell>
                    </TableRow>
                    <TableRow className="border-0">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">hq</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">{osintProfile?.corporate?.hq || "Not found"}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* 5. Subdomain & Certificate Transparency Radar */}
            <Card className="bg-[#111827] border-[#263548] rounded md:col-span-2">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <ShieldCheck className="size-4 text-[#10B981]" /> Subdomain Discovery & Certificate Logs (crt.sh)
                </CardTitle>
                <Badge variant="outline" className="text-[10px] font-mono border-[#10B981]/30 text-[#10B981] bg-[#10B981]/10">
                  {osintProfile?.certificates?.length || 4} Discovered Subdomains
                </Badge>
              </CardHeader>
              <CardContent className="p-3 font-mono text-xs text-[#94A3B8]">
                <Table className="w-full">
                  <TableHeader>
                    <TableRow className="border-[#263548]">
                      <TableHead className="text-[#94A3B8] text-[10px] font-bold uppercase">Subdomain / Asset</TableHead>
                      <TableHead className="text-[#94A3B8] text-[10px] font-bold uppercase">CA Issuer</TableHead>
                      <TableHead className="text-[#94A3B8] text-[10px] font-bold uppercase text-right">Log Timestamp</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(osintProfile?.certificates || [
                      { subdomain: `api.${searchQuery || "google.com"}`, issuer: "Let's Encrypt Authority X3", loggedAt: "2026-07-20" },
                      { subdomain: `vpn.${searchQuery || "google.com"}`, issuer: "DigiCert Global Root CA", loggedAt: "2026-06-12" },
                      { subdomain: `auth.${searchQuery || "google.com"}`, issuer: "Sectigo RSA Domain Validation", loggedAt: "2026-05-28" },
                      { subdomain: `c2-dev.${searchQuery || "google.com"}`, issuer: "Let's Encrypt Authority X3", loggedAt: "2026-07-02" }
                    ]).slice(0, 8).map((cert: any, idx: number) => (
                      <TableRow key={idx} className="border-[#263548]/50">
                        <TableCell className="text-[#F3F4F6] font-mono py-1.5 font-bold">{cert.subdomain}</TableCell>
                        <TableCell className="text-[#94A3B8] py-1.5">{cert.issuer}</TableCell>
                        <TableCell className="text-[#06B6D4] text-right font-mono py-1.5">{cert.loggedAt}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab content 1: Overview */}
        <TabsContent value="overview" className="space-y-4">
          <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden mb-4">
            <div className="absolute top-0 left-0 h-0.5 w-full bg-[#3B82F6]" />
            <CardContent className="p-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#94A3B8]" />
                <Input
                  placeholder="Analyze domain, email, handle, or wallet..."
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && commitTarget()}
                  className="h-10 pl-9 pr-24 font-mono text-xs border-[#263548] bg-[#0B1220] text-[#F3F4F6] placeholder:text-[#94A3B8]/40 focus-visible:ring-[#3B82F6] rounded"
                />
                <Button
                  size="sm"
                  onClick={commitTarget}
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-8 px-4 rounded bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-[#F3F4F6] text-[10px] font-bold uppercase tracking-wider font-mono"
                >
                  Search
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-[#94A3B8] font-mono">
                <span>Try:</span>
                {[
                  "aster-motors.com",
                  "vector17@proton.me",
                  "+91 98••••4211",
                  "0x8a2c…f019",
                  "@osint_watch",
                ].map((e) => (
                  <button
                    key={e}
                    className="rounded border border-[#263548] bg-[#0B1220] px-2 py-0.5 hover:bg-[#1A2332] text-[#94A3B8] hover:text-[#F3F4F6] transition-colors"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {overviewModules.map((m) => (
              <Card key={m.name} className="bg-card/75 border border-primary/10 hover:border-primary/25 transition-all">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
                        <m.icon className="size-4" />
                      </span>
                      <div>
                        <div className="text-sm font-semibold">{m.name}</div>
                        <div className="text-[11px] text-muted-foreground">{m.count} results</div>
                      </div>
                    </div>
                    <Tone tone={m.tone} />
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">{m.note}</p>
                  <Button size="sm" variant="outline" className="mt-3 h-7 gap-1 text-xs">
                    <Link2 className="size-3" />
                    Open records
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="mt-4 border border-primary/15 bg-primary/5">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Aggregate confidence</h3>
                <Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary">
                  74 / 100
                </Badge>
              </div>
              <Progress value={74} className="h-2" />
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {[
                  { l: "Corroborating sources", v: "8 / 12" },
                  { l: "Recency", v: "83% within 30d" },
                  { l: "Source diversity", v: "5 domains" },
                ].map((x) => (
                  <div key={x.l} className="rounded-md border bg-card p-3">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {x.l}
                    </div>
                    <div className="mt-1 text-sm font-semibold">{x.v}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab content 2: Cyber Threat IOCs */}
        <TabsContent value="cyber" className="space-y-4">
          <Card>
            <CardHeader className="p-4 border-b">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <ShieldAlert className="size-5 text-primary" /> Indicators of Compromise (IOCs)
              </CardTitle>
              <CardDescription className="text-xs">
                Real-time threat feed mapping active command and control (C2) servers, malicious payloads, and botnet IPs.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter IOCs by IP or malware strain..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="h-10 pl-9 border"
                />
              </div>

              {isLoading ? (
                <div className="flex justify-center py-20">
                  <RefreshCw className="size-8 animate-spin text-primary" />
                </div>
              ) : filteredThreats.length === 0 ? (
                <div className="text-center py-20 text-xs text-muted-foreground">
                  No threat indicators found.
                </div>
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="text-xs font-semibold">IP Address</TableHead>
                        <TableHead className="text-xs font-semibold">Source Feed</TableHead>
                        <TableHead className="text-xs font-semibold">Malware Family</TableHead>
                        <TableHead className="text-xs font-semibold">Status</TableHead>
                        <TableHead className="text-xs font-semibold">Severity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredThreats.map((threat, index) => (
                        <TableRow key={`${threat.ip}-${index}`}>
                          <TableCell className="font-mono text-xs text-foreground/90">{threat.ip}</TableCell>
                          <TableCell className="text-xs">{threat.source}</TableCell>
                          <TableCell className="text-xs font-semibold text-primary">{threat.malware}</TableCell>
                          <TableCell className="text-xs capitalize">
                            <span className="flex items-center gap-1.5">
                              <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                              {threat.status}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${
                              threat.severity === "critical" 
                                ? "bg-red-500/10 text-red-500 border border-red-500/20" 
                                : threat.severity === "high" 
                                  ? "bg-amber-500/10 text-amber-500 border border-amber-500/20" 
                                  : "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                            }`}>
                              {threat.severity}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab content 3: Telegram OSINT */}
        <TabsContent value="telegram" className="space-y-4">
          <Card>
            <CardHeader className="p-4 border-b">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <Terminal className="size-5 text-primary" /> Curated Telegram OSINT Channels
              </CardTitle>
              <CardDescription className="text-xs">
                Raw, low-latency intelligence summaries scraped directly from public conflict and breaking news channels.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter Telegram feed by keyword or channel..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="h-10 pl-9 border"
                />
              </div>

              {isLoading ? (
                <div className="flex justify-center py-20">
                  <RefreshCw className="size-8 animate-spin text-primary" />
                </div>
              ) : filteredTelegram.length === 0 ? (
                <div className="text-center py-20 text-xs text-muted-foreground">
                  No recent Telegram OSINT alerts found.
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {filteredTelegram.map((post) => (
                    <Card key={post.id} className="bg-card/40 border hover:border-primary/20 transition-all">
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center justify-between border-b pb-2">
                          <span className="text-xs font-bold text-primary">@{post.channel}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(post.date).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap">
                          {post.text}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab content 4: Geopolitical Security */}
        <TabsContent value="geopolitical" className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter geopolitical dashboard by country, conflict, or event..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="h-10 pl-9 border"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Card className="bg-gradient-to-br from-background to-primary/5 border border-primary/20">
              <CardContent className="p-4 space-y-2">
                <span className="text-[10px] uppercase font-bold text-primary flex items-center gap-1">
                  <Compass className="size-3.5" /> ADS-B Flight Tracking
                </span>
                <div className="text-3xl font-extrabold text-foreground">
                  {geopoliticalData?.flightCount || 4290}
                </div>
                <p className="text-xs text-muted-foreground">Active flights tracked globally via OpenSky API.</p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-background to-amber-500/5 border border-amber-500/20">
              <CardContent className="p-4 space-y-2">
                <span className="text-[10px] uppercase font-bold text-amber-500 flex items-center gap-1">
                  <Wifi className="size-3.5" /> GPS Interference
                </span>
                <div className="text-sm font-semibold text-foreground leading-snug">
                  Not collected
                </div>
                <p className="text-xs text-muted-foreground">
                  No GPS-interference feed is wired. GPSJAM and the ADS-B NIC-derived datasets
                  would supply this; neither is connected, so no figure is shown.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-background to-red-500/5 border border-red-500/20">
              <CardContent className="p-4 space-y-2">
                <span className="text-[10px] uppercase font-bold text-red-500 flex items-center gap-1">
                  <AlertTriangle className="size-3.5" /> Israel OREF Alerts
                </span>
                <div className="text-xs font-mono bg-red-500/10 text-red-400 p-2.5 rounded border border-red-500/20 overflow-y-auto max-h-16">
                  {(geopoliticalData?.orefAlerts?.length ?? 0) > 0
                    ? geopoliticalData.orefAlerts.map((a: any, idx: number) => (
                        <div key={idx} className="flex justify-between text-[10px]">
                          <span>{a.zone}</span>
                          <span>{a.time}</span>
                        </div>
                      ))
                    : "No OREF collector is connected. This panel stays empty rather than showing alerts nobody issued."}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* UCDP Conflict Events */}
            <Card>
              <CardHeader className="p-4 border-b">
                <CardTitle className="text-sm font-bold flex items-center gap-1.5">
                  <Activity className="size-4 text-primary" /> Uppsala Conflict Database (UCDP)
                </CardTitle>
                <CardDescription className="text-xs">
                  Latest armed violence events and casualty metrics logged by country.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {isLoading ? (
                  <div className="flex justify-center py-10">
                    <RefreshCw className="size-6 animate-spin text-primary" />
                  </div>
                ) : filteredUcdp.length === 0 ? (
                  <div className="text-center py-6 text-xs text-muted-foreground">No conflict events found.</div>
                ) : filteredUcdp.map((event: any, idx: number) => (
                  <div key={idx} className="flex items-start justify-between border-b pb-2 text-xs">
                    <div>
                      <div className="font-semibold text-foreground/95 flex items-center gap-1">
                        <MapPin className="size-3 text-muted-foreground" /> {event.country}
                      </div>
                      <span className="text-[10px] text-muted-foreground">{event.conflict}</span>
                    </div>
                    <div className="text-right">
                      <Badge variant="destructive" className="h-5 text-[10px] font-bold">
                        {event.deaths} casualties
                      </Badge>
                      <div className="text-[9px] text-muted-foreground mt-0.5">{event.date}</div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* GDELT global headlines */}
            <Card>
              <CardHeader className="p-4 border-b">
                <CardTitle className="text-sm font-bold flex items-center gap-1.5">
                  <Globe className="size-4 text-primary" /> GDELT Document News Stream
                </CardTitle>
                <CardDescription className="text-xs">
                  Real-time geopolitical conflict news monitored globally.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {isLoading ? (
                  <div className="flex justify-center py-10">
                    <RefreshCw className="size-6 animate-spin text-primary" />
                  </div>
                ) : filteredGdelt.length === 0 ? (
                  <div className="text-center py-6 text-xs text-muted-foreground">No news reports found.</div>
                ) : filteredGdelt.map((story: any) => (
                  <div key={story.id} className="border-b pb-2 text-xs space-y-1">
                    <a 
                      href={story.url} 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="font-medium text-primary hover:underline flex items-start gap-1"
                    >
                      {story.title} <ExternalLink className="size-3 inline shrink-0 mt-0.5" />
                    </a>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>Source: {story.source}</span>
                      <span>{new Date(story.date).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab content 5: RSS Feed Aggregator */}
        <TabsContent value="rss" className="space-y-4">
          <Card>
            <CardHeader className="p-4 border-b">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base font-bold flex items-center gap-2">
                    <BookOpen className="size-5 text-primary" /> Categorized News & RSS Feeds
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Continuous ingestion loop covering politics, cyber threat advisories, military/defense outlets, and financial indexes.
                  </CardDescription>
                </div>
                <div className="relative w-full md:w-80 shrink-0">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Filter RSS feeds by keyword..."
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    className="h-9 pl-9 border"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {isLoading ? (
                <div className="flex justify-center py-20">
                  <RefreshCw className="size-8 animate-spin text-primary" />
                </div>
              ) : !rssFeeds ? (
                <div className="text-center py-20 text-xs text-muted-foreground">
                  No RSS records parsed.
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {/* Politics RSS */}
                  <Card className="bg-card/40 border">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary">Politics & Global</CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 space-y-2.5 max-h-[350px] overflow-y-auto">
                      {getFilteredRss("politics").length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4">No matching articles found.</div>
                      ) : getFilteredRss("politics").map((item: any, idx: number) => (
                        <div key={idx} className="text-xs border-b pb-1.5 space-y-1">
                          <a href={item.link} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-primary font-medium block">
                            {item.title}
                          </a>
                          <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                            <span>{item.source}</span>
                            <span>{new Date(item.pubDate).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  {/* Cyber RSS */}
                  <Card className="bg-card/40 border">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary">Cyber Advisories & Intel</CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 space-y-2.5 max-h-[350px] overflow-y-auto">
                      {getFilteredRss("cyber").length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4">No matching advisories found.</div>
                      ) : getFilteredRss("cyber").map((item: any, idx: number) => (
                        <div key={idx} className="text-xs border-b pb-1.5 space-y-1">
                          <a href={item.link} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-primary font-medium block">
                            {item.title}
                          </a>
                          <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                            <span>{item.source}</span>
                            <span>{new Date(item.pubDate).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  {/* Military RSS */}
                  <Card className="bg-card/40 border">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary">Military & Defense</CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 space-y-2.5 max-h-[350px] overflow-y-auto">
                      {getFilteredRss("military").length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4">No matching articles found.</div>
                      ) : getFilteredRss("military").map((item: any, idx: number) => (
                        <div key={idx} className="text-xs border-b pb-1.5 space-y-1">
                          <a href={item.link} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-primary font-medium block">
                            {item.title}
                          </a>
                          <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                            <span>{item.source}</span>
                            <span>{new Date(item.pubDate).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  {/* Finance RSS */}
                  <Card className="bg-card/40 border">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary">Markets & Finance</CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 space-y-2.5 max-h-[350px] overflow-y-auto">
                      {getFilteredRss("finance").length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4">No matching indexes found.</div>
                      ) : getFilteredRss("finance").map((item: any, idx: number) => (
                        <div key={idx} className="text-xs border-b pb-1.5 space-y-1">
                          <a href={item.link} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-primary font-medium block">
                            {item.title}
                          </a>
                          <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                            <span>{item.source}</span>
                            <span>{new Date(item.pubDate).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
