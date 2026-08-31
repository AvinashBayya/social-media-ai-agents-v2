import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { AppShell, PageHeader, StatusDot } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { MarkdownReport } from "@/components/markdown-report";
import { toast } from "sonner";
import {
  getActiveTarget,
  setActiveTarget,
  getActiveTargetType,
  setActiveTargetType,
  TARGET_TYPES,
  type TargetType,
} from "@/utils/active-target";
import { getInvestigations } from "@/utils/investigations-store";
import { getWatchlists } from "@/utils/watchlist-store";
import { llmExecutiveBrief, llmAnalyseContent, summarizeCategoryCounts } from "@/utils/llm";
import { scoreCorpus, defaultFactors, bandFor } from "@/utils/credibility";
import type { Article } from "@/utils/analysis";
import { loadImageCorpus } from "@/utils/imaging-client";
import type { HashedImage } from "@/utils/imaging";
import { readGraphSnapshot, type GraphSnapshot } from "@/utils/graph-store";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { fetchNews, fetchOSINT } from "./news";
import { fetchGeoLayers } from "@/utils/geo-sources";
import { aiExtractEntities } from "@/utils/analysis-llm";
import { serverSearchYoutubeVideos } from "@/utils/youtube-collector";
import {
  Search,
  Globe2,
  Share2,
  Newspaper,
  Network,
  GitBranch,
  Clock,
  UserSearch,
  LineChart,
  TrendingUp,
  ImageIcon,
  Video,
  FolderLock,
  FileBarChart,
  ShieldAlert,
  Map,
  Bot,
  ListChecks,
  ChevronDown,
  Sparkles,
  RefreshCw,
  Activity,
  Terminal,
  ExternalLink,
  CheckCircle2,
  Maximize2,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Command Hub — Sentinel AI" },
      {
        name: "description",
        content: "Tactical Operations Command Hub for Open Source Intelligence (OSINT).",
      },
    ],
  }),
  component: CommandHub,
});

// Quick-nav intelligence modules grid definition
const MODULE_CARDS = [
  {
    title: "News Intelligence",
    to: "/news",
    icon: Newspaper,
    color: "text-console-blue",
    border: "hover:border-console-blue/50",
    desc: "Live Google News RSS, outlet cross-verification & bias rating",
  },
  {
    title: "OSINT Intelligence",
    to: "/osint",
    icon: Globe2,
    color: "text-console-green",
    border: "hover:border-console-green/50",
    desc: "WHOIS / RDAP, Cloudflare DoH DNS resolution & GitHub repo search",
  },
  {
    title: "Social Intelligence",
    to: "/social",
    icon: Share2,
    color: "text-[#EC4899]",
    border: "hover:border-[#EC4899]/50",
    desc: "Bluesky firehose & profiles, Mastodon, Reddit, Telegram — with CIB signals for review",
  },
  {
    title: "GIS Command Map",
    to: "/gis",
    icon: Map,
    color: "text-console-amber",
    border: "hover:border-console-amber/50",
    desc: "Interactive Leaflet geospatial threat map & regional density",
  },
  {
    title: "Knowledge Graph",
    to: "/graph",
    icon: Network,
    color: "text-console-purple",
    border: "hover:border-console-purple/50",
    desc: "Entity relationship topology & node-edge correlation network",
  },
  {
    title: "Timeline Explorer",
    to: "/timeline",
    icon: Clock,
    color: "text-console-cyan",
    border: "hover:border-console-cyan/50",
    desc: "Chronological event chain mapping & case timeline scrubber",
  },
  {
    title: "Entity Explorer",
    to: "/entities",
    icon: UserSearch,
    color: "text-[#EAB308]",
    border: "hover:border-[#EAB308]/50",
    desc: "Target identity profiling, alias discovery & network footprint",
  },
  {
    title: "Image Intelligence",
    to: "/images",
    icon: ImageIcon,
    color: "text-[#A855F7]",
    border: "hover:border-[#A855F7]/50",
    desc: "C2PA provenance, EXIF, OCR & perceptual matching — in this browser",
  },
  {
    title: "Video Intelligence",
    to: "/videos",
    icon: Video,
    color: "text-console-red",
    border: "hover:border-console-red/50",
    desc: "Keyframe sampling, scene-cut detection & reuse matching against hashed stills",
  },
  {
    title: "AI Investigations",
    to: "/investigations",
    icon: Search,
    color: "text-console-green",
    border: "hover:border-console-green/50",
    desc: "Active investigation case dossiers & threat containment workflow",
  },
  {
    title: "Evidence Vault",
    to: "/vault",
    icon: FolderLock,
    color: "text-[#6366F1]",
    border: "hover:border-[#6366F1]/50",
    desc: "Pinned intelligence assets & forensic evidence repository",
  },
  {
    title: "AI Intelligence Assistant",
    to: "/agents",
    icon: Bot,
    color: "text-console-blue",
    border: "hover:border-console-blue/50",
    desc: "Open-weight LLM analysis & report compiler",
  },
];

/**
 * Which target types a module is actually useful for — used to declutter
 * the grid, e.g. hiding OSINT's domain/WHOIS lookups when the analyst has
 * explicitly tagged the search as a Person. A module NOT listed here is
 * type-agnostic (a meta-view over investigations, or upload-driven analysis
 * that doesn't depend on what kind of target it's for) and always shows.
 * This is real product judgement about relevance, not a data classification
 * — nothing here asserts what TYPE the current target actually is, only
 * which modules are worth surfacing for the type the analyst picked.
 */
const MODULE_RELEVANCE: Partial<Record<string, TargetType[]>> = {
  "/news": ["person", "company", "topic", "social_handle"],
  "/osint": ["domain", "email", "company"],
  "/social": ["person", "company", "topic", "social_handle"],
  "/gis": ["topic", "company", "person"],
  "/entities": ["person", "company", "topic", "social_handle"],
};

