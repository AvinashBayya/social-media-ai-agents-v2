import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import type { CheckStatus, OsintVerificationReport } from "@/utils/osint/verification";

/**
 * `/osint-verification` — a real one-click run of the OSINT E2E verification
 * (2026-08-31, ported from the teammate's fork).
 *
 * The button calls a server function that executes `runOsintVerification` (the
 * SAME engine as `bun run verify:osint`) server-side, where the collectors run.
 * Nothing here is hardcoded — every row is the actual result of that execution.
 * The engine is imported dynamically inside the handler so it stays out of the
 * client bundle.
 */
export const runOsintVerificationServer = createServerFn({ method: "POST" }).handler(async () => {
  const { runOsintVerification } = await import("@/utils/osint/verification");
  return runOsintVerification({ live: true });
});

export const Route = createFileRoute("/osint-verification")({
  head: () => ({ meta: [{ title: "OSINT Verification — Sentinel AI" }] }),
  component: OsintVerificationPage,
});

const STATUS_STYLE: Record<CheckStatus, string> = {
  LIVE_VERIFIED: "border-console-green/40 bg-console-green/10 text-console-green",
  DETERMINISTIC_VERIFIED: "border-console-cyan/40 bg-console-cyan/10 text-console-cyan",
  CONFIG_DEPENDENT: "border-console-amber/40 bg-console-amber/10 text-console-amber",
  UNAVAILABLE: "border-console-label/40 bg-console-label/10 text-console-muted",
  FAILED: "border-console-red/40 bg-console-red/10 text-console-red",
};
const STATUS_LABEL: Record<CheckStatus, string> = {
  LIVE_VERIFIED: "LIVE",
  DETERMINISTIC_VERIFIED: "DETERMINISTIC",
  CONFIG_DEPENDENT: "CONFIG-DEPENDENT",
  UNAVAILABLE: "UNAVAILABLE",
  FAILED: "FAILED",
};

function OsintVerificationPage() {
  const [report, setReport] = useState<OsintVerificationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setBusy(true);
    setError("");
    setReport(null);
    try {
      setReport((await runOsintVerificationServer()) as unknown as OsintVerificationReport);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const overallTone =
    report?.overall === "READY"
      ? "border-console-green/40 bg-console-green/10 text-console-green"
      : report?.overall === "READY_WITH_LIMITATIONS"
        ? "border-console-amber/40 bg-console-amber/10 text-console-amber"
        : "border-console-red/40 bg-console-red/10 text-console-red";

  return (
    <AppShell>
      <PageHeader
        title="OSINT Verification"
        description="One-click end-to-end run of the passive OSINT pipeline. Every result below is produced by an actual execution — nothing is hardcoded."
      />

      <div className="space-y-4 p-6 font-mono text-xs">
        <Card className="bg-console-surface border-console-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] leading-relaxed text-console-muted">
              Runs planner → collectors → validation → snapshot → resolution → graph/timeline → four
              disciplines → contradictions/correlations → grounded context → report + PDF → case
              isolation → passive policy. Live collection depends on network reachability; gaps are
              reported honestly as UNAVAILABLE/CONFIG-DEPENDENT, never faked to pass.
            </p>
            <Button
              data-testid="run-osint-verification"
              onClick={run}
              disabled={busy}
              className="h-9 shrink-0 gap-1.5 rounded bg-console-cyan px-4 font-mono text-[11px] font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-cyan/90"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
              {busy ? "Verifying…" : "Run OSINT Verification"}
            </Button>
          </div>
        </Card>

        {error && (
          <div className="flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-3">
            <AlertTriangle className="size-4 shrink-0 text-console-red" />
            <span className="text-[11px] leading-relaxed text-console-red">Verification failed to run: {error}</span>
          </div>
        )}

        {report && (
          <>
            <Card className={`border p-4 ${overallTone}`} data-testid="osint-verification-overall">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-bold uppercase tracking-wider">Overall: {report.overall}</span>
                <span className="text-[10px]">
                  live {report.counts.LIVE_VERIFIED} · deterministic {report.counts.DETERMINISTIC_VERIFIED} · config{" "}
                  {report.counts.CONFIG_DEPENDENT} · unavailable {report.counts.UNAVAILABLE} · failed{" "}
                  {report.counts.FAILED}
                </span>
              </div>
            </Card>

            <div className="space-y-2" data-testid="osint-verification-checks">
              {report.checks.map((c) => (
                <Card key={c.id} className="bg-console-surface border-console-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold text-console-text">{c.label}</span>
                    <Badge className={`shrink-0 border text-[9px] uppercase ${STATUS_STYLE[c.status]}`}>
                      {STATUS_LABEL[c.status]}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-console-muted">{c.detail}</p>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
