import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { AppShell, PageHeader, StatusDot } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { getInvestigations } from "@/utils/investigations-store";
import { getWatchlists } from "@/utils/watchlist-store";
import { llmExecutiveBrief } from "@/utils/llm";
import {
  Search, Globe2, Share2, Newspaper, Network, GitBranch, Clock,
  UserSearch, LineChart, TrendingUp, ImageIcon, Video, FolderLock,
  FileBarChart, ShieldAlert, Map, Bot, ListChecks, ArrowUpRight,
  Sparkles, RefreshCw, Activity, Terminal, ExternalLink, CheckCircle2
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Command Hub — Sentinel AI" },
      { name: "description", content: "Tactical Operations Command Hub for Open Source Intelligence (OSINT)." },
    ],
  }),
  component: CommandHub,
});

// Quick-nav intelligence modules grid definition
const MODULE_CARDS = [
  { title: "News Intelligence", to: "/news", icon: Newspaper, color: "text-[#3B82F6]", border: "hover:border-[#3B82F6]/50", desc: "Live Google News RSS, outlet cross-verification & bias rating" },
  { title: "OSINT Intelligence", to: "/osint", icon: Globe2, color: "text-[#10B981]", border: "hover:border-[#10B981]/50", desc: "WHOIS / RDAP, Cloudflare DoH DNS resolution & GitHub repo search" },
  { title: "Social Intelligence", to: "/social", icon: Share2, color: "text-[#EC4899]", border: "hover:border-[#EC4899]/50", desc: "Wikidata profile lookup, CIB bot scoring & narrative tracking" },
  { title: "GIS Command Map", to: "/gis", icon: Map, color: "text-[#F59E0B]", border: "hover:border-[#F59E0B]/50", desc: "Interactive Leaflet geospatial threat map & regional density" },
  { title: "Knowledge Graph", to: "/graph", icon: Network, color: "text-[#8B5CF6]", border: "hover:border-[#8B5CF6]/50", desc: "Entity relationship topology & node-edge correlation network" },
  { title: "Timeline Explorer", to: "/timeline", icon: Clock, color: "text-[#06B6D4]", border: "hover:border-[#06B6D4]/50", desc: "Chronological event chain mapping & case timeline scrubber" },
  { title: "Entity Explorer", to: "/entities", icon: UserSearch, color: "text-[#EAB308]", border: "hover:border-[#EAB308]/50", desc: "Target identity profiling, alias discovery & network footprint" },
  { title: "Image Intelligence", to: "/images", icon: ImageIcon, color: "text-[#A855F7]", border: "hover:border-[#A855F7]/50", desc: "OCR text extraction, EXIF metadata & deepfake likelihood scoring" },
  { title: "Video Intelligence", to: "/videos", icon: Video, color: "text-[#EF4444]", border: "hover:border-[#EF4444]/50", desc: "Frame-by-frame object detection, face count & transcript analysis" },
  { title: "AI Investigations", to: "/investigations", icon: Search, color: "text-[#10B981]", border: "hover:border-[#10B981]/50", desc: "Active investigation case dossiers & threat containment workflow" },
  { title: "Evidence Vault", to: "/vault", icon: FolderLock, color: "text-[#6366F1]", border: "hover:border-[#6366F1]/50", desc: "Pinned intelligence assets & forensic evidence repository" },
  { title: "AI Intelligence Assistant", to: "/agents", icon: Bot, color: "text-[#3B82F6]", border: "hover:border-[#3B82F6]/50", desc: "Open-weight LLM analysis & report compiler" },
];