/** A real, individually-labelled item shown inside an expanded module card — never a rendering of the count alone. */
type ModuleStatItem = { primary: string; secondary?: string };
type ModuleStat = { count: number | null; loading: boolean; note: string; items: ModuleStatItem[] };

function CommandHub() {
  const [activeTarget, setActiveTargetState] = useState("GOOGLE.COM");
  const [inputVal, setInputVal] = useState("GOOGLE.COM");
  const [cases, setCases] = useState<any[]>([]);
  const [watchlists, setWatchlists] = useState<any[]>([]);

  // Evidence Collected tile — a real count, not an estimate: every
  // investigation's real `evidence` array (localStorage, sentinel_investigations),
  // summed. Zero investigations really is zero evidence, not "not yet computed".
  const evidenceCount = useMemo(
    () => cases.reduce((sum: number, c: any) => sum + (Array.isArray(c?.evidence) ? c.evidence.length : 0), 0),
    [cases],
  );

  // Executive briefing state (open-weight LLM)
  const [aiBriefing, setAiBriefing] = useState<string>("");
  const [briefModel, setBriefModel] = useState<string>("");
  const [briefError, setBriefError] = useState<string>("");
  const [loadingBrief, setLoadingBrief] = useState(false);

  // Public Sentiment AND Overall Threat Risk tiles — both real, both tallied
  // from the SAME per-article LLM classification calls (analyseContentOf(),
  // the same function /sentiment.tsx uses; auto-run here over a small
  // sample instead of analyst-triggered per article). Each real call
  // already returns BOTH a `sentiment` and a `threatLevel` field — a signal
  // that was being fetched and thrown away before. Both report a real
  // distribution across N analyzed articles, never a single invented score.
  const [sentimentCounts, setSentimentCounts] = useState<Record<string, number> | null>(null);
  const [threatCounts, setThreatCounts] = useState<Record<string, number> | null>(null);
  const [contentAnalyzed, setContentAnalyzed] = useState(0);
  const [contentTotalStories, setContentTotalStories] = useState(0);
  const [contentAnalysisLoading, setContentAnalysisLoading] = useState(false);
  const [contentAnalysisError, setContentAnalysisError] = useState("");

  const sentimentSummary = useMemo(
    () => (sentimentCounts ? summarizeCategoryCounts(sentimentCounts, contentAnalyzed) : null),
    [sentimentCounts, contentAnalyzed],
  );
  const threatSummary = useMemo(
    () => (threatCounts ? summarizeCategoryCounts(threatCounts, contentAnalyzed) : null),
    [threatCounts, contentAnalyzed],
  );

  // Confidence Score tile — a real, disclosed, per-article credibility
  // score (Module 1's own deterministic scorer, defaultFactors() +
  // scoreCorpus(), the SAME engine /sources uses for real) averaged across
  // the same real collected corpus. Deliberately relabelled "Source
  // Credibility (avg)" rather than kept as the old "Confidence Score" name —
  // this measures source credibility specifically, not some broader
  // "system confidence" the old label implied and nothing here computes.
  // Synchronous and free: the deterministic factors need no LLM call at
  // all (credibility.ts's own design constraint), so this costs nothing
  // beyond the fetch already happening for the briefing/sentiment tiles.
  const [credibilityAvg, setCredibilityAvg] = useState<number | null>(null);
  const [credibilityScoredCount, setCredibilityScoredCount] = useState(0);
  const [credibilityTotalStories, setCredibilityTotalStories] = useState(0);

  // Specialized Intelligence Modules grid — real "data found" counts AND a
  // small real item preview per card, sourced from whatever each module
  // already persists locally. `null` means "not measured yet" (still
  // loading) for the ones that read a localStorage store on mount;
  // getModuleStat() below treats `null` AFTER load as "not queried" for
  // modules with nothing persisted (most only ever fetch live — see
  // runLiveCheck below for the on-demand version of that). None of these
  // are estimates or placeholders; the arrays (not just their lengths) are
  // kept in state so the expanded card can show real items, not a bare count.
  const [newsStories, setNewsStories] = useState<any[]>([]);
  const [vaultEvidenceItems, setVaultEvidenceItems] = useState<
    { id: string; title: string; type: string; caseId: string }[] | null
  >(null);
  const [imageCorpusItems, setImageCorpusItems] = useState<HashedImage[] | null>(null);
  const [graphSnapshot, setGraphSnapshot] = useState<GraphSnapshot | null>(null);
  const [openModule, setOpenModule] = useState<(typeof MODULE_CARDS)[number] | null>(null);
  const [targetType, setTargetType] = useState<TargetType | null>(null);

  // On-demand real live checks for modules with no persisted store. Fired
  // only when the analyst explicitly asks (a button inside the expanded
  // card), never automatically for all 12 on page load — several of the
  // underlying sources are rate-limited (GDELT's 1-request/5s ceiling) or
  // slow enough that firing them unasked for a badge nobody looked at yet
  // would be wasteful and risk 429s for a real /gis or /osint session.
  const [liveChecks, setLiveChecks] = useState<
    Record<string, { loading: boolean; error: string; count: number | null; items: ModuleStatItem[] }>
  >({});

  useEffect(() => {
    setCases(getInvestigations());
    setWatchlists(getWatchlists());
    setImageCorpusItems(loadImageCorpus());
    setGraphSnapshot(readGraphSnapshot());
    // /vault's evidence store has no exported reader (its logic lives inline
    // in vault.tsx) — read the same "sentinel_evidence" key defensively
    // rather than duplicate its component logic. The 3 seeded demo records
    // (`seeded: true`) are excluded so this never counts fictional evidence
    // as real.
    try {
      const raw = localStorage.getItem("sentinel_evidence");
      const parsed = raw ? JSON.parse(raw) : [];
      setVaultEvidenceItems(Array.isArray(parsed) ? parsed.filter((e: any) => e && !e.seeded) : []);
    } catch {
      setVaultEvidenceItems([]);
    }
  }, []);

  // Sync with global target search
  useEffect(() => {
    const target = getActiveTarget();
    setActiveTargetState(target);
    setInputVal(target);
    fetchAiBrief(target);
    setTargetType(getActiveTargetType());

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setActiveTargetState(e.detail);
        setInputVal(e.detail);
        fetchAiBrief(e.detail);
      }
    };
    const handleTargetTypeChange = (e: any) => {
      setTargetType(e.detail ?? null);
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    window.addEventListener("sentinel_target_type_changed", handleTargetTypeChange);
    return () => {
      window.removeEventListener("sentinel_target_changed", handleTargetChange);
      window.removeEventListener("sentinel_target_type_changed", handleTargetTypeChange);
    };
  }, []);

  const CONTENT_ANALYSIS_SAMPLE_SIZE = 5;

  /**
   * Real per-article sentiment AND threatLevel over a small sample of the
   * real collected corpus, from the SAME analyseContentOf() calls — never a
   * single synthesized score for either. Failures on individual articles
   * (LLM unavailable, malformed response) are dropped from the tally, not
   * counted as a default category; if every attempt fails, that is reported
   * as an error, not silently as "neutral"/"low".
   */
  const runContentAnalysis = async (stories: any[]) => {
    setContentAnalysisLoading(true);
    setContentAnalysisError("");
    setSentimentCounts(null);
    setThreatCounts(null);
    setContentAnalyzed(0);
    setContentTotalStories(stories.length);
    if (stories.length === 0) {
      setContentAnalysisLoading(false);
      return;
    }
    const sample = stories.slice(0, CONTENT_ANALYSIS_SAMPLE_SIZE);
    try {
      const results = await Promise.allSettled(
        sample.map((s) =>
          llmAnalyseContent({
            data: { text: `${s.primaryTitle || ""}\n\n${s.body || ""}`.trim() },
          }),
        ),
      );
      const sCounts: Record<string, number> = {};
      const tCounts: Record<string, number> = {};
      let analyzed = 0;
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const value = r.value as any;
        if (typeof value?.sentiment !== "string" || typeof value?.threatLevel !== "string") continue;
        sCounts[value.sentiment] = (sCounts[value.sentiment] ?? 0) + 1;
        tCounts[value.threatLevel] = (tCounts[value.threatLevel] ?? 0) + 1;
        analyzed += 1;
      }
      setSentimentCounts(sCounts);
      setThreatCounts(tCounts);
      setContentAnalyzed(analyzed);
      if (analyzed === 0) {
        const firstReason = results.find((r) => r.status === "rejected") as
          | PromiseRejectedResult
          | undefined;
        setContentAnalysisError(
          `Content analysis failed for every sampled article: ${firstReason?.reason?.message ?? firstReason?.reason ?? "unknown error"}`,
        );
      }
    } catch (err: any) {
      setContentAnalysisError(err?.message ?? String(err));
    } finally {
      setContentAnalysisLoading(false);
    }
  };

  /**
   * Real, synchronous credibility scoring — Module 1's own deterministic
   * scorer (defaultFactors() + scoreCorpus(), no LLM call, so this runs
   * instantly on whatever corpus fetchAiBrief just collected). Averages
   * only the articles a score could actually be computed for; an article
   * scoreCorpus returned `null` for (nothing computable) is excluded from
   * both the average and its own denominator, not folded in as a 0.
   */
  const runCredibility = (stories: any[]) => {
    setCredibilityTotalStories(stories.length);
    if (stories.length === 0) {
      setCredibilityAvg(null);
      setCredibilityScoredCount(0);
      return;
    }
    const articles: Article[] = stories.map((s, i) => ({
      id: String(s.id ?? s.primaryLink ?? i),
      title: s.primaryTitle || "",
      source: s.primarySource || "",
      url: s.primaryLink || s.url || "",
      pubDate: s.pubDate || "",
      body: s.body || "",
    }));
    const scores = scoreCorpus(articles, defaultFactors())
      .map((r) => r.score)
      .filter((s): s is number => s !== null);
    setCredibilityScoredCount(scores.length);
    setCredibilityAvg(scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null);
  };

  const fetchAiBrief = async (targetStr: string) => {
    if (typeof window === "undefined") return;
    setLoadingBrief(true);
    setBriefError("");
    setAiBriefing("");
    try {
      // The context previously sent here was `Target acquisition search
      // initiated for ${targetStr}. Provide an automated threat briefing...` —
      // that's the INSTRUCTION echoed back as if it were evidence, containing
      // zero real facts about the target. The model's own system prompt says
      // "use only the information supplied," so it was doing exactly that —
      // the "information supplied" just never included anything real,
      // leaving it to either say so or fill the gap from its own training
      // knowledge dressed up as a briefing. Ground it in the same collected
      // news corpus /sources, /trends and /sentiment already fetch for this
      // target, so "Strategic Profile"/"Known Capabilities" trace to real
      // headlines, not a description of the task.
      const newsRes: any = await fetchNews({ data: { query: targetStr } });
      const stories: any[] = Array.isArray(newsRes?.stories) ? newsRes.stories : [];
      setNewsStories(stories);

      // Fire-and-forget: content analysis is a separate set of LLM calls
      // from the briefing below and manages its own loading/error state, so
      // it runs in parallel rather than blocking the briefing on it (or
      // vice versa). Credibility scoring is synchronous and free — runs
      // immediately, no loading state needed.
      void runContentAnalysis(stories);
      runCredibility(stories);

      if (stories.length === 0) {
        // Matches reports.ts's generateProduct(): refuse rather than ask the
        // model to write a "Risk Assessment" from nothing.
        setBriefError(
          `No collected sources for "${targetStr}" — nothing to brief. A briefing written ` +
            `without real collected material would be the model's invention, not intelligence.`,
        );
        return;
      }

      const context = stories
        .slice(0, 8)
        .map((s, i) => {
          const source = s.primarySource || "unknown source";
          const date = typeof s.pubDate === "string" ? s.pubDate.slice(0, 10) : "undated";
          const snippet = s.body ? ` — ${String(s.body).slice(0, 220)}` : "";
          return `${i + 1}. [${source}, ${date}] ${s.primaryTitle || "(untitled)"}${snippet}`;
        })
        .join("\n");

      const res = await llmExecutiveBrief({
        data: {
          target: targetStr,
          context: `${stories.length} article(s) collected for "${targetStr}":\n${context}`,
        },
      });
      setAiBriefing(res.text);
      setBriefModel(res.model);
    } catch (err: any) {
      // Previously this wrote a fabricated "monitoring active across news wires,
      // social streams and DNS subnets" briefing whenever the model failed —
      // an invented intelligence product presented as a real one.
      setBriefError(err?.message ?? String(err));
    } finally {
      setLoadingBrief(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputVal.trim()) return;
    setActiveTarget(inputVal.trim());
    toast.success(`Target Acquisition set to: ${inputVal.trim()}`);
  };

  // Modules with a real, minimal, already-existing live query reusable from
  // a bare target string — surveyed per module before wiring anything so
  // "Run Live Check" is never a fabricated result. Timeline (pure reader of
  // pinned case evidence, no collector of its own) and AI Assistant (an LLM
  // report compiler over existing cases, not a target-string collector) have
  // no such query and are left honestly explained instead. Social
  // Intelligence's own collector (`fetchSocialIntelligence`) was checked too
  // and deliberately left OUT here — its `mentions` path reads from a
  // separate in-progress cache/scraper pipeline this task did not touch;
  // see the chat writeup for what was found there.
  const LIVE_CHECK_MODULES = new Set(["/osint", "/gis", "/entities", "/videos"]);

  const runLiveCheck = async (m: (typeof MODULE_CARDS)[number]) => {
    setLiveChecks((prev) => ({ ...prev, [m.to]: { loading: true, error: "", count: null, items: [] } }));
    try {
      let count = 0;
      let items: ModuleStatItem[] = [];
      if (m.to === "/osint") {
        const res: any = await fetchOSINT({ data: { query: activeTarget } });
        items = [
          { primary: "WHOIS registrar", secondary: res?.whois?.Registrar ?? "N/A" },
          { primary: "DNS A record", secondary: res?.dns?.a ?? "N/A" },
          { primary: "GitHub repositories", secondary: String(res?.github?.length ?? 0) },
          {
            primary: "Certificate transparency",
            secondary: res?.certificatesError ?? `${res?.certificates?.length ?? 0} logged`,
          },
        ];
        count = (res?.github?.length ?? 0) + (res?.certificates?.length ?? 0);
      } else if (m.to === "/gis") {
        const res: any = await fetchGeoLayers({ data: { query: activeTarget } });
        const layers: any[] = Array.isArray(res?.layers) ? res.layers : [];
        count = layers.reduce((sum, l) => sum + (Array.isArray(l?.records) ? l.records.length : 0), 0);
        items = layers
          .filter((l) => Array.isArray(l?.records) && l.records.length > 0)
          .slice(0, 4)
          .map((l) => ({ primary: String(l.layer), secondary: `${l.records.length} located record(s)` }));
        if (items.length === 0) {
          items = [{ primary: "No layer returned a located record for this target", secondary: undefined }];
        }
      } else if (m.to === "/entities") {
        const newsRes: any = await fetchNews({ data: { query: activeTarget } });
        const sample: any[] = Array.isArray(newsRes?.stories) ? newsRes.stories.slice(0, 1) : [];
        if (sample.length === 0) {
          items = [{ primary: `No collected articles for ${activeTarget} to extract entities from` }];
        } else {
          const s = sample[0];
          const article = {
            id: String(s.id ?? s.primaryLink ?? "0"),
            title: s.primaryTitle || "",
            source: s.primarySource || "",
            url: s.primaryLink || s.url || "",
            pubDate: s.pubDate || "",
            body: s.body || "",
          };
          const res: any = await aiExtractEntities({ data: { article } });
          const entities: any[] = Array.isArray(res?.entities) ? res.entities : [];
          count = entities.length;
          items = entities
            .slice(0, 4)
            .map((e) => ({ primary: String(e.entity), secondary: String(e.type) }));
          if (items.length === 0) items = [{ primary: "No named entities found in the sampled article" }];
        }
      } else if (m.to === "/videos") {
        const res: any = await serverSearchYoutubeVideos({ data: { query: activeTarget } });
        if (res?.error) throw new Error(res.error);
        const results: any[] = Array.isArray(res?.results) ? res.results : [];
        count = results.length;
        items = results
          .slice(0, 4)
          .map((v) => ({ primary: v.title, secondary: v.channel ?? undefined }));
        if (items.length === 0) items = [{ primary: `No YouTube results for ${activeTarget}` }];
      }
      setLiveChecks((prev) => ({ ...prev, [m.to]: { loading: false, error: "", count, items } }));
    } catch (err: any) {
      setLiveChecks((prev) => ({
        ...prev,
        [m.to]: { loading: false, error: err?.message ?? String(err), count: null, items: [] },
      }));
    }
  };

  // Real "data found" for the module grid — items, not just a count, for
  // every module that has real data to show. Five modules (News, AI
  // Investigations, Evidence Vault, Image Intelligence, Knowledge Graph)
  // read from a local store already populated on this page; four more
  // (OSINT, GIS, Entity Explorer, Video Intelligence) fall through to their
  // liveChecks[to] entry once the analyst presses "Run Live Check" inside
  // the expanded card. Timeline and AI Assistant have no per-target
  // collector at all and say so specifically.
  const getModuleStat = (to: string): ModuleStat => {
    switch (to) {
      case "/news":
        return contentAnalysisLoading
          ? { count: null, loading: true, items: [], note: `Fetching live Google News RSS coverage for ${activeTarget}…` }
          : {
              count: contentTotalStories,
              loading: false,
              note: `Real live Google News RSS results collected for ${activeTarget}.`,
              items: newsStories
                .slice(0, 4)
                .map((s) => ({
                  primary: s.primaryTitle || "(untitled)",
                  secondary: `${s.primarySource || "unknown source"} · ${typeof s.pubDate === "string" ? s.pubDate.slice(0, 10) : "undated"}`,
                })),
            };
      case "/investigations":
        return {
          count: cases.length,
          loading: false,
          note: "Real investigation case dossiers in this browser's local store (all targets, not filtered to the current one).",
          items: cases
            .slice(0, 4)
            .map((c: any) => ({
              primary: c.title || c.target || c.id,
              secondary: `${c.target ?? ""} · ${Array.isArray(c.evidence) ? c.evidence.length : 0} evidence`,
            })),
        };
      case "/vault":
        return vaultEvidenceItems === null
          ? { count: null, loading: true, items: [], note: "Loading the local evidence store…" }
          : {
              count: vaultEvidenceItems.length,
              loading: false,
              note: "Real pinned evidence items across all cases in this browser (excludes seeded demo records; all targets).",
              items: vaultEvidenceItems
                .slice(0, 4)
                .map((e) => ({ primary: e.title, secondary: `${e.type} · ${e.caseId}` })),
            };
      case "/images":
        return imageCorpusItems === null
          ? { count: null, loading: true, items: [], note: "Loading the local image-hash corpus…" }
          : {
              count: imageCorpusItems.length,
              loading: false,
              note: "Real analyzed-image hash corpus in this browser across all sessions — not specific to the current target.",
              items: imageCorpusItems
                .slice(0, 4)
                .map((img) => ({ primary: img.id, secondary: img.source })),
            };
      case "/graph": {
        const matchesTarget =
          !!graphSnapshot && graphSnapshot.target.trim().toLowerCase() === activeTarget.trim().toLowerCase();
        return matchesTarget
          ? {
              count: graphSnapshot!.entities.length + graphSnapshot!.relationships.length,
              loading: false,
              note: `Real entity + relationship count from the last "View in Graph" hand-off for ${activeTarget} (${graphSnapshot!.entities.length} entities, ${graphSnapshot!.relationships.length} relationships).`,
              items: graphSnapshot!.entities
                .slice(0, 4)
                .map((e) => ({ primary: e.displayName, secondary: e.type })),
            }
          : {
              count: null,
              loading: false,
              items: [],
              note: `No graph has been built for ${activeTarget} yet — run an OSINT investigation on /osint and use "View in Graph" to populate this.`,
            };
      }
      case "/timeline":
        return {
          count: null,
          loading: false,
          items: [],
          note: "No collector of its own — it visualizes evidence already pinned to your investigations. Open it directly to view real case timelines.",
        };
      case "/agents":
        return {
          count: null,
          loading: false,
          items: [],
          note: "A report compiler over your existing investigations, not a target collector — open it directly to generate a report from a case.",
        };
      default: {
        if (LIVE_CHECK_MODULES.has(to)) {
          const live = liveChecks[to];
          if (!live) {
            return {
              count: null,
              loading: false,
              items: [],
              note: "Not queried yet — press \"Run Live Check\" below to fetch real results for this target.",
            };
          }
          if (live.loading) {
            return { count: null, loading: true, items: [], note: `Running a live check for ${activeTarget}…` };
          }
          if (live.error) {
            return { count: null, loading: false, items: [], note: `Live check failed: ${live.error}` };
          }
          return {
            count: live.count,
            loading: false,
            items: live.items,
            note: `Real live result for ${activeTarget}, fetched just now.`,
          };
        }
        return {
          count: null,
          loading: false,
          items: [],
          note:
            "Not queried yet — this module runs live, keyless queries against its own sources on open. " +
            "Nothing is fetched for it here automatically, so its data isn't counted until you open it.",
        };
      }
    }
  };

  // Declutters the grid for the type of target actually being searched —
  // e.g. hides OSINT's domain/WHOIS lookups when the analyst has tagged the
  // search as a Person. A module with no entry in MODULE_RELEVANCE is
  // type-agnostic and always shows. "All types" (targetType === null) shows
  // everything, and is always one click away via the header's "Show all".
  const visibleModules = useMemo(() => {
    if (!targetType) return MODULE_CARDS;
    return MODULE_CARDS.filter((m) => {
      const relevant = MODULE_RELEVANCE[m.to];
      return !relevant || relevant.includes(targetType);
    });
  }, [targetType]);

  return (
    <AppShell>
      <PageHeader
        title="Tactical Operations Command Hub"
        description="Unified AI intelligence acquisition engine. Search any corporate entity, digital handle, domain footprint, or tactical threat topic to activate cross-module intelligence pipelines."
      />

      <div className="p-6 space-y-6">
        {/* Top Target Acquisition Bar */}
        <Card className="bg-console-surface border-console-border p-6 shadow-xl">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Badge className="bg-console-green/10 text-console-green border-console-green/30 font-mono text-xs px-2.5 py-1">
                  <span className="size-1.5 rounded-full bg-console-green animate-ping mr-1.5" />
                  ACTIVE TARGET: {activeTarget.toUpperCase()}
                </Badge>
                <span className="text-xs font-mono text-console-muted">
                  CLASSIFICATION:{" "}
                  <span className="text-console-text font-bold">UNCLASSIFIED // DEMONSTRATOR</span>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchAiBrief(activeTarget)}
                className="h-8 gap-2 border-console-border text-xs font-mono text-console-muted hover:text-console-text"
              >
                <RefreshCw className={`size-3.5 ${loadingBrief ? "animate-spin" : ""}`} />
                Refresh AI Brief
              </Button>
            </div>

            <form onSubmit={handleSearchSubmit} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-console-green" />
                <Input
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  placeholder="INPUT TARGET PARAMETER (Company, Domain, Person, Hashtag, Threat Keyword)..."
                  className="h-11 pl-10 bg-console-deep border-console-border text-sm font-mono text-console-text placeholder:text-console-label focus:border-console-green rounded-lg"
                />
              </div>
              <Button
                type="submit"
                className="h-11 px-6 bg-console-green hover:bg-console-green-hover text-console-accent-foreground font-bold font-mono text-xs rounded-lg"
              >
                EXECUTE ACQUISITION
              </Button>
            </form>

            <div className="flex flex-wrap gap-2 text-xs font-mono text-console-muted items-center">
              <span className="text-[10px] text-console-label uppercase">Quick Presets:</span>
              {[
                "Tesla",
                "OpenAI",
                "google.com",
                "Elon Musk",
                "#ElectionIntegrity",
                "Cyber Attack",
              ].map((preset) => (
                <button
                  key={preset}
                  onClick={() => {
                    setInputVal(preset);
                    setActiveTarget(preset);
                  }}
                  className="px-2.5 py-1 rounded bg-console-deep border border-console-border hover:border-console-green hover:text-console-green transition-colors text-[11px]"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </Card>

        {/*
          Executive triage metrics.

          These four tiles previously displayed 85% / 68 / -12 / 148 as
          constants — never computed from anything, never changing with the
          target. All four are now real (2026-08-20), each traceable to a
          real computation, none a synthesized/guessed score:
            - Source Credibility (avg): Module 1's own deterministic scorer
              (defaultFactors() + scoreCorpus(), same engine /sources uses),
              averaged over the real collected corpus. Synchronous, no LLM.
              Deliberately renamed from "Confidence Score" — this measures
              source credibility specifically, not some broader "system
              confidence" nothing here computes.
            - Overall Threat Risk: real per-article LLM threatLevel
              classification (analyseContentOf) — the SAME calls Public
              Sentiment already makes, just reading a second field off the
              same real response instead of a separate metric.
            - Public Sentiment: real per-article LLM sentiment
              classification, same calls as above.
            - Evidence Collected: a real count of investigations' real
              `evidence` arrays.
          What none of these do: blend UNRELATED modules (GIS conflict
          proximity, credibility, CIB signals, sentiment...) into one
          number. There is still no principled formula for that, and an LLM
          asked to invent one would be guessing, not measuring — exactly
          the fabrication this system exists to avoid.
        */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-console-surface border-console-border p-4">
            <div className="text-[10px] font-mono text-console-muted uppercase">
              Source Credibility (avg)
            </div>
            {credibilityAvg !== null ? (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-text">
                  {(credibilityAvg * 100).toFixed(0)}%
                </span>
                <span className="text-[10px] font-mono text-console-muted font-bold">
                  {bandFor(credibilityAvg).label.toUpperCase()}
                </span>
              </div>
            ) : (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-label">—</span>
                <span className="text-[10px] font-mono text-console-label font-bold">NOT MEASURED</span>
              </div>
            )}
            <p className="mt-3 text-[9px] font-mono leading-relaxed text-console-label">
              {credibilityAvg !== null
                ? `Module 1's deterministic scorer, averaged across ${credibilityScoredCount} of ${credibilityTotalStories} collected article(s) that could be scored.`
                : "No collected sources for this target — nothing to score."}
            </p>
          </Card>

          <Card className="bg-console-surface border-console-border p-4">
            <div className="text-[10px] font-mono text-console-muted uppercase">Overall Threat Risk</div>
            {contentAnalysisLoading ? (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-label">—</span>
                <span className="text-[10px] font-mono text-console-green font-bold">ANALYZING…</span>
              </div>
            ) : contentAnalysisError ? (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-red">—</span>
                <span className="text-[10px] font-mono text-console-red font-bold">AI UNAVAILABLE</span>
              </div>
            ) : threatSummary ? (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-text uppercase">
                  {threatSummary.label}
                </span>
                <span className="text-[10px] font-mono text-console-muted font-bold">
                  {threatSummary.pct}%
                </span>
              </div>
            ) : (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-label">—</span>
                <span className="text-[10px] font-mono text-console-label font-bold">NOT MEASURED</span>
              </div>
            )}
            <p className="mt-3 text-[9px] font-mono leading-relaxed text-console-label">
              {contentAnalysisError
                ? contentAnalysisError
                : threatSummary
                  ? `Real LLM threat-level classification across ${contentAnalyzed} of ${contentTotalStories} collected article(s) for this target.`
                  : contentAnalysisLoading
                    ? `Classifying up to ${CONTENT_ANALYSIS_SAMPLE_SIZE} collected articles for this target...`
                    : "No collected sources for this target — nothing to classify."}
            </p>
          </Card>

          <Card className="bg-console-surface border-console-border p-4">
            <div className="text-[10px] font-mono text-console-muted uppercase">Public Sentiment</div>
            {contentAnalysisLoading ? (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-label">—</span>
                <span className="text-[10px] font-mono text-console-green font-bold">ANALYZING…</span>
              </div>
            ) : contentAnalysisError ? (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-red">—</span>
                <span className="text-[10px] font-mono text-console-red font-bold">AI UNAVAILABLE</span>
              </div>
            ) : sentimentSummary ? (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-text uppercase">
                  {sentimentSummary.label}
                </span>
                <span className="text-[10px] font-mono text-console-muted font-bold">
                  {sentimentSummary.pct}%
                </span>
              </div>
            ) : (
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-console-label">—</span>
                <span className="text-[10px] font-mono text-console-label font-bold">NOT MEASURED</span>
              </div>
            )}
            <p className="mt-3 text-[9px] font-mono leading-relaxed text-console-label">
              {contentAnalysisError
                ? contentAnalysisError
                : sentimentSummary
                  ? `Real LLM sentiment classification across ${contentAnalyzed} of ${contentTotalStories} collected article(s) for this target.`
                  : contentAnalysisLoading
                    ? `Classifying up to ${CONTENT_ANALYSIS_SAMPLE_SIZE} collected articles for this target...`
                    : "No collected sources for this target — nothing to classify."}
            </p>
          </Card>

          <Card className="bg-console-surface border-console-border p-4">
            <div className="text-[10px] font-mono text-console-muted uppercase">Evidence Collected</div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-mono font-bold text-console-text">{evidenceCount}</span>
              <span className="text-[10px] font-mono text-console-muted font-bold">
                {evidenceCount === 1 ? "ITEM" : "ITEMS"}
              </span>
            </div>
            <p className="mt-3 text-[9px] font-mono leading-relaxed text-console-label">
              {cases.length === 0
                ? "No investigations exist yet — pin evidence from any module to an investigation to populate this."
                : `Real count across ${cases.length} investigation(s) in this browser's local evidence store.`}
            </p>
          </Card>
        </div>

        {/* AI Briefing & Strategic Recommendations */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 bg-console-surface border-console-border">
            <CardHeader className="border-b border-console-border pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-mono flex items-center gap-2 text-console-text">
                  <Bot className="size-4 text-console-green" />
                  EXECUTIVE AI BRIEFING
                </CardTitle>
                <Badge className="bg-console-green/10 text-console-green border-console-green/30 font-mono text-[10px]">
                  LIVE GENERATION
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              {loadingBrief ? (
                <div className="space-y-2 py-6 text-center text-xs font-mono text-console-muted">
                  <RefreshCw className="size-5 animate-spin mx-auto text-console-green" />
                  <p>Querying the configured LLM for a target intelligence brief...</p>
                </div>
              ) : briefError ? (
                <div className="rounded border border-console-red/30 bg-console-red/5 p-3">
                  <div className="text-xs font-mono font-bold text-console-red">AI unavailable</div>
                  <p className="mt-1 text-[10px] font-mono leading-relaxed text-console-red/80">
                    No briefing was produced. {briefError}
                  </p>
                </div>
              ) : aiBriefing ? (
                <>
                  <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-console-cyan">
                    AI-generated · {briefModel}
                  </div>
                  <MarkdownReport text={aiBriefing} className="text-xs font-mono text-console-text font-normal leading-relaxed" />
                </>
              ) : (
                <p className="py-6 text-center text-xs font-mono text-console-label">
                  No briefing generated yet.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="bg-console-surface border-console-border">
            <CardHeader className="border-b border-console-border pb-3">
              {/*
                These three were static strings with the target interpolated in.
                Nothing generated them and they never varied, so presenting them
                as machine-derived analysis was false. Relabelled as the fixed
                procedural checklist they actually are.
              */}
              <CardTitle className="text-sm font-mono flex items-center gap-2 text-console-text">
                <Sparkles className="size-4 text-console-label" />
                STANDARD ANALYST CHECKLIST
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <p className="text-[10px] font-mono leading-relaxed text-console-label">
                A fixed procedural checklist, not generated analysis.
              </p>
              {[
                "Run OSINT enumeration on infrastructure associated with the target.",
                "Configure volume-threshold alerting on social mentions.",
                "Track WHOIS and DNS history to detect domain changes.",
              ].map((step, i) => (
                <div
                  key={i}
                  className="p-3 rounded bg-console-deep border border-console-border text-xs font-mono space-y-1"
                >
                  <span className="text-console-muted font-bold">STEP_0{i + 1}:</span>
                  <p className="text-console-muted">{step}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Specialized Intelligence Modules Directory */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-mono font-bold text-console-text uppercase tracking-wider flex items-center gap-2">
              <Activity className="size-4 text-console-green" />
              Specialized Intelligence Modules (Target Context Active)
            </h2>
            <span className="flex items-center gap-2 text-xs font-mono text-console-muted">
              {targetType ? (
                <>
                  {visibleModules.length} of {MODULE_CARDS.length} shown for{" "}
                  <span className="text-console-green font-bold">
                    {TARGET_TYPES.find((t) => t.value === targetType)?.label ?? targetType}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTargetType(null);
                      setTargetType(null);
                    }}
                    className="text-console-blue hover:underline font-bold"
                  >
                    Show all
                  </button>
                </>
              ) : (
                `${MODULE_CARDS.length} Operational Suites Ready`
              )}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
            {visibleModules.map((m) => {
              const Icon = m.icon;
              const stat = getModuleStat(m.to);
              const isOpen = openModule?.to === m.to;
              return (
                // Collapsible, not Popover — the SAME card container grows to
                // reveal its data, rather than a second box appearing next to
                // it. CollapsibleContent's height animates smoothly between 0
                // and its real measured height via the collapsible-down/up
                // keyframes in styles.css (Radix exposes the real content
                // height as --radix-collapsible-content-height, so the
                // transition always matches the actual content instead of a
                // guessed max-height). The grid naturally reflows around the
                // taller card — no absolute positioning, no overlay.
                <Collapsible
                  key={m.to}
                  open={isOpen}
                  onOpenChange={(o) => setOpenModule(o ? m : null)}
                  className={`rounded-lg bg-console-surface border border-console-border ${m.border} transition-colors group`}
                >
                  <CollapsibleTrigger asChild>
                    <button type="button" className="text-left w-full p-4 flex flex-col justify-between cursor-pointer">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="p-2 rounded bg-console-deep border border-console-border">
                            <Icon className={`size-4 ${m.color}`} />
                          </div>
                          <div className="flex items-center gap-1.5">
                            {stat.loading ? (
                              <span className="text-[10px] font-mono text-console-green animate-pulse">…</span>
                            ) : stat.count !== null ? (
                              <span className="text-xs font-mono font-bold text-console-text bg-console-deep border border-console-border rounded px-1.5 py-0.5 tabular-nums">
                                {stat.count}
                              </span>
                            ) : (
                              <span className="text-[9px] font-mono text-console-label uppercase">Not queried</span>
                            )}
                            <ChevronDown
                              className={`size-4 text-console-label group-hover:text-console-text transition-transform duration-300 ${isOpen ? "rotate-180" : ""}`}
                            />
                          </div>
                        </div>
                        <div>
                          <h3 className="text-xs font-mono font-bold text-console-text group-hover:text-console-green transition-colors">
                            {m.title}
                          </h3>
                          <p className="text-[11px] text-console-muted leading-normal mt-1">{m.desc}</p>
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-console-border flex items-center justify-between text-[10px] font-mono text-console-label">
                        <span>QUERY: {activeTarget}</span>
                        <span className="text-console-green font-bold">{isOpen ? "COLLAPSE" : "DETAILS"}</span>
                      </div>
                    </button>
                  </CollapsibleTrigger>

                  <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
                    <div className="px-4 pb-4 space-y-3">
                      <div className="rounded bg-console-deep border border-console-border overflow-hidden">
                        <div className="px-2.5 py-2 flex items-center justify-between border-b border-console-border">
                          <span className="text-[9px] font-mono text-console-muted uppercase">Data Found</span>
                          {stat.loading ? (
                            <span className="text-[10px] font-mono font-bold text-console-green">Checking…</span>
                          ) : stat.count !== null ? (
                            <span className="text-[10px] font-mono font-bold text-console-text tabular-nums">
                              {stat.count} {stat.count === 1 ? "item" : "items"}
                            </span>
                          ) : (
                            <span className="text-[10px] font-mono font-bold text-console-label">NOT QUERIED</span>
                          )}
                        </div>

                        {stat.items.length > 0 ? (
                          <ul className="divide-y divide-console-border">
                            {stat.items.map((it, i) => (
                              <li key={i} className="px-2.5 py-1.5">
                                <p className="text-[10px] font-mono text-console-text leading-snug truncate">
                                  {it.primary}
                                </p>
                                {it.secondary && (
                                  <p className="text-[9px] font-mono text-console-label leading-snug truncate">
                                    {it.secondary}
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="px-2.5 py-2 text-[9px] font-mono text-console-label leading-relaxed">
                            {stat.note}
                          </p>
                        )}
                      </div>

                      {LIVE_CHECK_MODULES.has(m.to) && stat.count === null && !stat.loading && (
                        <button
                          type="button"
                          onClick={() => runLiveCheck(m)}
                          className="w-full flex items-center justify-center gap-1.5 rounded border border-console-border text-console-text font-mono font-bold text-[10px] py-2 hover:border-console-green hover:text-console-green transition-colors cursor-pointer"
                        >
                          <RefreshCw className="size-3" /> RUN LIVE CHECK
                        </button>
                      )}

                      <Link
                        to={m.to}
                        onClick={() => setOpenModule(null)}
                        className="w-full flex items-center justify-center gap-1.5 rounded bg-console-green text-console-accent-foreground font-mono font-bold text-[10px] py-2 hover:bg-console-green/90 transition-colors"
                      >
                        <Maximize2 className="size-3" /> FULL SCREEN
                      </Link>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        </div>

        {/* Active Files & Monitored Entities */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-console-surface border-console-border">
            <CardHeader className="border-b border-console-border pb-3">
              <CardTitle className="text-sm font-mono text-console-text flex items-center justify-between">
                <span>ACTIVE INVESTIGATION DOSSIERS</span>
                <Badge
                  variant="outline"
                  className="text-[10px] font-mono border-console-border text-console-muted"
                >
                  {cases.length} Active Cases
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-2">
              {cases.slice(0, 4).map((c) => (
                <div
                  key={c.id}
                  className="p-3 rounded bg-console-deep border border-console-border flex items-center justify-between text-xs font-mono"
                >
                  <div>
                    <div className="text-console-green font-bold">
                      {c.id}: {c.title}
                    </div>
                    <div className="text-console-muted text-[10px] mt-0.5">
                      Target: {c.target} · {c.evidence?.length ?? 0} evidence item(s)
                    </div>
                  </div>
                  {/*
                    Was `{c.status || "OPEN"}` in a permanently red destructive
                    badge, so a Closed case rendered in the same alarm colour as
                    an Active one, and a case with no status displayed "OPEN" —
                    a state createInvestigation never assigns.
                  */}
                  <Badge
                    className={`border text-[10px] ${
                      c.status === "Closed"
                        ? "border-console-border bg-console-deep text-console-muted"
                        : c.status === "Triage"
                          ? "border-console-amber/30 bg-console-amber/10 text-console-amber"
                          : "border-console-green/30 bg-console-green/10 text-console-green"
                    }`}
                  >
                    {c.status ?? "status not set"}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="bg-console-surface border-console-border">
            <CardHeader className="border-b border-console-border pb-3">
              <CardTitle className="text-sm font-mono text-console-text flex items-center justify-between">
                <span>ACTIVE WATCHLISTS</span>
                <Badge
                  variant="outline"
                  className="text-[10px] font-mono border-console-border text-console-muted"
                >
                  {watchlists.length} Watchlists
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-2">
              {watchlists.slice(0, 4).map((w) => (
                <div
                  key={w.id}
                  className="p-3 rounded bg-console-deep border border-console-border flex items-center justify-between text-xs font-mono"
                >
                  <div>
                    <div className="text-console-blue font-bold">{w.name}</div>
                    <div className="text-console-muted text-[10px] mt-0.5">
                      {/* `|| "General"` rendered an empty filter as though it had a scope. */}
                      Keywords: {w.filters?.keywords?.join(", ") || "none set"}
                    </div>
                  </div>
                  {/*
                    This badge read "MONITORING", which contradicted both
                    /watchlists and /subjects: nothing runs on a schedule,
                    because the container scales to zero and there is no process
                    between requests to run one in. A filter is matched when an
                    analyst opens the page, and not before.
                  */}
                  <Badge className="border-console-border bg-console-deep text-[10px] text-console-muted">
                    FILTER
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
