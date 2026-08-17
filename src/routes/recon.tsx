import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Radar,
  Server,
  ShieldAlert,
  ShieldCheck,
  Search,
  ExternalLink,
  Copy,
  Loader2,
  AlertTriangle,
  Info,
  Network,
  ChevronDown,
  ChevronRight,
  Share2,
} from "lucide-react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { lookupAttackSurface, type AttackSurfaceResult } from "@/utils/attack-surface";
import {
  DORK_TEMPLATES,
  buildDork,
  runNewsDork,
  toDomain,
  type DorkHit,
  type DorkTemplate,
} from "@/utils/dorks";
import { crtShSubdomains, RECON_NOTES, type SubdomainFinding } from "@/utils/recon-sources";
import {
  planOsintInvestigation,
  pollOsintInvestigationJob,
  startOsintInvestigationJob,
} from "@/utils/osint/jobs";
import type { InvestigationJob, InvestigationPoll, StartedInvestigation } from "@/utils/osint/jobs";
import type { OsintPlan } from "@/utils/osint/query-planner";
import { saveGraphSnapshot } from "@/utils/graph-store";

export const Route = createFileRoute("/recon")({
  head: () => ({ meta: [{ title: "Recon & Dorks — Sentinel AI" }] }),
  component: ReconPage,
});

const CARD = "bg-[#111827] border-[#263548]";
const MUTED = "text-[#94A3B8]";
const DIM = "text-[#64748B]";

/** Explicit failure surface. Never replaced by placeholder results. */
function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-3">
      <AlertTriangle className="size-4 shrink-0 text-[#EF4444]" />
      <span className="font-mono text-[11px] leading-relaxed text-[#EF4444]">{message}</span>
    </div>
  );
}