function CommandHub() {
  const [activeTarget, setActiveTargetState] = useState("GOOGLE.COM");
  const [inputVal, setInputVal] = useState("GOOGLE.COM");
  const [cases, setCases] = useState<any[]>([]);
  const [watchlists, setWatchlists] = useState<any[]>([]);
  
  // Executive briefing state (open-weight LLM)
  const [aiBriefing, setAiBriefing] = useState<string>("");
  const [briefModel, setBriefModel] = useState<string>("");
  const [briefError, setBriefError] = useState<string>("");
  const [loadingBrief, setLoadingBrief] = useState(false);

  useEffect(() => {
    setCases(getInvestigations());
    setWatchlists(getWatchlists());
  }, []);

  // Sync with global target search
  useEffect(() => {
    const target = getActiveTarget();
    setActiveTargetState(target);
    setInputVal(target);
    fetchAiBrief(target);

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setActiveTargetState(e.detail);
        setInputVal(e.detail);
        fetchAiBrief(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  const fetchAiBrief = async (targetStr: string) => {
    if (typeof window === "undefined") return;
    setLoadingBrief(true);
    setBriefError("");
    setAiBriefing("");
    try {
      const res = await llmExecutiveBrief({
        data: {
          target: targetStr,
          context: `Target acquisition search initiated for ${targetStr}. Provide an automated threat briefing summarizing risk profile, digital footprint, and strategic containment guidance.`
        }
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

  return (
    <AppShell>
      <PageHeader
        title="Tactical Operations Command Hub"
        description="Unified AI intelligence acquisition engine. Search any corporate entity, digital handle, domain footprint, or tactical threat topic to activate cross-module intelligence pipelines."
      />

      <div className="p-6 space-y-6">
        {/* Top Target Acquisition Bar */}
        <Card className="bg-[#111827] border-[#263548] p-6 shadow-xl">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Badge className="bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 font-mono text-xs px-2.5 py-1">
                  <span className="size-1.5 rounded-full bg-[#10B981] animate-ping mr-1.5" />
                  ACTIVE TARGET: {activeTarget.toUpperCase()}
                </Badge>
                <span className="text-xs font-mono text-[#94A3B8]">
                  CLASSIFICATION: <span className="text-[#F3F4F6] font-bold">UNCLASSIFIED // DEMONSTRATOR</span>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchAiBrief(activeTarget)}
                className="h-8 gap-2 border-[#263548] text-xs font-mono text-[#94A3B8] hover:text-[#F3F4F6]"
              >
                <RefreshCw className={`size-3.5 ${loadingBrief ? "animate-spin" : ""}`} />
                Refresh AI Brief
              </Button>
            </div>

            <form onSubmit={handleSearchSubmit} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-[#10B981]" />
                <Input
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  placeholder="INPUT TARGET PARAMETER (Company, Domain, Person, Hashtag, Threat Keyword)..."
                  className="h-11 pl-10 bg-[#0B1220] border-[#263548] text-sm font-mono text-[#F3F4F6] placeholder:text-[#64748B] focus:border-[#10B981] rounded-lg"
                />
              </div>
              <Button type="submit" className="h-11 px-6 bg-[#10B981] hover:bg-[#059669] text-black font-bold font-mono text-xs rounded-lg">
                EXECUTE ACQUISITION
              </Button>
            </form>

            <div className="flex flex-wrap gap-2 text-xs font-mono text-[#94A3B8] items-center">
              <span className="text-[10px] text-[#64748B] uppercase">Quick Presets:</span>
              {["Tesla", "OpenAI", "google.com", "Elon Musk", "#ElectionIntegrity", "Cyber Attack"].map((preset) => (
                <button
                  key={preset}
                  onClick={() => {
                    setInputVal(preset);
                    setActiveTarget(preset);
                  }}
                  className="px-2.5 py-1 rounded bg-[#0B1220] border border-[#263548] hover:border-[#10B981] hover:text-[#10B981] transition-colors text-[11px]"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </Card>

        {/*
          Executive triage metrics.

          These four tiles previously displayed 85% / 68 / -12 / 148 as constants
          — they were never computed from anything and did not change with the
          target. Aggregate scoring across modules is not implemented, so they
          report no value rather than a confident-looking invented one.

          Source credibility IS scored for real, per article, on /sources.
        */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { label: "Confidence Score", why: "No aggregate confidence model implemented." },
            { label: "Overall Threat Risk", why: "No cross-module risk aggregation implemented." },
            { label: "Public Sentiment", why: "Sentiment is not computed over collected data." },
            { label: "Evidence Collected", why: "Evidence store is local-only and uncounted." },
          ].map((m) => (
            <Card key={m.label} className="bg-[#111827] border-[#263548] p-4">
              <div className="text-[10px] font-mono text-[#94A3B8] uppercase">{m.label}</div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-[#64748B]">—</span>
                <span className="text-[10px] font-mono text-[#64748B] font-bold">NOT MEASURED</span>
              </div>
              <p className="mt-3 text-[9px] font-mono leading-relaxed text-[#64748B]">{m.why}</p>
            </Card>
          ))}
        </div>

        {/* AI Briefing & Strategic Recommendations */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 bg-[#111827] border-[#263548]">
            <CardHeader className="border-b border-[#263548] pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-mono flex items-center gap-2 text-[#F3F4F6]">
                  <Bot className="size-4 text-[#10B981]" />
                  EXECUTIVE AI BRIEFING
                </CardTitle>
                <Badge className="bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 font-mono text-[10px]">
                  LIVE GENERATION
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              {loadingBrief ? (
                <div className="space-y-2 py-6 text-center text-xs font-mono text-[#94A3B8]">
                  <RefreshCw className="size-5 animate-spin mx-auto text-[#10B981]" />
                  <p>Querying the configured LLM for a target intelligence brief...</p>
                </div>
              ) : briefError ? (
                <div className="rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-3">
                  <div className="text-xs font-mono font-bold text-[#EF4444]">AI unavailable</div>
                  <p className="mt-1 text-[10px] font-mono leading-relaxed text-[#EF4444]/80">
                    No briefing was produced. {briefError}
                  </p>
                </div>
              ) : aiBriefing ? (
                <>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">
                    AI-generated · {briefModel}
                  </div>
                  <div className="text-xs font-mono text-[#CBD5E1] whitespace-pre-wrap leading-relaxed">
                    {aiBriefing}
                  </div>
                </>
              ) : (
                <p className="py-6 text-center text-xs font-mono text-[#64748B]">
                  No briefing generated yet.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="bg-[#111827] border-[#263548]">
            <CardHeader className="border-b border-[#263548] pb-3">
              {/*
                These three were static strings with the target interpolated in.
                Nothing generated them and they never varied, so presenting them
                as machine-derived analysis was false. Relabelled as the fixed
                procedural checklist they actually are.
              */}
              <CardTitle className="text-sm font-mono flex items-center gap-2 text-[#F3F4F6]">
                <Sparkles className="size-4 text-[#64748B]" />
                STANDARD ANALYST CHECKLIST
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <p className="text-[10px] font-mono leading-relaxed text-[#64748B]">
                A fixed procedural checklist, not generated analysis.
              </p>
              {[
                "Run OSINT enumeration on infrastructure associated with the target.",
                "Configure volume-threshold alerting on social mentions.",
                "Track WHOIS and DNS history to detect domain changes.",
              ].map((step, i) => (
                <div
                  key={i}
                  className="p-3 rounded bg-[#0B1220] border border-[#263548] text-xs font-mono space-y-1"
                >
                  <span className="text-[#94A3B8] font-bold">STEP_0{i + 1}:</span>
                  <p className="text-[#94A3B8]">{step}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Specialized Intelligence Modules Directory */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-mono font-bold text-[#F3F4F6] uppercase tracking-wider flex items-center gap-2">
              <Activity className="size-4 text-[#10B981]" />
              Specialized Intelligence Modules (Target Context Active)
            </h2>
            <span className="text-xs font-mono text-[#94A3B8]">12 Operational Suites Ready</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {MODULE_CARDS.map((m) => {
              const Icon = m.icon;
              return (
                <Link
                  key={m.to}
                  to={m.to}
                  className={`p-4 rounded-lg bg-[#111827] border border-[#263548] ${m.border} transition-all group flex flex-col justify-between`}
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="p-2 rounded bg-[#0B1220] border border-[#263548]">
                        <Icon className={`size-4 ${m.color}`} />
                      </div>
                      <ArrowUpRight className="size-4 text-[#64748B] group-hover:text-[#F3F4F6] transition-colors" />
                    </div>
                    <div>
                      <h3 className="text-xs font-mono font-bold text-[#F3F4F6] group-hover:text-[#10B981] transition-colors">
                        {m.title}
                      </h3>
                      <p className="text-[11px] text-[#94A3B8] leading-normal mt-1">{m.desc}</p>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-[#263548] flex items-center justify-between text-[10px] font-mono text-[#64748B]">
                    <span>QUERY: {activeTarget}</span>
                    <span className="text-[#10B981] font-bold group-hover:underline">OPEN MODULE →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Active Files & Monitored Entities */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-[#111827] border-[#263548]">
            <CardHeader className="border-b border-[#263548] pb-3">
              <CardTitle className="text-sm font-mono text-[#F3F4F6] flex items-center justify-between">
                <span>ACTIVE INVESTIGATION DOSSIERS</span>
                <Badge variant="outline" className="text-[10px] font-mono border-[#263548] text-[#94A3B8]">
                  {cases.length} Active Cases
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-2">
              {cases.slice(0, 4).map((c) => (
                <div key={c.id} className="p-3 rounded bg-[#0B1220] border border-[#263548] flex items-center justify-between text-xs font-mono">
                  <div>
                    <div className="text-[#10B981] font-bold">{c.id}: {c.title}</div>
                    <div className="text-[#94A3B8] text-[10px] mt-0.5">Target: {c.target} · {c.evidence?.length ?? 0} evidence item(s)</div>
                  </div>
                  <Badge className="bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/30 text-[10px]">
                    {c.status || "OPEN"}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="bg-[#111827] border-[#263548]">
            <CardHeader className="border-b border-[#263548] pb-3">
              <CardTitle className="text-sm font-mono text-[#F3F4F6] flex items-center justify-between">
                <span>ACTIVE WATCHLISTS</span>
                <Badge variant="outline" className="text-[10px] font-mono border-[#263548] text-[#94A3B8]">
                  {watchlists.length} Watchlists
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-2">
              {watchlists.slice(0, 4).map((w) => (
                <div key={w.id} className="p-3 rounded bg-[#0B1220] border border-[#263548] flex items-center justify-between text-xs font-mono">
                  <div>
                    <div className="text-[#3B82F6] font-bold">{w.name}</div>
                    <div className="text-[#94A3B8] text-[10px] mt-0.5">Keywords: {w.filters?.keywords?.join(", ") || "General"}</div>
                  </div>
                  <Badge className="bg-[#3B82F6]/10 text-[#3B82F6] border-[#3B82F6]/30 text-[10px]">
                    MONITORING
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