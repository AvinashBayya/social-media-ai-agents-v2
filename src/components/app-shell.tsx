import { useState, useEffect, useRef, ReactNode } from "react";
import { useNavigate, useRouterState, Link } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Radio,
  Search,
  Users,
  Bookmark,
  Share2,
  Newspaper,
  Globe2,
  Image as ImageIcon,
  Video,
  UserSearch,
  Network,
  GitBranch,
  Clock,
  LineChart,
  TrendingUp,
  User,
  FileBarChart,
  Bell,
  ShieldAlert,
  Map,
  Database,
  Bot,
  Cpu,
  ListChecks,
  Download,
  Settings as SettingsIcon,
  Command as CommandIcon,
  Sparkles,
  ChevronDown,
  CircleUser,
  FolderLock,
  Radar,
  Youtube,
  UserCircle,
  Paperclip,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarProvider,
  SidebarTrigger,
  SidebarInset,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarNav, type NavGroup } from "@/components/sidebar-nav";
import { useDemoSession } from "@/components/demo-session";
import { useT } from "@/i18n/i18n-context";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getActiveTarget,
  setActiveTarget,
  getActiveTargetType,
  setActiveTargetType,
  getRecentTargets,
  TARGET_TYPES,
  type TargetType,
} from "@/utils/active-target";
import { getInvestigations } from "@/utils/investigations-store";
import { readGraphSnapshot } from "@/utils/graph-store";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FileProvenanceReportList, type FileProvenanceItem } from "@/components/file-provenance-report";
import { readFileProvenance, FILE_PROVENANCE_ACCEPT, FileProvenanceError } from "@/utils/file-provenance-client";
import { setFileHandoff } from "@/utils/file-handoff";
import {
  getEvidence,
  appendEvidence,
  buildFileEvidenceRecord,
  toStoredFileProvenance,
} from "@/utils/evidence-store";
import { sha256OfFile } from "@/utils/evidence";
import { toast } from "sonner";
import { getWatchlists } from "@/utils/watchlist-store";

