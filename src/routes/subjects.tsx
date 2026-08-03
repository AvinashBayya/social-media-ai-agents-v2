import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone, StatusDot } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { fetchNews, fetchSocialIntelligence } from "./news";
import { fetchCyberThreats, fetchTelegramOSINT } from "./osint";
import {
  getWatchlists,
  createWatchlist,
  deleteWatchlist,
  getWatchlistMatches,
  type Watchlist,
  type WatchlistMatch
} from "@/utils/watchlist-store";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from "recharts";
import {
  Users2,
  Plus,
  RefreshCw,
  AlertTriangle,
  Clock,
  TrendingUp,
  Tag,
  Globe2,
  Trash2,
  ShieldAlert,
  Terminal,
  Activity
} from "lucide-react";

export const Route = createFileRoute("/subjects")({
  head: () => ({ meta: [{ title: "Watchlists / Subjects — Sentinel AI" }] }),
  component: SubjectsPage,
});

function SubjectsPage() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [loadingFeeds, setLoadingFeeds] = useState(true);

  // Form states
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [kws, setKws] = useState("");
  const [orgs, setOrgs] = useState("");
  const [peop, setPeop] = useState("");
  const [countries, setCountries] = useState("");
  const [doms, setDoms] = useState("");
  const [socials, setSocials] = useState("");

  // Feeds cache state for real correlation
  const [newsStories, setNewsStories] = useState<any[]>([]);
  const [socialMentions, setSocialMentions] = useState<any[]>([]);
  const [telegramPosts, setTelegramPosts] = useState<any[]>([]);
  const [cyberThreats, setCyberThreats] = useState<any[]>([]);

  // Load lists and fetch raw feeds data on mount
  useEffect(() => {
    const list = getWatchlists();
    setWatchlists(list);
    if (list.length > 0) {
      setSelectedWatchlistId(list[0].id);
    }

    // Load active intelligence feeds in background to run dynamic watchlist matching
    Promise.all([
      fetchNews({ data: { query: "intel", q: "intel" } }),
      fetchSocialIntelligence({ data: { query: "threat", q: "threat" } }),
      fetchCyberThreats({ data: { query: "c2" } }),
      fetchTelegramOSINT({ data: { query: "OSINT" } })
    ]).then(([newsRes, socialRes, cyberRes, telegramRes]) => {
      setNewsStories(newsRes?.stories || []);
      setSocialMentions(socialRes?.mentions || []);
      setCyberThreats(cyberRes || []);
      setTelegramPosts(telegramRes || []);
      setLoadingFeeds(false);
    }).catch(err => {
      console.error(err);
      setLoadingFeeds(false);
    });
  }, []);

  const refreshWatchlistsList = () => {
    const list = getWatchlists();
    setWatchlists(list);
  };

  const handleCreateWatchlist = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Please provide a watchlist name.");
      return;
    }

    const filters = {
      keywords: kws.split(",").map(k => k.trim()).filter(Boolean),
      organizations: orgs.split(",").map(k => k.trim()).filter(Boolean),
      people: peop.split(",").map(k => k.trim()).filter(Boolean),
      countries: countries.split(",").map(k => k.trim()).filter(Boolean),
      domains: doms.split(",").map(k => k.trim()).filter(Boolean),
      emails: [],
      phones: [],
      hashtags: kws.split(",").map(k => `#${k.trim()}`).filter(Boolean),
      socialAccounts: socials.split(",").map(k => k.startsWith("@") ? k.trim() : `@${k.trim()}`).filter(Boolean)
    };

    const newWatch = createWatchlist(name, desc, filters);
    toast.success(`Watchlist "${newWatch.name}" configured.`);
    
    // Reset Form
    setName("");
    setDesc("");
    setKws("");
    setOrgs("");
    setPeop("");
    setCountries("");
    setDoms("");
    setSocials("");
    setShowCreateForm(false);
    
    // Refresh & Select
    const list = getWatchlists();
    setWatchlists(list);
    setSelectedWatchlistId(newWatch.id);
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteWatchlist(id);
    toast.success("Watchlist removed.");
    const list = getWatchlists();
    setWatchlists(list);
    if (list.length > 0) {
      setSelectedWatchlistId(list[0].id);
    } else {
      setSelectedWatchlistId("");
    }
  };

  const activeWatchlist = watchlists.find(w => w.id === selectedWatchlistId) || watchlists[0];

  // Dynamic matches calculated on active watchlist + feeds
  const matches = useMemo(() => {
    if (!activeWatchlist) return [];
    return getWatchlistMatches(activeWatchlist, {
      stories: newsStories,
      socialMentions: socialMentions,
      cyberThreats: cyberThreats,
      telegramPosts: telegramPosts
    });
  }, [activeWatchlist, newsStories, socialMentions, cyberThreats, telegramPosts]);

  // Critical alerts (severity = high or critical)
  const criticalAlerts = useMemo(() => {
    return matches.filter(m => m.severity === "high" || m.severity === "critical");
  }, [matches]);

  // Generate chart mock trend points based on match density
  const chartData = useMemo(() => {
    const hours = ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
    const baseVal = matches.length > 0 ? matches.length : 5;
    return hours.map((h, idx) => ({
      hour: h,
      threats: Math.max(2, Math.round(baseVal * 0.4 + (idx * 2) % 5)),
      scans: Math.round(150 + idx * 12 + (idx * idx * 3) % 25)
    }));
  }, [matches]);

  return (
    <AppShell>
      <PageHeader
        title="Watchlists / Subjects"
        description="Configure entity target filters and monitor real-time correlation matches across GDELT, social streams, and threat telemetry."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => refreshWatchlistsList()} className="font-mono text-xs gap-1.5 border-[#263548] text-[#94A3B8] hover:bg-[#1A2332]">
              <RefreshCw className="size-3.5" /> Reload Filters
            </Button>
            <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)} className="gap-1.5 font-mono text-xs bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-white">
              <Plus className="size-3.5" /> Configure Watchlist
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[300px_1fr] font-mono text-xs text-[#94A3B8]">
        {/* Left Side Column: Watchlists & Creation Form */}
        <div className="space-y-4">
          {showCreateForm && (
            <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-[#3B82F6]" />
              <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#06B6D4]">New Intelligence Filter</CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <form onSubmit={handleCreateWatchlist} className="space-y-3 text-[10px]">
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Watchlist Name</label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Project-X Monitor" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Description</label>
                    <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Brief monitor scope..." className="min-h-12 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Keywords</label>
                    <Input value={kws} onChange={(e) => setKws(e.target.value)} placeholder="leak, surveillance, drone" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Target Organizations</label>
                    <Input value={orgs} onChange={(e) => setOrgs(e.target.value)} placeholder="Tesla, OpenAI" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Monitored People</label>
                    <Input value={peop} onChange={(e) => setPeop(e.target.value)} placeholder="Musk, Altman" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Focus Countries</label>
                    <Input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="Iran, Russia, Germany" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Domains / C2 Server IPs</label>
                    <Input value={doms} onChange={(e) => setDoms(e.target.value)} placeholder="feodotracker.abuse.ch" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[#94A3B8] uppercase">Social Handles</label>
                    <Input value={socials} onChange={(e) => setSocials(e.target.value)} placeholder="@osint_watch, @OSINTdefender" className="h-7 text-[10px] border-[#263548] bg-[#0B1220] text-white" />
                  </div>
                  <div className="flex gap-2 pt-1.5">
                    <Button type="submit" size="sm" className="h-7 bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-white font-mono text-[9px] uppercase px-2">Save</Button>
                    <Button type="button" onClick={() => setShowCreateForm(false)} variant="outline" className="h-7 text-[9px] font-mono border-[#263548] text-[#94A3B8] hover:bg-[#1A2332] px-2 uppercase">Cancel</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          <Card className="bg-[#111827] border-[#263548] rounded">
            <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/20">
              <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#94A3B8]">
                <Users2 className="size-4 text-[#3B82F6]" /> Watchlist Filters
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 p-2 max-h-[70vh] overflow-y-auto">
              {watchlists.map((w) => {
                const isActive = w.id === selectedWatchlistId;
                return (
                  <div
                    key={w.id}
                    onClick={() => setSelectedWatchlistId(w.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setSelectedWatchlistId(w.id); }}
                    className={`w-full rounded border px-3 py-2 text-left transition text-[10px] flex items-center justify-between cursor-pointer ${isActive ? "border-[#3B82F6]/50 bg-[#3B82F6]/10 text-white" : "border-[#263548]/40 bg-[#111827] text-[#94A3B8] hover:bg-[#1A2332]"}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-white uppercase tracking-wide truncate">{w.name}</div>
                      <div className="text-[8px] text-[#94A3B8]/60 truncate mt-0.5">{w.description}</div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => handleDelete(w.id, e)}
                      className="text-red-500 hover:text-red-400 p-1 size-6 shrink-0 ml-2"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>

        {/* Watchlist Dashboard Content */}
        {activeWatchlist ? (
          <div className="space-y-4">
            {/* Topbar Info Card */}
            <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-[#06B6D4]" />
              <CardContent className="p-4 flex flex-wrap justify-between items-center gap-4">
                <div className="space-y-1 min-w-[280px]">
                  <div className="text-[10px] text-[#94A3B8]/60 flex items-center gap-2">
                    <span className="font-bold text-[#06B6D4]">MONITORING ACTIVE</span>
                    <span>·</span>
                    <span>CREATED: {new Date(activeWatchlist.createdAt).toLocaleDateString()}</span>
                  </div>
                  <h2 className="text-sm font-bold text-white uppercase tracking-wide">{activeWatchlist.name}</h2>
                  <p className="text-[10px] text-[#94A3B8]">{activeWatchlist.description}</p>
                </div>
                {loadingFeeds && (
                  <div className="flex items-center gap-1.5 text-[9px] text-[#06B6D4]">
                    <RefreshCw className="size-3.5 animate-spin" /> CORRELATING LIVE FEEDS...
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Dashboard Telemetry row */}
            <div className="grid gap-4 sm:grid-cols-4">
              <Card className="bg-[#111827] border-[#263548] p-3 text-center">
                <span className="text-[8px] uppercase text-[#94A3B8]">Correlated Matches</span>
                <div className="text-xl font-bold text-white mt-1 font-mono">{matches.length}</div>
              </Card>
              <Card className="bg-[#111827] border-[#263548] p-3 text-center">
                <span className="text-[8px] uppercase text-[#EF4444]">Threat Alerts</span>
                <div className="text-xl font-bold text-[#EF4444] mt-1 font-mono">{criticalAlerts.length}</div>
              </Card>
              <Card className="bg-[#111827] border-[#263548] p-3 text-center">
                <span className="text-[8px] uppercase text-[#06B6D4]">Growth Rate</span>
                <div className="text-xl font-bold text-[#06B6D4] mt-1 font-mono">+{matches.length > 3 ? Math.round(matches.length * 1.5) : 8}%</div>
              </Card>
              <Card className="bg-[#111827] border-[#263548] p-3 text-center">
                <span className="text-[8px] uppercase text-[#F59E0B]">Risk Index</span>
                <div className="text-xl font-bold text-[#F59E0B] mt-1 font-mono">{activeWatchlist.riskScore}/100</div>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              {/* Trend graph */}
              <Card className="bg-[#111827] border-[#263548] rounded lg:col-span-2">
                <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/20">
                  <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#94A3B8]">
                    <TrendingUp className="size-4 text-[#3B82F6]" /> Activity Scanner Pulse
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-6 h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="colorThreats" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#EF4444" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#EF4444" stopOpacity={0}/>
                        </linearGradient>
                        <linearGradient id="colorScans" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#3B82F6" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#263548" opacity={0.3} />
                      <XAxis dataKey="hour" stroke="#94A3B8" fontSize={9} />
                      <YAxis stroke="#94A3B8" fontSize={9} />
                      <Tooltip contentStyle={{ backgroundColor: "#111827", borderColor: "#263548", fontSize: 10 }} />
                      <Area type="monotone" dataKey="threats" name="Threat Matches" stroke="#EF4444" fillOpacity={1} fill="url(#colorThreats)" />
                      <Area type="monotone" dataKey="scans" name="Total Scans" stroke="#3B82F6" fillOpacity={1} fill="url(#colorScans)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Activity Timeline */}
              <Card className="bg-[#111827] border-[#263548] rounded lg:col-span-1">
                <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/20">
                  <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#94A3B8]">
                    <Clock className="size-4 text-[#3B82F6]" /> Activity Timeline
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 space-y-3 max-h-60 overflow-y-auto">
                  {matches.slice(0, 4).map((m, idx) => (
                    <div key={idx} className="relative pl-4 border-l border-[#263548] pb-1">
                      <span className="absolute left-[-4px] top-1 size-2 rounded-full bg-[#3B82F6]" />
                      <div className="flex justify-between items-center text-[8px] text-[#94A3B8]/60">
                        <span>{new Date(m.date).toLocaleTimeString()}</span>
                        <Tone tone={m.severity} />
                      </div>
                      <p className="text-white text-[9px] mt-0.5 leading-snug truncate">Match hit: "{m.matchValue}" in {m.source}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            {/* Recent Matches */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/20">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#94A3B8]">
                  <Activity className="size-4 text-[#3B82F6]" /> Recent Matches
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-left border-collapse text-[10px]">
                  <thead>
                    <tr className="border-b border-[#263548] bg-[#0B1220]/40 text-[#94A3B8] font-bold uppercase">
                      <th className="p-3">Trigger Entity</th>
                      <th className="p-3">Trigger Type</th>
                      <th className="p-3">Match Source</th>
                      <th className="p-3">Content Snippet</th>
                      <th className="p-3 text-right">Severity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#263548]/30">
                    {matches.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-[#94A3B8]/40">No matching search hits found. Ensure target crawler indices are active.</td>
                      </tr>
                    ) : (
                      matches.map((m) => (
                        <tr key={m.id} className="hover:bg-[#1A2332]/40 text-[#94A3B8]">
                          <td className="p-3 font-semibold text-white uppercase">{m.matchValue}</td>
                          <td className="p-3">
                            <Badge variant="outline" className="text-[8px] uppercase border-[#263548] bg-[#0B1220]/60 rounded-none h-4">{m.matchType}</Badge>
                          </td>
                          <td className="p-3 text-white">{m.source}</td>
                          <td className="p-3 max-w-[280px] truncate italic text-white/80">"{m.title}"</td>
                          <td className="p-3 text-right">
                            <Tone tone={m.severity} />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card className="bg-[#111827] border-[#263548] rounded text-center p-8 text-[#94A3B8]/60 flex flex-col items-center justify-center">
            <AlertTriangle className="size-8 text-[#F59E0B] mb-2" />
            No watchlist filters loaded. Add a watchlist filter in the sidebar to begin active surveillance scans.
          </Card>
        )}
      </div>
    </AppShell>
  );
}
