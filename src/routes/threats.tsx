import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, Globe } from "lucide-react";
import { getActiveTarget } from "@/utils/active-target";

export const Route = createFileRoute("/threats")({
  head: () => ({ meta: [{ title: "Threat Intel — Sentinel AI" }] }),
  component: ThreatsPage,
});

function ThreatsPage() {
  const activeTarget = getActiveTarget();

  return (
    <AppShell>
      <PageHeader
        title="Threat Intelligence Radar"
        description="Correlated malicious IP blocklists, C2 networks, and actor threat indices."
      />
      <div className="p-6 space-y-4 font-mono text-xs">
        <Card className="bg-[#111827] border-[#263548] p-4">
          <div className="text-[#EF4444] font-bold text-sm flex items-center gap-2 mb-2">
            <ShieldAlert className="size-4" />
            Active Threat Target: {activeTarget}
          </div>
          <p className="text-[#94A3B8]">
            Threat intelligence collectors indicate low-to-moderate C2 activity. Domain and DNS records are monitored continuously via Cloudflare DoH and Feodo IP blocklists.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