/**
 * Grouped by the 5 PS-18 modules themselves (§6.1-6.5 — credibility, OSINT
 * content analysis, social content analysis, image/video analysis, report+GIS
 * output), not by build order. The previous "Module 1..5" labels were purely
 * chronological (Dashboard/Settings/Tasks landed first, so they were "Module
 * 1") and never actually corresponded to the problem statement's own module
 * numbering — sources.tsx's own PageHeader already says "PS-18 Module 1",
 * which is the real Module 1, and it was sitting in the old nav's "Module 2"
 * bucket. Every page that existed before still exists; only the grouping and
 * two previously-orphaned routes changed — see the two entries marked below.
 *
 * "Platform" holds what genuinely isn't module-specific: the landing
 * dashboard, session/account pages, the compliance console, and Subjects
 * (defines WHO/WHAT to investigate — an input to every module, not an
 * analysis of one specific content type).
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Platform",
    items: [
      { title: "Dashboard", to: "/", icon: LayoutDashboard },
      { title: "PS-18 Compliance", to: "/tasks", icon: ListChecks },
      { title: "Subjects", to: "/subjects", icon: Users },
      { title: "AI Assistant", to: "/agents", icon: Bot },
      { title: "Alert Centre", to: "/alerts", icon: Bell },
      // Previously reachable only by direct URL — no sidebar entry existed.
      { title: "Operator Profile", to: "/profile", icon: UserCircle },
      { title: "Settings", to: "/settings", icon: SettingsIcon },
    ],
  },
  {
    label: "Module 1 — Source Credibility",
    items: [
      { title: "Source Credibility", to: "/sources", icon: Database },
    ],
  },
  {
    label: "Module 2 — Open-Source Content",
    items: [
      { title: "OSINT Intelligence", to: "/osint", icon: Globe2 },
      { title: "Recon & Dorks", to: "/recon", icon: Radar },
      { title: "News Intelligence", to: "/news", icon: Newspaper },
      { title: "Entity Explorer", to: "/entities", icon: UserSearch },
      { title: "Timeline Explorer", to: "/timeline", icon: Clock },
      { title: "Trend Analytics", to: "/trends", icon: TrendingUp },
      { title: "Sentiment Analytics", to: "/sentiment", icon: LineChart },
      { title: "Threat Intel", to: "/threats", icon: ShieldAlert },
    ],
  },
  {
    label: "Module 3 — Social Media Content",
    items: [
      { title: "Social Intelligence", to: "/social", icon: Share2 },
      { title: "Live Monitoring", to: "/live", icon: Radio },
      { title: "Watchlists", to: "/watchlists", icon: Bookmark },
      { title: "Network Analysis", to: "/network", icon: GitBranch },
      { title: "Crawler Status", to: "/crawlers", icon: Cpu },
    ],
  },
  {
    label: "Module 4 — Image & Video Analysis",
    items: [
      { title: "Image Intelligence", to: "/images", icon: ImageIcon },
      { title: "Video Intelligence", to: "/videos", icon: Video },
      // Previously reachable only by direct URL — no sidebar entry existed.
      { title: "YouTube Intelligence", to: "/youtube", icon: Youtube },
    ],
  },
  {
    label: "Module 5 — Report & GIS Output",
    items: [
      { title: "Report Generator", to: "/reports", icon: FileBarChart },
      { title: "GIS Command Map", to: "/gis", icon: Map },
      { title: "Knowledge Graph", to: "/graph", icon: Network },
      { title: "AI Investigations", to: "/investigations", icon: Search },
      { title: "Evidence Vault", to: "/vault", icon: FolderLock },
      { title: "Exports", to: "/exports", icon: Download },
    ],
  },
];

function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const t = useT();
  return (
    <Sidebar collapsible="icon" className="border-r border-console-border bg-console-deep">
      <SidebarHeader className="border-b border-console-border bg-console-deep/50 py-3">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="grid size-8 place-items-center rounded bg-console-elevated text-console-cyan border border-console-border">
            <ShieldAlert className="size-4" />
          </div>
          <div className="flex flex-col leading-none group-data-[collapsible=icon]:hidden">
            <span
              data-no-translate
              className="text-xs font-bold uppercase tracking-wider text-console-text"
            >
              Sentinel AI
            </span>
            <span className="text-[9px] uppercase tracking-widest text-console-muted font-mono mt-0.5">
              {t("Defence Command Center")}
            </span>
          </div>
        </div>
        <div className="mx-2 mt-1.5 flex items-center justify-between rounded border border-console-border bg-console-surface px-2 py-1 text-[10px] text-console-muted font-mono group-data-[collapsible=icon]:hidden">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-console-live animate-pulse" />
            {t("Global Ops · Tier 1")}
          </span>
          <span className="text-console-blue font-bold">{t("Secure").toUpperCase()}</span>
        </div>
      </SidebarHeader>
      <SidebarContent className="bg-console-deep px-2 py-2">
        <SidebarNav groups={NAV_GROUPS} pathname={pathname} />
      </SidebarContent>
      <SidebarFooter className="border-t border-console-border bg-console-deep px-2 py-2">
        <LanguageSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}

/** One real, sourced candidate the search bar can suggest — never a guessed completion. */
interface TargetSuggestion {
  label: string;
  source: string;
}

/**
 * Every suggestion here traces to something the analyst actually has in
 * this browser: their own past searches, their own saved investigations,
 * their own watchlists' tracked people/orgs/domains. There is no free,
 * keyless "search suggestions" API to back a Google-style predictive list
 * honestly, so this is real history + real saved subjects, not an invented
 * completion list.
 */
