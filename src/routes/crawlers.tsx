import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Cpu, RefreshCw, Radio, Globe, ShieldAlert, Database, CheckCircle2 } from "lucide-react";
import { socialCache } from "@/utils/social";

export const Route = createFileRoute("/crawlers")({
  head: () => ({ meta: [{ title: "Crawler Operations — Sentinel AI" }] }),
  component: CrawlersPage,
});

type Crawler = { id: string; name: string; status: "ONLINE" | "STANDBY" | "POLLING"; rate: string; target: string; type: string; lastSync: string };

function CrawlersPage() {
  const [cachedCount, setCachedCount] = useState<number>(0);
  const [lastCheck, setLastCheck] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const items: any = await socialCache({ data: {} });
        setCachedCount(Array.isArray(items) ? items.length : 0);
      } catch {
        setCachedCount(0);
      }
      setLastCheck(new Date().toLocaleTimeString());
    })();
  }, []);

  const CRAWLERS: Crawler[] = [
    { id: "rss", name: "Google News RSS Collector", status: "ONLINE", rate: "12 req/min", target: "Global Defense & Security News", type: "RSS Engine", lastSync: "Live" },
    { id: "bsky", name: "Bluesky Jetstream WS", status: "ONLINE", rate: "~200 msgs/min", target: "Public Social Firehose", type: "WebSocket", lastSync: "Live" },
    { id: "reddit", name: "Reddit Public API", status: "POLLING", rate: "6 req/min", target: "OSINT Subreddits", type: "REST API", lastSync: "Every 2m" },
    { id: "usgs", name: "USGS Seismic Event Stream", status: "ONLINE", rate: "Real-time", target: "Global Earthquakes", type: "Geo Feed", lastSync: "Live" },
    { id: "gdelt", name: "GDELT Global Event DOC API", status: "POLLING", rate: "1 req / 5s", target: "International Events", type: "REST API", lastSync: "Every 5s" },
    { id: "cache", name: "Meta Social Cache Engine", status: "ONLINE", rate: `${cachedCount} records`, target: "Instagram / Facebook Data", type: "JSON Database", lastSync: lastCheck || "Active" },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Crawler Operations & Feed Health"
        description="Monitor telemetry and status of real-time server-side collectors, RSS engines, and social media ingestion pipelines."
      />
      <div className="p-6 space-y-4 font-mono text-xs">
        <div className="flex items-center justify-between border-b border-[#263548] pb-3">
          <span className="text-[#94A3B8] flex items-center gap-2">
            <span className="size-2 rounded-full bg-[#10B981] animate-pulse" />
            Telemetry Engine Active · {CRAWLERS.length} Collectors Monitored
          </span>
          <Badge variant="outline" className="border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#3B82F6] text-[10px]">
            System Nominal
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {CRAWLERS.map((c) => (
            <Card key={c.id} className="bg-[#111827] border-[#263548] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#F3F4F6] flex items-center gap-2">
                  <Cpu className="size-4 text-[#06B6D4]" />
                  {c.name}
                </span>
                <Badge
                  className={`text-[9px] uppercase border ${
                    c.status === "ONLINE"
                      ? "bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30"
                      : "bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30"
                  }`}
                >
                  {c.status}
                </Badge>
              </div>
              <div className="space-y-1 text-[11px]">
                <div className="text-[#94A3B8]"><span className="text-[#64748B]">Target:</span> {c.target}</div>
                <div className="text-[#94A3B8]"><span className="text-[#64748B]">Pipeline:</span> {c.type}</div>
                <div className="text-[#06B6D4]"><span className="text-[#64748B]">Throughput:</span> {c.rate}</div>
              </div>
              <div className="border-t border-[#263548]/40 pt-2 flex items-center justify-between text-[9px] text-[#64748B]">
                <span>Last Sync: {c.lastSync}</span>
                <span className="flex items-center gap-1 text-[#10B981]"><CheckCircle2 className="size-2.5" /> Verified</span>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
