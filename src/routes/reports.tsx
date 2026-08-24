import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  FileBarChart,
  Loader2,
  AlertTriangle,
  Info,
  Search,
  Download,
  FileText,
  Sparkles,
  Check,
  Trash2,
  ChevronDown,
  ChevronRight,
  Shield,
  Network,
} from "lucide-react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { fetchNews } from "./news";
import { clusterStories, type Article } from "@/utils/analysis";
import { bandFor, defaultFactors, scoreCorpus } from "@/utils/credibility";
import {
  generateIntelligenceProduct,
  renumber,
  sourcesFromArticles,
  sourcesFromGeo,
  sourcesFromOsintEvidence,
  sourcesFromOsintRelationships,
  toMarkdown,
  PRODUCT_TYPES,
  type IntelligenceProduct,
  type ProductType,
  type SourceRef,
} from "@/utils/reports";
import { renderProductPdf } from "@/utils/report-pdf";
import { fetchGeoLayers } from "@/utils/geo-sources";
import { runOsintInvestigation } from "@/utils/osint/orchestrator";
import type { Investigation } from "@/utils/osint/orchestrator";
import { LlmQuotaCard } from "@/components/llm-quota";

/**
 * Report Generator — Module 5 (PS-18 §6.5), the convergence layer.
 *
 * §6.5 is the only place the problem statement names the open-source LLM
 * requirement explicitly, so the model is shown on the product, in the PDF
 * footer of every page, and in the provenance block. That visibility is
 * compliance evidence.
 *
 * The analyst sees and controls the inputs BEFORE anything is generated: every
 * candidate source is listed with its Module 1 credibility and can be excluded.
 * A product is only ever built from sources the analyst kept, and every claim in
 * it is validated to resolve against one of them.
 */

/**
 * How many sources are pre-selected for generation.
 *
 * Sized against the free tier that actually serves this: Groq allows 8,000
 * tokens per minute for openai/gpt-oss-120b, and a 45-source context measured
 * 13,705. Twelve leaves room for the prompt, the reasoning budget these models
 * spend before answering, and the product itself.
 */
export const DEFAULT_SOURCE_BUDGET = 12;

export const Route = createFileRoute("/reports")({
  head: () => ({ meta: [{ title: "Report Generator — Sentinel AI" }] }),
  component: ReportsPage,
});

const CARD = "bg-console-surface border-console-border";
const STORE_KEY = "sentinel_products";

function loadProducts(): IntelligenceProduct[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProducts(list: IntelligenceProduct[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-25)));
  } catch {
    /* quota — the in-memory list is unaffected */
  }
}

