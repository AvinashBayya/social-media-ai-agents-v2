import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, ShieldAlert } from "lucide-react";
import { getActiveTarget } from "@/utils/active-target";

export const Route = createFileRoute("/alerts")({
  head: () => ({ meta: [{ title: "Alert Center — Sentinel AI" }] }),
  component: AlertsPage,
});

function AlertsPage() {
  const activeTarget = getActiveTarget();
  const ALERTS = [
    { title: `Volume Spike (>50%) detected on ${activeTarget}`, level: "HIGH", time: "12m ago" },
    { title: `State Media citation flagged in Google News for ${activeTarget}`, level: "MEDIUM", time: "45m ago" },
    { title: `New C2 IP block match registered`, level: "CRITICAL", time: "2h ago" },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Tactical Alert Center"
        description="Real-time triggers, volume anomaly alerts, and threat escalations."
      />
      <div className="p-6 space-y-3 font-mono text-xs">
        {ALERTS.map((a, i) => (
          <Card key={i} className="bg-[#111827] border-[#263548] p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bell className="size-4 text-[#EF4444]" />
              <div>
                <div className="text-[#F3F4F6] font-bold">{a.title}</div>
                <div className="text-[#64748B] text-[10px]">{a.time}</div>
              </div>
            </div>
            <Badge className="bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/30 text-[10px]">
              {a.level}
            </Badge>
          </Card>
        ))}
      </div>
    </AppShell>
  );
}
