import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Cpu, RefreshCw, Loader2, AlertTriangle, ShieldCheck } from "lucide-react";
import { collectorHealth, type CollectorProbe } from "@/utils/collector-health";
import { capabilityReport, type CapabilityReport } from "@/utils/collectors/capability-report";

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

              {/* The remediation for a credential-gated probe has a real existing
                  destination: the operator vault on /settings, the same place
                  CredentialNotice points to. Linked only for the no-credential
                  status, so it never implies a fix that does not apply. */}
              {p.status === "no-credential" && (
                <Link
                  to="/settings"
                  data-testid="crawler-settings-link"
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-console-purple hover:underline"
                >
                  Add credentials in Settings →
                </Link>
              )}
            </Card>
          ))}
        </div>

        {probes?.length === 0 && (
          <Card className={`${CARD} p-10 text-center text-console-muted`}>
            No collectors registered.
          </Card>
        )}

        <CapabilityMatrix />
      </div>
    </AppShell>
  );
}

/**
 * Source capability matrix — ported from a teammate's parallel fork alongside
 * `passive-policy.ts`/`wayback.ts`/`sherlock.ts`.
 *
 * Deliberately BELOW the probe and visually separated: this table reports what each
 * collector *declares*, and the probe above reports what actually answered. Merging
 * them into one table would let a static declaration read as a live status, which is
 * the exact failure this page was rebuilt to remove (it once showed hardcoded
 * ONLINE badges for collectors that were returning 403).
 */
function CapabilityMatrix() {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = (await capabilityReport()) as unknown as CapabilityReport;
        if (!cancelled) setReport(data);
      } catch (err: any) {
        // An unreadable registry is reported, never rendered as an empty table —
        // an empty table would say "no sources", which is a different claim.
        if (!cancelled) setError(err?.message ?? String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-3">
        <AlertTriangle className="size-4 shrink-0 text-console-red" />
        <span className="text-[11px] leading-relaxed text-console-red">
          Capability matrix unavailable: {error}
        </span>
      </div>
    );
  }

  if (!report) {
    return (
      <Card className={`${CARD} p-4 text-[10px] text-console-label`}>Loading capability matrix…</Card>
    );
  }

  const yn = (v: boolean) => (v ? "yes" : "no");

  return (
    <Card className={`${CARD} space-y-3 p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-bold text-console-text">
          <ShieldCheck className="size-4 shrink-0 text-console-cyan" />
          Source Capability Matrix
        </span>
        <span className="text-[10px] text-console-muted">
          {report.totals.declared} declared · {report.totals.passive} passive ·{" "}
          {report.totals.refused} refused
          {report.totals.activeCapableGated > 0 &&
            ` · ${report.totals.activeCapableGated} active-capable behind an authorisation gate`}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-[10px]">
          <thead>
            <tr className="border-b border-console-border text-left text-console-label">
              <th className="py-2 pr-3 font-normal">Source</th>
              <th className="py-2 pr-3 font-normal">Discipline</th>
              <th className="py-2 pr-3 font-normal">Input types</th>
              <th className="py-2 pr-3 font-normal">Mode</th>
              <th className="py-2 pr-3 font-normal">Passive</th>
              <th className="py-2 pr-3 font-normal">API</th>
              <th className="py-2 pr-3 font-normal">Auth</th>
              <th className="py-2 pr-3 font-normal">Manual</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={r.sourceId} className="border-b border-console-border/40 align-top">
                <td className="py-2 pr-3 font-bold text-console-text">{r.name}</td>
                <td className="py-2 pr-3 text-console-muted">
                  {/* Untagged is shown as untagged, never filed under a default discipline. */}
                  {r.disciplines.length ? r.disciplines.join(", ") : "—"}
                </td>
                <td className="py-2 pr-3 text-console-muted">{r.inputTypes.join(", ")}</td>
                <td className="py-2 pr-3 text-console-muted">{r.collectionMode}</td>
                <td className="py-2 pr-3">
                  <Badge
                    className={`border text-[9px] uppercase ${
                      r.passive
                        ? "border-console-green/30 bg-console-green/10 text-console-green"
                        : "border-console-red/30 bg-console-red/10 text-console-red"
                    }`}
                  >
                    {r.passive ? "passive" : "refused"}
                  </Badge>
                </td>
                <td className="py-2 pr-3 text-console-muted">{yn(r.apiAvailable)}</td>
                <td className="py-2 pr-3 text-console-muted">{yn(r.requiresAuth)}</td>
                <td className="py-2 pr-3 text-console-muted">{yn(r.requiresManualAction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* A refusal always states its reason — a source silently missing from a run
          reads to an analyst as a source that found nothing. */}
      {report.rows
        .filter((r) => r.rejection)
        .map((r) => (
          <p
            key={`${r.sourceId}-rejection`}
            className="rounded border border-console-red/30 bg-console-red/5 p-2 text-[10px] leading-relaxed text-console-red"
          >
            <span className="font-bold">{r.name} will not run:</span> {r.rejection!.detail}
          </p>
        ))}

      {report.rows
        .filter((r) => r.activeCapable && r.authorisationGated)
        .map((r) => (
          <p
            key={`${r.sourceId}-gated`}
            className="rounded border border-console-amber/30 bg-console-amber/5 p-2 text-[10px] leading-relaxed text-console-amber"
          >
            <span className="font-bold">{r.name} is active-capable.</span> It only reads a stored
            operator-owned dataset and sends the target nothing, but that dataset originates from
            scanning, so every call passes a named-officer authorisation gate that denies by default.
          </p>
        ))}

      <div className="space-y-1 border-t border-console-border/40 pt-2">
        {report.caveats.map((c) => (
          <p key={c} className="text-[10px] leading-relaxed text-console-label">
            {c}
          </p>
        ))}
      </div>
    </Card>
  );
}
