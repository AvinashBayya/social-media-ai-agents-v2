import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { createServerFn } from "@tanstack/react-start";
import { Search, Filter, Bookmark, Expand, ExternalLink, RefreshCw, X } from "lucide-react";
import {
  DATE_WINDOWS,
  DEFAULT_WINDOW_ID,
  WINDOW_REACH_NOTE,
  withinWindow,
} from "@/utils/live-filters";
import {
  getBookmarks,
  isBookmarked,
  pinnedBookmarks,
  removeBookmark,
  saveBookmarks,
  setBookmarkCase,
  shortlisted,
  toggleBookmark as toggleBookmarkIn,
  type Bookmark as BookmarkRecord,
} from "@/utils/bookmark-store";
import { PinButton } from "@/components/pin-button";
import { getInvestigations, removeEvidence } from "@/utils/investigations-store";
import { useT } from "@/i18n/i18n-context";
import { toast } from "sonner";

export const fetchLiveMonitoring = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const q = data?.query || data?.q || "ISRO Chandrayaan";
    try {
      const Parser = (await import("rss-parser")).default;
      const parser = new Parser();

      /*
       * The Wikipedia thumbnail fetch that stood here is gone with the fields
       * it fed. The images were real, but they illustrated the SEARCH TOPIC and
       * were attached to articles by `idx % 3` - so a real photograph appeared
       * beside an unrelated headline and read as that article's own imagery.
       */
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const feed = await parser.parseURL(url);

      const items = feed.items || [];

      /*
       * HONEST MAPPING ONLY.
       *
       * What this replaced was the single worst thing in the codebase. Every
       * field on a card was manufactured from the array index:
       *
       *   - `platform` was relabelled by `idx % 3` so Google News RSS rendered
       *     as "X / Twitter" and "Telegram" — platforms /social correctly
       *     declares uncollectable. The app contradicted itself on screen.
       *   - `handle` was invented: "channel_" + (1000 + ((idx * 23) % 9000)).
       *   - `loc` was `locations[idx % 9]`, so an ISRO story from the Times of
       *     India was plotted at "Washington, US".
       *   - `credibility` was `idx % 2 === 0 ? "medium" : "unverified"`.
       *   - `source` defaulted to "Reuters" for any title without " - ".
       *   - Worst: real article text was DISCARDED and replaced with invented
       *     Spanish, French and Hindi prose attributed to El País, Le Monde and
       *     दैनिक जागरण — real news organisations that had published no such
       *     thing. The code comment read "Simulating different languages".
       *
       * A Google News RSS item supports exactly five real facts: title,
       * snippet, publisher, publication time and link. Those are what this
       * returns. Anything the feed cannot tell us is null, and the UI renders
       * the absence rather than a plausible substitute.
       */
      const streams = items.map((item) => {
        let title = (item.title || "").trim();

        // Google News formats titles as "Headline - Publisher". Absent that
        // separator the publisher is genuinely unknown, so it stays null — it
        // is never defaulted to a real outlet's name.
        let source: string | null = null;
        const dashIndex = title.lastIndexOf(" - ");
        if (dashIndex !== -1) {
          source = title.substring(dashIndex + 3).trim() || null;
          title = title.substring(0, dashIndex).trim();
        }

        const snippet = (item.contentSnippet || item.content || "").trim();
        const text = snippet ? `${title}. ${snippet}` : title;
        const textLower = text.toLowerCase();

        // Keyword classification. Deterministic, cheap, and crude — the UI
        // labels it as keyword-derived so it is never read as model output.
        const posWords = ["success", "launch", "growth", "win", "approve", "record", "boost"];
        const negWords = ["fail", "crash", "attack", "threat", "loss", "ban", "strike", "protest"];
        let sentiment: "positive" | "negative" | "neutral" = "neutral";
        if (posWords.some((w) => textLower.includes(w))) sentiment = "positive";
        if (negWords.some((w) => textLower.includes(w))) sentiment = "negative";

        const threatWords = ["attack", "missile", "breach", "malware", "conflict", "casualt"];
        const threat: "low" | "medium" = threatWords.some((w) => textLower.includes(w))
          ? "medium"
          : "low";

        return {
          author: source,
          platform: "News" as const,
          // null, never Date.now(). An item the feed did not date must stay
          // distinguishable from one published this second.
          pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : null,
          text,
          tags: [sentiment === "positive" ? "growth" : "alert"],
          sentiment,
          threat,
          url: item.link,
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

/*
 * Example queries. "Vector-17" used to sit at the end of this list beside six
 * real subjects — an invented name that returns nothing from Google News, so
 * clicking it looked like a broken collector rather than an empty search.
 */
const examples = ["Tesla", "OpenAI", "India Election", "ISRO", "Narendra Modi", "OPEC", "NATO"];

/*
 * The "Quick filters" row (Social / News / Images / Videos / OSINT / Forums /
 * Documents) is gone. Six of its seven options filtered on fields that were
 * invented - `platform` relabelled by array index, `handle` fabricated,
 * `hasImage` driven by `idx % 3` - so the controls appeared to segment a
 * multi-platform stream that never existed. This page reads one Google News
 * RSS feed. Presenting a "Social" filter over it was part of the same fiction.
 *
 * The advanced Language, Country and Status/Credibility selects are gone for
 * the same reason: language was simulated, location was `locations[idx % 9]`,
 * and credibility was `idx % 2`. Date and Threat survive because both are
 * computed from something real.
 */

/*
 * The window table used to live here as `DATE_RANGE_HOURS` with three entries.
 * It now lives in utils/live-filters.ts alongside the predicate, so both can be
 * unit tested — a route module cannot be imported by `bun test`.
 */

/**
 * Relative age, or an explicit absence.
 *
 * Items now carry `pubDate: null` when the feed published no date. The previous
 * implementation returned the literal string "1m" from its catch block, so an
 * unparseable date rendered as "1m ago" - inventing a publication time at the
 * point of display.
 */
function formatRelativeTime(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const ms = new Date(dateStr).getTime();
  if (!Number.isFinite(ms)) return null;
  const diffMins = Math.floor((Date.now() - ms) / 60000);
  if (diffMins < 0) return null;
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

/** Two-letter avatar, or a neutral mark when the feed named no publisher. */
function initialsOf(author: string | null): string {
  return author ? author.slice(0, 2).toUpperCase() : "??";
}

/** Cards shown immediately after a fetch, before the reveal interval runs. */
const INITIAL_REVEAL = 4;
/** How often one more collected item is revealed. */
const REVEAL_MS = 6000;

function Page() {
  // Empty on both server and first client render — getActiveTarget() reads
  // localStorage, unavailable during SSR. The mount effect below (which
  // already existed for the sentinel_target_changed listener) sets the real
  // value client-side, after hydration, avoiding the text mismatch a
  // synchronous getActiveTarget() call here used to cause.
  const [searchVal, setSearchVal] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<any[]>([]);
  /**
   * How many of the FILTERED items are on screen.
   *
   * This replaces `visibleStreams` + `bufferIndex`, which held their own copy of
   * the list capped at 8. The filters ran over that copy, so widening the date
   * window re-filtered at most eight cards while the rest of the collected feed
   * sat in `buffer` untouched — "Last 30 days" could not show more than "Last 24
   * hours" no matter how much had been collected. Filtering now happens over the
   * whole buffer and this only controls the reveal animation.
   */
  const [revealCount, setRevealCount] = useState(INITIAL_REVEAL);

  const [selectedDate, setSelectedDate] = useState(DEFAULT_WINDOW_ID);
  const [selectedThreat, setSelectedThreat] = useState("Any");

  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([]);
  const [expandedPost, setExpandedPost] = useState<any | null>(null);
  const t = useT();

  // Sync Live Monitoring state with the global search bar target
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

  // Reading happens after mount, and migration from the v1 URL array happens
  // inside getBookmarks(). See bookmark-store.ts for why nothing is back-filled.
  useEffect(() => {
    setBookmarks(getBookmarks());
  }, []);

  /**
   * Shortlist an item, carrying what the feed reported.
   *
   * This used to push a bare URL string onto an array no other file read. The
   * headline, publisher, publication time and body were all discarded at this
   * point, which is why a bookmark could never become citable evidence.
   */
  const toggleBookmark = (item: any) => {
    setBookmarks((prev) => {
      const wasSet = isBookmarked(prev, item.url);
      const updated = toggleBookmarkIn(
        prev,
        {
          url: item.url,
          title: item.text ?? null,
          source: item.author ?? null,
          // Never `?? new Date()`. An undated item stays undated.
          publishedAt: item.pubDate ?? null,
          text: item.text ?? null,
        },
        new Date().toISOString(),
      );
      saveBookmarks(updated);
      toast.success(wasSet ? "Removed from shortlist." : "Added to shortlist.");
      return updated;
    });
  };

  /** Record that an item reached a case, so the two panels below stay in step. */
  const notePinned = (item: any, caseId: string) => {
    setBookmarks((prev) => {
      const updated = setBookmarkCase(
        prev,
        {
          url: item.url,
          title: item.text ?? null,
          source: item.author ?? null,
          publishedAt: item.pubDate ?? null,
          text: item.text ?? null,
        },
        caseId,
        new Date().toISOString(),
      );
      saveBookmarks(updated);
      return updated;
    });
  };

  const dropBookmark = (url: string) => {
    setBookmarks((prev) => {
      const updated = removeBookmark(prev, url);
      saveBookmarks(updated);
      return updated;
    });
  };

  /**
   * Unpin from the case AND clear the record here.
   *
   * The evidence id is resolved by URL against the live case, because that is
   * the key `pinToInvestigation` itself de-duplicates on.
   */
  const unpin = (b: BookmarkRecord) => {
    if (!b.caseId) return;
    const found = getInvestigations().find((c) => c.id === b.caseId);
    const evidence = found?.evidence.find((e) => e.url === b.url);
    if (found && evidence) removeEvidence(found.id, evidence.id);
    setBookmarks((prev) => {
      const updated = prev.map((x) => (x.url === b.url ? { ...x, caseId: null } : x));
      saveBookmarks(updated);
      return updated;
    });
    toast.success(found ? `Removed from ${b.caseId}.` : `${b.caseId} no longer exists.`);
  };

  const payloadFor = (item: any) => ({
    kind: "news" as const,
    title: item.text as string,
    // The feed names no publisher on some items; that absence travels rather
    // than being replaced by a plausible outlet.
    source: (item.author as string | null) ?? "",
    url: item.url as string,
    publishedAt: (item.pubDate as string | null) ?? "",
    excerpt: item.text as string,
    credibility: null,
    credibilityRationale:
      "Not scored. /live reads one Google News search feed and runs no Module 1 " +
      "scoring over it; corroboration and source scoring live on /sources.",
  });

  const fetchStream = async (queryStr: string) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetchLiveMonitoring({ data: { query: queryStr, q: queryStr } });
      const fetched = res?.streams || [];
      setBuffer(fetched);
      setRevealCount(INITIAL_REVEAL);
    } catch (err: any) {
      // A failed fetch is NOT an empty result. Collapsing the two produced
      // "No live stream signals found... Try another topic." for an outage,
      // sending the analyst to re-query instead of telling them collection
      // broke.
      console.error(err);
      setLoadError(err?.message ?? String(err));
      setBuffer([]);
      setRevealCount(INITIAL_REVEAL);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Skip the empty placeholder render — the mount-sync effect above fills
    // in the real target a moment later, which re-triggers this effect.
    // Fetching on "" would waste a call and briefly show a bogus empty result.
    if (!activeQuery) return;
    fetchStream(activeQuery);
  }, [activeQuery]);

  // Poll for items the feed has added since the last fetch.
  useEffect(() => {
    if (!activeQuery) return;
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetchLiveMonitoring({ data: { query: activeQuery, q: activeQuery } });
        const fetched = res?.streams || [];
        if (fetched.length > 0) {
          setBuffer((prevBuffer) => {
            const existingUrls = new Set(prevBuffer.map((x) => x.url));
            const newItems = fetched.filter((x: any) => !existingUrls.has(x.url));
            return newItems.length > 0 ? [...newItems, ...prevBuffer] : prevBuffer;
          });
        }
      } catch (err) {
        console.error("Background live stream poll failed:", err);
      }
    }, 25000);
    return () => clearInterval(pollInterval);
  }, [activeQuery]);

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (searchVal.trim()) setActiveQuery(searchVal.trim());
  };

  /**
   * Filters run over the WHOLE collected buffer.
   *
   * They used to run over an 8-item display copy, which made the date select
   * close to inert: everything the feed returned beyond the eighth card was
   * outside the filter's reach, so widening the window changed nothing.
   */
  const filteredBuffer = useMemo(() => {
    const now = Date.now();
    return buffer.filter((item) => {
      if (!withinWindow(item.pubDate ?? null, selectedDate, now)) return false;
      if (selectedThreat !== "Any" && item.threat !== selectedThreat) return false;
      return true;
    });
  }, [buffer, selectedDate, selectedThreat]);

  // Reveal one more collected item at a time, so the page reads as a feed rather
  // than dumping everything at once. There is no longer a hard cap: the ceiling
  // is however many items actually passed the filters.
  useEffect(() => {
    if (isLoading || revealCount >= filteredBuffer.length) return;
    const interval = setInterval(
      () => setRevealCount((n) => Math.min(n + 1, filteredBuffer.length)),
      REVEAL_MS,
    );
    return () => clearInterval(interval);
  }, [filteredBuffer.length, revealCount, isLoading]);

  const filteredStreams = filteredBuffer.slice(0, revealCount);

  return (
    <AppShell>
      <PageHeader
        title="Live Monitoring"
        description="Google News search feed for the active target, polled every 25 seconds. One source, not a multi-platform stream."
      />

      <Card className="mb-4">
        <CardContent className="p-4">
          <form onSubmit={handleSearch} className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search a subject, entity, or keyword..."
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
                className="rounded-full border bg-card px-2 py-0.5 text-xs transition-colors hover:bg-accent"
                onClick={() => {
                  setSearchVal(e);
                  setActiveQuery(e);
                }}
              >
                {e}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3">
            <span className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
              <Filter className="size-3" /> Filters:
            </span>
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">Date:</span>
              <select
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="cursor-pointer rounded border bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {DATE_WINDOWS.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">Threat:</span>
              <select
                value={selectedThreat}
                onChange={(e) => setSelectedThreat(e.target.value)}
                className="cursor-pointer rounded border bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="Any">Any</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
              </select>
            </div>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              showing {filteredStreams.length} of {filteredBuffer.length} matching ·{" "}
              {buffer.length} collected
            </span>
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            {WINDOW_REACH_NOTE} Items the feed published without a date are kept under every
            window and shown as &ldquo;no date reported&rdquo;.
          </p>

          <p className="mt-3 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
            Sentiment and threat are <strong>keyword matches over the headline and snippet</strong>,
            not model output and not an assessment. This feed carries no author account, no location
            and no credibility rating, so none is shown - Module 1 scoring lives on{" "}
            <a href="/sources" className="text-primary hover:underline">
              /sources
            </a>
            .
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="size-8 animate-spin text-primary" />
        </div>
      ) : loadError ? (
        <Card className="border-destructive/40">
          <CardContent className="p-6 text-xs">
            <div className="font-semibold text-destructive">Collection failed</div>
            <p className="mt-1 text-muted-foreground">
              The feed could not be read, so nothing is shown. This is not a finding that no
              coverage exists.
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
              {loadError}
            </pre>
          </CardContent>
        </Card>
      ) : filteredStreams.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-xs text-muted-foreground">
            {buffer.length > 0
              ? `None of the ${buffer.length} collected item(s) match the current filters. Widen the date window or set Threat to Any.`
              : `The feed returned no items for "${activeQuery}".`}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {filteredStreams.map((r, i) => {
            const timeAgo = formatRelativeTime(r.pubDate);
            const marked = isBookmarked(bookmarks, r.url);
            return (
              <Card
                key={`${r.url}-${i}`}
                className="overflow-hidden border border-primary/10 bg-card/75 transition-all hover:border-primary/25"
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                      {initialsOf(r.author)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="truncate font-medium">
                          {r.author ?? (
                            <span className="italic text-muted-foreground">
                              publisher not reported
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-medium">
                          Google News
                        </Badge>
                        <span>&middot;</span>
                        <span>{timeAgo ?? "no date reported"}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Tone tone={r.sentiment} />
                      <Tone tone={r.threat} />
                    </div>
                  </div>

                  <p className="mt-3 text-sm leading-relaxed text-foreground/95">{r.text}</p>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {r.tags.map((t: string) => (
                      <span
                        key={t}
                        className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>

                  <div className="mt-3 flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => setExpandedPost(r)}
                    >
                      <Expand className="size-3.5" />
                      Expand
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`h-8 gap-1.5 text-xs ${marked ? "bg-amber-500/10 text-amber-500" : ""}`}
                      onClick={() => toggleBookmark(r)}
                      title="Shortlist this item on this page"
                    >
                      <Bookmark className={`size-3.5 ${marked ? "fill-amber-500" : ""}`} />
                      {marked ? "Shortlisted" : "Shortlist"}
                    </Button>
                    {/*
                      /live was the only page with a bookmark-looking control
                      that did not pin into a case. PinButton is what "bookmark"
                      means on /news, /social and /images, and what
                      /investigations tells the analyst to use.
                    */}
                    <PinButton
                      payload={payloadFor(r)}
                      label="Pin to case"
                      onPinned={(caseId) => notePinned(r, caseId)}
                    />
                    <Button
                      asChild
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-8 gap-1.5 text-xs"
                    >
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

      {/*
        Where a bookmark goes.

        Before this panel existed, `sentinel_bookmarks` had no reader anywhere in
        the repository — bookmarking wrote a URL into storage and there was no
        surface, on this page or any other, that could show it again.
      */}
      {bookmarks.length > 0 && (
        <Card className="mt-4">
          <CardContent className="p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Bookmark className="size-3.5" /> Shortlist &amp; case evidence
            </h3>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Shortlisted ({shortlisted(bookmarks).length})
                </div>
                {shortlisted(bookmarks).length === 0 ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Nothing shortlisted. The shortlist lives in this browser only and is not
                    evidence until it is pinned to a case.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {shortlisted(bookmarks).map((b) => (
                      <li
                        key={b.url}
                        className="flex items-start gap-2 rounded border bg-muted/30 p-2 text-[11px]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {b.title ?? (
                              <span className="italic text-muted-foreground">
                                headline not recorded
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-muted-foreground">
                            {b.source ?? "publisher not reported"} ·{" "}
                            {formatRelativeTime(b.publishedAt) ?? "no date reported"}
                          </div>
                        </div>
                        <PinButton
                          payload={{
                            kind: "news",
                            title: b.title ?? b.url,
                            source: b.source ?? "",
                            url: b.url,
                            publishedAt: b.publishedAt ?? "",
                            excerpt: b.text ?? b.title ?? b.url,
                            credibility: null,
                            credibilityRationale:
                              "Not scored. /live runs no Module 1 scoring over this feed.",
                          }}
                          onPinned={(caseId) =>
                            setBookmarks((prev) => {
                              const updated = prev.map((x) =>
                                x.url === b.url ? { ...x, caseId } : x,
                              );
                              saveBookmarks(updated);
                              return updated;
                            })
                          }
                        />
                        <button
                          onClick={() => dropBookmark(b.url)}
                          aria-label="Remove from shortlist"
                          title="Remove from shortlist"
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <X className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("Pin to Investigation")} ({pinnedBookmarks(bookmarks).length})
                </div>
                {pinnedBookmarks(bookmarks).length === 0 ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Nothing pinned yet. Pinning copies the item into a case with its publisher,
                    URL and publication time, which is what makes it citable in a Module 5
                    product.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {pinnedBookmarks(bookmarks).map((b) => (
                      <li
                        key={b.url}
                        className="flex items-start gap-2 rounded border border-primary/20 bg-primary/5 p-2 text-[11px]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {b.title ?? (
                              <span className="italic text-muted-foreground">
                                headline not recorded
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-muted-foreground">
                            {b.source ?? "publisher not reported"} ·{" "}
                            <Link
                              to="/investigations"
                              search={{ case: b.caseId ?? undefined }}
                              className="font-medium text-primary hover:underline"
                            >
                              {b.caseId}
                            </Link>
                          </div>
                        </div>
                        <button
                          onClick={() => unpin(b)}
                          aria-label="Unpin from case"
                          title="Unpin from case"
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <X className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {expandedPost && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setExpandedPost(null)}
        >
          <Card
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto border border-primary/20 bg-card"
            onClick={(e) => e.stopPropagation()}
          >
            <CardContent className="space-y-4 p-6">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="grid size-12 place-items-center rounded-full bg-primary/10 text-base font-semibold text-primary">
                    {initialsOf(expandedPost.author)}
                  </div>
                  <h3 className="text-base font-semibold text-foreground">
                    {expandedPost.author ?? "Publisher not reported"}
                  </h3>
                </div>
                <div className="flex flex-wrap items-end gap-1">
                  <Tone tone={expandedPost.sentiment} />
                  <Tone tone={expandedPost.threat} />
                </div>
              </div>

              <div className="flex gap-2 border-b pb-3 text-xs text-muted-foreground">
                <Badge variant="secondary">Google News</Badge>
                <span>&middot;</span>
                <span>
                  {expandedPost.pubDate
                    ? new Date(expandedPost.pubDate).toLocaleString()
                    : "no date reported"}
                </span>
              </div>

              <p className="whitespace-pre-wrap text-base leading-relaxed text-foreground/90">
                {expandedPost.text}
              </p>

              <div className="flex flex-wrap gap-1.5 pt-2">
                {expandedPost.tags.map((t: string) => (
                  <Badge key={t} variant="outline" className="text-xs">
                    {t}
                  </Badge>
                ))}
              </div>

              {/*
                The "AI Signal Analysis Report" that sat here was a hardcoded
                template restating the keyword classification as though a model
                had assessed it - on a page that made zero LLM calls. Per-article
                model analysis is on /news and /sources, where it is a real call
                attributed to the model that produced it.
              */}
              <p className="rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
                Sentiment and threat above are keyword matches over the headline and snippet. No
                model has assessed this item.
              </p>

              <div className="flex items-center justify-end gap-2 border-t pt-3">
                <Button size="sm" variant="outline" onClick={() => setExpandedPost(null)}>
                  Close
                </Button>
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
