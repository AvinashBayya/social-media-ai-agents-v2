import { useEffect, useState } from "react";
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
  // Empty on first render, server and client alike — getActiveTarget() reads
  // localStorage, which does not exist during SSR. Calling it directly in the
  // render body (the previous code) made the server render one string and the
  // client's first paint render another, which is a React hydration mismatch.
  // Populating the real value in an effect (client-only, post-hydration)
  // matches the working pattern already used in index.tsx.
  const [activeTarget, setActiveTarget] = useState("");
  useEffect(() => {
    setActiveTarget(getActiveTarget());

    // Without this, changing the target via the top-nav search bar while
    // already on this page did nothing until navigating away and back.
    const handleTargetChange = (e: any) => {
      if (e.detail) setActiveTarget(e.detail);
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  return (
    <AppShell>
      <PageHeader
        title="Threat Intelligence Radar"
        description="Pointers to the collectors that do run. No threat index is computed for a target — nothing here correlates blocklists, DNS and infrastructure into a rating."
      />
      <div className="p-6 space-y-4 font-mono text-xs">
        <Card className="bg-console-surface border-console-border p-4">
          <div className="text-console-red font-bold text-sm flex items-center gap-2 mb-2">
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
          <p className="text-console-muted leading-relaxed">
            No threat index is computed for this target. Nothing in this system correlates blocklist
            hits, DNS records and actor infrastructure into a single rating, so none is shown — a
            number here would be an assertion, not a measurement.
          </p>
          <p className="mt-2 text-console-muted leading-relaxed">
            The collectors that do run are reachable directly:{" "}
            <a href="/recon" className="text-console-blue hover:underline">
              Recon
            </a>{" "}
            resolves DNS via Cloudflare DoH and queries Shodan InternetDB for exposed services, and{" "}
            <a href="/osint" className="text-console-blue hover:underline">
              OSINT
            </a>{" "}
            pulls the Feodo C2 blocklist. Both report what they actually find, including nothing.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