function ReportsPage() {
  // Empty on both server and first client render — getActiveTarget() reads
  // localStorage, unavailable during SSR. A synchronous getActiveTarget()
  // call here made the server-rendered text differ from the client's first
  // paint (a React hydration mismatch); a mount effect now sets the real
  // value client-side, after hydration.
  const [target, setTarget] = useState("");
  const [draft, setDraft] = useState("");
  const [type, setType] = useState<ProductType>("EXECUTIVE_BRIEF");

  const [candidates, setCandidates] = useState<SourceRef[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState("");

  const [osintCollecting, setOsintCollecting] = useState(false);
  const [osintError, setOsintError] = useState("");
  const [osintIncluded, setOsintIncluded] = useState<Investigation | null>(null);

  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [products, setProducts] = useState<IntelligenceProduct[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [exporting, setExporting] = useState("");

  useEffect(() => setProducts(loadProducts()), []);

  // ── Preview the inputs. No model call: this is collection and scoring only. ──
  const collect = useCallback(async (subject: string) => {
    setCollecting(true);
    setCollectError("");
    setCandidates([]);
    setExcluded(new Set());
    // A fresh collect() replaces the whole candidate list, so a previously
    // included OSINT investigation (merged into that same list) no longer
    // exists — reset the flag rather than leave it claiming inclusion of
    // sources that were just cleared.
    setOsintIncluded(null);
    setOsintError("");
    try {
      const [newsRes, geoRes] = await Promise.all([
        fetchNews({ data: { query: subject, q: subject } }) as any,
        fetchGeoLayers({ data: { query: subject } }).catch(() => null) as any,
      ]);

      const corpus: Article[] = (newsRes?.stories ?? [])
        .map((s: any, i: number) => ({
          id: String(s.id ?? s.primaryLink ?? i),
          title: s.primaryTitle || "",
          source: s.primarySource || "",
          // The PUBLISHER, not the aggregator redirect. Ordered the other way
          // round, every article on a queried corpus resolved to
          // news.google.com and Module 1 scored the aggregator 35 times.
          url: s.url || "",
          pubDate: s.pubDate || "",
          body: s.body || "",
        }))
        .filter((a: Article) => a.title);

      const clusters = clusterStories(corpus);
      const scored = scoreCorpus(corpus, defaultFactors(), { clusters });

      // Geo records only when they carry a real coordinate — geo.ts already
      // guarantees that, so nothing here can introduce a placed-but-unlocated
      // source into the citation list.
      const geoRecords = (geoRes?.layers ?? []).flatMap((l: any) => l.records ?? []).slice(0, 10);

      const merged = renumber([
        ...sourcesFromArticles(corpus, scored),
        ...sourcesFromGeo(geoRecords),
      ]);
      setCandidates(merged);
      // Pre-exclude past the budget rather than letting generation fail with a
      // 413 the analyst has no way to act on. Sources arrive ordered by Module 1
      // credibility, so this keeps the best-scored material and drops the tail.
      setExcluded(new Set(merged.slice(DEFAULT_SOURCE_BUDGET).map((s) => s.n)));
    } catch (err: any) {
      setCollectError(err?.message ?? String(err));
    } finally {
      setCollecting(false);
    }
  }, []);

  useEffect(() => {
    const initial = getActiveTarget();
    setTarget(initial);
    setDraft(initial);

    // Without this, changing the target via the top-nav search bar while
    // already on this page did nothing until navigating away and back.
    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setTarget(e.detail);
        setDraft(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  useEffect(() => {
    // Skip the empty placeholder — the mount-sync effect above fills in the
    // real target a moment later, which re-triggers this effect via [target].
    if (!target) return;
    collect(target);
  }, [target, collect]);

  /**
   * Runs the same OSINT collector framework `/recon` uses (`runOsintInvestigation`
   * — registers every collector, including theHarvester/SpiderFoot, and applies
   * entity resolution) and appends its evidence and relationships to the
   * existing candidate list, plan §31 P2 "Reports: include external collector
   * results / evidence / relationships."
   *
   * Deliberately a separate, explicit action rather than folded into the
   * automatic `collect()` above: most report subjects here are open-ended
   * topics ("China Taiwan tensions"), not recon targets, and running every
   * OSINT collector — including live crt.sh/Shodan/theHarvester/SpiderFoot
   * calls — on every keystroke-triggered collection would be slow and
   * usually fruitless. An analyst working an actual domain/IP/email subject
   * opts in.
   *
   * Sources are APPENDED, not merged into a fresh `renumber()` of the whole
   * list from scratch — `renumber()` only reassigns numbers by array
   * position, so appending at the end leaves every already-decided
   * inclusion/exclusion (keyed by citation number) valid.
   *
   * A domain with real infrastructure easily returns 30-100+ evidence and
   * relationship items — well past DEFAULT_SOURCE_BUDGET on its own, the same
   * "HTTP 413: tokens per minute" failure the budget trim below already
   * exists to prevent for news/geo collection. So newly-added OSINT sources
   * get the identical treatment: whatever budget room is left after the
   * analyst's EXISTING inclusions is filled first, and the rest are
   * pre-excluded (never silently dropped — re-includable like any other row,
   * and the existing "N pre-excluded" banner already renders correctly for
   * this since it just reads `candidates.length`). Sources already decided
   * before this call are never touched.
   */
  const collectOsint = async () => {
    setOsintCollecting(true);
    setOsintError("");
    try {
      const investigation = (await runOsintInvestigation({
        data: { target },
      })) as unknown as Investigation;
      const osintSources = [
        ...sourcesFromOsintEvidence(investigation.evidence),
        ...sourcesFromOsintRelationships(investigation.relationships, investigation.entities),
      ];
      const priorSelectedCount = candidates.length - excluded.size;
      const remainingBudget = Math.max(0, DEFAULT_SOURCE_BUDGET - priorSelectedCount);
      const merged = renumber([...candidates, ...osintSources]);
      const newNumbers = merged.slice(candidates.length).map((s) => s.n);
      const autoExcludedOsint = newNumbers.slice(remainingBudget);
      setCandidates(merged);
      setExcluded((prev) => new Set([...prev, ...autoExcludedOsint]));
      setOsintIncluded(investigation);
    } catch (err: any) {
      setOsintError(err?.message ?? String(err));
    } finally {
      setOsintCollecting(false);
    }
  };

  /*
   * DEFAULT SOURCE BUDGET.
   *
   * Collection routinely returns 45+ sources, and passing them all exceeded the
   * free tier on every attempt:
   *
   *   HTTP 413: Request too large for model openai/gpt-oss-120b
   *   tokens per minute (TPM): Limit 8000, Requested 13705
   *
   * The failure was surfaced honestly - "No product was produced" - but the
   * page was unusable at its defaults, and the only route to output was for the
   * analyst to hand-deselect about forty rows without being told why.
   *
   * So the first DEFAULT_SOURCE_BUDGET sources are pre-selected. They arrive
   * ordered by Module 1 credibility, so this keeps the best-scored material and
   * drops the tail. The analyst can re-include any row; nothing is hidden, and
   * the count is stated on screen.
   */
  const selected = useMemo(
    () => renumber(candidates.filter((s) => !excluded.has(s.n))),
    [candidates, excluded],
  );

  /** Sources beyond the budget that were pre-excluded, so the UI can say so. */
  const autoTrimmed = useMemo(
    () => Math.max(0, candidates.length - DEFAULT_SOURCE_BUDGET),
    [candidates],
  );

  const meanCredibility = useMemo(() => {
    const scored = selected.map((s) => s.credibility).filter((c): c is number => c !== null);
    return scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  }, [selected]);

  const generate = async () => {
    setGenerating(true);
    setGenError("");
    try {
      const product = (await generateIntelligenceProduct({
        data: { type, subject: target, sources: selected },
      })) as unknown as IntelligenceProduct;
      const next = [...products, product];
      setProducts(next);
      saveProducts(next);
      setOpenId(product.id);
    } catch (err: any) {
      // Never a partial product. Validation failure and provider failure both
      // land here with the real reason.
      setGenError(err?.message ?? String(err));
    } finally {
      setGenerating(false);
    }
  };

  const download = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportPdf = async (product: IntelligenceProduct) => {
    setExporting(`${product.id}-pdf`);
    try {
      const bytes = await renderProductPdf(product);
      download(
        new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }),
        `${product.type}_${product.subject.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`,
      );
    } catch (err: any) {
      setGenError(`PDF export failed: ${err?.message ?? String(err)}`);
    } finally {
      setExporting("");
    }
  };

  const exportMarkdown = (product: IntelligenceProduct) => {
    download(
      new Blob([toMarkdown(product)], { type: "text/markdown" }),
      `${product.type}_${product.subject.replace(/[^a-zA-Z0-9]/g, "_")}.md`,
    );
  };

  const remove = (id: string) => {
    const next = products.filter((p) => p.id !== id);
    setProducts(next);
    saveProducts(next);
  };

  const search = () => {
    const v = draft.trim();
    if (!v) return;
    setActiveTarget(v);
    setTarget(v);
  };

  const spec = PRODUCT_TYPES.find((p) => p.id === type)!;

  return (
    <AppShell>
      <PageHeader
        title="Report Generator"
        description="Intelligence products built only from sources you approve, with every claim traced to a numbered source."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {/* ── Subject and product type ─────────────────────────────────── */}
          <Card className={CARD}>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[220px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-console-label" />
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && search()}
                    placeholder="Subject…"
                    className="h-8 border-console-border bg-console-deep pl-8 text-[11px] text-console-text"
                  />
                </div>
                <Button size="sm" onClick={search} disabled={collecting} className="h-8">
                  {collecting ? <Loader2 className="size-3.5 animate-spin" /> : "Collect sources"}
                </Button>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {PRODUCT_TYPES.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setType(p.id)}
                    className={`rounded border px-2 py-1 text-[10px] ${
                      type === p.id
                        ? "border-console-blue/60 bg-console-blue/10 text-console-blue"
                        : "border-console-border bg-console-deep text-console-label"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-console-muted">
                {spec.description}
              </p>

              {collectError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                  <span className="font-mono text-[10px] text-console-red">{collectError}</span>
                </div>
              )}

              <div className="mt-3 flex items-center gap-2 border-t border-console-border pt-3">
                <Network className="size-3.5 shrink-0 text-console-purple" />
                <p className="flex-1 text-[10px] leading-relaxed text-console-muted">
                  Also run DNS/RDAP/crt.sh/Shodan/dorks/news/social/theHarvester/SpiderFoot against
                  "{target}" and cite their evidence and relationships. Most useful when the subject
                  is a domain, IP, email or similar recon target — a general topic subject will
                  likely return nothing, which is expected.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={collectOsint}
                  disabled={osintCollecting || collecting || !target.trim()}
                  className="h-7 shrink-0 gap-1.5 border-console-purple/40 text-[10px] text-console-purple hover:bg-console-purple/10"
                >
                  {osintCollecting ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Network className="size-3" />
                  )}
                  {osintCollecting ? "Running…" : "Include OSINT investigation"}
                </Button>
              </div>

              {osintIncluded && (
                <>
                  <p className="mt-1.5 font-mono text-[9px] text-console-purple">
                    Included: {osintIncluded.evidence.length} evidence item(s) and{" "}
                    {osintIncluded.relationships.length} relationship(s) from{" "}
                    {osintIncluded.plan.collectors.length} candidate collector(s).
                  </p>
                  {osintIncluded.errors.map((e, i) => (
                    <p key={i} className="mt-0.5 font-mono text-[9px] text-console-amber">
                      ⚠ {e}
                    </p>
                  ))}
                </>
              )}

              {osintError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                  <span className="font-mono text-[10px] text-console-red">{osintError}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Source preview, BEFORE generation ────────────────────────── */}
          <Card className={CARD}>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Shield className="size-3.5 text-console-green" />
                <h3 className="text-xs font-bold uppercase text-console-text">
                  Sources that will be used
                </h3>
                <span className="ml-auto font-mono text-[10px] text-console-muted">
                  {selected.length} of {candidates.length} included
                  {meanCredibility !== null &&
                    ` · mean credibility ${(meanCredibility * 100).toFixed(0)}% (${bandFor(meanCredibility).label})`}
                </span>
              </div>

              {/*
                Silent truncation reads as "everything was covered". The trim is
                a budget decision, not a judgement about the dropped sources, so
                it says so and points at the control that undoes it.
              */}
              {autoTrimmed > 0 && (
                <p className="mb-2 rounded border border-console-amber/25 bg-console-amber/5 p-2 text-[10px] leading-relaxed text-console-muted">
                  <span className="font-bold text-console-amber">
                    {autoTrimmed} lower-scored source{autoTrimmed === 1 ? "" : "s"} pre-excluded.
                  </span>{" "}
                  The configured free tier allows 8,000 tokens per minute, and a full
                  {` ${candidates.length}`}-source context measured 13,705 — generation failed with
                  HTTP 413 every time. The highest-credibility {DEFAULT_SOURCE_BUDGET} are selected;
                  re-include any row below to override.
                </p>
              )}

              <p className="mt-1 flex items-start gap-1.5 text-[10px] leading-relaxed text-console-label">
                <Info className="mt-px size-3 shrink-0" />
                Nothing is generated until you press Generate. Exclude anything you do not want
                cited — the product can only draw on what remains, and every claim in it is checked
                to resolve against one of these numbered entries.
              </p>

              <div className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
                {collecting && (
                  <div className="flex items-center gap-2 text-[11px] text-console-muted">
                    <Loader2 className="size-3.5 animate-spin" /> Collecting and scoring…
                  </div>
                )}
                {!collecting && candidates.length === 0 && !collectError && (
                  <p className="text-[11px] text-console-label">
                    Nothing collected for "{target}". Generation is refused with no sources — a
                    product written without material would be the model's invention.
                  </p>
                )}
                {candidates.map((s) => {
                  const off = excluded.has(s.n);
                  return (
                    <button
                      key={s.n}
                      onClick={() =>
                        setExcluded((prev) => {
                          const next = new Set(prev);
                          if (next.has(s.n)) next.delete(s.n);
                          else next.add(s.n);
                          return next;
                        })
                      }
                      className={`flex w-full items-start gap-2 rounded border p-2 text-left ${
                        off
                          ? "border-console-border bg-console-deep/40 opacity-45"
                          : "border-console-border bg-console-deep/70"
                      }`}
                    >
                      <span
                        className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${
                          off ? "border-[#334155]" : "border-console-green bg-console-green/20"
                        }`}
                      >
                        {!off && <Check className="size-2.5 text-console-green" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] text-console-text">{s.title}</span>
                        <span className="block truncate font-mono text-[9px] text-console-label">
                          {s.outlet} · {s.module}
                        </span>
                        <span className="block text-[9px] leading-relaxed text-console-muted">
                          {s.credibility === null
                            ? "not scored"
                            : `credibility ${(s.credibility * 100).toFixed(0)}% (${bandFor(s.credibility).label})`}
                          {" — "}
                          {s.credibilityRationale.slice(0, 110)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <Button
                onClick={generate}
                disabled={generating || selected.length === 0}
                className="mt-3 h-9 w-full gap-1.5 bg-console-green font-bold text-console-accent-foreground hover:bg-console-green-hover"
              >
                {generating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {generating
                  ? "Generating…"
                  : `Generate ${spec.label} from ${selected.length} source(s)`}
              </Button>

              {genError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                  <div className="font-mono text-[10px] leading-relaxed text-console-red">
                    <span className="font-bold">No product was produced.</span>
                    <div className="pt-0.5 opacity-80">{genError}</div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Products ─────────────────────────────────────────────────── */}
          {products.length > 0 && (
            <Card className={CARD}>
              <CardContent className="p-4">
                <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                  <FileBarChart className="size-3.5 text-console-blue" />
                  Generated products ({products.length})
                </h3>

                <div className="mt-3 space-y-2">
                  {[...products].reverse().map((p) => {
                    const open = openId === p.id;
                    return (
                      <div key={p.id} className="rounded border border-console-border bg-console-deep/60">
                        <div className="flex flex-wrap items-center gap-2 p-2.5">
                          <button
                            onClick={() => setOpenId(open ? null : p.id)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            {open ? (
                              <ChevronDown className="size-3.5 shrink-0 text-console-label" />
                            ) : (
                              <ChevronRight className="size-3.5 shrink-0 text-console-label" />
                            )}
                            <span className="min-w-0">
                              <span className="block truncate text-[11px] font-semibold text-console-text">
                                {p.typeLabel} — {p.subject}
                              </span>
                              <span className="block font-mono text-[9px] text-console-label">
                                {p.provenance.generatedAt.slice(0, 16).replace("T", " ")} ·{" "}
                                {p.sources.length} sources
                              </span>
                            </span>
                          </button>

                          <Badge
                            variant="outline"
                            className="shrink-0 border-console-purple/40 bg-console-purple/10 text-[9px] font-normal text-console-purple"
                            title="Open-source model — PS-18 §6.5"
                          >
                            {p.provenance.model}
                          </Badge>

                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => exportPdf(p)}
                            disabled={exporting === `${p.id}-pdf`}
                            className="h-6 gap-1 text-[9px]"
                          >
                            {exporting === `${p.id}-pdf` ? (
                              <Loader2 className="size-2.5 animate-spin" />
                            ) : (
                              <Download className="size-2.5" />
                            )}
                            PDF
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => exportMarkdown(p)}
                            className="h-6 gap-1 text-[9px]"
                          >
                            <FileText className="size-2.5" />
                            MD
                          </Button>
                          <button
                            onClick={() => remove(p.id)}
                            className="shrink-0 text-console-label hover:text-console-red"
                            aria-label="Delete product"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>

                        {open && <ProductView product={p} />}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <LlmQuotaCard />

          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="text-xs font-bold uppercase text-console-text">Sourcing discipline</h3>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-console-muted">
                <li>Every judgement and finding must cite numbered sources.</li>
                <li>
                  Citations are resolved against the real source list AFTER generation. A citation
                  to a source that was not supplied fails validation.
                </li>
                <li>
                  Findings are typed <em>reported</em> or <em>assessment</em>, so an inference is
                  never rendered as something a source stated.
                </li>
                <li>
                  A product failing validation is retried once with the specific violations, then
                  rejected. Partial products are never returned — a brief missing its sourcing is
                  worse than no brief, because it looks complete.
                </li>
                <li>
                  Every product carries an Intelligence Gaps section. Standard practice in real
                  products, and the section most implementations omit.
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

// ─── Rendered product ──────────────────────────────────────────────────────

function ProductView({ product }: { product: IntelligenceProduct }) {
  const byNumber = new Map(product.sources.map((s) => [s.n, s]));

  const cite = (nums: number[]) => (
    <span className="ml-1 font-mono text-[9px] text-console-blue">
      {nums.map((n) => `[${n}]`).join("")}
    </span>
  );

  return (
    <div className="space-y-3 border-t border-console-border p-3">
      <div className="rounded border border-console-amber/40 bg-console-amber/5 px-2 py-1 text-center font-mono text-[9px] font-bold tracking-wider text-console-amber">
        {product.classification}
      </div>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-console-blue">
          Bottom line
        </h4>
        <p className="mt-1 text-[11px] leading-relaxed text-console-text">{product.bottomLine}</p>
      </section>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-console-blue">
          Key judgements
        </h4>
        <div className="mt-1 space-y-2">
          {product.keyJudgements.map((kj, i) => (
            <div key={i} className="rounded border border-console-border bg-console-surface p-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] font-bold text-console-text">KJ-{i + 1}</span>
                <Badge
                  variant="outline"
                  className={`text-[8px] font-normal ${
                    kj.confidence === "high"
                      ? "border-console-green/40 bg-console-green/10 text-console-green"
                      : kj.confidence === "moderate"
                        ? "border-console-amber/40 bg-console-amber/10 text-console-amber"
                        : "border-console-red/40 bg-console-red/10 text-console-red"
                  }`}
                >
                  {kj.confidence} confidence
                </Badge>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-console-text">
                {kj.judgement}
                {cite(kj.sources)}
              </p>
              <p className="mt-0.5 text-[9px] italic leading-relaxed text-console-muted">
                Confidence basis: {kj.confidenceRationale}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-console-blue">Findings</h4>
        <ul className="mt-1 space-y-1">
          {product.findings.map((f, i) => (
            <li key={i} className="text-[11px] leading-relaxed text-console-text">
              • {f.text}
              {f.kind === "assessment" && (
                <span className="ml-1 font-mono text-[9px] text-console-amber">
                  [analyst assessment, not reported fact]
                </span>
              )}
              {cite(f.sources)}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-console-amber">
          Intelligence gaps
        </h4>
        <ul className="mt-1 space-y-1">
          {product.gaps.map((g, i) => (
            <li key={i} className="text-[10px] leading-relaxed text-console-muted">
              • <span className="font-semibold text-console-text">{g.gap}</span> — {g.why}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-console-blue">Sources</h4>
        <ol className="mt-1 space-y-1">
          {product.sources.map((s) => (
            <li key={s.n} className="text-[10px] leading-relaxed">
              <span className="font-mono text-console-blue">[{s.n}]</span>{" "}
              <span className="text-console-text">{s.title}</span>{" "}
              <span className="text-console-label">— {s.outlet}</span>
              <div className="pl-6 text-[9px] text-console-muted">
                {s.credibility === null
                  ? "credibility not scored"
                  : `credibility ${(s.credibility * 100).toFixed(0)}%`}
                {" · "}
                {s.credibilityRationale}
              </div>
              {s.url && (
                <div className="pl-6">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[9px] text-console-blue hover:underline"
                  >
                    {s.url.slice(0, 90)}
                  </a>
                </div>
              )}
            </li>
          ))}
        </ol>
        {byNumber.size !== product.sources.length && (
          <p className="mt-1 text-[9px] text-console-red">Duplicate source numbering detected.</p>
        )}
      </section>

      <section className="border-t border-console-border pt-2">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
          Provenance
        </h4>
        <dl className="mt-1 space-y-0.5 font-mono text-[9px]">
          <div className="flex justify-between">
            <dt className="text-console-label">Model</dt>
            <dd className="text-console-text">{product.provenance.model}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-console-label">Provider</dt>
            <dd className="text-console-text">
              {product.provenance.provider}
              {product.provenance.cacheHit ? " (cached)" : ""}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-console-label">Generated</dt>
            <dd className="text-console-text">{product.provenance.generatedAt}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-console-label">Modules</dt>
            <dd className="text-right text-console-text">{product.provenance.modules.join(", ")}</dd>
          </div>
        </dl>
        <p className="mt-1.5 rounded border border-console-amber/30 bg-console-amber/5 p-2 text-[9px] leading-relaxed text-console-amber">
          {product.provenance.notice}
        </p>
      </section>
    </div>
  );
}