function AttackSurfacePanel({ target }: { target: string }) {
  const [result, setResult] = useState<AttackSurfaceResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      setResult(await lookupAttackSurface({ data: { target } }));
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className={`${CARD} p-4 space-y-3`}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-mono text-xs font-bold text-[#F3F4F6]">
          <Server className="size-4 text-[#10B981]" />
          Attack Surface — Shodan InternetDB
        </span>
        <Button
          size="sm"
          onClick={run}
          disabled={loading || !target.trim()}
          className="h-7 rounded bg-[#10B981] px-3 font-mono text-[10px] font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#10B981]/90"
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : "Probe"}
        </Button>
      </div>

      <p className={`font-mono text-[10px] leading-relaxed ${DIM}`}>
        Resolves the target over Cloudflare DoH, then queries Shodan's keyless InternetDB for
        observed ports, software and known CVEs. Passive only — nothing is sent to the target.
      </p>

      {error && <ErrorNote message={error} />}

      {result && (
        <div className="space-y-3">
          <div className={`font-mono text-[10px] ${DIM}`}>
            {result.hostname} → {result.addresses.join(", ")} · retrieved{" "}
            {new Date(result.retrievedAt).toLocaleTimeString()}
          </div>

          {result.hosts.map((h) => (
            <div key={h.ip} className="rounded border border-[#263548] bg-[#0B1220] p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-bold text-[#F3F4F6]">{h.ip}</span>
                {h.scanned ? (
                  <Badge className="border-[#10B981]/30 bg-[#10B981]/10 text-[10px] text-[#10B981]">
                    {h.ports.length} port{h.ports.length === 1 ? "" : "s"}
                  </Badge>
                ) : (
                  <Badge className="border-[#64748B]/30 bg-[#64748B]/10 text-[10px] text-[#94A3B8]">
                    No Shodan record
                  </Badge>
                )}
              </div>

              {!h.scanned && (
                <div className={`font-mono text-[10px] ${MUTED}`}>
                  Shodan has never observed internet-facing services on this address.
                </div>
              )}

              {h.scanned && (
                <div className="space-y-1.5 font-mono text-[10px]">
                  {h.ports.length > 0 && (
                    <div className={MUTED}>
                      <span className={DIM}>Ports: </span>
                      {h.ports.join(", ")}
                    </div>
                  )}
                  {h.hostnames.length > 0 && (
                    <div className={MUTED}>
                      <span className={DIM}>Hostnames: </span>
                      {h.hostnames.join(", ")}
                    </div>
                  )}
                  {h.cpes.length > 0 && (
                    <div className={MUTED}>
                      <span className={DIM}>Software: </span>
                      {h.cpes.join(", ")}
                    </div>
                  )}
                  {h.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {h.tags.map((t) => (
                        <Badge
                          key={t}
                          className="border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[9px] text-[#3B82F6]"
                        >
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {h.vulns.length > 0 && (
                    <div className="flex items-start gap-1.5 pt-1">
                      <ShieldAlert className="size-3 shrink-0 text-[#EF4444]" />
                      <span className="text-[#EF4444]">
                        {h.vulns.length} known CVE{h.vulns.length === 1 ? "" : "s"}:{" "}
                        {h.vulns.slice(0, 12).join(", ")}
                        {h.vulns.length > 12 && ` +${h.vulns.length - 12} more`}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Certificate Transparency subdomain discovery.
 *
 * This is the native stand-in for theHarvester's highest-yield passive source.
 * CT logs record every hostname a public CA has ever issued a certificate for,
 * so they surface subdomains that were never linked or indexed — and reading
 * them sends nothing to the target.
 */
function SubdomainPanel({ target }: { target: string }) {
  const [findings, setFindings] = useState<SubdomainFinding[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const domain = toDomain(target);

  const run = async () => {
    setLoading(true);
    setError("");
    setFindings(null);
    try {
      setFindings(await crtShSubdomains({ data: { domain } }));
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className={`${CARD} p-4 space-y-3`}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-mono text-xs font-bold text-[#F3F4F6]">
          <ShieldCheck className="size-4 text-[#06B6D4]" />
          Subdomains — Certificate Transparency (crt.sh)
        </span>
        <Button
          size="sm"
          onClick={run}
          disabled={loading || !domain}
          className="h-7 rounded bg-[#06B6D4] px-3 font-mono text-[10px] font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#06B6D4]/90"
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : "Enumerate"}
        </Button>
      </div>

      <p className={`font-mono text-[10px] leading-relaxed ${DIM}`}>
        Reads public Certificate Transparency logs for hostnames under{" "}
        <span className="text-[#06B6D4]">{domain || "—"}</span>. Passive — nothing is sent to the
        target. Only certificates a public CA logged appear here; internal or self-signed hosts will
        not.
      </p>

      {error && <ErrorNote message={error} />}

      {/* An empty result is a finding, and must not read like a failed lookup. */}
      {findings?.length === 0 && (
        <div
          className={`rounded border border-[#263548] bg-[#0B1220] p-3 font-mono text-[10px] leading-relaxed ${MUTED}`}
        >
          No certificates for {domain} in the public CT logs. That is a result, not a failure — the
          domain may use no publicly logged certificate.
        </div>
      )}

      {findings && findings.length > 0 && (
        <div className="space-y-2">
          <div className={`font-mono text-[10px] ${DIM}`}>
            {findings.length} hostname{findings.length === 1 ? "" : "s"} found
          </div>
          <div className="max-h-80 overflow-y-auto rounded border border-[#263548] bg-[#0B1220]">
            {findings.map((f) => (
              <div
                key={f.hostname}
                className="flex items-baseline justify-between gap-3 border-b border-[#263548]/50 px-3 py-1.5 last:border-0"
              >
                <span className="font-mono text-[11px] font-bold text-[#F3F4F6]">{f.hostname}</span>
                <span className={`shrink-0 font-mono text-[9px] ${DIM}`}>
                  {/* null is rendered as "not reported", never as a guessed CA or today's date. */}
                  {f.issuer ?? "issuer not reported"} · {f.firstSeen ?? "date not reported"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Capability gaps, rendered verbatim from `RECON_NOTES`.
 *
 * §8 requires a capability we cannot deliver to be declared with its reason
 * rather than silently omitted. An evaluator who knows this field will ask why
 * there is no SpiderFoot or Maltego integration; the answer is an architectural
 * constraint, and saying so is stronger than leaving a hole.
 */
function ReconGaps() {
  return (
    <Card className={`${CARD} p-4 space-y-3`}>
      <span className="flex items-center gap-2 font-mono text-xs font-bold text-[#F3F4F6]">
        <Info className="size-4 text-[#94A3B8]" />
        What external recon does not do, and why
      </span>

      <div className="space-y-2">
        {RECON_NOTES.map((gap) => (
          <div
            key={gap.capability}
            className="rounded border border-[#263548] bg-[#0B1220] p-3 space-y-1"
          >
            <div className="font-mono text-[11px] font-bold text-[#F3F4F6]">{gap.capability}</div>
            <div className={`font-mono text-[10px] leading-relaxed ${MUTED}`}>
              <span className={DIM}>Requires: </span>
              {gap.requires}
            </div>
            {gap.licence && (
              <div className={`font-mono text-[10px] leading-relaxed ${MUTED}`}>
                <span className={DIM}>Licence: </span>
                {gap.licence}
              </div>
            )}
            <div className={`font-mono text-[10px] leading-relaxed ${MUTED}`}>
              <span className={DIM}>Limitation: </span>
              {gap.limitation}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function DorkPanel({ target }: { target: string }) {
  const [outlet, setOutlet] = useState("reuters.com");
  const [active, setActive] = useState<DorkTemplate | null>(null);
  const [query, setQuery] = useState("");
  const [manualUrl, setManualUrl] = useState<string | undefined>();
  const [hits, setHits] = useState<DorkHit[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const select = async (template: DorkTemplate) => {
    setActive(template);
    setError("");
    setHits(null);
    setManualUrl(undefined);
    setCopied(false);

    let built;
    try {
      built = buildDork(template, target, outlet);
    } catch (err: any) {
      setQuery("");
      setError(err?.message ?? String(err));
      return;
    }

    setQuery(built.query);

    // Web-scoped dorks are handed to the analyst; only news-scoped ones run here.
    if (built.manualUrl) {
      setManualUrl(built.manualUrl);
      return;
    }

    setLoading(true);
    try {
      const res = await runNewsDork({ data: { query: built.query, limit: 25 } });
      setHits(res.hits);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(query);
      setCopied(true);
    } catch {
      setError("Clipboard unavailable — select the query text and copy manually.");
    }
  };

  const news = DORK_TEMPLATES.filter((t) => t.scope === "news");
  const web = DORK_TEMPLATES.filter((t) => t.scope === "web");

  const renderTemplate = (t: DorkTemplate) => (
    <button
      key={t.id}
      onClick={() => select(t)}
      className={`w-full rounded border p-2.5 text-left transition-colors ${
        active?.id === t.id
          ? "border-[#06B6D4] bg-[#06B6D4]/5"
          : "border-[#263548] bg-[#0B1220] hover:border-[#06B6D4]/50"
      }`}
    >
      <div className="font-mono text-[11px] font-bold text-[#F3F4F6]">{t.label}</div>
      <div className={`font-mono text-[9px] leading-relaxed ${DIM}`}>{t.purpose}</div>
    </button>
  );

  return (
    <Card className={`${CARD} p-4 space-y-3`}>
      <span className="flex items-center gap-2 font-mono text-xs font-bold text-[#F3F4F6]">
        <Search className="size-4 text-[#06B6D4]" />
        Google Dork Builder
      </span>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <div className={`font-mono text-[10px] font-bold uppercase tracking-wider ${DIM}`}>
            Executable · Google News index
          </div>
          {news.map(renderTemplate)}

          <div className="flex items-center gap-2 pt-1">
            <span className={`font-mono text-[10px] ${DIM}`}>Outlet:</span>
            <Input
              value={outlet}
              onChange={(e) => setOutlet(e.target.value)}
              placeholder="reuters.com"
              className="h-7 border-[#263548] bg-[#0B1220] font-mono text-[10px] text-[#F3F4F6]"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className={`font-mono text-[10px] font-bold uppercase tracking-wider ${DIM}`}>
            Manual · full web index
          </div>
          {web.map(renderTemplate)}
        </div>
      </div>

      {query && (
        <div className="space-y-2 rounded border border-[#263548] bg-[#0B1220] p-3">
          <div className="flex items-start justify-between gap-2">
            <code className="break-all font-mono text-[11px] text-[#06B6D4]">{query}</code>
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                onClick={copy}
                className="h-6 rounded bg-[#1A2332] px-2 font-mono text-[9px] text-[#94A3B8] hover:bg-[#263548]"
              >
                <Copy className="mr-1 size-3" />
                {copied ? "Copied" : "Copy"}
              </Button>
              {manualUrl && (
                <a href={manualUrl} target="_blank" rel="noopener noreferrer">
                  <Button
                    size="sm"
                    className="h-6 rounded bg-[#3B82F6] px-2 font-mono text-[9px] text-[#F3F4F6] hover:bg-[#3B82F6]/90"
                  >
                    <ExternalLink className="mr-1 size-3" />
                    Open
                  </Button>
                </a>
              )}
            </div>
          </div>

          {manualUrl && (
            <p className={`font-mono text-[9px] leading-relaxed ${DIM}`}>
              Full-web dork. Google publishes no free web-search API and scraping their results page
              breaches their terms, so this is not executed here — open it in your own browser. No
              results are shown above because none were retrieved.
            </p>
          )}
        </div>
      )}

      {error && <ErrorNote message={error} />}
      {loading && (
        <div className={`flex items-center gap-2 font-mono text-[10px] ${MUTED}`}>
          <Loader2 className="size-3 animate-spin" /> Querying Google News index…
        </div>
      )}

      {hits && hits.length === 0 && (
        <div className={`font-mono text-[10px] ${MUTED}`}>
          Query executed successfully and matched no articles. This is an empty result, not a
          failure — the dork is likely too narrow.
        </div>
      )}

      {hits && hits.length > 0 && (
        <div className="space-y-1.5">
          <div className={`font-mono text-[10px] ${DIM}`}>{hits.length} results</div>
          {hits.map((h, i) => (
            <a
              key={`${h.url}-${i}`}
              href={h.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded border border-[#263548] bg-[#0B1220] p-2.5 hover:border-[#06B6D4]/50"
            >
              <div className="font-mono text-[11px] text-[#F3F4F6]">{h.title}</div>
              <div className={`font-mono text-[9px] ${DIM}`}>
                {h.source}
                {h.pubDate && ` · ${new Date(h.pubDate).toLocaleString()}`}
              </div>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

const EXECUTION_STATUS_STYLE: Record<string, string> = {
  completed: "border-[#10B981]/30 bg-[#10B981]/10 text-[#10B981]",
  partial: "border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[#F59E0B]",
  failed: "border-[#EF4444]/30 bg-[#EF4444]/10 text-[#EF4444]",
  cancelled: "border-[#64748B]/30 bg-[#64748B]/10 text-[#94A3B8]",
  queued: "border-[#64748B]/30 bg-[#64748B]/10 text-[#94A3B8]",
  running: "border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[#3B82F6]",
};

const POLL_INTERVAL_MS = 1200;
/**
 * A large domain can legitimately return thousands of entities — cloudflare.com
 * returned 3,461 in testing, almost all crt.sh subdomains, a real result, not a
 * bug. Rendering all of them into the DOM uncapped is a real performance/UX
 * problem discovered by testing against an actual large target, not a
 * hypothetical one. Capped here, in the UI layer only — the underlying data
 * (and a report generated from it, once that exists) is unaffected.
 */
const MAX_RENDERED_ITEMS = 200;

/**
 * Multi-collector OSINT investigation — OSINT-INTEGRATION-PLAN.md §31 P2
 * "Investigation start" + "Progress" + "Collector status" + "Recon collector
 * selection".
 *
 * Target type is auto-detected (`planOsintInvestigation`, re-run whenever
 * `target` changes) and every matching collector is offered as a checked-by-
 * default checkbox the analyst can deselect before running — the plan
 * preview never starts anything itself, it only lists candidates. Uses the
 * job-polling system (`jobs.ts`) rather than the synchronous orchestrator:
 * `startOsintInvestigationJob` returns immediately, and this component polls
 * `pollOsintInvestigationJob` every `POLL_INTERVAL_MS` until every job
 * reaches a terminal status, showing each collector's status live as it
 * changes rather than only once everything finishes. This is the first UI
 * consumer `jobs.ts` has ever had — before this it was fully built and
 * tested but unreachable from the app, the same "control with no handler"
 * gap the theHarvester/SpiderFoot registration bug turned out to be (see the
 * plan doc's §21a for that one).
 *
 * Entity resolution is NOT applied here — `pollInvestigation` (unlike
 * `runOsintInvestigation`) returns raw per-collector entities, since
 * merging happens once at the end in `orchestrator.ts`'s wrapper and doing
 * it on every poll tick would be wasted work for a set that's still
 * growing. A later refinement could resolve once `done` is true.
 */
function InvestigationPanel({ target }: { target: string }) {
  const navigate = useNavigate();
  const [started, setStarted] = useState<StartedInvestigation | null>(null);
  const [poll, setPoll] = useState<InvestigationPoll | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [plan, setPlan] = useState<OsintPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const stoppedRef = useRef(false);

  // Preview which collectors this target would trigger, so the analyst can
  // deselect some before running — plan §31 P2 "Recon collector selection."
  // Re-plans whenever the committed target changes; `target` only updates on
  // "Set Target"/Enter upstream (ReconPage's own `input` state is separate),
  // so this does not re-fire on every keystroke.
  useEffect(() => {
    let cancelled = false;
    if (!target.trim()) {
      setPlan(null);
      setSelected(new Set());
      return;
    }
    (async () => {
      try {
        const data = (await planOsintInvestigation({ data: { target } })) as OsintPlan;
        if (cancelled) return;
        setPlan(data);
        setSelected(new Set(data.collectors.map((c) => c.collectorId)));
      } catch {
        if (cancelled) return;
        setPlan(null);
        setSelected(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  const toggleCollector = (collectorId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(collectorId)) next.delete(collectorId);
      else next.add(collectorId);
      return next;
    });
  };

  const run = async () => {
    setRunning(true);
    setError("");
    setStarted(null);
    setPoll(null);
    try {
      const data = await startOsintInvestigationJob({
        data: { target, collectorIds: [...selected] },
      });
      setStarted(data as StartedInvestigation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  useEffect(() => {
    if (!started || !running) return;
    stoppedRef.current = false;

    const tick = async () => {
      let data: InvestigationPoll;
      try {
        data = (await pollOsintInvestigationJob({
          data: { investigationId: started.investigationId },
        })) as InvestigationPoll;
      } catch (err) {
        if (stoppedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setRunning(false);
        return;
      }
      if (stoppedRef.current) return;
      setPoll(data);
      if (data.done) {
        setRunning(false);
        return;
      }
      if (!stoppedRef.current) setTimeout(tick, POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      stoppedRef.current = true;
    };
  }, [started, running]);

  const jobs: InvestigationJob[] = poll?.jobs ?? started?.jobs ?? [];

  const viewInGraph = () => {
    if (!started || !poll) return;
    saveGraphSnapshot({
      investigationId: started.investigationId,
      target,
      savedAt: new Date().toISOString(),
      entities: poll.entities,
      relationships: poll.relationships,
    });
    void navigate({ to: "/graph" });
  };

  return (
    <Card className={`${CARD} p-4 space-y-3`}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-mono text-xs font-bold text-[#F3F4F6]">
          <Network className="size-4 text-[#8B5CF6]" />
          OSINT Investigation — multi-collector
        </span>
        <Button
          size="sm"
          onClick={run}
          disabled={running || !target.trim() || selected.size === 0}
          className="h-7 rounded bg-[#8B5CF6] px-3 font-mono text-[10px] font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#8B5CF6]/90"
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : "Run Investigation"}
        </Button>
      </div>

      <p className={`font-mono text-[10px] leading-relaxed ${DIM}`}>
        Auto-detects the target type, offers every collector that supports it (DNS, RDAP, crt.sh,
        Shodan InternetDB, Dorks, News, Social — theHarvester and SpiderFoot only if a worker is
        configured) for selection below, then polls for live status until every selected job
        finishes.
      </p>

      {plan && plan.collectors.length > 0 && (
        <div className="space-y-1.5">
          <div className={`font-mono text-[10px] font-bold uppercase tracking-wider ${DIM}`}>
            Collectors to run ({selected.size}/{plan.collectors.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {plan.collectors.map((c) => (
              <label
                key={c.collectorId}
                className={`flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] transition-colors ${
                  selected.has(c.collectorId)
                    ? "border-[#8B5CF6]/40 bg-[#8B5CF6]/10 text-[#F3F4F6]"
                    : "border-[#263548] bg-[#0B1220] text-[#64748B]"
                }`}
                title={c.reason}
              >
                <Checkbox
                  checked={selected.has(c.collectorId)}
                  disabled={running}
                  onCheckedChange={() => toggleCollector(c.collectorId)}
                  className="size-3"
                />
                {c.collectorId}
              </label>
            ))}
          </div>
        </div>
      )}

      {plan && plan.collectors.length === 0 && (
        <div className={`font-mono text-[10px] ${MUTED}`}>
          No registered collector supports the detected target type ({plan.detected.primaryType}).
        </div>
      )}

      {error && <ErrorNote message={error} />}

      {started && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className={`font-mono text-[10px] ${DIM}`}>
              Detected type:{" "}
              <span className="text-[#8B5CF6]">{started.plan.detected.primaryType}</span>
              {started.plan.detected.alternateTypes.length > 0 &&
                ` (also considered: ${started.plan.detected.alternateTypes.join(", ")})`}
              {running && !poll?.done && " · polling…"}
            </div>
            {poll && poll.entities.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={viewInGraph}
                className="h-6 shrink-0 gap-1.5 rounded border-[#8B5CF6]/40 bg-transparent px-2 font-mono text-[9px] font-bold uppercase tracking-wider text-[#8B5CF6] hover:bg-[#8B5CF6]/10"
              >
                <Share2 className="size-2.5" />
                View in Graph
              </Button>
            )}
          </div>

          <div className="space-y-1.5">
            <div className={`font-mono text-[10px] font-bold uppercase tracking-wider ${DIM}`}>
              Collectors ({jobs.length})
            </div>
            {jobs.length === 0 && (
              <div className={`font-mono text-[10px] ${MUTED}`}>
                No collectors ran — either none support this target type, or none were selected.
              </div>
            )}
            {jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between gap-2 rounded border border-[#263548] bg-[#0B1220] px-3 py-1.5"
              >
                <span className="font-mono text-[11px] text-[#F3F4F6]">{job.collector}</span>
                <Badge
                  className={`text-[9px] ${
                    EXECUTION_STATUS_STYLE[job.status] ?? EXECUTION_STATUS_STYLE.cancelled
                  }`}
                >
                  {job.status === "running" && (
                    <Loader2 className="mr-1 inline size-2.5 animate-spin" />
                  )}
                  {job.status}
                  {job.error && ` · ${job.error.reason}`}
                </Badge>
              </div>
            ))}
          </div>

          {poll && poll.entities.length > 0 && (
            <div className="space-y-1.5">
              <div className={`font-mono text-[10px] font-bold uppercase tracking-wider ${DIM}`}>
                Entities ({poll.entities.length})
                {poll.entities.length > MAX_RENDERED_ITEMS &&
                  ` — showing first ${MAX_RENDERED_ITEMS}`}
              </div>
              <div className="max-h-80 overflow-y-auto rounded border border-[#263548] bg-[#0B1220]">
                {poll.entities.slice(0, MAX_RENDERED_ITEMS).map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between gap-3 border-b border-[#263548]/50 px-3 py-1.5 last:border-0"
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                      <Badge className="shrink-0 border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[9px] text-[#3B82F6]">
                        {e.type}
                      </Badge>
                      <span className="truncate font-mono text-[11px] text-[#F3F4F6]">
                        {e.displayName}
                      </span>
                    </div>
                    <span className={`shrink-0 font-mono text-[9px] ${DIM}`}>
                      {e.confidence.value !== null
                        ? `${Math.round(e.confidence.value * 100)}%`
                        : e.source}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {poll && poll.evidence.length > 0 && (
            <div className="space-y-1.5">
              <button
                onClick={() => setShowEvidence((s) => !s)}
                className={`flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider ${DIM} hover:text-[#8B5CF6]`}
              >
                {showEvidence ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                Evidence ({poll.evidence.length}) — every fact's source, never dropped
                {poll.evidence.length > MAX_RENDERED_ITEMS &&
                  ` (showing first ${MAX_RENDERED_ITEMS})`}
              </button>
              {showEvidence && (
                <div className="max-h-96 overflow-y-auto rounded border border-[#263548] bg-[#0B1220]">
                  {poll.evidence.slice(0, MAX_RENDERED_ITEMS).map((ev, i) => (
                    <div
                      key={i}
                      className="space-y-1 border-b border-[#263548]/50 px-3 py-2 last:border-0"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge className="shrink-0 border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[9px] text-[#3B82F6]">
                          {ev.collector}
                        </Badge>
                        <span className={`shrink-0 font-mono text-[9px] ${DIM}`}>
                          {new Date(ev.collectedAt).toLocaleString()}
                        </span>
                      </div>
                      <div className={`truncate font-mono text-[10px] ${MUTED}`}>
                        {ev.source}
                        {ev.confidence?.value != null &&
                          ` · ${Math.round(ev.confidence.value * 100)}% confidence`}
                      </div>
                      <div className={`truncate font-mono text-[9px] ${DIM}`}>
                        {JSON.stringify(ev.normalizedValue)}
                      </div>
                      {ev.sourceUrl && (
                        <a
                          href={ev.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[9px] text-[#3B82F6] hover:underline"
                        >
                          <ExternalLink className="size-2.5" /> {ev.sourceUrl}
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {poll && poll.warnings.length > 0 && (
            <div className="space-y-1">
              {poll.warnings.map((w, i) => (
                <div key={i} className={`font-mono text-[10px] leading-relaxed ${MUTED}`}>
                  ⚠ {w}
                </div>
              ))}
            </div>
          )}

          {poll && poll.errors.length > 0 && (
            <div className="space-y-1">
              {poll.errors.map((e, i) => (
                <ErrorNote key={i} message={e} />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function ReconPage() {
  const [target, setTarget] = useState(() => getActiveTarget());
  const [input, setInput] = useState(() => getActiveTarget());

  const commit = () => {
    const next = input.trim();
    if (!next || next === target) return;
    setTarget(next);
    setActiveTarget(next);
  };

  return (
    <AppShell>
      <PageHeader
        title="Recon & Dork Builder"
        description="Passive attack-surface enumeration via Shodan InternetDB, and Google dork construction against the news index."
      />

      <div className="space-y-4 p-6">
        <Card className={`${CARD} p-4`}>
          <div className="flex items-center gap-2">
            <Radar className="size-4 shrink-0 text-[#06B6D4]" />
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              placeholder="Target domain, IP, organisation or person…"
              className="h-9 border-[#263548] bg-[#0B1220] font-mono text-xs text-[#F3F4F6]"
            />
            <Button
              size="sm"
              onClick={commit}
              className="h-9 shrink-0 rounded bg-[#06B6D4] px-4 font-mono text-[10px] font-bold uppercase tracking-wider text-[#0B1220] hover:bg-[#06B6D4]/90"
            >
              Set Target
            </Button>
          </div>
          <div className={`pt-2 font-mono text-[10px] ${DIM}`}>
            Active target: <span className="text-[#06B6D4]">{target || "none"}</span>
          </div>
        </Card>

        <AttackSurfacePanel target={target} />
        <SubdomainPanel target={target} />
        <DorkPanel target={target} />
        <InvestigationPanel target={target} />
        <ReconGaps />
      </div>
    </AppShell>
  );
}
