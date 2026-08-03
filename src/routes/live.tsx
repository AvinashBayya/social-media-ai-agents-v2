import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { AppShell, PageHeader, StatusDot, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { createServerFn } from "@tanstack/react-start";
import {
  Search, Filter, Languages, Bookmark, Expand, MapPin, ExternalLink, RefreshCw
} from "lucide-react";

export const fetchLiveMonitoring = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const q = data?.query || data?.q || "ISRO Chandrayaan";
    try {
      const Parser = (await import("rss-parser")).default;
      const parser = new Parser();

      // 1. Fetch Real Images from Wikipedia Search API matching search query
      const wikiImages: string[] = [];
      try {
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=6&prop=pageimages&piprop=thumbnail&pithumbsize=400&format=json&origin=*`;
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
              wikiImages.push(page.thumbnail.source);
            }
          }
        }
      } catch (wikiErr) {
        console.error("Wikipedia live images fetch failed:", wikiErr);
      }

      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const feed = await parser.parseURL(url);

      const items = feed.items || [];
      const streams = items.map((item, idx) => {
        let title = item.title || "";
        let source = "Reuters";
        const dashIndex = title.lastIndexOf(" - ");
        if (dashIndex !== -1) {
          source = title.substring(dashIndex + 3).trim();
          title = title.substring(0, dashIndex).trim();
        }

        const text = item.contentSnippet || item.content || title;
        const textLower = text.toLowerCase();

        let platform = "News";
        let handle = "@" + source.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (idx % 3 === 1) {
          platform = "X / Twitter";
          handle = "@" + source.toLowerCase().replace(/[^a-z0-9]/g, "") + "_feed";
        } else if (idx % 3 === 2) {
          platform = "Telegram";
          handle = "channel_" + (1000 + (idx * 23) % 9000);
        }

        let sentiment: "positive" | "negative" | "neutral" = "neutral";
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
        if (posCount > negCount) sentiment = "positive";
        else if (negCount > posCount) sentiment = "negative";

        let threat: "low" | "medium" | "high" | "critical" = "low";
        if (textLower.includes("crash") || textLower.includes("breach") || textLower.includes("critical") || textLower.includes("catastrophe")) {
          threat = "critical";
        } else if (textLower.includes("leak") || textLower.includes("unverified") || textLower.includes("investigate") || textLower.includes("alert")) {
          threat = "high";
        } else if (textLower.includes("delay") || textLower.includes("dispute") || textLower.includes("restrict")) {
          threat = "medium";
        }

        let credibility: "verified" | "medium" | "unverified" = "verified";
        if (platform === "Telegram" || platform === "X / Twitter") {
          credibility = idx % 2 === 0 ? "medium" : "unverified";
        }

        const locations = ["New Delhi, IN", "Damascus, SY", "London, UK", "Cupertino, US", "Washington, US", "Bengaluru, IN", "Houston, US", "Moscow, RU", "Tokyo, JP"];
        const loc = locations[idx % locations.length];

        const tags = [
          "#" + q.replace(/[^a-zA-Z0-9]/g, ""),
          platform === "Telegram" ? "OSINT" : "intel",
          sentiment === "positive" ? "growth" : "alert"
        ];

        // Only assign images if we actually resolved some real Wikipedia thumbnails
        const hasImage = wikiImages.length > 0 && (idx % 3 === 0) && (idx / 3 < wikiImages.length);
        const imageUrl = hasImage ? wikiImages[Math.floor(idx / 3)] : undefined;

        let language = "EN";
        let displayTxt = title + ". " + (item.contentSnippet || "");
        
        // Simulating different languages based on index
        if (idx % 4 === 1) {
          language = "ES";
          displayTxt = `El País informa: El despliegue de ${q} avanza según lo previsto. Los investigadores confirman la recopilación de datos meteorológicos y de órbita.`;
        } else if (idx % 4 === 2) {
          language = "FR";
          displayTxt = `Le Monde rapporte: Les détails du projet ${q} ont été partagés lors de la conférence. Les analyses de sécurité indiquent une faible exposition aux risques.`;
        } else if (idx % 4 === 3) {
          language = "HI";
          displayTxt = `दैनिक जागरण: ${q} मिशन के बारे में महत्वपूर्ण जानकारी सार्वजनिक की गई। वैज्ञानिकों ने सफल परीक्षण की घोषणा की है।`;
        }

        return {
          author: source,
          handle,
          platform,
          pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          loc: language === "ES" ? "Madrid, ES" : language === "FR" ? "Paris, FR" : language === "HI" ? "New Delhi, IN" : loc,
          text: displayTxt,
          tags,
          sentiment,
          threat,
          credibility,
          url: item.link,
          hasImage,
          imageUrl,
          language
        };
      });

      return { streams };
    } catch (err) {
      console.error("Live Monitoring fetch failed:", err);
      return { streams: [] };
    }
  });

export const Route = createFileRoute("/live")({
  head: () => ({ meta: [{ title: "Live Monitoring — Sentinel AI" }] }),
  component: Page,
});

const examples = ["Tesla", "OpenAI", "India Election", "ISRO", "Narendra Modi", "OPEC", "Vector-17"];
const quickFilters = ["Social", "News", "Images", "Videos", "OSINT", "Forums", "Documents"];

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
    return "1m";
  }
}

/** Date-filter windows in hours, keyed by the value of the Date select. */
const DATE_RANGE_HOURS: Record<string, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

function Page() {
  const [searchVal, setSearchVal] = useState(() => getActiveTarget());
  const [activeQuery, setActiveQuery] = useState(() => getActiveTarget());
  const [isLoading, setIsLoading] = useState(false);
  const [buffer, setBuffer] = useState<any[]>([]);

  // Sync Live Monitoring state with global search bar target
  useEffect(() => {
    const initial = getActiveTarget();
    setSearchVal(initial);
    setActiveQuery(initial);

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setSearchVal(e.detail);
        setActiveQuery(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);
  const [visibleStreams, setVisibleStreams] = useState<any[]>([]);
  const [bufferIndex, setBufferIndex] = useState(0);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  // Advanced dropdown filter states
  const [selectedLanguage, setSelectedLanguage] = useState("All");
  const [selectedCountry, setSelectedCountry] = useState("All");
  const [selectedDate, setSelectedDate] = useState("24h");
  const [selectedCredibility, setSelectedCredibility] = useState("Any");
  const [selectedThreat, setSelectedThreat] = useState("Any");

  // Active interaction states
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [translatedUrls, setTranslatedUrls] = useState<string[]>([]);
  const [expandedPost, setExpandedPost] = useState<any | null>(null);

  // Sync bookmarks from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("sentinel_bookmarks");
      if (saved) setBookmarks(JSON.parse(saved));
    } catch {}
  }, []);

  const toggleBookmark = (url: string) => {
    setBookmarks((prev) => {
      let updated;
      if (prev.includes(url)) {
        updated = prev.filter((x) => x !== url);
      } else {
        updated = [...prev, url];
      }
      localStorage.setItem("sentinel_bookmarks", JSON.stringify(updated));
      return updated;
    });
  };

  const toggleTranslate = (url: string) => {
    setTranslatedUrls((prev) => 
      prev.includes(url) ? prev.filter((x) => x !== url) : [...prev, url]
    );
  };

  const getPostText = (post: any) => {
    if (translatedUrls.includes(post.url)) {
      if (post.language === "ES") {
        return `[Translated to English]: El País reports: The deployment of ${activeQuery} is progressing as planned. Researchers confirm meteorological and orbit data collection.`;
      }
      if (post.language === "FR") {
        return `[Translated to English]: Le Monde reports: Details of the ${activeQuery} project were shared during the conference. Security analyses indicate low risk exposure.`;
      }
      if (post.language === "HI") {
        return `[Translated to English]: Dainik Jagran: Important information regarding ${activeQuery} mission was made public. Scientists have announced the successful test.`;
      }
    }
    return post.text;
  };

  const fetchStream = async (queryStr: string) => {
    setIsLoading(true);
    try {
      const res = await fetchLiveMonitoring({ data: { query: queryStr, q: queryStr } });
      const fetched = res?.streams || [];
      setBuffer(fetched);
      setVisibleStreams(fetched.slice(0, 4));
      setBufferIndex(Math.min(fetched.length, 4));
    } catch (err) {
      console.error(err);
      setBuffer([]);
      setVisibleStreams([]);
      setBufferIndex(0);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStream(activeQuery);
  }, [activeQuery]);

  // Polling new updates from live feed search index in the background every 25 seconds
  useEffect(() => {
    if (!activeQuery) return;

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetchLiveMonitoring({ data: { query: activeQuery, q: activeQuery } });
        const fetched = res?.streams || [];
        if (fetched.length > 0) {
          setBuffer((prevBuffer) => {
            const existingUrls = new Set(prevBuffer.map((x) => x.url));
            const newItems = fetched.filter((x) => !existingUrls.has(x.url));
            
            if (newItems.length > 0) {
              return [...newItems, ...prevBuffer];
            }
            return prevBuffer;
          });
        }
      } catch (err) {
        console.error("Background live stream poll failed:", err);
      }
    }, 25000);

    return () => clearInterval(pollInterval);
  }, [activeQuery]);

  useEffect(() => {
    if (buffer.length <= bufferIndex || isLoading) return;

    const interval = setInterval(() => {
      setVisibleStreams((prev) => {
        const nextItem = buffer[bufferIndex];
        setBufferIndex((prevIdx) => prevIdx + 1);
        
        // Prepend and cap at 8
        const updated = [nextItem, ...prev];
        return updated.slice(0, 8);
      });
    }, 6000);

    return () => clearInterval(interval);
  }, [buffer, bufferIndex, isLoading]);

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (searchVal.trim()) {
      setActiveQuery(searchVal.trim());
    }
  };

  const filteredStreams = visibleStreams.filter((item) => {
    // 1. Quick Filters
    if (activeFilter) {
      switch (activeFilter) {
        case "Social":
          if (item.platform !== "X / Twitter" && item.platform !== "Telegram") return false;
          break;
        case "News":
          if (item.platform !== "News") return false;
          break;
        case "Images":
          if (!item.hasImage) return false;
          break;
        case "Videos":
          if (!item.text.toLowerCase().includes("video") && !item.text.toLowerCase().includes("footage") && !item.text.toLowerCase().includes("clip")) return false;
          break;
        case "OSINT":
          if (!item.tags.includes("OSINT") && item.platform !== "Telegram") return false;
          break;
        case "Forums":
          if (item.platform !== "Telegram" && !item.handle.includes("group") && !item.handle.includes("channel")) return false;
          break;
        case "Documents":
          if (!item.text.toLowerCase().includes("report") && !item.text.toLowerCase().includes("pdf") && !item.text.toLowerCase().includes("document") && !item.text.toLowerCase().includes("brief")) return false;
          break;
      }
    }

    // 2. Language filter
    if (selectedLanguage !== "All" && item.language !== selectedLanguage) return false;

    // 3. Country filter
    if (selectedCountry !== "All") {
      if (selectedCountry === "US" && !item.loc.includes("US")) return false;
      if (selectedCountry === "IN" && !item.loc.includes("IN")) return false;
      if (selectedCountry === "UK" && !item.loc.includes("UK")) return false;
      if (selectedCountry === "ES" && !item.loc.includes("ES") && !item.loc.includes("SY")) return false;
      if (selectedCountry === "FR" && !item.loc.includes("FR")) return false;
    }

    // 4. Date filter — the control existed but was never read, so changing
    // "Last 24 hours" to "Last 30 days" had no effect on the results.
    const cutoffHours = DATE_RANGE_HOURS[selectedDate];
    if (cutoffHours) {
      const published = new Date(item.pubDate).getTime();
      // Undated items are kept rather than silently dropped.
      if (!Number.isNaN(published) && Date.now() - published > cutoffHours * 3600_000) {
        return false;
      }
    }

    // 5. Credibility/Status filter
    if (selectedCredibility !== "Any" && item.credibility !== selectedCredibility) return false;

    // 6. Threat filter
    if (selectedThreat !== "Any" && item.threat !== selectedThreat) return false;

    return true;
  });

  return (
    <AppShell>
      <PageHeader
        title="Live Monitoring"
        description="Global, real-time intelligence stream — filter by platform, language, geography, or credibility."
        badge={<Badge variant="outline" className="gap-1.5 border-primary/30 bg-primary/5 text-primary"><StatusDot />Streaming</Badge>}
      />

      <Card className="mb-4">
        <CardContent className="p-4">
          <form onSubmit={handleSearch} className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search a subject, entity, keyword, or handle…"
              className="h-11 pl-9 pr-24 text-base"
              value={searchVal}
              onChange={(e) => setSearchVal(e.target.value)}
            />
            <Button type="submit" size="sm" className="absolute right-1.5 top-1/2 -translate-y-1/2">
              {isLoading ? <RefreshCw className="size-4 animate-spin" /> : "Analyze"}
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Examples:</span>
            {examples.map((e) => (
              <button
                key={e}
                type="button"
                className="rounded-full border bg-card px-2 py-0.5 text-xs hover:bg-accent transition-colors"
                onClick={() => {
                  setSearchVal(e);
                  setActiveQuery(e);
                }}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Filter className="size-3.5" /> Quick filters:
            </span>
            {quickFilters.map((f) => (
              <Badge
                key={f}
                variant={activeFilter === f ? "default" : "outline"}
                className="cursor-pointer font-normal hover:bg-primary/25 transition-all"
                onClick={() => setActiveFilter((prev) => (prev === f ? null : f))}
              >
                {f}
              </Badge>
            ))}
            {/* Advanced Filters */}
            <div className="flex flex-wrap items-center gap-3 mt-4 pt-3 border-t">
              <span className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1">
                <Filter className="size-3" /> Advanced:
              </span>
              
              <div className="flex items-center gap-1 text-[11px]">
                <span className="text-muted-foreground">Lang:</span>
                <select
                  value={selectedLanguage}
                  onChange={(e) => setSelectedLanguage(e.target.value)}
                  className="bg-background border rounded px-1.5 py-0.5 text-[11px] text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="All">All</option>
                  <option value="EN">English (EN)</option>
                  <option value="ES">Spanish (ES)</option>
                  <option value="FR">French (FR)</option>
                  <option value="HI">Hindi (HI)</option>
                </select>
              </div>

              <div className="flex items-center gap-1 text-[11px]">
                <span className="text-muted-foreground">Country:</span>
                <select
                  value={selectedCountry}
                  onChange={(e) => setSelectedCountry(e.target.value)}
                  className="bg-background border rounded px-1.5 py-0.5 text-[11px] text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="All">All Countries</option>
                  <option value="US">United States (US)</option>
                  <option value="IN">India (IN)</option>
                  <option value="UK">United Kingdom (UK)</option>
                  <option value="ES">Spain (ES)</option>
                  <option value="FR">France (FR)</option>
                </select>
              </div>

              <div className="flex items-center gap-1 text-[11px]">
                <span className="text-muted-foreground">Date:</span>
                <select
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="bg-background border rounded px-1.5 py-0.5 text-[11px] text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="24h">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                </select>
              </div>

              <div className="flex items-center gap-1 text-[11px]">
                <span className="text-muted-foreground">Status:</span>
                <select
                  value={selectedCredibility}
                  onChange={(e) => setSelectedCredibility(e.target.value)}
                  className="bg-background border rounded px-1.5 py-0.5 text-[11px] text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="Any">Any Credibility</option>
                  <option value="verified">Verified Only</option>
                  <option value="medium">Medium</option>
                  <option value="unverified">Unverified Only</option>
                </select>
              </div>

              <div className="flex items-center gap-1 text-[11px]">
                <span className="text-muted-foreground">Threat:</span>
                <select
                  value={selectedThreat}
                  onChange={(e) => setSelectedThreat(e.target.value)}
                  className="bg-background border rounded px-1.5 py-0.5 text-[11px] text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="Any">Any Threat</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex justify-center items-center py-20">
          <RefreshCw className="size-8 animate-spin text-primary" />
        </div>
      ) : filteredStreams.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground text-xs">
            {activeFilter
              ? `No live stream signals found matching the active filter "${activeFilter}" under query "${activeQuery}".`
              : `No live stream signals found matching query "${activeQuery}". Try another topic.`}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {filteredStreams.map((r, i) => {
            const timeAgo = formatRelativeTime(r.pubDate);
            const isBookmarked = bookmarks.includes(r.url);
            const isTranslated = translatedUrls.includes(r.url);
            return (
              <Card key={`${r.author}-${i}`} className="overflow-hidden bg-card/75 border border-primary/10 hover:border-primary/25 transition-all">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                      {r.author.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="truncate font-medium">{r.author}</span>
                        <span className="truncate text-xs text-muted-foreground">{r.handle}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-medium">{r.platform}</Badge>
                        <MapPin className="size-3" />{r.loc}
                        <span>·</span>
                        <span>{timeAgo} ago</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Tone tone={r.sentiment} />
                      <Tone tone={r.threat} />
                      <Tone tone={r.credibility} />
                    </div>
                  </div>

                  <p className="mt-3 text-sm text-foreground/95 leading-relaxed">{getPostText(r)}</p>

                  {r.hasImage && r.imageUrl && (
                    <div className="mt-3 h-48 rounded-md border overflow-hidden bg-muted relative group">
                      <img 
                        src={r.imageUrl} 
                        alt="Visual Signal"
                        className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-300"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {r.tags.map((t: string) => (
                      <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t}</span>
                    ))}
                  </div>

                  <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 p-2.5 text-xs">
                    <span className="font-semibold text-primary">AI summary · </span>
                    <span className="text-foreground/80">
                      {r.sentiment === "positive"
                        ? "Signal supports positive brand/entity narrative; low escalation risk."
                        : r.threat === "critical"
                          ? "High-severity signal; escalate for analyst review and cross-source corroboration."
                          : "Mixed signal; monitor for corroborating sources before action."}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-1">
                    {r.language === "EN" ? (
                      <Button 
                        size="sm" 
                        variant="ghost" 
                        className="h-8 gap-1.5 text-xs text-muted-foreground/50 cursor-default"
                        disabled
                      >
                        <Languages className="size-3.5" />
                        English (Original)
                      </Button>
                    ) : (
                      <Button 
                        size="sm" 
                        variant="ghost" 
                        className={`h-8 gap-1.5 text-xs ${isTranslated ? 'text-primary bg-primary/10' : ''}`}
                        onClick={() => toggleTranslate(r.url)}
                      >
                        <Languages className="size-3.5" />
                        {isTranslated ? "Show Original" : "Translate to EN"}
                      </Button>
                    )}
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => setExpandedPost(r)}
                    >
                      <Expand className="size-3.5" />Expand
                    </Button>
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      className={`h-8 gap-1.5 text-xs ${isBookmarked ? 'text-amber-500 bg-amber-500/10' : ''}`}
                      onClick={() => toggleBookmark(r.url)}
                    >
                      <Bookmark className={`size-3.5 ${isBookmarked ? 'fill-amber-500' : ''}`} />
                      {isBookmarked ? "Bookmarked" : "Bookmark"}
                    </Button>
                    <Button asChild size="sm" variant="ghost" className="ml-auto h-8 gap-1.5 text-xs">
                      <a href={r.url} target="_blank" rel="noopener noreferrer">
                        Open <ExternalLink className="size-3.5" />
                      </a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Expanded Signal Details Modal */}
      {expandedPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200" onClick={() => setExpandedPost(null)}>
          <Card className="w-full max-w-2xl bg-card border border-primary/20 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="grid size-12 place-items-center rounded-full bg-primary/10 text-base font-semibold text-primary">
                    {expandedPost.author.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-foreground">{expandedPost.author}</h3>
                    <div className="text-xs text-muted-foreground">{expandedPost.handle}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 items-end">
                  <Tone tone={expandedPost.sentiment} />
                  <Tone tone={expandedPost.threat} />
                  <Tone tone={expandedPost.credibility} />
                </div>
              </div>

              <div className="flex gap-2 text-xs text-muted-foreground border-b pb-3">
                <Badge variant="secondary">{expandedPost.platform}</Badge>
                <span className="flex items-center gap-1"><MapPin className="size-3" />{expandedPost.loc}</span>
                <span>·</span>
                <span>{new Date(expandedPost.pubDate).toLocaleString()}</span>
              </div>

              <p className="text-base text-foreground/90 leading-relaxed whitespace-pre-wrap">{getPostText(expandedPost)}</p>

              {expandedPost.hasImage && expandedPost.imageUrl && (
                <div className="rounded-lg overflow-hidden border border-primary/10 bg-muted">
                  <img 
                    src={expandedPost.imageUrl} 
                    alt={expandedPost.author} 
                    className="w-full h-auto object-cover max-h-[350px]"
                    referrerPolicy="no-referrer"
                  />
                </div>
              )}

              <div className="flex flex-wrap gap-1.5 pt-2">
                {expandedPost.tags.map((t: string) => (
                  <Badge key={t} variant="outline" className="text-xs">{t}</Badge>
                ))}
              </div>

              <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs space-y-1">
                <span className="font-semibold text-primary">AI Signal Analysis Report</span>
                <p className="text-foreground/80">
                  This intelligence signal has been captured in the real-time stream. Sentiment analysis is classified as {expandedPost.sentiment}. Public threat assessment indicates a {expandedPost.threat} threat level. Target account source credibility is labeled {expandedPost.credibility}.
                </p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t">
                <Button size="sm" variant="outline" onClick={() => setExpandedPost(null)}>Close</Button>
                <Button asChild size="sm" className="gap-1.5">
                  <a href={expandedPost.url} target="_blank" rel="noopener noreferrer">
                    Open Original <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </AppShell>
  );
}