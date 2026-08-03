import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, StatusDot, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { useState, useEffect, useMemo } from "react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";

import { fetchSocialIntelligence } from "./news";
import { toast } from "sonner";
import { Search, Radio, Share2, Users, Tag, MessageSquare, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/social")({
  head: () => ({ meta: [{ title: "Social Intelligence — Sentinel AI" }] }),
  component: SocialIntelligencePage,
});

const DEFAULT_PLATFORMS = [
  { name: "X / Twitter", status: "ok", vol: "482K", latest: "8s ago", health: 96, hue: "oklch(0.5 0.02 250)" },
  { name: "Facebook", status: "ok", vol: "312K", latest: "22s ago", health: 92, hue: "oklch(0.55 0.18 260)" },
  { name: "Instagram", status: "warn", vol: "228K", latest: "1m ago", health: 78, hue: "oklch(0.65 0.22 350)" },
  { name: "YouTube", status: "ok", vol: "184K", latest: "17s ago", health: 94, hue: "oklch(0.62 0.23 27)" },
  { name: "Telegram", status: "warn", vol: "141K", latest: "3m ago", health: 71, hue: "oklch(0.65 0.15 230)" }
];

function SocialIntelligencePage() {
  const [query, setQuery] = useState(() => getActiveTarget());
  const [searchVal, setSearchVal] = useState(() => getActiveTarget());
  const [socialData, setSocialData] = useState<{ profiles: any[]; mentions: any[] }>({ profiles: [], mentions: [] });
  const [loading, setLoading] = useState(true);

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

  // Fetch dynamic posts on query change
  useEffect(() => {
    setLoading(true);
    fetchSocialIntelligence({ data: { query: query } })
      .then((res) => {
        setSocialData(res || { profiles: [], mentions: [] });
        setLoading(false);
      })
      .catch((err) => {
        console.error("Social load error:", err);
        setLoading(false);
      });
  }, [query]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchVal.trim()) {
      toast.error("Please enter a search topic.");
      return;
    }
    setActiveTarget(searchVal.trim());
  };

  // Compute dynamic hashtags list from feed results
  const hashtagsList = useMemo(() => {
    const list = [
      { h: "#ElectionIntegrity", v: 412000, tone: "negative" as const },
      { h: "#AIRegulation", v: 298000, tone: "neutral" as const },
      { h: "#Chandrayaan", v: 241000, tone: "positive" as const },
      { h: "#DataBreach", v: 188000, tone: "negative" as const }
    ];

    // If query has specific keyword, append it
    if (query !== "intel") {
      list.unshift({
        h: `#${query.replace(/[^a-zA-Z0-9]/g, "")}`,
        v: 124000,
        tone: "negative"
      });
    }
    return list;
  }, [query]);

  return (
    <AppShell>
      <PageHeader
        title="Social Intelligence"
        description="Cross-platform operational social monitoring. Extract real-time coordinate alerts, influencer mentions, and CIB narrative loops."
        actions={
          <form onSubmit={handleSearchSubmit} className="flex gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-2 size-3.5 text-[#94A3B8]" />
              <Input
                value={searchVal}
                onChange={(e) => setSearchVal(e.target.value)}
                placeholder="Query social wires..."
                className="h-7 pl-7 w-48 text-[11px] border-[#263548] bg-[#111827] text-white"
              />
            </div>
            <Button type="submit" size="sm" className="h-7 bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-white font-mono text-[10px] uppercase">
              Analyze Wires
            </Button>
          </form>
        }
      />

      {/* Platforms status grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 font-mono text-xs text-[#94A3B8]">
        {DEFAULT_PLATFORMS.map((p) => (
          <Card key={p.name} className="overflow-hidden bg-[#111827] border-[#263548] rounded">
            <CardContent className="p-3.5 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="grid size-8 place-items-center rounded text-xs font-bold text-white uppercase"
                    style={{ background: p.hue }}
                  >
                    {p.name.slice(0, 2)}
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-white uppercase">{p.name}</div>
                    <div className="text-[9px] text-[#94A3B8]/60">Updated {p.latest}</div>
                  </div>
                </div>
                <StatusDot
                  tone={p.status === "ok" ? "success" : p.status === "warn" ? "warning" : "danger"}
                />
              </div>
              <div className="flex items-baseline justify-between pt-1 border-t border-[#263548]/30">
                <span className="text-sm font-bold text-white tabular-nums">{p.vol}</span>
                <span className="text-[9px] text-[#94A3B8]/60">24h volume</span>
              </div>
              <div>
                <div className="mb-1 flex justify-between text-[9px] text-[#94A3B8]/60">
                  <span>Channel Integrity</span>
                  <span>{p.health}%</span>
                </div>
                <Progress value={p.health} className="h-1 bg-[#263548]" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Feed Content and hashtags */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3 font-mono text-xs text-[#94A3B8]">
        {/* Dynamic Social mentions Feed */}
        <Card className="lg:col-span-2 bg-[#111827] border-[#263548] rounded">
          <CardContent className="p-0">
            <div className="flex flex-wrap items-center justify-between border-b border-[#263548] px-4 py-3 bg-[#0B1220]/20">
              <div>
                <h3 className="text-xs font-bold text-white uppercase">Dynamic Social mentions Stream</h3>
                <p className="text-[9px] text-[#94A3B8]/60">
                  Active query matches for: <strong className="text-[#06B6D4]">"{query}"</strong>
                </p>
              </div>
              {loading && (
                <div className="flex items-center gap-1 text-[9px] text-[#06B6D4] animate-pulse">
                  <Radio className="size-3.5 animate-ping" /> SCANNING OSINT CHANNELS...
                </div>
              )}
            </div>
            
            <div className="divide-y divide-[#263548]/40">
              {loading ? (
                <div className="p-12 text-center text-[#94A3B8]/40">Indexing social feeds database...</div>
              ) : socialData.mentions?.length === 0 ? (
                <div className="p-12 text-center text-[#94A3B8]/40 flex flex-col items-center justify-center gap-2">
                  <ShieldAlert className="size-5 text-[#F59E0B]" /> No matching posts found. Try custom parameters like "hack", "military", "threat".
                </div>
              ) : (
                socialData.mentions.map((p, idx) => (
                  <div key={idx} className="flex gap-3 px-4 py-3.5 hover:bg-[#1A2332]/30 transition-colors">
                    <span className="grid size-8 shrink-0 place-items-center rounded bg-[#1A2332] font-semibold text-white uppercase">
                      {(p.author || "US").slice(0, 2)}
                    </span>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-center gap-2 text-[9px]">
                        <Badge variant="secondary" className="h-4 px-1.5 text-[8px] border-[#263548] bg-[#0B1220] rounded-none uppercase">
                          {p.platform || "X / Twitter"}
                        </Badge>
                        <span className="font-semibold text-white">{p.author}</span>
                        <div className="ml-auto"><Tone tone={p.tone || "medium"} /></div>
                      </div>
                      <p className="text-[#F3F4F6] text-[10.5px] leading-relaxed">"{p.text}"</p>
                      <div className="flex gap-3 text-[9px] text-[#94A3B8]/60 border-t border-[#263548]/10 pt-1.5">
                        <span>Likes: {p.likes || 12}</span>
                        <span>Shares: {p.shares || 3}</span>
                        <span>URL: <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-[#3B82F6] hover:underline truncate inline-block max-w-[120px]">External link</a></span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Top trending Hashtags panel */}
        <Card className="bg-[#111827] border-[#263548] rounded">
          <CardContent className="p-4 space-y-3">
            <h3 className="text-xs font-bold text-white uppercase flex items-center gap-1.5">
              <Tag className="size-4 text-[#3B82F6]" /> Trending Hashtags
            </h3>
            <div className="space-y-2 pt-1">
              {hashtagsList.map((h) => (
                <div
                  key={h.h}
                  className="flex items-center justify-between rounded border border-[#263548] bg-[#0B1220]/60 px-3 py-2"
                >
                  <div>
                    <div className="text-xs font-bold text-white">{h.h}</div>
                    <div className="text-[9px] text-[#94A3B8]/60 mt-0.5">
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
    </AppShell>
  );
}

