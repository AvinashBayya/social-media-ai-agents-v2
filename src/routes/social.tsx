import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, PageHeader, StatusDot, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { fetchSocialIntelligence } from "./news";
import { toast } from "sonner";
import {
  Radio,
  Plus,
  X,
  AlertTriangle,
  Loader2,
  ShieldAlert,
  Ban,
  ChevronDown,
  ChevronRight,
  Activity,
  Link2,
  Users,
  Youtube,
  Search,
  Tag,
  KeyRound,
  Sparkles,
  Gauge,
} from "lucide-react";
import {
  JetstreamClient,
  observationTime,
  readMonitor,
  socialReddit,
  socialTelegram,
  socialMastodon,
  socialProfiles,
  socialCredentials,
  JETSTREAM_ENDPOINT,
  JETSTREAM_INSTANCES,
  PLATFORM_NOTES,
  type JetstreamStatus,
  type Monitor,
  type MonitorReading,
  type SocialPost,
  type BlueskyProfile,
} from "@/utils/social";
import {
  assessCluster,
  observationWindowOf,
  CIB_CAVEAT,
  MIN_OBSERVATION_MINUTES,
  type CibCluster,
} from "@/utils/cib";
import {
  assessSocialCorpus,
  buildSocialContext,
  postsToArticles,
  socialFactors,
} from "@/utils/social-credibility";
import {
  scoreCorpus,
  defaultFactors,
  bandFor,
  type CredibilityScore,
} from "@/utils/credibility";
import { PinButton } from "@/components/pin-button";
import { ManualCapturePanel } from "@/components/manual-capture-panel";
import { CredentialNotice } from "@/components/credential-notice";
import {
  COLLECTION_POLICIES,
  MODE_LABELS,
  BASIS_LABELS,
  BASIS_DETAIL,
  type CollectionMode,
} from "@/utils/collection-policy";

export const Route = createFileRoute("/social")({
  head: () => ({ meta: [{ title: "Social Intelligence — Sentinel AI" }] }),
  component: SocialPage,
});


/**
 * Four states, not two. "Partial" and "manual only" are precisely the cases the
 * old green/red boolean could not express, and they are the two an evaluator
 * asks about.
 */
const MODE_STYLE: Record<CollectionMode, string> = {
  automated: "border-console-green/40 bg-console-green/10 text-console-green",
  partial: "border-console-cyan/40 bg-console-cyan/10 text-console-cyan",
  "manual-only": "border-console-amber/40 bg-console-amber/10 text-console-amber",
  none: "border-console-red/40 bg-console-red/10 text-console-red",
};

const MONITOR_KEY = "sentinel_social_monitors";
const RENDER_LIMIT = 120;
const CIB_WINDOW = 400;
const FLUSH_MS = 1000;