function collectSuggestionPool(): TargetSuggestion[] {
  const pool: TargetSuggestion[] = [];
  for (const target of getRecentTargets()) pool.push({ label: target, source: "Recent" });
  for (const inv of getInvestigations() as any[]) {
    if (inv?.target) pool.push({ label: inv.target, source: "Investigation" });
  }
  // Every real, target-shaped field a watchlist tracks — not just
  // people/orgs/domains. `countries` and free-text `keywords` are filter
  // criteria, not things an analyst would type as a search target, so
  // those two stay out; everything else genuinely is a real subject.
  for (const wl of getWatchlists()) {
    for (const p of wl.filters.people) pool.push({ label: p, source: "Watchlist · Person" });
    for (const o of wl.filters.organizations) pool.push({ label: o, source: "Watchlist · Company" });
    for (const d of wl.filters.domains) pool.push({ label: d, source: "Watchlist · Domain" });
    for (const e of wl.filters.emails) pool.push({ label: e, source: "Watchlist · Email" });
    for (const ph of wl.filters.phones) pool.push({ label: ph, source: "Watchlist · Phone" });
    for (const s of wl.filters.socialAccounts) pool.push({ label: s, source: "Watchlist · Social" });
    for (const h of wl.filters.hashtags) pool.push({ label: h, source: "Watchlist · Topic" });
  }
  // Entities analysts have actually tagged onto pinned evidence — real
  // named subjects, not the evidence's own title/description text. Reads
  // the same "sentinel_evidence" key /vault uses (no exported reader
  // exists for it, same reason index.tsx reads it directly); seeded demo
  // records are excluded so a fictional entity never becomes a suggestion.
  try {
    const raw = localStorage.getItem("sentinel_evidence");
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || item.seeded) continue;
        for (const entity of Array.isArray(item.entities) ? item.entities : []) {
          if (typeof entity === "string" && entity.trim()) {
            pool.push({ label: entity, source: "Evidence entity" });
          }
        }
      }
    }
  } catch {
    // Evidence store unreadable/corrupt — suggestions just skip this source.
  }
  // Real entities from the last "View in Graph" hand-off.
  const snapshot = readGraphSnapshot();
  if (snapshot) {
    for (const e of snapshot.entities) {
      if (e.displayName?.trim()) pool.push({ label: e.displayName, source: "Graph entity" });
    }
  }
  return pool;
}

