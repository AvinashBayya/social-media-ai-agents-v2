import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  FileBarChart, Loader2, AlertTriangle, Info, Search, Download, FileText,
  Sparkles, Check, Trash2, ChevronDown, ChevronRight, Shield,
} from "lucide-react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { fetchNews } from "./news";
import { clusterStories, type Article } from "@/utils/analysis";
import { bandFor, defaultFactors, scoreCorpus } from "@/utils/credibility";
import {
  generateIntelligenceProduct, renumber, sourcesFromArticles, sourcesFromGeo, toMarkdown,
  PRODUCT_TYPES,
  type IntelligenceProduct, type ProductType, type SourceRef,
} from "@/utils/reports";
import { renderProductPdf } from "@/utils/report-pdf";
import { fetchGeoLayers } from "@/utils/geo-sources";
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

export const Route = createFileRoute("/reports")({
  head: () => ({ meta: [{ title: "Report Generator — Sentinel AI" }] }),
  component: ReportsPage,
});

const CARD = "bg-[#111827] border-[#263548]";
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
  const [target, setTarget] = useState(() => getActiveTarget());
  const [draft, setDraft] = useState(() => getActiveTarget());
  const [type, setType] = useState<ProductType>("EXECUTIVE_BRIEF");

  const [candidates, setCandidates] = useState<SourceRef[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState("");

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
          url: s.primaryLink || s.url || "",
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

      setCandidates(
        renumber([...sourcesFromArticles(corpus, scored), ...sourcesFromGeo(geoRecords)]),
      );
    } catch (err: any) {
      setCollectError(err?.message ?? String(err));
    } finally {
      setCollecting(false);
    }
  }, []);

  useEffect(() => { collect(target); }, [target, collect]);

  const selected = useMemo(
    () => renumber(candidates.filter((s) => !excluded.has(s.n))),
    [candidates, excluded],
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
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#64748B]" />
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && search()}
                    placeholder="Subject…"
                    className="h-8 border-[#263548] bg-[#0B1220] pl-8 text-[11px] text-white"
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
                        ? "border-[#3B82F6]/60 bg-[#3B82F6]/10 text-[#3B82F6]"
                        : "border-[#263548] bg-[#0B1220] text-[#64748B]"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-[#94A3B8]">{spec.description}</p>

              {collectError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
                  <span className="font-mono text-[10px] text-[#EF4444]">{collectError}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Source preview, BEFORE generation ────────────────────────── */}
          <Card className={CARD}>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Shield className="size-3.5 text-[#10B981]" />
                <h3 className="text-xs font-bold uppercase text-white">
                  Sources that will be used
                </h3>
                <span className="ml-auto font-mono text-[10px] text-[#94A3B8]">
                  {selected.length} of {candidates.length} included
                  {meanCredibility !== null &&
                    ` · mean credibility ${(meanCredibility * 100).toFixed(0)}% (${bandFor(meanCredibility).label})`}
                </span>
              </div>

              <p className="mt-1 flex items-start gap-1.5 text-[10px] leading-relaxed text-[#64748B]">
                <Info className="mt-px size-3 shrink-0" />
                Nothing is generated until you press Generate. Exclude anything you do not want
                cited — the product can only draw on what remains, and every claim in it is
                checked to resolve against one of these numbered entries.
              </p>

              <div className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
                {collecting && (
                  <div className="flex items-center gap-2 text-[11px] text-[#94A3B8]">
                    <Loader2 className="size-3.5 animate-spin" /> Collecting and scoring…
                  </div>
                )}
                {!collecting && candidates.length === 0 && !collectError && (
                  <p className="text-[11px] text-[#64748B]">
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
                          if (next.has(s.n)) next.delete(s.n); else next.add(s.n);
                          return next;
                        })
                      }
                      className={`flex w-full items-start gap-2 rounded border p-2 text-left ${
                        off
                          ? "border-[#263548] bg-[#0B1220]/40 opacity-45"
                          : "border-[#263548] bg-[#0B1220]/70"
                      }`}
                    >
                      <span
                        className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${
                          off ? "border-[#334155]" : "border-[#10B981] bg-[#10B981]/20"
                        }`}
                      >
                        {!off && <Check className="size-2.5 text-[#10B981]" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] text-[#F3F4F6]">{s.title}</span>
                        <span className="block truncate font-mono text-[9px] text-[#64748B]">
                          {s.outlet} · {s.module}
                        </span>
                        <span className="block text-[9px] leading-relaxed text-[#94A3B8]">
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
                className="mt-3 h-9 w-full gap-1.5 bg-[#10B981] font-bold text-black hover:bg-[#059669]"
              >
                {generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                {generating ? "Generating…" : `Generate ${spec.label} from ${selected.length} source(s)`}
              </Button>

              {genError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
                  <div className="font-mono text-[10px] leading-relaxed text-[#EF4444]">
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
                <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
                  <FileBarChart className="size-3.5 text-[#3B82F6]" />
                  Generated products ({products.length})
                </h3>

                <div className="mt-3 space-y-2">
                  {[...products].reverse().map((p) => {
                    const open = openId === p.id;
                    return (
                      <div key={p.id} className="rounded border border-[#263548] bg-[#0B1220]/60">
                        <div className="flex flex-wrap items-center gap-2 p-2.5">
                          <button
                            onClick={() => setOpenId(open ? null : p.id)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            {open ? (
                              <ChevronDown className="size-3.5 shrink-0 text-[#64748B]" />
                            ) : (
                              <ChevronRight className="size-3.5 shrink-0 text-[#64748B]" />
                            )}
                            <span className="min-w-0">
                              <span className="block truncate text-[11px] font-semibold text-white">
                                {p.typeLabel} — {p.subject}
                              </span>
                              <span className="block font-mono text-[9px] text-[#64748B]">
                                {p.provenance.generatedAt.slice(0, 16).replace("T", " ")} ·{" "}
                                {p.sources.length} sources
                              </span>
                            </span>
                          </button>

                          <Badge
                            variant="outline"
                            className="shrink-0 border-[#8B5CF6]/40 bg-[#8B5CF6]/10 text-[9px] font-normal text-[#8B5CF6]"
                            title="Open-source model — PS-18 §6.5"
                          >
                            {p.provenance.model}
                          </Badge>

                          <Button
                            size="sm" variant="outline"
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
                            size="sm" variant="outline"
                            onClick={() => exportMarkdown(p)}
                            className="h-6 gap-1 text-[9px]"
                          >
                            <FileText className="size-2.5" />
                            MD
                          </Button>
                          <button
                            onClick={() => remove(p.id)}
                            className="shrink-0 text-[#64748B] hover:text-[#EF4444]"
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
              <h3 className="text-xs font-bold uppercase text-white">Sourcing discipline</h3>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-[#94A3B8]">
                <li>Every judgement and finding must cite numbered sources.</li>
                <li>
                  Citations are resolved against the real source list AFTER generation. A
                  citation to a source that was not supplied fails validation.
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
    <span className="ml-1 font-mono text-[9px] text-[#3B82F6]">
      {nums.map((n) => `[${n}]`).join("")}
    </span>
  );

  return (
    <div className="space-y-3 border-t border-[#263548] p-3">
      <div className="rounded border border-[#F59E0B]/40 bg-[#F59E0B]/5 px-2 py-1 text-center font-mono text-[9px] font-bold tracking-wider text-[#F59E0B]">
        {product.classification}
      </div>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#3B82F6]">Bottom line</h4>
        <p className="mt-1 text-[11px] leading-relaxed text-[#F3F4F6]">{product.bottomLine}</p>
      </section>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#3B82F6]">Key judgements</h4>
        <div className="mt-1 space-y-2">
          {product.keyJudgements.map((kj, i) => (
            <div key={i} className="rounded border border-[#263548] bg-[#111827] p-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] font-bold text-white">KJ-{i + 1}</span>
                <Badge
                  variant="outline"
                  className={`text-[8px] font-normal ${
                    kj.confidence === "high"
                      ? "border-[#10B981]/40 bg-[#10B981]/10 text-[#10B981]"
                      : kj.confidence === "moderate"
                        ? "border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[#F59E0B]"
                        : "border-[#EF4444]/40 bg-[#EF4444]/10 text-[#EF4444]"
                  }`}
                >
                  {kj.confidence} confidence
                </Badge>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-[#F3F4F6]">
                {kj.judgement}
                {cite(kj.sources)}
              </p>
              <p className="mt-0.5 text-[9px] italic leading-relaxed text-[#94A3B8]">
                Confidence basis: {kj.confidenceRationale}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#3B82F6]">Findings</h4>
        <ul className="mt-1 space-y-1">
          {product.findings.map((f, i) => (
            <li key={i} className="text-[11px] leading-relaxed text-[#F3F4F6]">
              • {f.text}
              {f.kind === "assessment" && (
                <span className="ml-1 font-mono text-[9px] text-[#F59E0B]">
                  [analyst assessment, not reported fact]
                </span>
              )}
              {cite(f.sources)}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#F59E0B]">
          Intelligence gaps
        </h4>
        <ul className="mt-1 space-y-1">
          {product.gaps.map((g, i) => (
            <li key={i} className="text-[10px] leading-relaxed text-[#94A3B8]">
              • <span className="font-semibold text-[#F3F4F6]">{g.gap}</span> — {g.why}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#3B82F6]">Sources</h4>
        <ol className="mt-1 space-y-1">
          {product.sources.map((s) => (
            <li key={s.n} className="text-[10px] leading-relaxed">
              <span className="font-mono text-[#3B82F6]">[{s.n}]</span>{" "}
              <span className="text-[#F3F4F6]">{s.title}</span>{" "}
              <span className="text-[#64748B]">— {s.outlet}</span>
              <div className="pl-6 text-[9px] text-[#94A3B8]">
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
                    className="font-mono text-[9px] text-[#3B82F6] hover:underline"
                  >
                    {s.url.slice(0, 90)}
                  </a>
                </div>
              )}
            </li>
          ))}
        </ol>
        {byNumber.size !== product.sources.length && (
          <p className="mt-1 text-[9px] text-[#EF4444]">Duplicate source numbering detected.</p>
        )}
      </section>

      <section className="border-t border-[#263548] pt-2">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">Provenance</h4>
        <dl className="mt-1 space-y-0.5 font-mono text-[9px]">
          <div className="flex justify-between">
            <dt className="text-[#64748B]">Model</dt>
            <dd className="text-white">{product.provenance.model}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[#64748B]">Provider</dt>
            <dd className="text-white">
              {product.provenance.provider}
              {product.provenance.cacheHit ? " (cached)" : ""}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[#64748B]">Generated</dt>
            <dd className="text-white">{product.provenance.generatedAt}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-[#64748B]">Modules</dt>
            <dd className="text-right text-white">{product.provenance.modules.join(", ")}</dd>
          </div>
        </dl>
        <p className="mt-1.5 rounded border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-2 text-[9px] leading-relaxed text-[#F59E0B]">
          {product.provenance.notice}
        </p>
      </section>
    </div>
  );
}
