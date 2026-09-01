import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Cpu,
  Layers,
  Terminal,
  Activity,
  CheckCircle2,
  Globe,
  Radio,
  Wifi,
  RefreshCw,
  Car,
  Sparkles,
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
import { getLocalNetworkDevices, type LocalNetworkInfo } from "@/utils/local-network";
import { fetchVehicleOSINT, type VehicleIntelligenceResult } from "@/utils/vehicle-osint";

export const Route = createFileRoute("/recon")({
  head: () => ({ meta: [{ title: "Module 2 OSINT & Recon — Sentinel AI" }] }),
  component: ReconPage,
});

const CARD = "bg-console-surface/90 border-console-border backdrop-blur-sm shadow-md";
const MUTED = "text-console-muted";
const DIM = "text-console-label";

/** Explicit failure surface. Never replaced by placeholder results. */
function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-console-red/40 bg-console-red/10 p-3.5 shadow-sm">
      <AlertTriangle className="size-4 shrink-0 text-console-red mt-0.5" />
      <div className="space-y-1">
        <div className="font-mono text-xs font-bold uppercase tracking-wider text-console-red">
          System Notice
        </div>
        <span className="font-mono text-xs leading-relaxed text-console-red/90">{message}</span>
      </div>
    </div>
  );
}

function AttackSurfacePanel({ target: initialTarget }: { target: string }) {
  const [target, setTarget] = useState(initialTarget);
  const [result, setResult] = useState<AttackSurfaceResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialTarget) {
      setTarget(initialTarget);
    }
  }, [initialTarget]);

  const run = async () => {
    if (!target.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      setResult(await lookupAttackSurface({ data: { target: target.trim() } }));
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className={`${CARD} p-5 space-y-4`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-console-border/60 pb-3">
        <div>
          <span className="flex items-center gap-2 font-mono text-sm font-bold text-console-text">
            <Server className="size-4 text-console-green" />
            Shodan InternetDB — Attack Surface & Device Classifier
          </span>
          <p className={`font-mono text-xs leading-relaxed ${DIM} mt-1`}>
            Passive keyless query across Shodan's observed ports, software CPEs, CVEs, and device signatures (CCTV, Routers, IoT).
          </p>
        </div>
        <Badge variant="outline" className="w-fit font-mono text-[10px] border-console-green/40 text-console-green bg-console-green/10">
          100% Free & Keyless
        </Badge>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Enter IP address (e.g. 8.8.8.8) or domain (e.g. example.com)..."
          className="h-9 font-mono text-xs bg-console-deep border-console-border text-console-text placeholder:text-console-muted"
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <Button
          size="sm"
          onClick={run}
          disabled={loading || !target.trim()}
          className="h-9 shrink-0 rounded bg-console-green px-5 font-mono text-xs font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-green/90 shadow-sm"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <Radar className="size-3.5 mr-1.5" />}
          {loading ? "Probing Host..." : "Probe IP / Domain"}
        </Button>
      </div>

      {error && <ErrorNote message={error} />}

      {result && (
        <div className="space-y-4 pt-2">
          <div className="flex items-center justify-between font-mono text-xs border-b border-console-border/40 pb-2">
            <span className="text-console-text font-bold">
              {result.hostname} → <span className="text-console-green">{result.addresses.join(", ")}</span>
            </span>
            <span className={DIM}>Retrieved {new Date(result.retrievedAt).toLocaleTimeString()}</span>
          </div>

          {result.hosts.map((h) => (
            <div key={h.ip} className="rounded-md border border-console-border bg-console-deep p-4 space-y-3 shadow-inner">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-console-border/40 pb-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-sm font-bold text-console-text">{h.ip}</span>
                  {h.shodanUrl && (
                    <a
                      href={h.shodanUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-console-green hover:underline flex items-center gap-1 text-xs font-mono font-medium"
                    >
                      <ExternalLink className="size-3" />
                      View Host Profile on Shodan
                    </a>
                  )}
                </div>
                {h.scanned ? (
                  <Badge className="border-console-green/40 bg-console-green/15 text-xs text-console-green font-mono">
                    {h.ports.length} Open Port{h.ports.length === 1 ? "" : "s"}
                  </Badge>
                ) : (
                  <Badge className="border-console-label/40 bg-console-label/10 text-xs text-console-muted font-mono">
                    No Shodan Record
                  </Badge>
                )}
              </div>

              {!h.scanned && (
                <div className={`font-mono text-xs ${MUTED} italic`}>
                  Shodan has never observed internet-facing services on this IP address.
                </div>
              )}

              {h.scanned && (
                <div className="space-y-2.5 font-mono text-xs">
                  {h.devices?.detectedDevices && h.devices.detectedDevices.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pb-1">
                      <span className="text-[10px] uppercase font-bold text-console-amber mr-1">Detected Hardware:</span>
                      {h.devices.detectedDevices.map((dev) => (
                        <Badge
                          key={dev}
                          className="border-console-amber/50 bg-console-amber/20 text-xs text-console-amber font-bold"
                        >
                          {dev}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {h.ports.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={`${DIM} mr-1 font-bold`}>Open Ports:</span>
                      {h.ports.map((p) => (
                        <span key={p} className="inline-block rounded bg-console-elevated px-2 py-0.5 text-xs text-console-text font-bold border border-console-border">
                          {p}
                        </span>
                      ))}
                    </div>
                  )}

                  {h.hostnames.length > 0 && (
                    <div className={MUTED}>
                      <span className={`${DIM} font-bold`}>Hostnames: </span>
                      <span className="text-console-text">{h.hostnames.join(", ")}</span>
                    </div>
                  )}

                  {h.cpes.length > 0 && (
                    <div className={MUTED}>
                      <span className={`${DIM} font-bold`}>Software CPEs: </span>
                      <span className="text-console-text">{h.cpes.join(", ")}</span>
                    </div>
                  )}

                  {h.tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      <span className={`${DIM} text-[10px] uppercase font-bold mr-1`}>Tags:</span>
                      {h.tags.map((t) => (
                        <Badge
                          key={t}
                          className="border-console-cyan/40 bg-console-cyan/10 text-[10px] text-console-cyan"
                        >
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {h.vulns.length > 0 && (
                    <div className="flex flex-wrap items-start gap-1.5 pt-2 border-t border-console-border/40">
                      <ShieldAlert className="size-4 shrink-0 text-console-red mt-0.5" />
                      <div className="text-console-red font-bold">
                        {h.vulns.length} Known CVE{h.vulns.length === 1 ? "" : "s"}:
                        <div className="flex flex-wrap gap-1 mt-1 font-mono text-[10px]">
                          {h.vulns.map((v) => (
                            <span key={v} className="rounded bg-console-red/20 border border-console-red/40 px-1.5 py-0.5 text-console-red">
                              {v}
                            </span>
                          ))}
                        </div>
                      </div>
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
    <Card className={`${CARD} p-5 space-y-4`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-console-border/60 pb-3">
        <div>
          <span className="flex items-center gap-2 font-mono text-sm font-bold text-console-text">
            <ShieldCheck className="size-4 text-console-cyan" />
            Certificate Transparency Log Subdomain Enumeration (crt.sh)
          </span>
          <p className={`font-mono text-xs leading-relaxed ${DIM} mt-1`}>
            Queries public CT logs for hostnames issued to <span className="text-console-cyan font-bold">{domain || "target domain"}</span>.
          </p>
        </div>
        <Button
          size="sm"
          onClick={run}
          disabled={loading || !domain}
          className="h-8 shrink-0 rounded bg-console-cyan px-4 font-mono text-xs font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-cyan/90 shadow-sm"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <Search className="size-3.5 mr-1" />}
          Enumerate CT Logs
        </Button>
      </div>

      {error && <ErrorNote message={error} />}

      {findings?.length === 0 && (
        <div className={`rounded-md border border-console-border bg-console-deep p-4 font-mono text-xs leading-relaxed ${MUTED}`}>
          No certificates recorded for <span className="text-console-text font-bold">{domain}</span> in public CT logs.
        </div>
      )}

      {findings && findings.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between font-mono text-xs">
            <span className="font-bold text-console-cyan">{findings.length} Subdomains Discovered</span>
            <span className={DIM}>Source: Public Certificate Authorities</span>
          </div>
          <div className="max-h-96 overflow-y-auto rounded-md border border-console-border bg-console-deep">
            {findings.map((f) => (
              <div
                key={f.hostname}
                className="flex items-baseline justify-between gap-3 border-b border-console-border/50 px-4 py-2 hover:bg-console-surface/50 transition-colors last:border-0"
              >
                <span className="font-mono text-xs font-bold text-console-text">{f.hostname}</span>
                <span className={`shrink-0 font-mono text-[10px] ${DIM}`}>
                  {f.issuer ?? "Issuer not reported"} · {f.firstSeen ?? "Date not reported"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
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
      className={`w-full rounded-md border p-3 text-left transition-all ${
        active?.id === t.id
          ? "border-console-cyan bg-console-cyan/10 ring-1 ring-console-cyan/30"
          : "border-console-border bg-console-deep hover:border-console-cyan/50 hover:bg-console-surface/40"
      }`}
    >
      <div className="font-mono text-xs font-bold text-console-text flex items-center gap-1.5">
        <Search className="size-3.5 text-console-cyan" />
        {t.label}
      </div>
      <div className={`font-mono text-[10px] leading-relaxed ${DIM} mt-1`}>{t.purpose}</div>
    </button>
  );

  return (
    <Card className={`${CARD} p-5 space-y-4`}>
      <div className="border-b border-console-border/60 pb-3">
        <span className="flex items-center gap-2 font-mono text-sm font-bold text-console-text">
          <Search className="size-4 text-console-cyan" />
          Interactive Google Dork Builder
        </span>
        <p className={`font-mono text-xs leading-relaxed ${DIM} mt-1`}>
          Construct specialized Google dorks for News RSS indexes and web reconnaissance.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2.5">
          <div className={`font-mono text-xs font-bold uppercase tracking-wider text-console-cyan border-b border-console-border/40 pb-1`}>
            Executable · Google News Index
          </div>
          <div className="space-y-2">{news.map(renderTemplate)}</div>

          <div className="flex items-center gap-2 pt-2">
            <span className={`font-mono text-xs font-bold ${DIM}`}>Target News Outlet:</span>
            <Input
              value={outlet}
              onChange={(e) => setOutlet(e.target.value)}
              placeholder="reuters.com"
              className="h-8 border-console-border bg-console-deep font-mono text-xs text-console-text"
            />
          </div>
        </div>

        <div className="space-y-2.5">
          <div className={`font-mono text-xs font-bold uppercase tracking-wider text-console-blue border-b border-console-border/40 pb-1`}>
            Manual Launch · Full Web Index
          </div>
          <div className="space-y-2">{web.map(renderTemplate)}</div>
        </div>
      </div>

      {query && (
        <div className="space-y-2.5 rounded-md border border-console-cyan/40 bg-console-cyan/5 p-4 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <code className="break-all font-mono text-xs font-bold text-console-cyan">{query}</code>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                onClick={copy}
                className="h-7 rounded bg-console-elevated px-3 font-mono text-xs text-console-text hover:bg-console-border border border-console-border"
              >
                <Copy className="mr-1.5 size-3" />
                {copied ? "Copied!" : "Copy Dork"}
              </Button>
              {manualUrl && (
                <a href={manualUrl} target="_blank" rel="noopener noreferrer">
                  <Button
                    size="sm"
                    className="h-7 rounded bg-console-blue px-3 font-mono text-xs font-bold text-console-text hover:bg-console-blue/90"
                  >
                    <ExternalLink className="mr-1.5 size-3" />
                    Open in Google
                  </Button>
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {error && <ErrorNote message={error} />}
      {loading && (
        <div className={`flex items-center gap-2 font-mono text-xs ${MUTED} py-2`}>
          <Loader2 className="size-4 animate-spin text-console-cyan" /> Executing dork against Google News index…
        </div>
      )}

      {hits && hits.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-console-border/40">
          <div className={`font-mono text-xs font-bold text-console-cyan`}>{hits.length} Articles Matched</div>
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {hits.map((h, i) => (
              <a
                key={`${h.url}-${i}`}
                href={h.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-md border border-console-border bg-console-deep p-3 hover:border-console-cyan/50 hover:bg-console-surface/50 transition-all"
              >
                <div className="font-mono text-xs font-bold text-console-text">{h.title}</div>
                <div className={`font-mono text-[10px] ${DIM} mt-1`}>
                  {h.source} {h.pubDate && `· ${new Date(h.pubDate).toLocaleString()}`}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function LocalNetworkPanel() {
  const [data, setData] = useState<LocalNetworkInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const scan = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await getLocalNetworkDevices();
      setData(res as LocalNetworkInfo);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void scan();
  }, []);

  return (
    <Card className={`${CARD} p-5 space-y-5`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-console-border/60 pb-3">
        <div>
          <span className="flex items-center gap-2 font-mono text-base font-bold text-console-green">
            <Wifi className="size-5 text-console-green animate-pulse" />
            Wi-Fi Network Scanner & LAN Recon
          </span>
          <p className={`font-mono text-xs leading-relaxed ${DIM} mt-1`}>
            Scan nearby Wi-Fi access points and view SSID, Signal %, Channel, Security, and BSSID MAC addresses via a real, forced scan through Windows' own <code className="text-console-green">WiFiAdapter</code> API (falls back to <code className="text-console-green">netsh</code> if unavailable).
          </p>
        </div>
        <Button
          size="sm"
          onClick={scan}
          disabled={loading}
          className="h-9 shrink-0 rounded bg-console-green px-4 font-mono text-xs font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-green/90 shadow-sm"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <RefreshCw className="size-3.5 mr-1.5" />}
          {loading ? "Scanning Networks..." : "Scan Nearby Wi-Fi"}
        </Button>
      </div>

      {error && <ErrorNote message={error} />}

      {data && (
        <div className="space-y-6 font-mono text-xs">
          {/* Top Section: Cyber Radar Scope & Nearby Wi-Fi Networks in Range */}
          <div className="grid gap-5 lg:grid-cols-12 items-start">
            {/* Left Column: Nearby Scanned Wi-Fi Networks Console */}
            <div className="lg:col-span-6 space-y-4">
              <div className="rounded-lg border border-console-border bg-console-deep p-4 space-y-2 font-mono text-[11px]">
                <div className="flex items-center justify-between font-bold text-console-text border-b border-console-border/40 pb-2">
                  <span className="text-console-green flex items-center gap-1.5 font-bold uppercase tracking-wider text-xs">
                    <Wifi className="size-4 text-console-green" />
                    Nearby Scanned Wi-Fi Networks ({data.wifiNetworks?.length || 0})
                  </span>
                  <span className={DIM}>{new Date(data.scannedAt).toLocaleTimeString()}</span>
                </div>

                <div className="space-y-1.5 pt-1">
                  {data.wifiNetworks?.map((net, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between gap-2 border-b border-console-border/30 py-2 text-[11px] last:border-0 hover:bg-console-surface/40 px-1 rounded transition-colors"
                    >
                      <div className="flex items-center gap-2 font-bold truncate">
                        <span className="text-console-muted">[{idx + 1}]</span>
                        <span className="text-console-text truncate max-w-[140px]">{net.ssid}</span>
                        {net.isConnected && (
                          <Badge className="border-console-green/50 bg-console-green/20 text-[8px] text-console-green font-bold">
                            CONNECTED
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-console-green font-bold">
                          Signal: {net.signal}%
                        </span>
                        <Badge
                          variant="outline"
                          className={`text-[9px] font-bold ${
                            net.security.includes("Open")
                              ? "border-console-red/60 text-console-red bg-console-red/10"
                              : net.security.includes("WPA3")
                              ? "border-console-cyan/60 text-console-cyan bg-console-cyan/10"
                              : "border-console-green/60 text-console-green bg-console-green/10"
                          }`}
                        >
                          {net.security}
                        </Badge>
                        <span className="text-console-muted text-[10px]">Ch: {net.channel}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Column: Cyber Radar Scope */}
            <div className="lg:col-span-6 space-y-4">
              <div className="relative flex flex-col items-center justify-center rounded-lg border border-console-green/50 bg-[#040D0B] p-6 shadow-2xl overflow-hidden min-h-[320px]">
                <div className="absolute top-3 left-3 text-[10px] font-bold tracking-widest text-console-green flex items-center gap-2 uppercase">
                  <span className="inline-block size-2 rounded-full bg-console-green animate-ping" />
                  SCANNING FOR NEARBY WI-FI NETWORKS
                </div>

                <div className="relative size-72 rounded-full border-2 border-console-green/40 flex items-center justify-center shadow-[0_0_25px_rgba(34,197,94,0.15)] my-4">
                  <div className="absolute size-56 rounded-full border border-console-green/30" />
                  <div className="absolute size-36 rounded-full border border-console-green/20" />
                  <div className="absolute size-16 rounded-full border border-console-green/20" />
                  <div className="absolute size-2 rounded-full bg-console-green shadow-[0_0_8px_#22c55e]" />

                  <div className="absolute w-full h-[1px] bg-console-green/25" />
                  <div className="absolute h-full w-[1px] bg-console-green/25" />

                  <div
                    className="absolute inset-0 rounded-full animate-spin"
                    style={{ animationDuration: "3.5s" }}
                  >
                    <div
                      className="w-1/2 h-1/2 origin-bottom-right"
                      style={{
                        background:
                          "conic-gradient(from 180deg at 100% 100%, transparent 0deg, rgba(34, 197, 94, 0.35) 60deg, transparent 60deg)",
                      }}
                    />
                  </div>

                  {(() => {
                    // Strongest signals shown on the radar itself — the full
                    // list (however many were really found) is already the
                    // scrollable panel on the left; the radar is a
                    // supplementary view, not the primary data source, so it
                    // doesn't need to fit everything.
                    const shown = [...(data.wifiNetworks ?? [])].sort((a, b) => b.signal - a.signal).slice(0, 6);
                    // Evenly spaced by rank, not a fixed lookup table — the
                    // previous version used 5 hardcoded angles that could
                    // land two high-signal (small-radius) networks at very
                    // different angles but nearly the same tiny radius,
                    // colliding regardless of angle. Spacing derived from
                    // the real count guarantees angular separation scales
                    // with how many are actually shown.
                    const angleStep = (2 * Math.PI) / shown.length;
                    return shown.map((net, i) => {
                      const angle = i * angleStep - Math.PI / 2;
                      // Stronger signal sits closer to center, but never
                      // closer than 60px — a small radius compresses the
                      // physical distance between angularly-separated labels
                      // (arc length = radius × angle), which is the other
                      // half of what caused the original collision.
                      const radius = 60 + (100 - net.signal) * 0.55;
                      const x = Math.cos(angle) * radius;
                      const y = Math.sin(angle) * radius;

                      return (
                        <div
                          key={net.ssid + net.bssid}
                          className="absolute flex items-center gap-1.5 px-2 py-1 rounded-md bg-console-deep/90 border border-console-green/60 shadow-lg text-[9px] font-bold z-10 transition-all hover:scale-105 hover:z-20"
                          style={{ transform: `translate(${x}px, ${y}px)` }}
                          title={`${net.ssid} — ${net.signal}%, ${net.security}, ch ${net.channel}`}
                        >
                          <Wifi className="size-3 text-console-green shrink-0 animate-pulse" />
                          <span className="text-console-text truncate max-w-[76px]">{net.ssid}</span>
                          <span className="text-console-green font-bold">{net.signal}%</span>
                        </div>
                      );
                    });
                  })()}
                </div>

                <div className="w-full rounded-md border border-console-border/70 bg-console-deep/80 p-3 space-y-1.5 text-[10px] text-console-muted">
                  <div className="font-bold text-console-text flex items-center gap-1.5 uppercase tracking-wider text-[11px]">
                    <Sparkles className="size-3.5 text-console-amber" />
                    Tips & Info
                  </div>
                  <ul className="space-y-1 pl-1">
                    <li className="flex items-center gap-1.5">
                      <span className="text-console-green font-bold">✓</span> Scans only nearby visible Wi-Fi networks in range.
                    </li>
                    <li className="flex items-center gap-1.5">
                      <span className="text-console-green font-bold">✓</span> Forces a real Wi-Fi scan via Windows'{" "}
                      <code className="text-console-cyan">WiFiAdapter</code> API — a properly awaited scan takes several
                      real seconds, not an instant read of a stale cache.
                    </li>
                    <li className="flex items-center gap-1.5">
                      <span className="text-console-green font-bold">✓</span> Radar shows the {Math.min(6, data.wifiNetworks?.length ?? 0)} strongest
                      signals; the full list is on the left.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Currently Connected Wi-Fi Network HUD Banner */}
          {data.connectedWifi && (
            <div className="rounded-lg border border-console-green/50 bg-console-green/10 p-4 space-y-3 shadow-md border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-console-green/30 pb-2">
                <div className="flex items-center gap-2">
                  <Radio className="size-4 text-console-green animate-pulse" />
                  <span className="font-mono text-xs font-bold text-console-text uppercase tracking-wider">YOUR CONNECTED WI-FI NETWORK:</span>
                  <span className="font-mono text-sm font-extrabold text-console-green bg-console-green/20 px-2.5 py-0.5 rounded border border-console-green/40">
                    {data.connectedWifi.ssid}
                  </span>
                </div>
                <Badge className="border-console-green/60 bg-console-green/30 text-console-green text-[10px] font-bold uppercase tracking-wider">
                  CONNECTED (ACTIVE HOST LINK)
                </Badge>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4 font-mono text-xs">
                <div className="rounded border border-console-border/40 bg-console-deep/60 p-2 space-y-0.5">
                  <span className="text-console-muted text-[10px] uppercase block font-bold">Access Point BSSID</span>
                  <span className="font-bold text-console-text text-xs font-mono">{data.connectedWifi.bssid}</span>
                </div>
                <div className="rounded border border-console-border/40 bg-console-deep/60 p-2 space-y-0.5">
                  <span className="text-console-muted text-[10px] uppercase block font-bold">Signal & Band</span>
                  <span className="font-bold text-console-green text-xs">{data.connectedWifi.signal}% · Ch {data.connectedWifi.channel} ({data.connectedWifi.radioType})</span>
                </div>
                <div className="rounded border border-console-border/40 bg-console-deep/60 p-2 space-y-0.5">
                  <span className="text-console-muted text-[10px] uppercase block font-bold">Host IPv4 Address</span>
                  <span className="font-bold text-console-cyan text-xs font-mono">{data.connectedWifi.ipAddress || data.interfaces[0]?.ip || "Not detected"}</span>
                </div>
                <div className="rounded border border-console-border/40 bg-console-deep/60 p-2 space-y-0.5">
                  <span className="text-console-muted text-[10px] uppercase block font-bold">Wi-Fi Gateway Router</span>
                  <span className="font-bold text-console-amber text-xs font-mono">{data.connectedWifi.gatewayIp || "Not detected"}</span>
                </div>
              </div>
            </div>
          )}

          {/* Devices Connected to Your Wi-Fi Network */}
          <div className="space-y-2 pt-2 border-t border-console-border/40">
            <div className="flex items-center justify-between font-bold uppercase text-console-green text-[11px]">
              <span className="flex items-center gap-1.5">
                <Network className="size-3.5 text-console-green" />
                Devices Connected to "{data.connectedWifi?.ssid || "Your Wi-Fi Network"}" ({data.neighbors.length} Active Devices)
              </span>
              <span className={DIM}>Scanned: {new Date(data.scannedAt).toLocaleTimeString()}</span>
            </div>

            {data.neighbors.length === 0 ? (
              <div className={`rounded-md border border-console-border bg-console-deep p-4 text-center ${MUTED}`}>
                No active devices detected on local Wi-Fi subnet.
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto rounded-md border border-console-border bg-console-deep">
                {data.neighbors.map((n, idx) => (
                  <div
                    key={n.ip + idx}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-console-border/40 px-4 py-3 hover:bg-console-surface/50 transition-colors last:border-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-console-cyan text-sm">{n.ip}</span>
                      {n.isGateway ? (
                        <Badge className="border-console-green/50 bg-console-green/20 text-[9px] text-console-green font-bold">
                          Wi-Fi Router Gateway
                        </Badge>
                      ) : n.isHost ? (
                        <Badge className="border-console-amber/50 bg-console-amber/20 text-[9px] text-console-amber font-bold">
                          This PC (Local Host)
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className={`text-[9px] font-bold ${
                            n.deviceCategory === "Smartphone"
                              ? "border-console-cyan/60 text-console-cyan bg-console-cyan/10"
                              : n.deviceCategory === "Smart TV / Media"
                              ? "border-console-purple/60 text-console-purple bg-console-purple/10"
                              : n.deviceCategory === "Laptop / PC"
                              ? "border-console-amber/60 text-console-amber bg-console-amber/10"
                              : "border-console-border text-console-muted"
                          }`}
                        >
                          {n.deviceCategory || "Connected Client"}
                        </Badge>
                      )}
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 text-[11px]">
                      <div className="flex flex-col text-left sm:text-right">
                        <span className="text-console-text font-bold text-xs">{n.deviceName || n.vendor}</span>
                        <span className="text-console-muted text-[10px]">{n.vendor}</span>
                      </div>
                      <span className="text-console-muted font-mono text-[10px] bg-console-surface px-2 py-0.5 rounded border border-console-border shrink-0">
                        MAC: {n.mac}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Local Host Interfaces */}
          <div className="space-y-2 pt-4 border-t border-console-border/50">
            <div className="font-bold uppercase text-console-amber text-[11px]">
              Local Host Interfaces ({data.interfaces.length})
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.interfaces.map((iface) => (
                <div key={iface.name} className="rounded-md border border-console-border bg-console-deep p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-console-text">{iface.name}</span>
                    <Badge className="border-console-amber/40 bg-console-amber/15 text-[10px] text-console-amber font-bold">
                      {iface.family}
                    </Badge>
                  </div>
                  <div className="text-console-amber font-bold text-sm">{iface.ip}</div>
                  <div className={DIM}>Netmask: {iface.netmask}</div>
                  <div className={MUTED}>MAC: {iface.mac || "Not reported"}</div>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}
    </Card>
  );
}

function VehicleOsintPanel() {
  const [vehicleQuery, setVehicleQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<VehicleIntelligenceResult | null>(null);

  const handleLookup = async () => {
    if (!vehicleQuery.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetchVehicleOSINT({ data: { target: vehicleQuery.trim() } });
      setResult(res as VehicleIntelligenceResult);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className={`${CARD} p-5 space-y-4`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-console-border/60 pb-3">
        <div>
          <span className="flex items-center gap-2 font-mono text-sm font-bold text-console-text">
            <Car className="size-4 text-console-cyan" />
            Vehicle Registration Plate & VIN OSINT Intelligence
          </span>
          <p className={`font-mono text-xs leading-relaxed ${DIM} mt-1`}>
            Keyless OSINT lookup for Vehicle Registration Numbers (e.g. MH12DE1432, KA01MJ9999, DL3CCE1234) & 17-character VINs.
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <Input
          value={vehicleQuery}
          onChange={(e) => setVehicleQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          placeholder="Enter Vehicle Plate (e.g. MH12DE1432, KA01MJ9999) or 17-digit VIN..."
          className="h-9 font-mono text-xs bg-console-deep border-console-border text-console-text placeholder:text-console-muted shadow-inner"
        />
        <Button
          size="sm"
          onClick={handleLookup}
          disabled={loading || !vehicleQuery.trim()}
          className="h-9 shrink-0 rounded bg-console-cyan px-4 font-mono text-xs font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-cyan/90 shadow-sm"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <Search className="size-3.5 mr-1.5" />}
          Lookup Vehicle
        </Button>
      </div>

      {error && <ErrorNote message={error} />}

      {result && (
        <div className="space-y-4 font-mono text-xs pt-2 border-t border-console-border/50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-console-muted">Target:</span>
              <span className="font-bold text-console-cyan bg-console-cyan/10 px-2 py-0.5 rounded border border-console-cyan/30">
                {result.target}
              </span>
              <Badge className="border-console-green/40 bg-console-green/15 text-[10px] text-console-green font-bold uppercase">
                {result.type === "vin" ? "17-Digit Global VIN" : "Vehicle License Plate"}
              </Badge>
            </div>
            {result.officialPortalUrl && (
              <a
                href={result.officialPortalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-console-blue/20 text-console-blue border border-console-blue/40 text-[11px] font-bold hover:bg-console-blue/30 transition-colors"
              >
                <ExternalLink className="size-3" />
                Official Transport Portal
              </a>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            <div className="rounded-md border border-console-border bg-console-deep p-3 space-y-1">
              <span className="text-console-muted text-[10px] uppercase block font-bold">Make / Manufacturer</span>
              <span className="font-bold text-console-text text-sm block">{result.make || "Not reported"}</span>
            </div>
            <div className="rounded-md border border-console-border bg-console-deep p-3 space-y-1">
              <span className="text-console-muted text-[10px] uppercase block font-bold">Model / Series</span>
              <span className="font-bold text-console-text text-sm block">{result.model || "Not reported"}</span>
            </div>
            <div className="rounded-md border border-console-border bg-console-deep p-3 space-y-1">
              <span className="text-console-muted text-[10px] uppercase block font-bold">Vehicle Class / Category</span>
              <span className="font-bold text-console-amber text-sm block">{result.vehicleClass || "Motor Vehicle"}</span>
            </div>
            <div className="rounded-md border border-console-border bg-console-deep p-3 space-y-1">
              <span className="text-console-muted text-[10px] uppercase block font-bold">Registration State / Region</span>
              <span className="font-bold text-console-text text-xs block">{result.stateOrRegion || "Not reported"}</span>
            </div>
            <div className="rounded-md border border-console-border bg-console-deep p-3 space-y-1">
              <span className="text-console-muted text-[10px] uppercase block font-bold">RTO / Registration Authority</span>
              <span className="font-bold text-console-cyan text-xs block">{result.rtoLocation || "Not reported"}</span>
            </div>
            <div className="rounded-md border border-console-border bg-console-deep p-3 space-y-1">
              <span className="text-console-muted text-[10px] uppercase block font-bold">Fuel Type</span>
              <span className="font-bold text-console-green text-xs block">{result.fuelType || "Petrol / Diesel / EV"}</span>
            </div>
          </div>

          {result.externalPortals && result.externalPortals.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-console-border/40">
              <span className="font-bold text-console-cyan text-[11px] uppercase block flex items-center gap-1.5">
                <ExternalLink className="size-3.5" />
                1-Click Verification Portals (Real-Time Vehicle RC Reports)
              </span>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {result.externalPortals.map((p, idx) => (
                  <a
                    key={idx}
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex flex-col p-2.5 rounded border border-console-cyan/30 bg-console-cyan/5 hover:bg-console-cyan/15 hover:border-console-cyan/60 transition-all text-left group"
                  >
                    <div className="flex items-center justify-between font-bold text-console-text group-hover:text-console-cyan text-xs">
                      <span>{p.name}</span>
                      <ExternalLink className="size-3 shrink-0 text-console-muted group-hover:text-console-cyan" />
                    </div>
                    <span className="text-[10px] text-console-muted leading-tight mt-1">
                      {p.description}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {Object.keys(result.rawDetails).length > 0 && (
            <div className="space-y-2 pt-2 border-t border-console-border/40">
              <span className="font-bold text-console-text text-[11px] uppercase block">Detailed Intelligence Attributes</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(result.rawDetails).map(([k, v]) => (
                  <div key={k} className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-console-border/40 py-1.5 text-[11px] gap-1">
                    <span className="text-console-muted font-semibold shrink-0">{k}:</span>
                    {v.startsWith("http") ? (
                      <a href={v} target="_blank" rel="noopener noreferrer" className="text-console-blue hover:underline font-bold truncate max-w-[280px]">
                        {v}
                      </a>
                    ) : (
                      <span className="text-console-text font-bold leading-relaxed">{v}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function ReconGaps() {
  return (
    <Card className={`${CARD} p-5 space-y-4`}>
      <div className="border-b border-console-border/60 pb-3">
        <span className="flex items-center gap-2 font-mono text-sm font-bold text-console-text">
          <Cpu className="size-4 text-console-muted" />
          Framework Capabilities & Architecture Notes
        </span>
        <p className={`font-mono text-xs leading-relaxed ${DIM} mt-1`}>
          System limitations, licensing boundaries, and integration notes for external Kali / Azure OSINT workers.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {RECON_NOTES.map((gap) => (
          <div
            key={gap.capability}
            className="rounded-md border border-console-border bg-console-deep p-4 space-y-2 shadow-inner"
          >
            <div className="font-mono text-xs font-bold text-console-text border-b border-console-border/40 pb-1.5 flex items-center justify-between">
              <span>{gap.capability}</span>
              <Badge variant="outline" className="text-[9px] border-console-muted text-console-muted font-mono">
                Declared Boundary
              </Badge>
            </div>
            <div className={`font-mono text-[11px] leading-relaxed ${MUTED}`}>
              <span className={`${DIM} font-bold`}>Requires: </span>
              {gap.requires}
            </div>
            {gap.licence && (
              <div className={`font-mono text-[11px] leading-relaxed ${MUTED}`}>
                <span className={`${DIM} font-bold`}>Licence: </span>
                {gap.licence}
              </div>
            )}
            <div className={`font-mono text-[11px] leading-relaxed ${MUTED}`}>
              <span className={`${DIM} font-bold`}>Limitation: </span>
              {gap.limitation}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const EXECUTION_STATUS_STYLE: Record<string, string> = {
  completed: "border-console-green/40 bg-console-green/15 text-console-green",
  partial: "border-console-amber/40 bg-console-amber/15 text-console-amber",
  failed: "border-console-red/40 bg-console-red/15 text-console-red",
  cancelled: "border-console-label/40 bg-console-label/15 text-console-muted",
  queued: "border-console-label/40 bg-console-label/15 text-console-muted",
  running: "border-console-blue/40 bg-console-blue/15 text-console-blue font-bold",
};

const MAX_RENDERED_ITEMS = 200;
const POLL_INTERVAL_MS = 1200;

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
    <Card className={`${CARD} p-5 space-y-4`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-console-border/60 pb-3">
        <div>
          <span className="flex items-center gap-2 font-mono text-sm font-bold text-console-text">
            <Network className="size-4 text-console-purple" />
            Automated Multi-Collector OSINT Suite
          </span>
          <p className={`font-mono text-xs leading-relaxed ${DIM} mt-1`}>
            Orchestrates parallel OSINT collectors (DNS, RDAP, crt.sh, Shodan InternetDB, Dorks, News, Social) with real-time job polling and entity graph generation.
          </p>
        </div>
        <Button
          size="sm"
          onClick={run}
          disabled={running || !target.trim() || selected.size === 0}
          className="h-8 shrink-0 rounded bg-console-purple px-4 font-mono text-xs font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-purple/90 shadow-sm"
        >
          {running ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <Activity className="size-3.5 mr-1.5" />}
          {running ? "Running Suite..." : "Run OSINT Suite"}
        </Button>
      </div>

      {plan && plan.collectors.length > 0 && (
        <div className="space-y-2">
          <div className={`font-mono text-xs font-bold uppercase tracking-wider ${DIM}`}>
            Select Active Collectors ({selected.size}/{plan.collectors.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {plan.collectors.map((c) => (
              <label
                key={c.collectorId}
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-xs transition-all ${
                  selected.has(c.collectorId)
                    ? "border-console-purple/50 bg-console-purple/15 text-console-text font-bold"
                    : "border-console-border bg-console-deep text-console-muted hover:border-console-purple/30"
                }`}
                title={c.reason}
              >
                <Checkbox
                  checked={selected.has(c.collectorId)}
                  disabled={running}
                  onCheckedChange={() => toggleCollector(c.collectorId)}
                  className="size-3.5"
                />
                {c.collectorId}
              </label>
            ))}
          </div>
        </div>
      )}

      {error && <ErrorNote message={error} />}

      {started && (
        <div className="space-y-4 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-console-border/40 pb-2.5">
            <div className={`font-mono text-xs ${DIM}`}>
              Target Type: <span className="text-console-purple font-bold">{started.plan.detected.primaryType}</span>
              {running && !poll?.done && <span className="text-console-purple font-bold ml-2 animate-pulse">● Polling live results...</span>}
            </div>
            {poll && poll.entities.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={viewInGraph}
                className="h-7 gap-1.5 rounded border-console-purple/50 bg-console-purple/10 font-mono text-xs font-bold uppercase tracking-wider text-console-purple hover:bg-console-purple/20"
              >
                <Share2 className="size-3" />
                View in Knowledge Graph
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <div className={`font-mono text-xs font-bold uppercase tracking-wider ${DIM}`}>
              Collector Execution Jobs ({jobs.length})
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-console-border bg-console-deep px-3 py-2"
                >
                  <span className="font-mono text-xs font-bold text-console-text truncate">{job.collector}</span>
                  <Badge
                    className={`text-[10px] font-mono ${
                      EXECUTION_STATUS_STYLE[job.status] ?? EXECUTION_STATUS_STYLE.cancelled
                    }`}
                  >
                    {job.status === "running" && <Loader2 className="mr-1 inline size-3 animate-spin" />}
                    {job.status}
                  </Badge>
                </div>
              ))}
            </div>
          </div>

          {poll && poll.entities.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className={`font-mono text-xs font-bold uppercase tracking-wider ${DIM}`}>
                Discovered Entities ({poll.entities.length})
              </div>
              <div className="max-h-80 overflow-y-auto rounded-md border border-console-border bg-console-deep">
                {poll.entities.slice(0, MAX_RENDERED_ITEMS).map((e) => {
                  // Only some entity types carry a real URL as their value
                  // (article, social_account — see identity-websearch.ts /
                  // presence-username.ts). A domain, IP, email or username
                  // has no single canonical page to open, so those rows stay
                  // plain rather than fabricating a destination. This was
                  // visually implying every row was clickable (a hover
                  // highlight with no handler behind it) when none of them
                  // were.
                  const href = e.value.startsWith("http") ? e.value : null;
                  const row = (
                    <>
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        <Badge className="shrink-0 border-console-blue/40 bg-console-blue/15 text-[10px] text-console-blue font-bold">
                          {e.type}
                        </Badge>
                        <span className="truncate font-mono text-xs text-console-text font-bold">
                          {e.displayName}
                        </span>
                        {href && <ExternalLink className="size-3 shrink-0 text-console-label" />}
                      </div>
                      <span className={`shrink-0 font-mono text-[10px] ${DIM}`}>
                        {e.confidence.value !== null ? `${Math.round(e.confidence.value * 100)}% Conf` : e.source}
                      </span>
                    </>
                  );
                  return href ? (
                    <a
                      key={e.id}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-3 border-b border-console-border/50 px-3.5 py-2 hover:bg-console-surface/50 transition-colors last:border-0"
                    >
                      {row}
                    </a>
                  ) : (
                    <div
                      key={e.id}
                      className="flex items-center justify-between gap-3 border-b border-console-border/50 px-3.5 py-2 last:border-0"
                    >
                      {row}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {poll && poll.evidence.length > 0 && (
            <div className="space-y-2 pt-2">
              <button
                onClick={() => setShowEvidence((s) => !s)}
                className={`flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider ${DIM} hover:text-console-purple transition-colors`}
              >
                {showEvidence ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                Evidence Log ({poll.evidence.length} facts)
              </button>
              {showEvidence && (
                <div className="max-h-96 overflow-y-auto rounded-md border border-console-border bg-console-deep p-2 space-y-2">
                  {poll.evidence.slice(0, MAX_RENDERED_ITEMS).map((ev, i) => (
                    <div key={i} className="rounded border border-console-border/60 bg-console-surface/40 p-2.5 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <Badge className="shrink-0 border-console-blue/40 bg-console-blue/15 text-[9px] text-console-blue font-bold">
                          {ev.collector}
                        </Badge>
                        <span className={`shrink-0 font-mono text-[10px] ${DIM}`}>
                          {new Date(ev.collectedAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className={`truncate font-mono text-xs font-bold text-console-text`}>
                        {ev.source}
                      </div>
                      <div className={`truncate font-mono text-[10px] ${DIM}`}>
                        {JSON.stringify(ev.normalizedValue)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function ReconPage() {
  const [target, setTarget] = useState("");
  const [input, setInput] = useState("");
  const [activeTab, setActiveTab] = useState("investigation");

  useEffect(() => {
    const initial = getActiveTarget();
    setTarget(initial);
    setInput(initial);

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setTarget(e.detail);
        setInput(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  const commit = () => {
    const next = input.trim();
    if (!next) return;
    setTarget(next);
    setActiveTarget(next);
  };

  return (
    <AppShell>
      <PageHeader
        title="Module 2: OSINT & Attack Surface Intelligence"
        description="Automated multi-collector OSINT suite, keyless Shodan InternetDB device classifier, crt.sh subdomains, and Google Dork builder."
      />

      <div className="space-y-5 p-6">
        {/* Active Target Hero Bar */}
        <Card className={`${CARD} p-4 border-console-cyan/40 bg-gradient-to-r from-console-surface via-console-surface to-console-cyan/5`}>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="flex items-center gap-2 shrink-0 font-mono text-xs font-bold text-console-cyan">
              <Radar className="size-5 text-console-cyan animate-pulse" />
              <span>ACTIVE TARGET:</span>
            </div>
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              placeholder="Enter Domain, IP Address, Username, or Person name..."
              className="h-10 border-console-border bg-console-deep font-mono text-sm text-console-text placeholder:text-console-muted shadow-inner"
            />
            <Button
              size="sm"
              onClick={commit}
              className="h-10 shrink-0 rounded bg-console-cyan px-5 font-mono text-xs font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-cyan/90 shadow-md"
            >
              Set Active Target
            </Button>
          </div>
          <div className="flex items-center justify-between pt-2.5 border-t border-console-border/40 mt-3 font-mono text-xs">
            <div className="flex items-center gap-2">
              <span className={DIM}>Target Committed:</span>
              <span className="font-bold text-console-cyan bg-console-cyan/10 px-2 py-0.5 rounded border border-console-cyan/30">
                {target || "None (Type a target above)"}
              </span>
            </div>
            <div className="hidden md:flex items-center gap-4 text-[11px] text-console-muted">
              <span className="flex items-center gap-1"><Server className="size-3 text-console-green" /> Shodan Free</span>
              <span className="flex items-center gap-1"><ShieldCheck className="size-3 text-console-cyan" /> crt.sh Logs</span>
              <span className="flex items-center gap-1"><Network className="size-3 text-console-purple" /> Multi-Collector</span>
            </div>
          </div>
        </Card>

        {/* Tabbed Navigation Interface */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="flex flex-wrap h-auto gap-1 border border-console-border bg-console-surface p-1 mb-5 justify-start rounded-md font-mono">
            <TabsTrigger
              value="investigation"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-console-muted hover:text-console-text data-[state=active]:bg-console-purple/20 data-[state=active]:text-console-purple data-[state=active]:border-console-purple/40 border border-transparent rounded-md transition-all"
            >
              <Network className="size-3.5" />
              Multi-Collector OSINT
            </TabsTrigger>
            <TabsTrigger
              value="attack-surface"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-console-muted hover:text-console-text data-[state=active]:bg-console-green/20 data-[state=active]:text-console-green data-[state=active]:border-console-green/40 border border-transparent rounded-md transition-all"
            >
              <Server className="size-3.5" />
              Shodan Attack Surface
            </TabsTrigger>
            <TabsTrigger
              value="subdomains"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-console-muted hover:text-console-text data-[state=active]:bg-console-cyan/20 data-[state=active]:text-console-cyan data-[state=active]:border-console-cyan/40 border border-transparent rounded-md transition-all"
            >
              <ShieldCheck className="size-3.5" />
              crt.sh Subdomains
            </TabsTrigger>
            <TabsTrigger
              value="dorks"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-console-muted hover:text-console-text data-[state=active]:bg-console-blue/20 data-[state=active]:text-console-blue data-[state=active]:border-console-blue/40 border border-transparent rounded-md transition-all"
            >
              <Search className="size-3.5" />
              Google Dork Builder
            </TabsTrigger>
            <TabsTrigger
              value="lan"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-console-muted hover:text-console-text data-[state=active]:bg-console-amber/20 data-[state=active]:text-console-amber data-[state=active]:border-console-amber/40 border border-transparent rounded-md transition-all"
            >
              <Wifi className="size-3.5 text-console-amber" />
              Local Wi-Fi LAN Scanner
            </TabsTrigger>
            <TabsTrigger
              value="vehicle"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-console-muted hover:text-console-text data-[state=active]:bg-console-cyan/20 data-[state=active]:text-console-cyan data-[state=active]:border-console-cyan/40 border border-transparent rounded-md transition-all"
            >
              <Car className="size-3.5 text-console-cyan" />
              Vehicle & VIN OSINT
            </TabsTrigger>
            <TabsTrigger
              value="capabilities"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-console-muted hover:text-console-text data-[state=active]:bg-console-elevated data-[state=active]:text-console-text data-[state=active]:border-console-border border border-transparent rounded-md transition-all"
            >
              <Cpu className="size-3.5" />
              Architecture Notes
            </TabsTrigger>
          </TabsList>

          <TabsContent value="investigation">
            <InvestigationPanel target={target} />
          </TabsContent>
          <TabsContent value="attack-surface">
            <AttackSurfacePanel target={target} />
          </TabsContent>
          <TabsContent value="subdomains">
            <SubdomainPanel target={target} />
          </TabsContent>
          <TabsContent value="dorks">
            <DorkPanel target={target} />
          </TabsContent>
          <TabsContent value="lan">
            <LocalNetworkPanel />
          </TabsContent>
          <TabsContent value="vehicle">
            <VehicleOsintPanel />
          </TabsContent>
          <TabsContent value="capabilities">
            <ReconGaps />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