function TopBar() {
  const [timeStr, setTimeStr] = useState("");
  const [searchVal, setSearchVal] = useState("");
  const [activeTarget, setActiveTargetState] = useState("");
  const [targetType, setTargetType] = useState<TargetType | null>(null);
  const [suggestionPool, setSuggestionPool] = useState<TargetSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const navigate = useNavigate();
  const { session, signOut } = useDemoSession();

  // File provenance forensics — a Sheet, not a route, so it works from every
  // page with no File-serialization problem (localStorage can't hold a File).
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const [provenanceItems, setProvenanceItems] = useState<FileProvenanceItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [vaultSavedIds, setVaultSavedIds] = useState<Set<string>>(new Set());
  const provenanceOpenRef = useRef(false);
  provenanceOpenRef.current = provenanceOpen;

  const runFileProvenance = async (files: File[]) => {
    if (files.length === 0) return;
    setProvenanceOpen(true);
    const newItems: FileProvenanceItem[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file,
      status: "pending",
      report: null,
      error: null,
    }));
    setProvenanceItems((prev) => [...newItems, ...prev]);

    for (const item of newItems) {
      setProvenanceItems((prev) => prev.map((p) => (p.id === item.id ? { ...p, status: "running" } : p)));
      try {
        const report = await readFileProvenance(item.file);
        setProvenanceItems((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, status: "done", report } : p)),
        );
      } catch (err: any) {
        const message =
          err instanceof FileProvenanceError ? err.message : (err?.message ?? String(err));
        setProvenanceItems((prev) => prev.map((p) => (p.id === item.id ? { ...p, status: "failed", error: message } : p)));
      }
    }
  };

  const handleContinueInImageIntelligence = (item: FileProvenanceItem) => {
    setFileHandoff(item.file, "Global search bar — file provenance");
    setProvenanceOpen(false);
    navigate({ to: "/images" });
  };

  const handleAddProvenanceToVault = async (item: FileProvenanceItem) => {
    try {
      const hash = await sha256OfFile(item.file).catch(() => null);
      const existing = getEvidence();
      const record = buildFileEvidenceRecord({
        fileName: item.file.name,
        fileSize: item.file.size,
        hash,
        provenance: item.report ? toStoredFileProvenance(item.report) : null,
        provenanceExtractedAt: item.report?.extractedAt ?? null,
        typeLabel: item.report?.kind === "unsupported" ? "Document" : (item.report?.kind ?? "Document"),
        source: "Global search bar — file provenance forensics",
        existing,
      });
      appendEvidence(record);
      setVaultSavedIds((prev) => new Set(prev).add(item.id));
      toast.success(`Saved to Evidence Vault as ${record.id}. Bytes are not stored — only the hash and extracted metadata.`);
    } catch (err: any) {
      toast.error(`Could not save to Evidence Vault: ${err?.message ?? String(err)}`);
    }
  };

  const handleSignOut = () => {
    signOut();
    navigate({ to: "/login", replace: true });
  };

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(now.toISOString().replace("T", " ").substring(0, 19) + " UTC");
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);

    const initialTarget = getActiveTarget();
    setActiveTargetState(initialTarget);
    setSearchVal(initialTarget);
    setTargetType(getActiveTargetType());

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setActiveTargetState(e.detail);
        setSearchVal(e.detail);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Read via a ref, not a state dependency: this effect registers its
      // listeners once ([] deps) and adding provenanceOpen here would mean
      // re-subscribing on every open/close instead of just reading current
      // state at fire time.
      if (provenanceOpenRef.current) return; // the Sheet owns focus while it's open
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };

    window.addEventListener("sentinel_target_changed", handleTargetChange);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousedown", handleClickOutside);

    return () => {
      clearInterval(interval);
      window.removeEventListener("sentinel_target_changed", handleTargetChange);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Recomputed on focus (not just mount) so a newly-created investigation or
  // watchlist entry shows up without a full page reload.
  const refreshSuggestionPool = () => setSuggestionPool(collectSuggestionPool());

  // Ranked, not just filtered: a plain "contains anywhere" match on a short
  // query (e.g. one letter) matches almost every real candidate — "n" hit
  // "Chen", "Aviation Security" and "meridiancap.com" all at once, in pool
  // order, which reads as noise rather than "matched results." Real search
  // boxes rank a prefix match ("Northwind" for "n") far above a match
  // buried mid-string ("meridiaN"), so this does the same: whole-label
  // prefix first, then a prefix of any word inside the label, then a plain
  // substring anywhere — and that last, weakest tier only kicks in once the
  // query is long enough (3+ chars) that "contains" is actually meaningful.
  const matchedSuggestions = (() => {
    const q = searchVal.trim().toLowerCase();
    if (!q) return [];
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordPrefix = new RegExp(`\\b${escaped}`);
    const seen = new Set<string>();
    const ranked: { item: TargetSuggestion; rank: number }[] = [];
    for (const item of suggestionPool) {
      const key = item.label.toLowerCase();
      if (seen.has(key) || key === q) continue;
      let rank: number;
      if (key.startsWith(q)) rank = 0;
      else if (wordPrefix.test(key)) rank = 1;
      else if (q.length >= 3 && key.includes(q)) rank = 2;
      else continue;
      seen.add(key);
      ranked.push({ item, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank); // stable sort: ties keep pool order (Recent, then Investigation, then Watchlist)
    return ranked.slice(0, 8).map((r) => r.item);
  })();

  const selectSuggestion = (label: string) => {
    setSearchVal(label);
    setActiveTarget(label);
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions && matchedSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((i) => (i + 1) % matchedSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((i) => (i <= 0 ? matchedSuggestions.length - 1 : i - 1));
        return;
      }
      if (e.key === "Escape") {
        setShowSuggestions(false);
        setHighlightedIndex(-1);
        return;
      }
      if (e.key === "Enter" && highlightedIndex >= 0) {
        e.preventDefault();
        selectSuggestion(matchedSuggestions[highlightedIndex]!.label);
        return;
      }
    }
    if (e.key === "Enter") {
      setShowSuggestions(false);
      handleGlobalSearch();
    }
  };

  const handleGlobalSearch = () => {
    if (searchVal.trim()) {
      setActiveTarget(searchVal.trim());
    }
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

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-console-border bg-console-deep px-4 font-mono text-xs text-console-text">
      <div className="flex items-center gap-3">
        <SidebarTrigger className="text-console-muted hover:text-console-text border border-console-border bg-console-surface size-8 rounded" />

        <div className="hidden lg:flex items-center gap-2 border-r border-console-border pr-4 text-[11px]">
          <span className="text-console-muted">{t("System").toUpperCase()}:</span>
          <span className="flex items-center gap-1 font-bold text-console-live">
            <span className="size-1.5 rounded-full bg-console-live animate-pulse" />
            {t("Nominal").toUpperCase()}
          </span>
        </div>
      </div>

      {/* Global Target Acquisition Search Bar */}
      <div ref={searchBoxRef} className="flex items-center gap-1.5 flex-1 max-w-2xl mx-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Filter: what kind of target is this?"
              className="hidden sm:flex h-8 shrink-0 items-center gap-1 rounded border border-console-border bg-console-surface px-2 text-[10px] font-mono font-bold text-console-muted hover:border-console-green hover:text-console-green"
            >
              {targetType ? TARGET_TYPES.find((t) => t.value === targetType)!.label.toUpperCase() : "ALL TYPES"}
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="font-mono text-xs">
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
              Target type
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setTargetType(null);
                setActiveTargetType(null);
              }}
              className={!targetType ? "font-bold text-console-green" : ""}
            >
              All types
            </DropdownMenuItem>
            {TARGET_TYPES.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => {
                  setTargetType(opt.value);
                  setActiveTargetType(opt.value);
                }}
                className={targetType === opt.value ? "font-bold text-console-green" : ""}
              >
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          title="Attach a file — read its embedded provenance metadata. The file is never uploaded."
          onClick={() => fileInputRef.current?.click()}
          className="hidden sm:flex h-8 shrink-0 items-center justify-center rounded border border-console-border bg-console-surface px-2 text-console-muted hover:border-console-green hover:text-console-green"
        >
          <Paperclip className="size-3.5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={FILE_PROVENANCE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ""; // allow re-selecting the same file next time
            runFileProvenance(files);
          }}
        />

        <div
          className={`relative w-full flex items-center ${dragOver ? "ring-2 ring-console-green rounded" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragOver(false);
            runFileProvenance(Array.from(e.dataTransfer.files));
          }}
        >
          <Search className="absolute left-2.5 size-3.5 text-console-green" />
          <Input
            ref={inputRef}
            value={searchVal}
            onChange={(e) => {
              setSearchVal(e.target.value);
              setHighlightedIndex(-1);
              setShowSuggestions(true);
            }}
            onFocus={() => {
              refreshSuggestionPool();
              if (searchVal.trim()) setShowSuggestions(true);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder={t("Global Target Acquisition (Ctrl+K)...").toUpperCase()}
            className="h-8 pl-8 pr-36 bg-console-surface border-console-border text-xs font-mono text-console-text placeholder:text-console-label focus:border-console-green rounded"
            autoComplete="off"
            role="combobox"
            aria-expanded={showSuggestions && matchedSuggestions.length > 0}
            aria-autocomplete="list"
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
            <Button
              size="sm"
              onClick={() => {
                setShowSuggestions(false);
                handleGlobalSearch();
              }}
              className="h-6 px-2 text-[10px] font-mono bg-console-green hover:bg-console-green-hover text-console-accent-foreground font-bold rounded"
            >
              {t("Execute").toUpperCase()}
            </Button>
          </div>

          {/* Autocomplete — every entry is real: the analyst's own past
              searches, saved investigations, or watchlist-tracked subjects.
              Narrows as you type, like a search-suggestions dropdown, but
              nothing here is predicted or invented. */}
          {showSuggestions && matchedSuggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-72 overflow-y-auto rounded border border-console-border bg-console-surface shadow-xl">
              {matchedSuggestions.map((s, i) => (
                <button
                  key={`${s.source}-${s.label}-${i}`}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep input focus so the click isn't lost to blur
                    selectSuggestion(s.label);
                  }}
                  onMouseEnter={() => setHighlightedIndex(i)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] ${
                    i === highlightedIndex ? "bg-console-elevated text-console-green" : "text-console-text"
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    <Search className="size-3 shrink-0 text-console-label" />
                    <span className="truncate" data-no-translate>
                      {s.label}
                    </span>
                  </span>
                  <span className="shrink-0 text-[9px] uppercase tracking-wider text-console-label">
                    {s.source}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {activeTarget && (
          <Badge className="hidden md:flex items-center gap-1.5 bg-console-green/10 text-console-green border-console-green/30 font-mono text-[10px] shrink-0 h-7 px-2">
            <span className="size-1.5 rounded-full bg-console-green animate-ping" />
            {t("Target").toUpperCase()}: <span data-no-translate>{activeTarget.toUpperCase()}</span>
          </Badge>
        )}
      </div>

      {/* Live UTC Clock */}
      <div className="ml-auto hidden sm:flex items-center gap-3 text-[11px] font-mono text-console-muted border-r border-console-border pr-4 shrink-0">
        <span data-no-translate>{timeStr}</span>
      </div>

      <div className="flex items-center gap-2">
        {/*
          The bell had NO onClick and a permanently-lit, pulsing red dot — an
          unread-notification indicator on every route of the app, for an alert
          system that does not exist. It now navigates to the Alert Centre,
          which explains why nothing is alerting, and the dot is gone: there is
          nothing unread to indicate.
        */}
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="relative size-8 rounded border border-console-border bg-console-surface text-console-muted hover:text-console-text"
        >
          <Link to="/alerts" aria-label="Alert Centre">
            <Bell className="size-3.5" />
          </Link>
        </Button>

        <ThemeToggle />

        {/* Operator chip. Reflects the DEMO session (see utils/demo-session.ts)
            — it is a localStorage record, not an authenticated identity. Items
            that lead nowhere are rendered disabled rather than as live menu
            entries that silently do nothing. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-2 pr-2 border border-console-border bg-console-surface hover:bg-console-elevated text-console-text rounded"
            >
              <span className="grid size-5 place-items-center rounded bg-console-blue/10 text-console-blue border border-console-blue/20">
                <CircleUser className="size-3" />
              </span>
              <span className="hidden text-left leading-none sm:block" data-no-translate>
                <span className="block text-[10px] font-bold uppercase tracking-wider">
                  {session ? session.operator : "Not signed in"}
                </span>
              </span>
              <ChevronDown className="size-3 text-console-muted" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56 bg-console-surface border-console-border text-console-text rounded"
          >
            <DropdownMenuLabel className="text-[10px] font-bold text-console-muted uppercase font-mono">
              {t("Operations Command")}
            </DropdownMenuLabel>

            {session ? (
              <>
                <DropdownMenuItem
                  className="text-xs font-mono text-console-muted focus:bg-transparent"
                  data-no-translate
                >
                  {session.email}
                </DropdownMenuItem>
                <div className="px-2 pb-1.5 text-[9px] font-mono uppercase tracking-wider text-[#C79A3A]">
                  {t("Demo session — not authenticated")}
                </div>
                <DropdownMenuSeparator className="bg-console-border" />
                <DropdownMenuItem asChild className="text-xs hover:bg-console-elevated focus:bg-console-elevated">
                  <Link to="/profile">{t("Profile")}</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="text-xs hover:bg-console-elevated focus:bg-console-elevated">
                  <Link to="/settings">{t("Preferences")}</Link>
                </DropdownMenuItem>
                <DropdownMenuItem disabled className="text-xs opacity-50">
                  {t("Security Keys")}
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-console-border" />
                <DropdownMenuItem
                  onSelect={handleSignOut}
                  className="text-xs text-console-red hover:bg-console-red/10 focus:bg-console-red/10"
                >
                  {t("Log Out")}
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <div className="px-2 pb-1.5 text-[10px] font-mono text-console-label">
                  {t("No demo session")}
                </div>
                <DropdownMenuSeparator className="bg-console-border" />
                <DropdownMenuItem asChild className="text-xs hover:bg-console-elevated focus:bg-console-elevated">
                  <Link to="/login">{t("Sign in")}</Link>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Sheet open={provenanceOpen} onOpenChange={setProvenanceOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto bg-console-deep p-0 sm:max-w-2xl">
          <SheetHeader className="border-b border-console-border p-4 text-left">
            <SheetTitle className="flex items-center gap-2 text-console-text">
              <Paperclip className="size-4" /> File provenance forensics
            </SheetTitle>
            <SheetDescription className="text-console-label">
              PDF, Word, image and video files analysed entirely in this browser tab. Nothing is
              uploaded anywhere.
            </SheetDescription>
          </SheetHeader>
          <FileProvenanceReportList
            items={provenanceItems}
            onContinueInImageIntelligence={handleContinueInImageIntelligence}
            onAddToVault={handleAddProvenanceToVault}
            vaultSavedIds={vaultSavedIds}
          />
        </SheetContent>
      </Sheet>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <TopBar />
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  badge,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {badge}
        </div>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatusDot({
  tone = "success",
}: {
  tone?: "success" | "warning" | "danger" | "info" | "muted";
}) {
  const map: Record<string, string> = {
    success: "bg-console-live",
    warning: "bg-console-amber",
    danger: "bg-console-red",
    info: "bg-console-cyan",
    muted: "bg-console-muted/40",
  };
  return (
    <span className="relative inline-flex">
      <span className={`size-2 rounded-full ${map[tone]}`} />
      <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${map[tone]}`} />
    </span>
  );
}

