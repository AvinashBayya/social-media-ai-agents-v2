import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Cpu, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import { collectorHealth, type CollectorProbe } from "@/utils/collector-health";

/**
 * Collector reachability — measured on demand.
 *
 * This page previously listed six collectors with invented throughput figures
 * ("12 req/min", "~200 msgs/min"), hardcoded ONLINE/POLLING statuses, a
 * "Telemetry Engine Active" banner, a pulsing green dot and a "System Nominal"
 * badge. Nothing measured any of it. It showed Reddit as polling every two
 * minutes while Reddit was refusing every request with 403, and it listed a
 * "Meta Social Cache Engine" ingesting Instagram and Facebook data that this
 * system does not collect at all.
 *
 * Every figure here now comes from a probe that just ran. There is no aggregate
 * health verdict, no throughput and no uptime, because nothing measures them —
 * scale-to-zero means there is no process between requests to keep a counter in.
 */

export const Route = createFileRoute("/crawlers")({
  head: () => ({ meta: [{ title: "Collector Status — Sentinel AI" }] }),
  component: CrawlersPage,
});

const CARD = "bg-console-surface border-console-border";

const TONE: Record<CollectorProbe["status"], { label: string; cls: string }> = {
  reachable: { label: "Reachable", cls: "bg-console-green/10 text-console-green border-console-green/30" },
  refused: { label: "Refused us", cls: "bg-console-amber/10 text-console-amber border-console-amber/30" },
  unreachable: { label: "No response", cls: "bg-console-red/10 text-console-red border-console-red/30" },
  "no-credential": {
    label: "Needs credential",
    cls: "bg-console-purple/10 text-console-purple border-console-purple/30",
  },
  "not-probeable": {
    label: "Not probed",
    cls: "bg-console-label/10 text-console-muted border-console-label/30",
  },
};

function CrawlersPage() {
  const [probes, setProbes] = useState<CollectorProbe[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ranAt, setRanAt] = useState("");

  const run = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setProbes((await collectorHealth()) as unknown as CollectorProbe[]);
      setRanAt(new Date().toLocaleTimeString());
    } catch (err: any) {
      // A failed probe run is not "all collectors down" — say which it is.
      setError(err?.message ?? String(err));
      setProbes(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <AppShell>
      <PageHeader
        title="Collector Status"
        description="Live reachability probe of every collector endpoint. Run on demand — nothing polls in the background."
      />

      <div className="space-y-4 p-6 font-mono text-xs">
        <Card className={`${CARD} p-4`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-console-muted">
              {probes
                ? `${probes.length} collectors probed${ranAt ? ` at ${ranAt}` : ""}`
                : busy
                  ? "Probing…"
                  : "Not yet probed"}
            </span>
            <Button
              size="sm"
              onClick={run}
              disabled={busy}
              className="h-7 rounded bg-console-cyan px-3 text-[10px] font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-cyan/90"
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <>
                  <RefreshCw className="mr-1 size-3" /> Re-probe
                </>
              )}
            </Button>
          </div>
          <p className="pt-2 text-[10px] leading-relaxed text-console-label">
            Each row is the result of a request made when you loaded this page. No throughput,
            uptime or polling cadence is shown because nothing measures them — this container scales
            to zero and holds no process between requests. A collector that refuses us is reported
            as refusing, not as down: those need different responses.
          </p>
        </Card>

        {error && (
          <div className="flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-3">
            <AlertTriangle className="size-4 shrink-0 text-console-red" />
            <span className="text-[11px] leading-relaxed text-console-red">
              Probe run failed: {error}
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {probes?.map((p) => (
            <Card key={p.id} className={`${CARD} space-y-2 p-4`}>
              <div className="flex items-start justify-between gap-2">
                <span className="flex items-center gap-2 font-bold text-console-text">
                  <Cpu className="size-4 shrink-0 text-console-cyan" />
                  {p.name}
                </span>
                <Badge className={`shrink-0 border text-[9px] uppercase ${TONE[p.status].cls}`}>
                  {TONE[p.status].label}
                </Badge>
              </div>

              <div className="space-y-1 text-[10px]">
                <div className="text-console-muted">
                  <span className="text-console-label">Module: </span>
                  {p.module}
                </div>
                <div className="break-all text-console-muted">
                  <span className="text-console-label">Endpoint: </span>
                  {p.endpoint}
                </div>
                {/* null latency means no response arrived — not a fast zero. */}
                <div className="text-console-muted">
                  <span className="text-console-label">Response: </span>
                  {p.httpStatus === null ? "none" : `HTTP ${p.httpStatus}`}
                  {p.latencyMs !== null && ` · ${p.latencyMs} ms`}
                </div>
              </div>

              <p className="border-t border-console-border/40 pt-2 text-[10px] leading-relaxed text-console-label">
                {p.detail}
              </p>
            </Card>
          ))}
        </div>

        {probes?.length === 0 && (
          <Card className={`${CARD} p-10 text-center text-console-muted`}>
            No collectors registered.
          </Card>
        )}
      </div>
    </AppShell>
  );
}
