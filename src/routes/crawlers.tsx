import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Cpu } from "lucide-react";

export const Route = createFileRoute("/crawlers")({
  head: () => ({ meta: [{ title: "Crawler Status — Sentinel AI" }] }),
  component: CrawlersPage,
});

type Crawler = { name: string; status: string; rate: string; target: string };

function CrawlersPage() {
  // No collector telemetry source is wired up yet. This stays empty until real
  // collectors report in — never populate it with placeholder status figures.
  const CRAWLERS: Crawler[] = [];

  return (
    <AppShell>
      <PageHeader
        title="Crawler Operations & Feed Health"
        description="Monitor status of real-time server-side collectors, RSS engines, and Wikidata API pipelines."
      />
      {CRAWLERS.length === 0 ? (
        <div className="p-6">
          <Card className="bg-[#111827] border-[#263548] p-10 flex flex-col items-center justify-center text-center gap-2">
            <Cpu className="size-8 text-[#64748B]" />
            <span className="font-mono text-sm text-[#94A3B8]">No collectors configured</span>
            <span className="font-mono text-xs text-[#64748B]">
              Collector status will appear here once a telemetry source is connected.
            </span>
          </Card>
        </div>
      ) : (
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {CRAWLERS.map((c) => (
            <Card key={c.name} className="bg-[#111827] border-[#263548] p-4 space-y-2 font-mono text-xs">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#F3F4F6] flex items-center gap-2">
                  <Cpu className="size-4 text-[#10B981]" />
                  {c.name}
                </span>
                <Badge className="bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 text-[10px]">
                  {c.status}
                </Badge>
              </div>
              <div className="text-[#94A3B8]">Target: {c.target}</div>
              <div className="text-[#64748B] text-[10px]">Throughput: {c.rate}</div>
            </Card>
          ))}
        </div>
      )}
    </AppShell>
  );
}
