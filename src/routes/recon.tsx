import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Radar, Server, ShieldAlert, Search, ExternalLink, Copy, Loader2, AlertTriangle,
} from "lucide-react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { lookupAttackSurface, type AttackSurfaceResult } from "@/utils/attack-surface";
import {
  DORK_TEMPLATES, buildDork, runNewsDork, type DorkHit, type DorkTemplate,
} from "@/utils/dorks";

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
              Full-web dork. Google publishes no free web-search API and scraping their results
              page breaches their terms, so this is not executed here — open it in your own
              browser. No results are shown above because none were retrieved.
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
        <DorkPanel target={target} />
      </div>
    </AppShell>
  );
}