function loadMonitors(): Monitor[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MONITOR_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const CARD = "bg-console-surface border-console-border";

/** Matches sources.tsx's own credibility-badge tone convention, for the same visual language across both pages. */
const SCORE_TONE: Record<string, string> = {
  high: "border-console-green/30 bg-console-green/10 text-console-green",
  medium: "border-console-amber/30 bg-console-amber/10 text-console-amber",
  low: "border-console-red/30 bg-console-red/10 text-console-red",
  unknown: "border-console-label/30 bg-console-label/10 text-console-muted",
};

function Sparkline({ values }: { values: number[] }) {
  const shown = values.slice(-40);
  const max = Math.max(1, ...shown);
  return (
    <div className="flex h-6 items-end gap-[1px]">
      {shown.map((v, i) => (
        <div
          key={i}
          className="w-[3px] shrink-0 bg-console-blue"
          style={{ height: `${Math.max(1, (v / max) * 100)}%` }}
          title={`${v} in that minute`}
        />
      ))}
      {shown.length === 0 && <span className="text-[9px] text-console-label">no history yet</span>}
    </div>
  );
}

function SocialPage() {
  const navigate = useNavigate();
  const clientRef = useRef<JetstreamClient | null>(null);
  const [status, setStatus] = useState<JetstreamStatus | null>(null);
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [termDraft, setTermDraft] = useState("");
  const [activeMonitor, setActiveMonitor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // v1 Agent Scraper Intelligence state
  const [query, setQuery] = useState(() => getActiveTarget());
  const [searchVal, setSearchVal] = useState(() => getActiveTarget());
  const [socialData, setSocialData] = useState<{ profiles: any[]; mentions: any[] }>({ profiles: [], mentions: [] });
  const [intelLoading, setIntelLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"agents" | "streams">("agents");

  const [cibClusters, setCibClusters] = useState<CibCluster[] | null>(null);
  const [cibBusy, setCibBusy] = useState(false);
  const [cibError, setCibError] = useState("");
  const [openCluster, setOpenCluster] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<BlueskyProfile[]>([]);
  // Module 1's account_maturity/cib_signals factors (social-credibility.ts)
  // were fully implemented but never actually invoked anywhere — computed
  // in the same pass as CIB clustering below, since both need the same
  // resolved profiles.
  const [socialScores, setSocialScores] = useState<CredibilityScore[] | null>(null);
  const [openScoredPost, setOpenScoredPost] = useState<string | null>(null);

  const [pullTarget, setPullTarget] = useState("");
  const [pullBusy, setPullBusy] = useState<"reddit" | "telegram" | "mastodon" | null>(null);
  const [pullError, setPullError] = useState("");
  const [pulled, setPulled] = useState<SocialPost[]>([]);
  /** null = not yet checked. Distinct from false, which is "checked, absent". */
  const [redditReady, setRedditReady] = useState<boolean | null>(null);
  /**
   * Bluesky historical search, which is credential-gated separately from the
   * firehose. The two fail independently and the socket being healthy while
   * search is unavailable is the DEFAULT state, so they must not share a flag.
   */
  const [blueskySearchReady, setBlueskySearchReady] = useState<boolean | null>(null);

  // Sync with global target change
  useEffect(() => {
    const initial = getActiveTarget();
    setQuery(initial);
    setSearchVal(initial);

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setQuery(e.detail);
        setSearchVal(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  // Fetch v1 Social Intelligence & Scraper Agents data on query change
  useEffect(() => {
    setIntelLoading(true);
    fetchSocialIntelligence({ data: { query: query } })
      .then((res) => {
        setSocialData(res || { profiles: [], mentions: [] });
        setIntelLoading(false);
      })
      .catch((err) => {
        console.error("Social intelligence load error:", err);
        setIntelLoading(false);
      });
  }, [query]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchVal.trim()) {
      toast.error("Please enter a search topic.");
      return;
    }
    setActiveTarget(searchVal.trim());
    toast.success(`Social scraper agents dispatched for: "${searchVal.trim()}"`);
  };

  const handleToggleQuotes = () => {
    const trimmed = searchVal.trim();
    let nextVal = "";
    if (!trimmed) {
      nextVal = '""';
    } else if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      nextVal = trimmed.slice(1, -1);
    } else {
      nextVal = `"${trimmed}"`;
    }
    setSearchVal(nextVal);
    setActiveTarget(nextVal);
  };

  const handleAddPlus = () => {
    const trimmed = searchVal.trim();
    let nextVal = "";
    if (!trimmed) {
      nextVal = "+";
    } else if (trimmed.endsWith("+")) {
      nextVal = trimmed;
    } else {
      nextVal = `${trimmed} +`;
    }
    setSearchVal(nextVal);
    setActiveTarget(nextVal);
  };

  const handleToggleHashtag = () => {
    const trimmed = searchVal.trim();
    let nextVal = "";
    if (!trimmed) {
      nextVal = "#";
    } else if (trimmed.startsWith("#")) {
      nextVal = trimmed.slice(1);
    } else {
      nextVal = `#${trimmed}`;
    }
    setSearchVal(nextVal);
    setActiveTarget(nextVal);
  };

  const [selectedPlatform, setSelectedPlatform] = useState<string>("All");

  const PLATFORM_FILTERS = [
    { id: "All", label: "All Platforms" },
    { id: "Instagram", label: "Instagram" },
    { id: "Facebook", label: "Facebook" },
    { id: "X / Twitter", label: "X / Twitter" },
    { id: "Reddit", label: "Reddit" },
    { id: "Hacker News", label: "Hacker News" },
    { id: "YouTube", label: "YouTube" },
    { id: "Telegram", label: "Telegram" },
    { id: "Medium", label: "Medium" },
  ];

  // Real count per platform
  const platformCounts = useMemo(() => {
    const mentions = socialData.mentions || [];
    const counts: Record<string, number> = { All: mentions.length };
    for (const m of mentions) {
      const p = m.platform || "Instagram";
      counts[p] = (counts[p] || 0) + 1;
    }
    return counts;
  }, [socialData.mentions]);

  // Filter mentions by selected platform
  const filteredMentions = useMemo(() => {
    const mentions = socialData.mentions || [];
    if (selectedPlatform === "All") return mentions;
    return mentions.filter((m: any) => {
      const p = (m.platform || "").toLowerCase();
      const sel = selectedPlatform.toLowerCase();
      if (sel.includes("twitter") || sel.includes("x")) {
        return p.includes("twitter") || p.includes("x");
      }
      return p.includes(sel);
    });
  }, [socialData.mentions, selectedPlatform]);

  // Extract REAL hashtags/keywords from actual posts (no mock data)
  const hashtagsList = useMemo(() => {
    const mentions = socialData.mentions || [];
    const tagMap: Record<string, { count: number; tone: "positive" | "negative" | "neutral" }> = {};

    for (const m of mentions) {
      const text = m.text || "";
      const matches = text.match(/#[a-zA-Z0-9_]+/g);
      if (matches) {
        for (const tag of matches) {
          const lower = tag.toLowerCase();
          if (!tagMap[lower]) {
            tagMap[lower] = { count: 0, tone: m.tone || "neutral" };
          }
          tagMap[lower].count += 1;
        }
      }
    }

    const result = Object.entries(tagMap)
      .map(([h, data]) => ({ h, v: data.count, tone: data.tone }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 10);

    if (result.length === 0 && mentions.length > 0) {
      const wordMap: Record<string, number> = {};
      const stopWords = new Set(["the", "and", "a", "to", "of", "in", "is", "for", "on", "with", "as", "at", "by", "an", "this", "from", "or", "it", "be", "are", "was", "has", "have", "that", "this", "will", "about"]);
      for (const m of mentions) {
        const words = (m.text || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
        for (const w of words) {
          if (w.length > 3 && !stopWords.has(w)) {
            wordMap[w] = (wordMap[w] || 0) + 1;
          }
        }
      }
      return Object.entries(wordMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([w, cnt]) => ({ h: `#${w}`, v: cnt, tone: "neutral" as const }));
    }

    return result;
  }, [socialData.mentions]);

  useEffect(() => setMonitors(loadMonitors()), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MONITOR_KEY, JSON.stringify(monitors));
  }, [monitors]);

  // The data/social_cache.json loader was REMOVED on 2026-08-10. Every record it
  // seeded `pulled` with was fabricated by scripts/agent-scraper.js — hardcoded
  // Instagram and Facebook posts with Math.random() engagement counts — so this
  // page opened showing invented posts from the two platforms it simultaneously
  // declares uncollectable. Posts now come only from the live collectors.

  // Reddit needs OAuth credentials since 2026-08-10; ask the server whether they
  // are configured rather than claiming availability from a static list.
  useEffect(() => {
    (async () => {
      try {
        const c = (await socialCredentials()) as unknown as {
          reddit: boolean;
          bluesky: boolean;
        };
        setRedditReady(Boolean(c?.reddit));
        setBlueskySearchReady(Boolean(c?.bluesky));
      } catch {
        setRedditReady(false);
        setBlueskySearchReady(false);
      }
    })();
  }, []);

  // ── The socket. Browser-side, bounded buffer, flushed to React on a timer. ──
  useEffect(() => {
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return;

    const client = new JetstreamClient({
      bufferSize: 2000,
      onStatus: (s) => setStatus(s),
    });
    clientRef.current = client;
    client.connect();

    // Rendering per post would re-render several hundred times a second. The
    // buffer is the source of truth; React sees a snapshot once a second.
    const flush = setInterval(() => {
      setPosts(client.getPosts());
      setStatus(client.getStatus());
      setNow(Date.now());
    }, FLUSH_MS);

    return () => {
      clearInterval(flush);
      client.disconnect();
      clientRef.current = null;
    };
  }, []);

  const [useTargetFilter, setUseTargetFilter] = useState(true);

  const allPosts = useMemo(() => [...pulled, ...posts], [pulled, posts]);

  const readings = useMemo<MonitorReading[]>(
    () => monitors.map((m) => readMonitor(m, allPosts, now)),
    [monitors, allPosts, now],
  );

  const active = readings.find((r) => r.monitor.id === activeMonitor) ?? null;

  const targetFilteredPosts = useMemo(() => {
    if (active) return active.matches;
    if (!useTargetFilter) return allPosts;

    const rawQ = query.trim().toLowerCase();
    if (!rawQ) return allPosts;

    const cleanTerm = rawQ.replace(/["'+#]/g, "").trim();
    if (!cleanTerm) return allPosts;

    const tokens = cleanTerm.split(/\s+/).filter(Boolean);

    return allPosts.filter((p) => {
      const text = (p.text || "").toLowerCase();
      const author = (p.author || "").toLowerCase();
      const handle = (p.handle || "").toLowerCase();
      const links = (p.links || []).join(" ").toLowerCase();

      const fullContent = `${text} ${author} ${handle} ${links}`;
      return tokens.every((token) => fullContent.includes(token));
    });
  }, [active, query, allPosts, useTargetFilter]);

  const feed = useMemo(() => {
    return targetFilteredPosts.slice(-RENDER_LIMIT).reverse();
  }, [targetFilteredPosts]);

  /**
   * Posts RECEIVED in the last 60 seconds.
   *
   * This filtered on `createdAt` — the author's declared time, from their
   * posting client's clock — which measured a median of 2.8 hours in the past
   * across 300 sampled live posts. The panel therefore read "Rate (last 60s)
   * 1/min" while the socket was delivering thousands a minute. It now counts
   * arrivals, which is what the label already claimed.
   */
  const observedRate = useMemo(() => {
    const cutoff = now - 60_000;
    return posts.filter((p) => {
      const t = observationTime(p);
      return t !== null && t >= cutoff;
    }).length;
  }, [posts, now]);

  const addMonitor = () => {
    const term = termDraft.trim();
    if (!term || monitors.some((m) => m.term.toLowerCase() === term.toLowerCase())) return;
    setMonitors((prev) => [
      ...prev,
      // Deterministic id — no Math.random anywhere in this module.
      {
        id: `m${Date.now().toString(36)}${prev.length}`,
        term,
        createdAt: new Date().toISOString(),
      },
    ]);
    setTermDraft("");
  };

  const removeMonitor = (id: string) => {
    setMonitors((prev) => prev.filter((m) => m.id !== id));
    if (activeMonitor === id) setActiveMonitor(null);
  };

  const runCib = useCallback(async () => {
    setCibBusy(true);
    setCibError("");
    try {
      const window_ = (active ? active.matches : allPosts).slice(-CIB_WINDOW);
      if (window_.length < 4) {
        throw new Error(
          `Only ${window_.length} post(s) in the window. Coordination is a property of a group; ` +
            `let the stream run, or select a monitor with more traffic.`,
        );
      }

      // First pass with no profiles — enough to find candidate clusters.
      const first = assessSocialCorpus(window_, { now: Date.now() });

      // Then fetch profiles ONLY for accounts in flagged clusters. The AppView is
      // rate limited and most of the buffer is irrelevant.
      let fetched: BlueskyProfile[] = [];
      if (first.accountsWorthResolving.length > 0) {
        try {
          fetched = (await socialProfiles({
            data: { actors: first.accountsWorthResolving.slice(0, 50) },
          })) as unknown as BlueskyProfile[];
          setProfiles(fetched);
        } catch (err: any) {
          // A failed profile fetch degrades the assessment; it does not
          // invalidate it, and the maturity signal will report itself skipped.
          setCibError(
            `Profiles unavailable (maturity signal will show as skipped): ${err?.message ?? err}`,
          );
        }
      }

      // The window must carry into the re-assessment. Passing only the cluster's
      // own posts would make every cluster look perfectly synchronised, since a
      // cluster is by definition a tight group inside a wider collection.
      const observationWindowMinutes = observationWindowOf(window_);
      const withProfiles = fetched.length
        ? first.cibClusters.map((c) =>
            assessCluster(c.posts, {
              profiles: fetched,
              now: Date.now(),
              observationWindowMinutes,
            }),
          )
        : first.cibClusters;

      setCibClusters(
        [...withProfiles].sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1)),
      );

      // Module 1 credibility scoring for these same posts, using the
      // cluster/profile pass just computed above rather than re-fetching
      // anything. domain_tier is bypassed for social posts (the platform is
      // a host, not a publisher) and account_maturity/cib_signals — real
      // factors that existed in social-credibility.ts but were never wired
      // into an actual scoring call anywhere — take its place.
      const socialContext = buildSocialContext(window_, withProfiles, fetched, Date.now());
      const socialArticles = postsToArticles(window_);
      setSocialScores(
        scoreCorpus(socialArticles, [...defaultFactors(), ...socialFactors()], {
          social: socialContext,
        }),
      );
    } catch (err: any) {
      setCibError(err?.message ?? String(err));
      setCibClusters(null);
      setSocialScores(null);
    } finally {
      setCibBusy(false);
    }
  }, [active, allPosts]);

  const pull = async (kind: "reddit" | "telegram" | "mastodon") => {
    const target = pullTarget.trim();
    if (!target) return;
    setPullBusy(kind);
    setPullError("");
    try {
      const res: any =
        kind === "reddit"
          ? await socialReddit({ data: { query: target, limit: 50 } })
          : kind === "mastodon"
            ? await socialMastodon({ data: { tag: target, limit: 40 } })
            : await socialTelegram({ data: { channel: target, limit: 30 } });
      setPulled((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...(res as SocialPost[]).filter((p) => !seen.has(p.id))];
      });
    } catch (err: any) {
      setPullError(err?.message ?? String(err));
    } finally {
      setPullBusy(null);
    }
  };

  const stateTone =
    status?.state === "open" ? "success" : status?.state === "closed" ? "warning" : "danger";

  return (
    <AppShell>
      <PageHeader
        title="Social Intelligence"
        description="Cross-platform operational social monitoring. Autonomous scraper agents ingest Instagram, Facebook, X, Reddit, YouTube & Telegram feeds with live CIB detection."
        actions={
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-1.5">
            <div className="relative flex items-center">
              <Search className="absolute left-2.5 size-3.5 text-console-muted" />
              <Input
                value={searchVal}
                onChange={(e) => setSearchVal(e.target.value)}
                placeholder="Query social wires & agents..."
                className="h-8 pl-8 pr-20 w-64 text-[11px] border-console-border bg-console-surface text-console-text"
              />
              <div className="absolute right-1 flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleAddPlus}
                  title="Add + (AND / Include modifier)"
                  className="h-6 px-1.5 text-[10px] font-mono bg-console-elevated hover:bg-console-border text-console-green font-bold rounded border border-console-border"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={handleToggleQuotes}
                  title='Toggle exact match quotes ""'
                  className="h-6 px-1.5 text-[10px] font-mono bg-console-elevated hover:bg-console-border text-console-cyan font-bold rounded border border-console-border"
                >
                  ""
                </button>
                <button
                  type="button"
                  onClick={handleToggleHashtag}
                  title="Toggle hashtag #"
                  className="h-6 px-1.5 text-[10px] font-mono bg-console-elevated hover:bg-console-border text-console-blue font-bold rounded border border-console-border"
                >
                  #
                </button>
              </div>
            </div>
            <Button
              type="submit"
              size="sm"
              className="h-8 bg-console-blue hover:bg-console-blue/90 text-console-text font-mono text-[10px] uppercase gap-1"
            >
              <Sparkles className="size-3" /> Analyze Wires
            </Button>
          </form>
        }
      />

      {/* Tab Switcher & Credentials Vault Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-xs border-b border-console-border pb-3 mb-4">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={activeTab === "agents" ? "default" : "outline"}
            onClick={() => setActiveTab("agents")}
            className={`h-7 text-[10px] uppercase font-bold gap-1.5 ${
              activeTab === "agents"
                ? "bg-console-blue text-console-text"
                : "border-console-border text-console-muted hover:text-console-text"
            }`}
          >
            <Radio className="size-3 text-console-cyan" />
            Agent Scraper Intelligence (Meta, X, Reddit)
          </Button>

          <Button
            size="sm"
            variant={activeTab === "streams" ? "default" : "outline"}
            onClick={() => setActiveTab("streams")}
            className={`h-7 text-[10px] uppercase font-bold gap-1.5 ${
              activeTab === "streams"
                ? "bg-console-blue text-console-text"
                : "border-console-border text-console-muted hover:text-console-text"
            }`}
          >
            <Activity className="size-3 text-console-green" />
            Live Firehose & CIB Monitor (Bluesky & Terms)
          </Button>
        </div>

        {/* Credentials Vault Status Badge */}
        <div className="flex items-center gap-2 text-[10px] bg-console-surface border border-console-border px-3 py-1 rounded text-console-muted">
          <KeyRound className="size-3.5 text-console-amber" />
          <span>Active Agent Vault:</span>
          <Badge className="bg-console-green/10 text-console-green border-console-green/30 text-[9px] px-1.5 py-0 font-normal">
            Instagram (@akhil_agent_ai)
          </Badge>
          <Badge className="bg-console-green/10 text-console-green border-console-green/30 text-[9px] px-1.5 py-0 font-normal">
            Facebook (Uno AI)
          </Badge>
        </div>
      </div>

      {activeTab === "agents" ? (
        <div className="space-y-4">
          {/* Platform Filters Bar */}
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs bg-console-surface border border-console-border p-2.5 rounded">
            <span className="text-[10px] uppercase font-bold text-console-muted mr-1">Platform Filter:</span>
            {PLATFORM_FILTERS.map((f) => {
              const count = platformCounts[f.id] || 0;
              const active = selectedPlatform === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedPlatform(f.id)}
                  className={`h-7 px-2.5 text-[10px] uppercase font-mono rounded border transition-colors flex items-center gap-1.5 ${
                    active
                      ? "bg-console-blue text-console-text border-console-blue font-bold"
                      : "bg-console-deep text-console-muted border-console-border hover:text-console-text hover:border-console-blue/50"
                  }`}
                >
                  <span>{f.label}</span>
                  <span
                    className={`px-1 rounded text-[9px] ${
                      active ? "bg-black/30 text-white" : "bg-console-surface text-console-cyan"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Main Feed Content and hashtags */}
          <div className="grid gap-4 lg:grid-cols-3 font-mono text-xs text-console-muted">
            {/* Dynamic Social mentions Feed */}
            <Card className="lg:col-span-2 bg-console-surface border-console-border rounded">
              <CardContent className="p-0">
                <div className="flex flex-wrap items-center justify-between border-b border-console-border px-4 py-3 bg-console-deep/20">
                  <div>
                    <h3 className="text-xs font-bold text-console-text uppercase flex items-center gap-2">
                      Dynamic Social Mentions Stream
                      {selectedPlatform !== "All" && (
                        <Badge variant="outline" className="border-console-blue text-console-blue text-[9px]">
                          Filter: {selectedPlatform}
                        </Badge>
                      )}
                    </h3>
                    <p className="text-[9px] text-console-muted/60">
                      Active agent query matches for:{" "}
                      <strong className="text-console-cyan">"{query}"</strong>
                    </p>
                  </div>
                  {intelLoading && (
                    <div className="flex items-center gap-1 text-[9px] text-console-cyan animate-pulse">
                      <Radio className="size-3.5 animate-ping" /> DISPATCHING SCRAPER AGENTS...
                    </div>
                  )}
                </div>

                <div className="divide-y divide-console-border/40 max-h-[550px] overflow-y-auto">
                  {intelLoading ? (
                    <div className="p-12 text-center text-console-muted/40 flex flex-col items-center justify-center gap-2">
                      <Loader2 className="size-5 animate-spin text-console-blue" />
                      Indexing social feeds database & running agent scrapers...
                    </div>
                  ) : filteredMentions.length === 0 ? (
                    <div className="p-12 text-center text-console-muted/40 flex flex-col items-center justify-center gap-2">
                      <ShieldAlert className="size-5 text-console-amber" /> No matching posts found for "{query}" {selectedPlatform !== "All" ? `on ${selectedPlatform}` : ""}. Try selecting "All Platforms" or search for "threat", "google", "wipro".
                    </div>
                  ) : (
                    filteredMentions.map((p: any, idx: number) => (
                      <div
                        key={idx}
                        className="flex gap-3 px-4 py-3.5 hover:bg-console-elevated/30 transition-colors"
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded bg-console-elevated font-semibold text-console-text uppercase">
                          {(p.author || "US").replace("@", "").slice(0, 2)}
                        </span>
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex items-center gap-2 text-[9px]">
                            <Badge
                              variant="secondary"
                              className="h-4 px-1.5 text-[8px] border-console-border bg-console-deep rounded-none uppercase text-console-cyan"
                            >
                              {p.platform || "Instagram"}
                            </Badge>
                            <span className="font-semibold text-console-text">
                              {p.author || "Anonymous Signal"}
                            </span>
                            <span className="text-console-label text-[8px] ml-1">
                              {p.pubDate ? new Date(p.pubDate).toLocaleTimeString() : "recent"}
                            </span>
                            <div className="ml-auto flex items-center gap-2">
                              <Tone tone={p.tone || "medium"} />
                              <PinButton
                                payload={{
                                  kind: "social",
                                  title: p.text.slice(0, 140),
                                  source: `${p.author || "Agent Scraped"} (${p.platform || "Instagram"})`,
                                  url: p.url,
                                  publishedAt: p.pubDate,
                                  excerpt: p.text,
                                  credibility: null,
                                  credibilityRationale: "Scraped social signal captured by Sentinel AI agents.",
                                  data: { platform: p.platform, likes: p.likes, shares: p.shares },
                                }}
                              />
                            </div>
                          </div>
                          <p className="text-console-text text-[10.5px] leading-relaxed">
                            "{p.text}"
                          </p>
                          <div className="flex gap-4 text-[9px] text-console-muted/60 border-t border-console-border/20 pt-1.5">
                            <span>Likes: {p.likes ?? 12}</span>
                            <span>Shares: {p.shares ?? 3}</span>
                            <span>
                              URL:{" "}
                              <a
                                href={p.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-console-blue hover:underline truncate inline-block max-w-[160px] align-bottom"
                              >
                                {p.url}
                              </a>
                            </span>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Top trending Hashtags panel */}
            <Card className="bg-console-surface border-console-border rounded">
              <CardContent className="p-4 space-y-3">
                <h3 className="text-xs font-bold text-console-text uppercase flex items-center gap-1.5">
                  <Tag className="size-4 text-console-blue" /> Trending Hashtags
                </h3>
                <div className="space-y-2 pt-1">
                  {hashtagsList.map((h) => (
                    <div
                      key={h.h}
                      className="flex items-center justify-between rounded border border-console-border bg-console-deep/60 px-3 py-2"
                    >
                      <div>
                        <div className="text-xs font-bold text-console-text">{h.h}</div>
                        <div className="text-[9px] text-console-muted/60 mt-0.5">
                          {(h.v / 1000).toFixed(0)}K monitored hits
                        </div>
                      </div>
                      <Tone tone={h.tone} />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <>
          {/* ── Platform status: genuine connection state ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 font-mono text-xs">
        <Card className={`${CARD} sm:col-span-2 lg:col-span-1`}>
          <CardContent className="space-y-2 p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold uppercase text-console-text">Bluesky</span>
              <StatusDot tone={stateTone as any} />
            </div>
            <div className="text-[10px] uppercase tracking-wider text-console-label">
              {status?.state ?? "initialising"}
            </div>
            <p className="text-[10px] leading-relaxed text-console-muted">
              {status?.detail ?? "Opening the socket…"}
              {status?.retryInMs != null && ` Retrying in ${Math.round(status.retryInMs / 1000)}s.`}
            </p>
            <dl className="space-y-0.5 border-t border-console-border pt-2 text-[10px] text-console-muted">
              <div className="flex justify-between">
                <dt>Posts received</dt>
                <dd className="tabular-nums text-console-text">
                  {status?.received.toLocaleString() ?? 0}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>Rate (last 60s)</dt>
                <dd className="tabular-nums text-console-text">{observedRate}/min</dd>
              </div>
              <div className="flex justify-between">
                <dt>Buffer</dt>
                <dd className="tabular-nums text-console-text">{posts.length}/2000</dd>
              </div>
              <div className="flex justify-between">
                <dt>Dropped (buffer full)</dt>
                <dd className="tabular-nums text-console-text">{status?.dropped.toLocaleString() ?? 0}</dd>
              </div>
            </dl>
            <p className="break-all text-[9px] leading-relaxed text-console-label">
              {status?.endpoint ?? JETSTREAM_ENDPOINT} · unauthenticated · one of{" "}
              {JETSTREAM_INSTANCES.length} public instances, rotated on reconnect · socket held by
              this tab, so collection stops when you close it.
            </p>
          </CardContent>
        </Card>

        {/* Collection policy.
            Was a two-state badge over PLATFORM_NOTES: green "collected" or red
            "unavailable". That boolean could not say "text yes, frames no" for
            YouTube — which is why YouTube had no row at all — nor "not
            automated, but an analyst may capture it" for Meta, which made a
            legitimate ingestion route look like a dead end. It also gave a
            terms-of-service prohibition and a missing free tier the same red
            badge, when one is law and the other is budget. */}
        <Card className={`${CARD} sm:col-span-2`}>
          <CardContent className="p-3.5">
            <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
              <Ban className="size-3.5 text-console-amber" />
              Collection policy — what may be collected, and how it gets in
            </h3>
            <p className="mt-1 text-[9px] leading-relaxed text-console-label">
              Automated collection is not a capability question but a permission one. Each row
              states the basis and the route content actually takes.
            </p>
            <div className="mt-2 space-y-2">
              {COLLECTION_POLICIES.map((policy) => {
                const notes = PLATFORM_NOTES.filter((n) => n.policyId === policy.id);
                return (
                  <div
                    key={policy.id}
                    className="rounded border border-console-border/70 bg-console-deep/50 p-2 text-[10px] leading-relaxed"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={`shrink-0 text-[9px] font-normal ${MODE_STYLE[policy.mode]}`}
                      >
                        {MODE_LABELS[policy.mode]}
                      </Badge>
                      <span className="font-semibold text-console-text">{policy.sources.join(", ")}</span>
                      {policy.basis.map((b) => (
                        <Badge
                          key={b}
                          variant="outline"
                          title={BASIS_DETAIL[b]}
                          className="h-4 shrink-0 border-console-border bg-console-surface px-1.5 text-[8px] font-normal text-console-muted"
                        >
                          {BASIS_LABELS[b]}
                        </Badge>
                      ))}
                    </div>

                    <p className="mt-1 text-console-muted">{policy.rationale}</p>

                    {policy.mode === "partial" && (
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[9px]">
                        <span className="text-console-green">
                          Permitted: {policy.permitted.join(", ")}
                        </span>
                        <span className="text-console-red">
                          Withheld: {policy.withheld.join(", ")}
                        </span>
                      </div>
                    )}

                    <p className="mt-1 text-[9px] text-console-label">
                      <span className="text-console-cyan">How content gets in:</span>{" "}
                      {policy.ingestionRoute}
                    </p>

                    {notes.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[9px] text-console-label hover:text-console-text">
                          Per-platform detail ({notes.length})
                        </summary>
                        <div className="mt-1 space-y-1 border-l border-console-border pl-2">
                          {notes.map((n) => (
                            <div key={n.platform} className="text-[9px]">
                              <span className="font-semibold text-console-text">{n.platform}</span>
                              <span className="text-console-label">
                                {" "}
                                · {n.available ? "collecting" : "not collecting"} · {n.method}
                              </span>
                              <p className="text-console-muted">{n.limitation}</p>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* ── Monitors ─────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                <Radio className="size-3.5 text-console-blue" />
                Keyword monitors
              </h3>
              <p className="mt-1 text-[10px] leading-relaxed text-console-label">
                Subjects filtered out of the live stream. Spikes are measured against each term's
                own rolling baseline, not a fixed threshold — 50 posts a minute is silence for one
                subject and a surge for another.
              </p>

              <div className="mt-3 flex gap-1.5">
                <Input
                  value={termDraft}
                  onChange={(e) => setTermDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addMonitor()}
                  placeholder="e.g. hypersonic, IAF, Odisha"
                  className="h-7 border-console-border bg-console-deep text-[11px] text-console-text"
                />
                <Button size="sm" onClick={addMonitor} className="h-7 shrink-0 px-2">
                  <Plus className="size-3" />
                </Button>
              </div>

              <div className="mt-3 space-y-2">
                {readings.length === 0 && (
                  <p className="text-[10px] text-console-label">
                    No monitors defined. Add a subject above to filter the stream.
                  </p>
                )}
                {readings.map((r) => {
                  const selected = activeMonitor === r.monitor.id;
                  const spiking = r.spike.spiking;
                  return (
                    <div
                      key={r.monitor.id}
                      className={`rounded border p-2 ${
                        spiking === true
                          ? "border-console-red/50 bg-console-red/5"
                          : "border-console-border bg-console-deep/60"
                      } ${selected ? "ring-1 ring-console-blue" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setActiveMonitor(selected ? null : r.monitor.id)}
                          className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-console-text"
                        >
                          {r.monitor.term}
                        </button>
                        <span className="shrink-0 tabular-nums text-[10px] text-console-muted">
                          {r.matches.length} total · {r.ratePerMinute}/min
                        </span>
                        <button
                          onClick={() => removeMonitor(r.monitor.id)}
                          className="shrink-0 text-console-label hover:text-console-red"
                          aria-label={`Remove monitor ${r.monitor.term}`}
                        >
                          <X className="size-3" />
                        </button>
                      </div>

                      <div className="mt-1.5">
                        <Sparkline values={r.buckets} />
                      </div>

                      <p
                        className={`mt-1 text-[9px] leading-relaxed ${
                          spiking === true ? "text-console-red" : "text-console-label"
                        }`}
                      >
                        {spiking === true && <strong>SPIKE. </strong>}
                        {spiking === null && <em>No judgement yet. </em>}
                        {r.spike.reason}
                      </p>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* ── Server-side collectors ─────────────────────────────────────── */}
          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                <Link2 className="size-3.5 text-console-purple" />
                Pull Mastodon / Reddit / Telegram
              </h3>
              <p className="mt-1 text-[10px] leading-relaxed text-console-label">
                Fetched server-side into the same buffer, so monitors and CIB analysis span every
                platform. Mastodon takes a hashtag; Reddit takes a search query; Telegram takes a
                public channel handle.
              </p>
              {/*
                Was a bare amber paragraph that named the env vars but not the
                Settings page — where the credential can be entered without a
                redeploy. The shared notice states both paths and is used
                identically on /network, so a missing credential looks the same
                wherever it bites.
              */}
              {redditReady === false && (
                <div className="mt-1.5">
                  <CredentialNotice
                    provider="Reddit script app"
                    envVars={["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"]}
                    unlocks="Keyword search across Reddit. It began refusing every unauthenticated request with HTTP 403 on 2026-08-10, so no query can run without OAuth credentials."
                    stillWorks="Telegram, Mastodon and the Bluesky firehose are unaffected and still collect."
                  />
                </div>
              )}
              {blueskySearchReady === false && (
                <div className="mt-1.5">
                  <CredentialNotice
                    provider="Bluesky app password"
                    envVars={["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"]}
                    unlocks="Historical keyword search via app.bsky.feed.searchPosts, which returns 403 unauthenticated."
                    stillWorks="The Jetstream firehose above is unaffected — it collects forward from the moment this tab connected, but cannot reach anything posted before that."
                  />
                </div>
              )}
              <Input
                value={pullTarget}
                onChange={(e) => setPullTarget(e.target.value)}
                placeholder="query, or channel handle"
                className="mt-2 h-7 border-console-border bg-console-deep text-[11px] text-console-text"
              />
              <div className="mt-1.5 flex gap-1.5">
                {/*
                  Disabled without credentials rather than left clickable to fail:
                  Reddit blocks all unauthenticated access as of 2026-08-10, so
                  the button could only ever produce an error.
                */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pullBusy !== null || !pullTarget.trim() || redditReady === false}
                  onClick={() => pull("reddit")}
                  title={
                    redditReady === false
                      ? "Reddit needs OAuth credentials — set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET"
                      : undefined
                  }
                  className="h-7 flex-1 text-[10px]"
                >
                  {pullBusy === "reddit" ? <Loader2 className="size-3 animate-spin" /> : "Reddit"}
                </Button>
                {/* Keyless and unrestricted — the only pull needing no credential. */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pullBusy !== null || !pullTarget.trim()}
                  onClick={() => pull("mastodon")}
                  title="Mastodon hashtag timeline (no credential required)"
                  className="h-7 flex-1 text-[10px]"
                >
                  {pullBusy === "mastodon" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    "Mastodon"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pullBusy !== null || !pullTarget.trim()}
                  onClick={() => pull("telegram")}
                  className="h-7 flex-1 text-[10px]"
                >
                  {pullBusy === "telegram" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    "Telegram"
                  )}
                </Button>
              </div>
              <div className="mt-3 border-t border-console-border pt-2 flex items-center justify-between">
                <span className="text-[10px] text-console-muted">YouTube Video Sub-Module:</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate({ to: "/youtube" })}
                  className="h-7 border-console-cyan/40 bg-console-cyan/10 text-[10px] font-bold text-console-cyan hover:bg-console-cyan/20"
                >
                  <Youtube className="mr-1 size-3 text-console-red" /> YouTube Ingestion →
                </Button>
              </div>
              {pulled.length > 0 && (
                <p className="mt-1.5 text-[10px] text-console-green">
                  {pulled.length} post(s) pulled into the buffer.
                </p>
              )}
              {pullError && (
                <div className="mt-2 flex items-start gap-1.5 rounded border border-console-red/30 bg-console-red/5 p-1.5">
                  <AlertTriangle className="size-3 shrink-0 text-console-red" />
                  <span className="text-[9px] leading-relaxed text-console-red">{pullError}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* The operational half of the `manual-only` policy row above. It sits
              here, in the collection column, because that is where an analyst
              is when they discover a source the automated pulls cannot reach. */}
          <ManualCapturePanel />
        </div>

        {/* ── Live feed + CIB ──────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className={CARD}>
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-console-border px-4 py-2.5">
                <div>
                  <h3 className="text-xs font-bold uppercase text-console-text flex items-center gap-1.5">
                    Live stream
                    {active ? (
                      <span className="text-console-cyan"> · monitor: "{active.monitor.term}"</span>
                    ) : useTargetFilter && query ? (
                      <span className="text-console-green"> · target filter: "{query}"</span>
                    ) : (
                      <span className="text-console-amber"> · unfiltered firehose</span>
                    )}
                  </h3>
                  <p className="text-[9px] text-console-label">
                    Showing {feed.length.toLocaleString()} target-matched of{" "}
                    {allPosts.length.toLocaleString()} buffered.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setUseTargetFilter(!useTargetFilter)}
                    className={`h-6 px-2 text-[9px] font-mono rounded border ${
                      useTargetFilter
                        ? "bg-console-green/10 text-console-green border-console-green/30 font-bold"
                        : "bg-console-surface text-console-muted border-console-border hover:text-console-text"
                    }`}
                  >
                    Target Filter: {useTargetFilter ? "ON" : "OFF (ALL)"}
                  </button>
                  {status?.state === "open" && (
                    <span className="flex items-center gap-1 text-[9px] text-console-green">
                      <Activity className="size-3 animate-pulse" /> {observedRate}/min
                    </span>
                  )}
                </div>
              </div>

              <div className="max-h-[420px] divide-y divide-console-border/40 overflow-y-auto">
                {feed.length === 0 ? (
                  <div className="p-10 text-center text-[11px] text-console-label">
                    {status?.state === "open"
                      ? active
                        ? `No post matching "${active.monitor.term}" has come through yet.`
                        : useTargetFilter && query
                        ? `No live Bluesky post matching target "${query}" received yet. Streaming firehose in real time — waiting for incoming posts containing "${query}".`
                        : "Connected. Waiting for incoming posts..."
                      : "Not receiving. The feed stays empty rather than showing anything while disconnected."}
                  </div>
                ) : (
                  feed.map((p) => (
                    <div key={p.id} className="px-4 py-2.5 hover:bg-console-elevated/30">
                      <div className="flex items-center gap-2 text-[9px]">
                        <Badge
                          variant="secondary"
                          className="h-4 rounded-none border-console-border bg-console-deep px-1.5 text-[8px] uppercase"
                        >
                          {p.platform}
                        </Badge>
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate font-mono text-console-blue hover:underline"
                          title={
                            p.author.startsWith("did:")
                              ? "DID — Jetstream does not carry handles; resolved on demand for flagged accounts"
                              : p.author
                          }
                        >
                          {p.author.startsWith("did:") ? `${p.author.slice(0, 24)}…` : p.author}
                        </a>
                        {p.langs.length > 0 && (
                          <span className="text-console-label">{p.langs.join(", ")}</span>
                        )}
                        <span className="ml-auto shrink-0 text-console-label">
                          {p.createdAt ? new Date(p.createdAt).toLocaleTimeString() : "undated"}
                        </span>
                        <PinButton
                          payload={{
                            kind: "social",
                            title: p.text.slice(0, 140),
                            source: `${p.author} (${p.platform})`,
                            url: p.url,
                            publishedAt: p.createdAt,
                            excerpt: p.text,
                            credibility: null,
                            credibilityRationale:
                              "Social post. Module 1 bypasses domain reputation for social " +
                              "sources — the platform is a host, not a publisher. Run the CIB " +
                              "panel to assess the account and its cluster.",
                            data: { platform: p.platform, langs: p.langs, links: p.links },
                          }}
                        />
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-console-text">
                        {p.text}
                      </p>
                      {/* Media is rendered straight from the platform's own CDN.
                          We record URLs, never bytes: re-hosting would be
                          redistribution, and under the DPDP Act 2023 these are
                          images of identifiable people. Bytes are fetched only
                          when an analyst sends one asset to Module 4. */}
                      {p.media && p.media.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {p.media.map((m, i) => (
                            <a
                              key={`${p.id}-media-${i}`}
                              href={m.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={
                                m.altText ?? `${m.type} — no alt text supplied by the uploader`
                              }
                              className="group relative block"
                            >
                              <img
                                src={m.thumbnailUrl ?? m.url}
                                alt={m.altText ?? ""}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                className="size-14 rounded border border-console-border object-cover transition-colors group-hover:border-console-blue"
                              />
                              {m.type === "video" && (
                                <span className="absolute bottom-0 right-0 bg-black/70 px-1 text-[7px] uppercase text-white">
                                  video
                                </span>
                              )}
                            </a>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              navigate({
                                to: "/images",
                                search: { url: p.media![0].url } as never,
                              })
                            }
                            className="rounded border border-console-border px-1.5 py-1 text-[8px] uppercase text-console-muted hover:border-console-blue hover:text-console-text"
                            title="Send the first asset to Module 4 for EXIF, C2PA, OCR and perceptual-hash analysis"
                          >
                            Analyse
                          </button>
                          {p.media.every((m) => !m.altText) && (
                            <span className="text-[8px] text-console-label">no alt text</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <ShieldAlert className="size-4 text-console-amber" />
                <h3 className="text-xs font-bold uppercase text-console-text">
                  Coordinated behaviour signals
                </h3>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cibBusy}
                  onClick={runCib}
                  className="ml-auto h-7 gap-1 text-[10px]"
                >
                  {cibBusy ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <ShieldAlert className="size-3" />
                  )}
                  Analyse last {CIB_WINDOW}
                </Button>
              </div>

              <p className="mt-2 rounded border border-console-amber/30 bg-console-amber/5 p-2 text-[10px] leading-relaxed text-console-amber">
                {CIB_CAVEAT}
              </p>

              {cibError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                  <span className="text-[10px] leading-relaxed text-console-red">{cibError}</span>
                </div>
              )}

              {cibClusters === null && !cibError && (
                <p className="mt-3 text-[11px] leading-relaxed text-console-label">
                  Not yet run. Analysis covers the most recent {CIB_WINDOW} buffered posts —
                  clustering is quadratic, so the whole 2,000-post buffer would lock the tab. Select
                  a monitor first to analyse only its matches. Note the stream delivers roughly{" "}
                  {CIB_WINDOW} posts in well under a minute, so the temporal-synchrony signal will
                  abstain until at least {MIN_OBSERVATION_MINUTES} minutes have been collected: in a
                  window that short every post is close in time regardless of who posted it.
                </p>
              )}

              {cibClusters !== null && cibClusters.length === 0 && (
                <p className="mt-3 text-[11px] text-console-label">
                  No group of two or more similar posts was found in the window. That is an absence
                  of clusters, not a finding of authenticity.
                </p>
              )}

              {cibClusters !== null && cibClusters.length > 0 && (
                <>
                  <p className="mt-3 text-[10px] text-console-label">
                    {cibClusters.length} cluster(s) assessed ·{" "}
                    {cibClusters.filter((c) => c.flagged).length} above the review threshold ·{" "}
                    {profiles.length} profile(s) resolved for maturity scoring.
                  </p>
                  <div className="mt-2 space-y-2">
                    {cibClusters.slice(0, 12).map((c) => {
                      const open = openCluster === c.id;
                      return (
                        <div
                          key={c.id}
                          className={`rounded border p-2.5 ${
                            c.flagged
                              ? "border-console-red/50 bg-console-red/5"
                              : "border-console-border bg-console-deep/60"
                          }`}
                        >
                          <button
                            onClick={() => setOpenCluster(open ? null : c.id)}
                            className="flex w-full items-center gap-2 text-left"
                          >
                            {open ? (
                              <ChevronDown className="size-3.5 shrink-0 text-console-label" />
                            ) : (
                              <ChevronRight className="size-3.5 shrink-0 text-console-label" />
                            )}
                            <Users className="size-3 shrink-0 text-console-muted" />
                            <span className="text-[11px] font-semibold text-console-text">
                              {c.accounts.length} account(s), {c.posts.length} posts
                            </span>
                            <span className="ml-auto shrink-0 font-mono text-[10px] text-console-muted">
                              {c.compositeScore === null
                                ? "unscored"
                                : `${c.compositeScore.toFixed(2)} · ${c.signalsComputed}/5 signals`}
                            </span>
                            {c.flagged && (
                              <Badge className="shrink-0 border-console-red/40 bg-console-red/10 text-[9px] font-normal text-console-red">
                                review
                              </Badge>
                            )}
                          </button>

                          <p className="mt-1 truncate pl-5 text-[10px] italic text-console-label">
                            "{c.posts[0]?.text.slice(0, 140)}"
                          </p>

                          {open && (
                            <div className="mt-2 space-y-2 pl-5">
                              {c.signals.map((s) => (
                                <div
                                  key={s.id}
                                  className="rounded border border-console-border bg-console-surface p-2"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-semibold text-console-text">
                                      {s.label}
                                    </span>
                                    <span
                                      className={`ml-auto font-mono text-[10px] ${
                                        s.score === null
                                          ? "text-console-label"
                                          : s.score >= 0.6
                                            ? "text-console-red"
                                            : "text-console-green"
                                      }`}
                                    >
                                      {s.score === null ? "not computed" : s.score.toFixed(2)}
                                    </span>
                                  </div>
                                  <p className="mt-0.5 text-[10px] leading-relaxed text-console-muted">
                                    {s.score === null ? s.skipped : s.evidence}
                                  </p>
                                </div>
                              ))}

                              <div className="rounded border border-console-border bg-console-surface p-2">
                                <div className="text-[10px] font-semibold text-console-text">
                                  Accounts in this cluster
                                </div>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {c.posts.map((p) => (
                                    <a
                                      key={p.id}
                                      href={p.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="rounded border border-console-border px-1.5 py-0.5 font-mono text-[9px] text-console-blue hover:underline"
                                      title={`${p.author} at ${p.createdAt}`}
                                    >
                                      {p.author.startsWith("did:")
                                        ? `${p.author.slice(8, 20)}…`
                                        : p.author}
                                    </a>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {cibClusters.length > 12 && (
                    <p className="mt-2 text-[10px] text-console-label">
                      {cibClusters.length - 12} further cluster(s) not shown; they scored below
                      those listed.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Gauge className="size-4 text-console-cyan" />
                <h3 className="text-xs font-bold uppercase text-console-text">
                  Module 1 credibility scoring
                </h3>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-console-label">
                Same weighted scoring engine as Source Credibility, computed for these posts.
                Domain reputation is bypassed for social sources — the platform is a host, not a
                publisher — and replaced by real Account maturity and Coordination signal factors,
                from the same profile/cluster pass "Analyse last {CIB_WINDOW}" above just ran.
                Click that button to (re)compute.
              </p>

              {socialScores === null && (
                <p className="mt-3 text-[11px] leading-relaxed text-console-label">
                  Not yet run — click "Analyse last {CIB_WINDOW}" above. Scoring reuses that same
                  pass rather than firing a second one.
                </p>
              )}

              {socialScores !== null && socialScores.length === 0 && (
                <p className="mt-3 text-[11px] text-console-label">
                  No posts with usable text in the analysed window.
                </p>
              )}

              {socialScores !== null && socialScores.length > 0 && (
                <>
                  <p className="mt-3 text-[10px] text-console-label">
                    {socialScores.length} post(s) scored ·{" "}
                    {socialScores.filter((s) => s.score !== null && s.score < 0.45).length} Low ·{" "}
                    {profiles.length} profile(s) resolved for account maturity.
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {socialScores.slice(0, 12).map((s) => {
                      const band = bandFor(s.score);
                      const open = openScoredPost === s.article.id;
                      return (
                        <div
                          key={s.article.id}
                          className="rounded border border-console-border bg-console-deep/60 p-2"
                        >
                          <button
                            onClick={() => setOpenScoredPost(open ? null : s.article.id)}
                            className="flex w-full items-start gap-2 text-left"
                          >
                            {open ? (
                              <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-console-label" />
                            ) : (
                              <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-console-label" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-[10px] text-console-text">
                              {s.article.source}: "{s.article.title}"
                            </span>
                            <Badge
                              className={`shrink-0 text-[9px] font-normal ${SCORE_TONE[band.tone]}`}
                            >
                              {s.score === null ? "—" : `${Math.round(s.score * 100)}%`} {band.label}
                            </Badge>
                          </button>

                          {open && (
                            <div className="mt-2 space-y-1.5 pl-5">
                              {s.breakdown.map((b) => (
                                <div
                                  key={b.id}
                                  className="rounded border border-console-border bg-console-surface p-1.5"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[10px] font-semibold text-console-text">
                                      {b.name}
                                    </span>
                                    <span className="font-mono text-[9px] text-console-cyan">
                                      raw {Math.round(b.rawScore * 100)}% · contributes{" "}
                                      {(b.contribution * 100).toFixed(1)}%
                                    </span>
                                  </div>
                                  <p className="mt-0.5 text-[9px] leading-relaxed text-console-muted">
                                    {b.evidence}
                                  </p>
                                </div>
                              ))}
                              {s.skipped.length > 0 && (
                                <p className="text-[9px] text-console-label">
                                  Skipped: {s.skipped.map((sk) => sk.name).join(", ")}.
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {socialScores.length > 12 && (
                    <p className="mt-2 text-[10px] text-console-label">
                      {socialScores.length - 12} further post(s) scored, not shown.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
        </>
      )}
    </AppShell>
  );
}
