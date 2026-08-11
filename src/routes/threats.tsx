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
          {/*
            This read: "Threat intelligence collectors indicate low-to-moderate
            C2 activity. Domain and DNS records are monitored continuously via
            Cloudflare DoH and Feodo IP blocklists." Nothing computed that
            assessment and nothing monitors continuously — it was a finding with
            no measurement behind it, stated in the voice of one.

            The collectors it names are real and live on /recon (Cloudflare DoH,
            Shodan InternetDB) and /osint (Feodo). What does not exist is a
            correlation layer producing a per-target threat index, so this page
            points at the tools rather than asserting a conclusion.
          */}
          <p className="text-[#94A3B8] leading-relaxed">
            No threat index is computed for this target. Nothing in this system correlates blocklist
            hits, DNS records and actor infrastructure into a single rating, so none is shown — a
            number here would be an assertion, not a measurement.
          </p>
          <p className="mt-2 text-[#94A3B8] leading-relaxed">
            The collectors that do run are reachable directly:{" "}
            <a href="/recon" className="text-[#3B82F6] hover:underline">
              Recon
            </a>{" "}
            resolves DNS via Cloudflare DoH and queries Shodan InternetDB for exposed services, and{" "}
            <a href="/osint" className="text-[#3B82F6] hover:underline">
              OSINT
            </a>{" "}
            pulls the Feodo C2 blocklist. Both report what they actually find, including nothing.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
