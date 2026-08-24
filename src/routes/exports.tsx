import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Download,
  FileText,
  FileCode,
  FileSpreadsheet,
  Loader2,
  AlertTriangle,
  Info,
  Archive,
} from "lucide-react";
import { bandFor } from "@/utils/credibility";
import { toMarkdown, type IntelligenceProduct } from "@/utils/reports";
import { renderProductPdf } from "@/utils/report-pdf";

/**
 * Export Manager — Module 5.
 *
 * This page used to run its own collection and build its own dossier, with a
 * hardcoded `risk: 75` and `credibility: 88` printed into the PDF under a
 * classification header, two invented recommendations, and a heading reading
 * "LAST GENERATED GEMINI AI REPORT SUMMARY" for a model this project cannot use.
 *
 * It is now a pure export surface over the products generated on the Report
 * Generator page. There is exactly ONE product pipeline, so a figure can no
 * longer differ between what the analyst reviewed on screen and what landed in
 * the exported file — which is how the invented scores survived in the first
 * place.
 */

export const Route = createFileRoute("/exports")({
  head: () => ({ meta: [{ title: "Exports — Sentinel AI" }] }),
  component: ExportsPage,
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

type Format = "pdf" | "markdown" | "json" | "csv";

const FORMATS: { id: Format; name: string; desc: string; icon: any }[] = [
  {
    id: "pdf",
    name: "PDF",
    desc: "Laid-out product with numbered sources, page numbers and a provenance footer on every page",
    icon: FileText,
  },
  {
    id: "markdown",
    name: "Markdown",
    desc: "Full text for pasting into another system",
    icon: FileText,
  },
  {
    id: "json",
    name: "JSON",
    desc: "The product structure, including every source and citation",
    icon: FileCode,
  },
  { id: "csv", name: "CSV", desc: "Source table with credibility scores", icon: FileSpreadsheet },
];

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** CSV of the source table. Quotes are doubled so a comma in a title cannot shift columns. */
function toCsv(product: IntelligenceProduct): string {
  const esc = (v: string | number | null) =>
    `"${String(v ?? "")
      .replace(/"/g, '""')
      .replace(/\r?\n/g, " ")}"`;
  const rows = [
    [
      "citation",
      "title",
      "outlet",
      "published",
      "module",
      "credibility_pct",
      "credibility_band",
      "rationale",
      "url",
    ].join(","),
    ...product.sources.map((s) =>
      [
        esc(s.n),
        esc(s.title),
        esc(s.outlet),
        esc(s.publishedAt),
        esc(s.module),
        esc(s.credibility === null ? "" : Math.round(s.credibility * 100)),
        esc(s.credibility === null ? "not scored" : bandFor(s.credibility).label),
        esc(s.credibilityRationale),
        esc(s.url),
      ].join(","),
    ),
  ];
  return rows.join("\n");
}

function ExportsPage() {
  const [products, setProducts] = useState<IntelligenceProduct[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const list = loadProducts();
    setProducts(list);
    if (list.length > 0) setSelectedId(list[list.length - 1].id);
  }, []);

  const product = useMemo(
    () => products.find((p) => p.id === selectedId) ?? null,
    [products, selectedId],
  );

  const meanCredibility = useMemo(() => {
    if (!product) return null;
    const scored = product.sources.map((s) => s.credibility).filter((c): c is number => c !== null);
    return scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  }, [product]);

  const doExport = async (format: Format) => {
    if (!product) return;
    setBusy(format);
    setError("");
    const stem = `${product.type}_${product.subject.replace(/[^a-zA-Z0-9]/g, "_")}`;
    try {
      if (format === "pdf") {
        const bytes = await renderProductPdf(product);
        download(
          new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }),
          `${stem}.pdf`,
        );
      } else if (format === "markdown") {
        download(new Blob([toMarkdown(product)], { type: "text/markdown" }), `${stem}.md`);
      } else if (format === "json") {
        download(
          new Blob([JSON.stringify(product, null, 2)], { type: "application/json" }),
          `${stem}.json`,
        );
      } else {
        download(new Blob([toCsv(product)], { type: "text/csv" }), `${stem}_sources.csv`);
      }
    } catch (err: any) {
      // The real cause. "Export failed. Please try again." used to hide whether
      // the PDF layout threw or the product was malformed.
      setError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell>
      <PageHeader
        title="Export Manager"
        description="Exports the intelligence products generated on the Report Generator page. One pipeline, so the file matches what you reviewed."
      />

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card className={CARD}>
          <CardContent className="p-4">
            <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
              <Archive className="size-3.5 text-console-blue" />
              Products ({products.length})
            </h3>

            {products.length === 0 ? (
              <p className="mt-3 text-[11px] leading-relaxed text-console-label">
                No products yet. Generate one on the{" "}
                <a href="/reports" className="text-console-blue hover:underline">
                  Report Generator
                </a>{" "}
                page. This page deliberately does not generate anything of its own — a second
                pipeline is how the exported PDF ended up carrying invented scores that the
                on-screen product never showed.
              </p>
            ) : (
              <div className="mt-3 space-y-1.5">
                {[...products].reverse().map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={`w-full rounded border p-2 text-left ${
                      selectedId === p.id
                        ? "border-console-blue/60 bg-console-blue/10"
                        : "border-console-border bg-console-deep/60"
                    }`}
                  >
                    <span className="block truncate text-[11px] font-semibold text-console-text">
                      {p.typeLabel}
                    </span>
                    <span className="block truncate text-[10px] text-console-muted">{p.subject}</span>
                    <span className="block font-mono text-[9px] text-console-label">
                      {p.provenance.generatedAt.slice(0, 16).replace("T", " ")} · {p.sources.length}{" "}
                      sources · {p.provenance.model}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {product ? (
            <>
              <Card className={CARD}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-console-text">{product.typeLabel}</span>
                    <Badge
                      variant="outline"
                      className="border-console-amber/40 bg-console-amber/10 font-mono text-[9px] font-normal text-console-amber"
                    >
                      {product.classification}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="border-console-purple/40 bg-console-purple/10 font-mono text-[9px] font-normal text-console-purple"
                      title="Open-source model — PS-18 §6.5 names this requirement explicitly"
                    >
                      {product.provenance.model}
                    </Badge>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px] sm:grid-cols-3">
                    <div>
                      <dt className="text-console-label">Subject</dt>
                      <dd className="truncate text-console-text">{product.subject}</dd>
                    </div>
                    <div>
                      <dt className="text-console-label">Sources cited</dt>
                      <dd className="text-console-text">{product.sources.length}</dd>
                    </div>
                    <div>
                      <dt className="text-console-label">Mean credibility</dt>
                      <dd className="text-console-text">
                        {meanCredibility === null
                          ? "not scorable"
                          : `${(meanCredibility * 100).toFixed(0)}% (${bandFor(meanCredibility).label})`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-console-label">Key judgements</dt>
                      <dd className="text-console-text">{product.keyJudgements.length}</dd>
                    </div>
                    <div>
                      <dt className="text-console-label">Intelligence gaps</dt>
                      <dd className="text-console-text">{product.gaps.length}</dd>
                    </div>
                    <div>
                      <dt className="text-console-label">Modules</dt>
                      <dd className="truncate text-console-text">{product.provenance.modules.length}</dd>
                    </div>
                  </dl>

                  <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-console-label">
                    <Info className="mt-px size-3 shrink-0" />
                    No subject risk score is exported. Nothing in this system computes one, and a
                    number printed under a classification header reads as a measurement — which is
                    exactly how `risk: 75` used to reach a downloadable dossier.
                  </p>
                </CardContent>
              </Card>

              <Card className={CARD}>
                <CardContent className="p-4">
                  <h3 className="text-xs font-bold uppercase text-console-text">Export format</h3>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {FORMATS.map((f) => {
                      const Icon = f.icon;
                      return (
                        <Card
                          key={f.id}
                          className="flex flex-col justify-between border-console-border bg-console-deep p-3"
                        >
                          <div>
                            <Icon className="size-5 text-console-green" />
                            <div className="mt-1.5 text-xs font-bold text-console-text">{f.name}</div>
                            <div className="mt-0.5 text-[10px] leading-relaxed text-console-muted">
                              {f.desc}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => doExport(f.id)}
                            className="mt-2 h-7 w-full gap-1.5 bg-console-green text-[10px] font-bold text-console-accent-foreground hover:bg-console-green-hover"
                          >
                            {busy === f.id ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Download className="size-3" />
                            )}
                            Export
                          </Button>
                        </Card>
                      );
                    })}
                  </div>

                  {error && (
                    <div className="mt-3 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                      <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                      <div className="font-mono text-[10px] leading-relaxed text-console-red">
                        <span className="font-bold">Export failed. No file was written.</span>
                        <div className="pt-0.5 opacity-80">{error}</div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className={CARD}>
                <CardContent className="p-4">
                  <h3 className="text-xs font-bold uppercase text-console-text">
                    Sources carried into the export
                  </h3>
                  <ol className="mt-2 space-y-1.5">
                    {product.sources.map((s) => (
                      <li key={s.n} className="text-[10px] leading-relaxed">
                        <span className="font-mono text-console-blue">[{s.n}]</span>{" "}
                        <span className="text-console-text">{s.title}</span>
                        <div className="pl-6 text-[9px] text-console-muted">
                          {s.outlet} · {s.module} ·{" "}
                          {s.credibility === null
                            ? "credibility not scored"
                            : `credibility ${(s.credibility * 100).toFixed(0)}% (${bandFor(s.credibility).label})`}
                        </div>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            </>
          ) : (
            products.length > 0 && (
              <Card className={CARD}>
                <CardContent className="p-10 text-center text-[11px] text-console-label">
                  Select a product to export.
                </CardContent>
              </Card>
            )
          )}
        </div>
      </div>
    </AppShell>
  );
}
