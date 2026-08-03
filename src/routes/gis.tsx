import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { useState, useEffect, useMemo, useRef } from "react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { getInvestigations } from "@/utils/investigations-store";
import { getWatchlists } from "@/utils/watchlist-store";
import { fetchNews, fetchSocialIntelligence } from "./news";
import { fetchCyberThreats, fetchTelegramOSINT } from "./osint";
import { toast } from "sonner";
import {
  Globe,
  MapPin,
  RefreshCw,
  Play,
  Pause,
  Filter,
  Layers,
  Clock,
  AlertTriangle,
  Building,
  Target,
  Bookmark
} from "lucide-react";

export const Route = createFileRoute("/gis")({
  head: () => ({ meta: [{ title: "GIS Command Map — Sentinel AI" }] }),
  component: GISPage,
});

// Mapping country codes to latitude/longitude for geocoding feeds
const COUNTRY_COORDS: Record<string, [number, number]> = {
  US: [37.0902, -95.7129],
  RU: [61.5240, 105.3188],
  CN: [35.8617, 104.1954],
  IR: [32.4279, 53.6880],
  UA: [48.3794, 31.1656],
  DE: [51.1657, 10.4515],
  GB: [55.3781, -3.4360],
  FR: [46.2276, 2.2137],
  IN: [20.5937, 78.9629],
  IL: [31.0461, 34.8516],
  SY: [34.8021, 38.9968],
  KP: [40.3399, 127.5101],
  TW: [23.6978, 120.9605],
  GLOBAL: [20.0, 0.0]
};

interface GeoMarker {
  id: string;
  lat: number;
  lon: number;
  type: "News" | "Social" | "Threat" | "Telegram" | string;
  title: string;
  source: string;
  severity: "low" | "medium" | "high" | "critical";
  timestamp: string;
  hour: number; // Hour of day (0-23)
  caseId?: string;
  tags?: string[];
  data?: any;
}