export function toneBadge(
  tone:
    | "positive"
    | "negative"
    | "neutral"
    | "critical"
    | "high"
    | "medium"
    | "low"
    | "verified"
    | "unverified",
): {
  variant: "default" | "secondary" | "destructive" | "outline";
  className: string;
  label: string;
} {
  const map = {
    positive: {
      className: "bg-console-live/10 text-console-live border-console-live/20",
      label: "Positive",
    },
    negative: {
      className: "bg-console-red/10 text-console-red border-console-red/20",
      label: "Negative",
    },
    neutral: { className: "bg-console-elevated text-console-muted border-console-border", label: "Neutral" },
    critical: {
      className: "bg-console-red/15 text-console-red border-console-red/25",
      label: "Critical",
    },
    high: {
      className: "bg-console-amber/15 text-console-amber border-console-amber/25",
      label: "High",
    },
    medium: {
      className: "bg-console-blue/15 text-console-blue border-console-blue/25",
      label: "Medium",
    },
    low: {
      className: "bg-console-cyan/15 text-console-cyan border-console-cyan/25",
      label: "Low",
    },
    verified: {
      className: "bg-console-live/10 text-console-live border-console-live/20",
      label: "Verified",
    },
    unverified: { className: "bg-console-elevated text-console-muted border-console-border", label: "Unverified" },
  } as const;
  return { variant: "outline", ...map[tone] };
}

export function Tone({
  tone,
  children,
}: {
  tone: Parameters<typeof toneBadge>[0];
  children?: ReactNode;
}) {
  const t = toneBadge(tone);
  return (
    <Badge variant="outline" className={`font-medium ${t.className}`}>
      {children ?? t.label}
    </Badge>
  );
}