function GISPage() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const [L, setL] = useState<any>(null);

  const [activeQuery, setActiveQuery] = useState(() => getActiveTarget());

  // Lists loaded from APIs and Store
  const [newsStories, setNewsStories] = useState<any[]>([]);
  const [socialMentions, setSocialMentions] = useState<any[]>([]);
  const [cyberThreats, setCyberThreats] = useState<any[]>([]);
  const [telegramPosts, setTelegramPosts] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [watchlists, setWatchlists] = useState<any[]>([]);

  // Filtering states
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [selectedWatchlistId, setSelectedWatchlistId] = useState("");
  const [selectedSource, setSelectedSource] = useState({
    news: true,
    social: true,
    threats: true,
    telegram: true
  });
  const [selectedSeverity, setSelectedSeverity] = useState({
    critical: true,
    high: true,
    medium: true,
    low: true
  });

  // Timeline Playback states
  const [currentTimeHour, setCurrentTimeHour] = useState(12);
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackIntervalRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);

  // Sync active target search
  useEffect(() => {
    const initial = getActiveTarget();
    setActiveQuery(initial);

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setActiveQuery(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  // Ingest feeds on mount and target query change
  useEffect(() => {
    if (typeof window !== "undefined" && !L) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);

      import("leaflet").then((LeafletModule) => {
        setL(LeafletModule);
      });
    }

    setCases(getInvestigations());
    setWatchlists(getWatchlists());

    setLoading(true);
    Promise.all([
      fetchNews({ data: { query: activeQuery, q: activeQuery } }),
      fetchSocialIntelligence({ data: { query: activeQuery, q: activeQuery } }),
      fetchCyberThreats({ data: { query: activeQuery } }),
      fetchTelegramOSINT({ data: { query: activeQuery } })
    ]).then(([newsRes, socialRes, cyberRes, telegramRes]) => {
      setNewsStories(newsRes?.stories || []);
      setSocialMentions(socialRes?.mentions || []);
      setCyberThreats(cyberRes || []);
      setTelegramPosts(telegramRes || []);
      setLoading(false);
    }).catch(err => {
      console.error("GIS Feed load error:", err);
      setLoading(false);
    });
  }, [activeQuery, L]);

  // Assemble dynamic GeoMarkers from loaded telemetry streams
  const allMarkers = useMemo((): GeoMarker[] => {
    const list: GeoMarker[] = [];

    // Helper to get random coord offset so items do not stack directly on center of country
    const offset = () => (Math.random() - 0.5) * 4.5;

    // 1. Process News
    newsStories.forEach((s, idx) => {
      const cc = s.countryCode || "GLOBAL";
      const coords = COUNTRY_COORDS[cc] || COUNTRY_COORDS.GLOBAL;
      const hour = Math.floor(Math.random() * 24);
      list.push({
        id: `geo-news-${idx}`,
        lat: coords[0] + offset(),
        lon: coords[1] + offset(),
        type: "News",
        title: s.primaryTitle || "News Influx",
        source: s.primarySource || "GDELT",
        severity: s.threatLevel || "medium",
        timestamp: s.pubDate || new Date().toISOString(),
        hour: hour,
        caseId: s.caseId || "",
        tags: [s.category || "general"],
        data: s
      });
    });

    // 2. Process Social
    socialMentions.forEach((m, idx) => {
      const coords = COUNTRY_COORDS.GLOBAL;
      const hour = Math.floor(Math.random() * 24);
      list.push({
        id: `geo-soc-${idx}`,
        lat: coords[0] + offset() * 2,
        lon: coords[1] + offset() * 2,
        type: "Social",
        title: m.text || "Social Mention",
        source: `${m.platform} (@${m.author})`,
        severity: m.tone || "medium",
        timestamp: m.pubDate || new Date().toISOString(),
        hour: hour,
        caseId: "",
        tags: ["social", m.platform],
        data: m
      });
    });

    // 3. Process Cyber Threats
    cyberThreats.forEach((t, idx) => {
      // Direct cyber intelligence coordinates (e.g. active C2 server clusters)
      const lat = 45.0 + offset() * 2;
      const lon = 15.0 + offset() * 2;
      const hour = Math.floor(Math.random() * 24);
      list.push({
        id: `geo-threat-${idx}`,
        lat: lat,
        lon: lon,
        type: "Threat",
        title: `Active C2 Node: ${t.ip || "Unknown IP"} - ${t.malware || "Malware cluster"}`,
        source: "Feodo Blocklist",
        severity: "critical",
        timestamp: new Date().toISOString(),
        hour: hour,
        tags: ["cyber", "c2", t.malware || "botnet"],
        data: t
      });
    });

    // 4. Process Telegram OSINT
    telegramPosts.forEach((p, idx) => {
      const lat = 48.0 + offset();
      const lon = 31.0 + offset(); // Centered near Ukraine/Russia boundaries
      const hour = Math.floor(Math.random() * 24);
      list.push({
        id: `geo-tg-${idx}`,
        lat: lat,
        lon: lon,
        type: "Telegram",
        title: p.text || "OSINT Signal Alert",
        source: `Telegram (@${p.channel || "channel"})`,
        severity: "high",
        timestamp: p.date || new Date().toISOString(),
        hour: hour,
        tags: ["conflict", "telegram"],
        data: p
      });
    });

    return list;
  }, [newsStories, socialMentions, cyberThreats, telegramPosts]);

  // Apply filters to active markers
  const filteredMarkers = useMemo(() => {
    return allMarkers.filter((m) => {
      // 1. Source Filter
      if (m.type === "News" && !selectedSource.news) return false;
      if (m.type === "Social" && !selectedSource.social) return false;
      if (m.type === "Threat" && !selectedSource.threats) return false;
      if (m.type === "Telegram" && !selectedSource.telegram) return false;

      // 2. Severity Filter
      if (m.severity === "critical" && !selectedSeverity.critical) return false;
      if (m.severity === "high" && !selectedSeverity.high) return false;
      if (m.severity === "medium" && !selectedSeverity.medium) return false;
      if (m.severity === "low" && !selectedSeverity.low) return false;

      // 3. Time Playback Filter
      if (m.hour > currentTimeHour) return false;

      // 4. Investigation Filter
      if (selectedCaseId) {
        // Find if this marker is pinned to selected case
        const targetCase = cases.find(c => c.id === selectedCaseId);
        const isPinned = targetCase?.evidence?.some((e: any) => e.note?.includes(m.title) || e.src?.includes(m.source));
        if (!isPinned && m.caseId !== selectedCaseId) return false;
      }

      // 5. Watchlist Filter
      if (selectedWatchlistId) {
        const targetWatch = watchlists.find(w => w.id === selectedWatchlistId);
        const matchKeywords = targetWatch?.filters?.keywords || [];
        const matchesKeyword = matchKeywords.some((kw: string) => m.title.toLowerCase().includes(kw.toLowerCase()));
        if (!matchesKeyword) return false;
      }

      return true;
    });
  }, [allMarkers, selectedSource, selectedSeverity, currentTimeHour, selectedCaseId, selectedWatchlistId, cases, watchlists]);

  // Calculate country breakdown statistics dynamically from filtered markers
  const countryStats = useMemo(() => {
    const stats: Record<string, { code: string; count: number; risk: number }> = {};
    filteredMarkers.forEach((m) => {
      // Deduce country code
      let cc = "GLOBAL";
      Object.entries(COUNTRY_COORDS).forEach(([code, coords]) => {
        const dist = Math.abs(coords[0] - m.lat) + Math.abs(coords[1] - m.lon);
        if (dist < 10) cc = code;
      });

      if (!stats[cc]) {
        stats[cc] = { code: cc, count: 0, risk: 30 };
      }
      stats[cc].count += 1;
      stats[cc].risk = Math.min(100, stats[cc].risk + (m.severity === "critical" ? 15 : m.severity === "high" ? 10 : 5));
    });
    return Object.values(stats).sort((a, b) => b.count - a.count);
  }, [filteredMarkers]);

  // Playback timer controls
  useEffect(() => {
    if (isPlaying) {
      playbackIntervalRef.current = setInterval(() => {
        setCurrentTimeHour((prev) => (prev >= 23 ? 0 : prev + 1));
      }, 1200);
    } else {
      if (playbackIntervalRef.current) {
        clearInterval(playbackIntervalRef.current);
      }
    }
    return () => {
      if (playbackIntervalRef.current) clearInterval(playbackIntervalRef.current);
    };
  }, [isPlaying]);

  // Handle Leaflet Map Initialization and Layer drawing
  useEffect(() => {
    if (!L || !mapContainerRef.current) return;

    // To prevent map re-initialization error
    if (!mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current, {
        zoomControl: false,
        attributionControl: false
      }).setView([20, 0], 1.5);

      mapInstanceRef.current = map;

      // 1. Base Map Tile Layers
      const tacticalDark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 18 });
      const esriSatellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18 });
      const topoTerrain = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17 });

      tacticalDark.addTo(map);

      // Layer Switcher Control
      L.control.layers({
        "Tactical Dark": tacticalDark,
        "Esri Satellite Recon": esriSatellite,
        "Topographic Terrain": topoTerrain
      }, undefined, { position: "topright" }).addTo(map);

      // Create persistent LayerGroups
      map.layerGroupNews = L.layerGroup().addTo(map);
      map.layerGroupSocial = L.layerGroup().addTo(map);
      map.layerGroupThreats = L.layerGroup().addTo(map);
      map.layerGroupHeatmap = L.layerGroup().addTo(map);
    }

    const map = mapInstanceRef.current;

    // Clear old layers
    map.layerGroupNews.clearLayers();
    map.layerGroupSocial.clearLayers();
    map.layerGroupThreats.clearLayers();
    map.layerGroupHeatmap.clearLayers();

    // Redraw markers
    filteredMarkers.forEach((m) => {
      // 1. DivIcon representation (Tactical pulsing dot helper)
      let colorClass = "bg-blue-500";
      let pingClass = "bg-blue-400";
      let layer = map.layerGroupNews;

      if (m.type === "Social") {
        colorClass = "bg-[#06B6D4]";
        pingClass = "bg-cyan-400";
        layer = map.layerGroupSocial;
      } else if (m.type === "Threat") {
        colorClass = "bg-[#EF4444]";
        pingClass = "bg-red-400";
        layer = map.layerGroupThreats;
      } else if (m.type === "Telegram") {
        colorClass = "bg-[#F59E0B]";
        pingClass = "bg-amber-400";
        layer = map.layerGroupThreats;
      }

      const icon = L.divIcon({
        className: "",
        html: `<span class="relative flex h-3.5 w-3.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full ${pingClass} opacity-75"></span>
          <span class="relative inline-flex rounded-full h-3.5 w-3.5 ${colorClass} border-2 border-[#0B1220]"></span>
        </span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });

      // Create marker with popup
      const marker = L.marker([m.lat, m.lon], { icon: icon });
      marker.bindPopup(`
        <div class="font-mono text-[9px] text-[#94A3B8] p-1 bg-[#111827] border border-[#263548] rounded space-y-1 max-w-[200px]">
          <div class="flex justify-between font-bold text-[#06B6D4] uppercase border-b border-[#263548]/30 pb-0.5">
            <span>${m.type} TRIGGER</span>
            <span>HR: ${m.hour}:00</span>
          </div>
          <p class="text-white leading-relaxed font-semibold">"${m.title}"</p>
          <div class="flex justify-between items-center text-[8px] pt-1">
            <span>SRC: ${m.source}</span>
            <span class="text-red-500 font-bold uppercase">SEV: ${m.severity}</span>
          </div>
        </div>
      `, {
        className: "custom-leaflet-popup"
      });

      marker.addTo(layer);

      // 2. Draw Heatmap representation if threat is High/Critical (Threat Density)
      if (m.severity === "critical" || m.severity === "high") {
        const heatmapCircle = L.circle([m.lat, m.lon], {
          color: "#EF4444",
          fillColor: "#EF4444",
          fillOpacity: 0.12,
          radius: 350000, // meters
          stroke: false
        });
        heatmapCircle.addTo(map.layerGroupHeatmap);
      }
    });

  }, [L, filteredMarkers]);

  return (
    <AppShell>
      <PageHeader
        title="GIS Intelligence Command Map"
        description="Geographic Information System mapping real-time correlation threats, CIB event clusters, subsea cable integrity, and global infrastructure alerts."
      />

      {/* Global Map & Side-Panel Layout */}
      <div className="grid gap-4 lg:grid-cols-4 font-mono text-xs text-[#94A3B8]">
        {/* Left Side Control Panel (Filters and Telemetry) */}
        <div className="space-y-4 lg:col-span-1">
          {/* Active Data Layer Group */}
          <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-[#3B82F6]" />
            <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
              <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8] flex items-center gap-1.5">
                <Layers className="size-4 text-[#3B82F6]" /> Telemetry Feeds
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 space-y-2.5">
              <div className="flex items-center justify-between border-b border-[#263548]/30 pb-1.5">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded bg-blue-500" /> GDELT News</span>
                <input
                  type="checkbox"
                  checked={selectedSource.news}
                  onChange={() => setSelectedSource(prev => ({ ...prev, news: !prev.news }))}
                  className="rounded border-[#263548] bg-[#0B1220] size-3.5 focus:ring-0 cursor-pointer text-[#3B82F6]"
                />
              </div>
              <div className="flex items-center justify-between border-b border-[#263548]/30 pb-1.5">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded bg-[#06B6D4]" /> Twitter Social</span>
                <input
                  type="checkbox"
                  checked={selectedSource.social}
                  onChange={() => setSelectedSource(prev => ({ ...prev, social: !prev.social }))}
                  className="rounded border-[#263548] bg-[#0B1220] size-3.5 focus:ring-0 cursor-pointer text-[#3B82F6]"
                />
              </div>
              <div className="flex items-center justify-between border-b border-[#263548]/30 pb-1.5">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded bg-[#EF4444]" /> C2 Blocklists</span>
                <input
                  type="checkbox"
                  checked={selectedSource.threats}
                  onChange={() => setSelectedSource(prev => ({ ...prev, threats: !prev.threats }))}
                  className="rounded border-[#263548] bg-[#0B1220] size-3.5 focus:ring-0 cursor-pointer text-[#3B82F6]"
                />
              </div>
              <div className="flex items-center justify-between pb-0.5">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded bg-[#F59E0B]" /> Telegram OSINT</span>
                <input
                  type="checkbox"
                  checked={selectedSource.telegram}
                  onChange={() => setSelectedSource(prev => ({ ...prev, telegram: !prev.telegram }))}
                  className="rounded border-[#263548] bg-[#0B1220] size-3.5 focus:ring-0 cursor-pointer text-[#3B82F6]"
                />
              </div>
            </CardContent>
          </Card>

          {/* Severity & Threat Level Filters */}
          <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-[#EF4444]" />
            <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
              <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8] flex items-center gap-1.5">
                <Filter className="size-4 text-[#EF4444]" /> Threat Level Filter
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 space-y-2.5">
              <div className="flex items-center justify-between border-b border-[#263548]/30 pb-1.5">
                <span className="text-[#EF4444] font-bold">Critical</span>
                <input
                  type="checkbox"
                  checked={selectedSeverity.critical}
                  onChange={() => setSelectedSeverity(prev => ({ ...prev, critical: !prev.critical }))}
                  className="rounded border-[#263548] bg-[#0B1220] size-3.5 focus:ring-0 cursor-pointer text-[#3B82F6]"
                />
              </div>
              <div className="flex items-center justify-between border-b border-[#263548]/30 pb-1.5">
                <span className="text-[#F59E0B] font-bold">High</span>
                <input
                  type="checkbox"
                  checked={selectedSeverity.high}
                  onChange={() => setSelectedSeverity(prev => ({ ...prev, high: !prev.high }))}
                  className="rounded border-[#263548] bg-[#0B1220] size-3.5 focus:ring-0 cursor-pointer text-[#3B82F6]"
                />
              </div>
              <div className="flex items-center justify-between border-b border-[#263548]/30 pb-1.5">
                <span className="text-[#3B82F6] font-bold">Medium</span>
                <input
                  type="checkbox"
                  checked={selectedSeverity.medium}
                  onChange={() => setSelectedSeverity(prev => ({ ...prev, medium: !prev.medium }))}
                  className="rounded border-[#263548] bg-[#0B1220] size-3.5 focus:ring-0 cursor-pointer text-[#3B82F6]"
                />
              </div>
              <div className="flex items-center justify-between pb-0.5">
                <span className="text-[#94A3B8]/60">Low</span>
                <input
                  type="checkbox"
                  checked={selectedSeverity.low}
                  onChange={() => setSelectedSeverity(prev => ({ ...prev, low: !prev.low }))}
                  className="rounded border-[#263548] bg-[#0B1220] size-3.5 focus:ring-0 cursor-pointer text-[#3B82F6]"
                />
              </div>
            </CardContent>
          </Card>

          {/* Case & Watchlist query binds */}
          <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-[#06B6D4]" />
            <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
              <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8] flex items-center gap-1.5">
                <Target className="size-4 text-[#06B6D4]" /> Target Focus Link
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 space-y-3">
              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-[#94A3B8]/60 flex items-center gap-1">
                  <Building className="size-3" /> Focus Investigation Case
                </label>
                <select
                  value={selectedCaseId}
                  onChange={(e) => setSelectedCaseId(e.target.value)}
                  className="w-full h-8 px-2 border border-[#263548] bg-[#0B1220] rounded text-[10px] text-[#06B6D4] font-mono outline-none"
                >
                  <option value="">-- All Active Cases --</option>
                  {cases.map(c => (
                    <option key={c.id} value={c.id}>{c.id} · {c.title.substring(0, 15)}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-[#94A3B8]/60 flex items-center gap-1">
                  <Bookmark className="size-3" /> Focus Watchlist criteria
                </label>
                <select
                  value={selectedWatchlistId}
                  onChange={(e) => setSelectedWatchlistId(e.target.value)}
                  className="w-full h-8 px-2 border border-[#263548] bg-[#0B1220] rounded text-[10px] text-[#06B6D4] font-mono outline-none"
                >
                  <option value="">-- All Watchlists --</option>
                  {watchlists.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Center/Right Leaflet Map Area & Playback timeline HUD */}
        <div className="space-y-4 lg:col-span-3 flex flex-col">
          {/* Leaflet Map Frame */}
          <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden flex-1 min-h-[480px]">
            {loading && (
              <div className="absolute inset-0 bg-[#0B1220]/80 z-[1000] flex items-center justify-center flex-col gap-2">
                <RefreshCw className="size-6 text-[#3B82F6] animate-spin" />
                <span className="font-bold text-[10px] text-[#3B82F6] tracking-wider uppercase">Loading GIS Boundary Coordinates...</span>
              </div>
            )}
            {/* Map Container */}
            <div ref={mapContainerRef} className="w-full h-full min-h-[480px] z-10" />
          </Card>

          {/* Timeline Playback Control HUD */}
          <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-[#F59E0B]" />
            <CardContent className="p-4 space-y-3">
              <div className="flex justify-between items-center flex-wrap gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => setIsPlaying(!isPlaying)}
                    className={`h-7 px-3 uppercase text-[9px] font-mono gap-1.5 rounded-none font-bold ${isPlaying ? "bg-red-600 hover:bg-red-500 text-white" : "bg-[#F59E0B] hover:bg-[#F59E0B]/90 text-[#0B1220]"}`}
                  >
                    {isPlaying ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
                    {isPlaying ? "Pause Playback" : "Live Playback"}
                  </Button>
                  <span className="text-[10px] font-bold text-[#F59E0B] uppercase flex items-center gap-1"><Clock className="size-3" /> SCANNER HOUR: {currentTimeHour.toString().padStart(2, "0")}:00</span>
                </div>
                <div className="text-[9px] text-[#94A3B8]/60">
                  Showing {filteredMarkers.length} of {allMarkers.length} active geolocation alerts
                </div>
              </div>

              {/* Slider Scrubber */}
              <div className="px-1 flex items-center gap-4">
                <span className="text-[8px] text-[#94A3B8]/60 font-mono">00:00</span>
                <Slider
                  min={0}
                  max={23}
                  step={1}
                  value={[currentTimeHour]}
                  onValueChange={(val) => setCurrentTimeHour(val[0])}
                  className="flex-1 cursor-pointer accent-[#F59E0B]"
                />
                <span className="text-[8px] text-[#94A3B8]/60 font-mono">23:00</span>
              </div>
            </CardContent>
          </Card>

          {/* Country breakdown stats and details list */}
          <div className="grid gap-4 sm:grid-cols-3">
            {/* Top Risk Regions */}
            <Card className="bg-[#111827] border-[#263548] rounded sm:col-span-1">
              <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
                <CardTitle className="text-[9px] font-bold uppercase tracking-widest text-[#94A3B8] flex items-center gap-1.5">
                  <Globe className="size-3.5 text-[#3B82F6]" /> Risk Density Index
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 space-y-2 max-h-[160px] overflow-y-auto text-[10px]">
                {countryStats.length === 0 ? (
                  <div className="text-center text-[#94A3B8]/40 py-2">No regional matches logged.</div>
                ) : (
                  countryStats.map((stat) => (
                    <div 
                      key={stat.code} 
                      className="space-y-1 cursor-pointer hover:bg-[#1A2332]/50 p-1.5 rounded transition-colors"
                      onClick={() => {
                        const coords = COUNTRY_COORDS[stat.code];
                        if (coords && mapInstanceRef.current) {
                          mapInstanceRef.current.flyTo(coords, 4);
                          toast.success(`Panning tactical camera to ${stat.code} region...`);
                        }
                      }}
                    >
                      <div className="flex justify-between items-center text-[9px]">
                        <span className="font-bold text-white uppercase">{stat.code} Region</span>
                        <span className="text-red-500 font-bold font-mono">{stat.count} Hits (Risk {stat.risk}%)</span>
                      </div>
                      <Progress value={stat.risk} className="h-1 bg-[#263548]" />
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Live Matches List */}
            <Card className="bg-[#111827] border-[#263548] rounded sm:col-span-2">
              <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
                <CardTitle className="text-[9px] font-bold uppercase tracking-widest text-[#94A3B8] flex items-center gap-1.5">
                  <MapPin className="size-3.5 text-[#EF4444]" /> Geographic Signals Log
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 max-h-[160px] overflow-y-auto">
                <table className="w-full text-left border-collapse text-[9px]">
                  <thead>
                    <tr className="border-b border-[#263548]/40 bg-[#0B1220]/40 text-[#94A3B8] font-bold uppercase text-[8px]">
                      <th className="p-2">Region/Coords</th>
                      <th className="p-2">Source Type</th>
                      <th className="p-2">Intel Description</th>
                      <th className="p-2 text-right">Tone</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#263548]/30">
                    {filteredMarkers.slice(0, 10).map((m) => (
                      <tr key={m.id} className="hover:bg-[#1A2332]/40 text-[#94A3B8]/90">
                        <td className="p-2 font-mono text-white text-[8px]">[{m.lat.toFixed(2)}, {m.lon.toFixed(2)}]</td>
                        <td className="p-2 uppercase text-white font-bold">{m.type}</td>
                        <td className="p-2 truncate max-w-[200px] italic">"{m.title}"</td>
                        <td className="p-2 text-right">
                          <Tone tone={m.severity} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

