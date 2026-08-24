import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  FolderOpen,
  Plus,
  Sparkles,
  Loader2,
  AlertTriangle,
  Info,
  Trash2,
  ExternalLink,
  Newspaper,
  Users2,
  ImageIcon,
  MapPin,
  FileText,
  Save,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  caseMetrics,
  createInvestigation,
  deleteInvestigation,
  getInvestigations,
  removeEvidence,
  sourcesFromEvidence,
  updateAnalystNotes,
  type EvidenceKind,
  type Investigation,
} from "@/utils/investigations-store";
import { bandFor } from "@/utils/credibility";
import {
  generateIntelligenceProduct,
  toMarkdown,
  PRODUCT_TYPES,
  type IntelligenceProduct,
  type ProductType,
} from "@/utils/reports";
import { renderProductPdf } from "@/utils/report-pdf";

/**
 * Investigations — case workspaces (PS-18 §7, analyst workflow).
 *
 * The previous page rendered seeded fiction: two demonstration cases with
 * invented risk (78, 88) and threat (82, 90) scores shown as percentages with
 * progress bars, analyst names nobody assigned, and hand-written evidence
 * entries describing analysis that had never run. New cases were created with
 * risk 50 / threat 50 — two more numbers nothing computed.
 *
 * And the mechanism that would have made a case real, PinButton, had ZERO call
 * sites. No evidence could ever be added, so the seeded entries were all a case
 * could ever contain.
 *
 * Now: cases start empty, evidence is pinned from News, Social and Image
 * Intelligence with its full provenance, every figure is derived from that
 * evidence or reported absent, and "Generate product" runs Module 5 over the
 * curated evidence — so the case becomes the citation list and every claim in
 * the resulting brief is validated to resolve back to a pinned item.
 */

export const Route = createFileRoute("/investigations")({
  head: () => ({ meta: [{ title: "AI Investigations — Sentinel AI" }] }),
  component: InvestigationsPage,
});

const CARD = "bg-console-surface border-console-border";

const KIND_ICON: Record<EvidenceKind, any> = {
  news: Newspaper,
  social: Users2,
  image: ImageIcon,
  geo: MapPin,
  note: FileText,
};
const KIND_COLOUR: Record<EvidenceKind, string> = {
  news: "var(--console-blue)",
  social: "var(--console-purple)",
  image: "var(--console-green)",
  geo: "var(--console-amber)",
  note: "var(--console-label)",
};

function InvestigationsPage() {
  const [cases, setCases] = useState<Investigation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const [newTarget, setNewTarget] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newKeywords, setNewKeywords] = useState("");
  const [newOwner, setNewOwner] = useState("");

  const [noteDraft, setNoteDraft] = useState("");
  const [productType, setProductType] = useState<ProductType>("TARGET_DOSSIER");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [product, setProduct] = useState<IntelligenceProduct | null>(null);

  const refresh = () => {
    const list = getInvestigations();
    setCases(list);
    if (list.length > 0 && !list.some((c) => c.id === selectedId)) {
      setSelectedId(list[0].id);
      setNoteDraft(list[0].notes);
    }
    if (list.length === 0) setSelectedId("");
  };

  useEffect(() => {
    refresh();
  }, []);

  const active = useMemo(() => cases.find((c) => c.id === selectedId) ?? null, [cases, selectedId]);
  const metrics = useMemo(() => (active ? caseMetrics(active) : null), [active]);

  useEffect(() => {
    setProduct(null);
    setGenError("");
    setNoteDraft(active?.notes ?? "");
  }, [selectedId]);

  const create = () => {
    if (!newTarget.trim()) {
      toast.error("A case needs a target subject.");
      return;
    }
    const created = createInvestigation(
      newTarget,
      newTitle,
      newDesc,
      newKeywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      newOwner,
    );
    setNewTarget("");
    setNewTitle("");
    setNewDesc("");
    setNewKeywords("");
    setNewOwner("");
    setShowCreate(false);
    setSelectedId(created.id);
    refresh();
    toast.success(`${created.id} created. Pin evidence from News, Social or Images to build it.`);
  };

  const generate = async () => {
    if (!active) return;
    setGenerating(true);
    setGenError("");
    setProduct(null);
    try {
      const sources = sourcesFromEvidence(active.evidence);
      // Module 5 refuses on an empty source list, but saying it here is clearer
      // than surfacing that error after a round trip.
      if (sources.length === 0) {
        throw new Error(
          "No evidence is pinned to this case. A product generated with no source material " +
            "would be the model's invention, not intelligence — pin items from News, Social " +
            "or Image Intelligence first.",
        );
      }
      const result = (await generateIntelligenceProduct({
        data: { type: productType, subject: active.target, sources },
      })) as unknown as IntelligenceProduct;
      setProduct(result);
      toast.success(
        `Product generated by ${result.provenance.model} from ${sources.length} source(s).`,
      );
    } catch (err: any) {
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

  return (
    <AppShell>
      <PageHeader
        title="AI Investigations"
        description="Case workspaces built from evidence you pin. Every case figure is counted from that evidence."
        actions={
          <Button size="sm" onClick={() => setShowCreate(!showCreate)} className="h-8 gap-1.5">
            {showCreate ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
            {showCreate ? "Cancel" : "New investigation"}
          </Button>
        }
      />

      {showCreate && (
        <Card className={`${CARD} mb-4`}>
          <CardContent className="p-4">
            <h3 className="text-xs font-bold uppercase text-console-text">Initialise case</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-console-label">
                  Target subject *
                </label>
                <Input
                  value={newTarget}
                  onChange={(e) => setNewTarget(e.target.value)}
                  placeholder="Subject under investigation"
                  className="mt-1 h-8 border-console-border bg-console-deep text-[11px] text-console-text"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-console-label">
                  Case title
                </label>
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Defaults to the subject name"
                  className="mt-1 h-8 border-console-border bg-console-deep text-[11px] text-console-text"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-console-label">
                  Keywords (comma separated)
                </label>
                <Input
                  value={newKeywords}
                  onChange={(e) => setNewKeywords(e.target.value)}
                  className="mt-1 h-8 border-console-border bg-console-deep text-[11px] text-console-text"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-console-label">
                  Owner (optional)
                </label>
                <Input
                  value={newOwner}
                  onChange={(e) => setNewOwner(e.target.value)}
                  placeholder="Left blank — there is no signed-in identity"
                  className="mt-1 h-8 border-console-border bg-console-deep text-[11px] text-console-text"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-[10px] uppercase tracking-wider text-console-label">
                  Description
                </label>
                <Textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  rows={2}
                  className="mt-1 border-console-border bg-console-deep text-[11px] text-console-text"
                />
              </div>
            </div>
            <Button
              size="sm"
              onClick={create}
              className="mt-3 h-8 bg-console-green font-bold text-console-accent-foreground hover:bg-console-green-hover"
            >
              Create case
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {/* ── Case list ──────────────────────────────────────────────────── */}
        <Card className={CARD}>
          <CardContent className="p-4">
            <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
              <FolderOpen className="size-3.5 text-console-blue" />
              Open cases ({cases.length})
            </h3>

            {cases.length === 0 ? (
              <p className="mt-3 text-[11px] leading-relaxed text-console-label">
                No cases. This page ships with none — it previously seeded two demonstration
                dossiers with invented risk scores and evidence describing analysis that had never
                run.
              </p>
            ) : (
              <div className="mt-3 space-y-1.5">
                {cases.map((c) => {
                  const m = caseMetrics(c);
                  return (
                    <button
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      className={`w-full rounded border p-2 text-left ${
                        selectedId === c.id
                          ? "border-console-blue/60 bg-console-blue/10"
                          : "border-console-border bg-console-deep/60"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[9px] font-bold text-console-cyan">
                          {c.id}
                        </span>
                        <Badge
                          variant="outline"
                          className="border-console-border text-[8px] font-normal text-console-muted"
                        >
                          {c.status}
                        </Badge>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] font-semibold text-console-text">
                        {c.title}
                      </div>
                      <div className="font-mono text-[9px] text-console-label">
                        {m.evidenceCount} evidence · {m.distinctSources} source(s)
                        {m.meanCredibility !== null &&
                          ` · cred ${(m.meanCredibility * 100).toFixed(0)}%`}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Case detail ────────────────────────────────────────────────── */}
        <div className="space-y-4">
          {!active || !metrics ? (
            <Card className={CARD}>
              <CardContent className="p-10 text-center">
                <FolderOpen className="mx-auto size-8 text-console-border" />
                <p className="mt-3 text-sm text-console-muted">No case selected.</p>
                <p className="mx-auto mt-1 max-w-lg text-[11px] leading-relaxed text-console-label">
                  Create a case, then pin evidence to it from News Intelligence, Social Intelligence
                  or Image Intelligence using the bookmark control on each item. The pinned set
                  becomes the citation list for any product this case generates.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className={CARD}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] font-bold text-console-cyan">
                          {active.id}
                        </span>
                        <Badge
                          variant="outline"
                          className="border-console-border text-[9px] font-normal text-console-muted"
                        >
                          {active.status}
                        </Badge>
                        {active.owner && (
                          <span className="font-mono text-[9px] text-console-label">
                            owner: {active.owner}
                          </span>
                        )}
                      </div>
                      <h2 className="mt-1 text-lg font-bold uppercase text-console-text">
                        {active.title}
                      </h2>
                      {active.description && (
                        <p className="mt-1 text-[11px] leading-relaxed text-console-muted">
                          {active.description}
                        </p>
                      )}
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {active.keywords.map((k) => (
                          <Badge key={k} variant="secondary" className="text-[9px] font-normal">
                            {k}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        deleteInvestigation(active.id);
                        refresh();
                        toast.success(`${active.id} deleted.`);
                      }}
                      className="shrink-0 text-console-label hover:text-console-red"
                      title="Delete case"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>

                  {/* Derived metrics. No risk score, no threat score. */}
                  <div className="mt-3 grid grid-cols-2 gap-2 border-t border-console-border pt-3 sm:grid-cols-4">
                    <Metric label="Evidence" value={String(metrics.evidenceCount)} />
                    <Metric label="Distinct sources" value={String(metrics.distinctSources)} />
                    <Metric
                      label="Mean credibility"
                      value={
                        metrics.meanCredibility === null
                          ? "not scorable"
                          : `${(metrics.meanCredibility * 100).toFixed(0)}%`
                      }
                      sub={
                        metrics.meanCredibility === null
                          ? "no pinned item carries a score"
                          : `${bandFor(metrics.meanCredibility).label} · ${metrics.scoredCount}/${metrics.evidenceCount} scored`
                      }
                    />
                    <Metric
                      label="Evidence span"
                      value={
                        metrics.earliest && metrics.latest
                          ? `${metrics.earliest.slice(0, 10)} → ${metrics.latest.slice(0, 10)}`
                          : "undated"
                      }
                    />
                  </div>

                  <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-console-muted">
                    <Info className="mt-px size-3 shrink-0" />
                    {metrics.summary}
                  </p>
                  <p className="mt-1 text-[9px] leading-relaxed text-console-label">
                    No risk or threat score is shown. Nothing in this system computes one, and this
                    page previously rendered both as percentages with progress bars — which reads as
                    a measurement.
                  </p>
                </CardContent>
              </Card>

              {/* ── Evidence ─────────────────────────────────────────────── */}
              <Card className={CARD}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xs font-bold uppercase text-console-text">Pinned evidence</h3>
                    <span className="ml-auto flex flex-wrap gap-1">
                      {(Object.keys(metrics.byKind) as EvidenceKind[])
                        .filter((k) => metrics.byKind[k] > 0)
                        .map((k) => (
                          <Badge
                            key={k}
                            variant="outline"
                            className="text-[9px] font-normal"
                            style={{
                              borderColor: `color-mix(in srgb, ${KIND_COLOUR[k]} 40%, transparent)`,
                              background: `color-mix(in srgb, ${KIND_COLOUR[k]} 10%, transparent)`,
                              color: KIND_COLOUR[k],
                            }}
                          >
                            {k} {metrics.byKind[k]}
                          </Badge>
                        ))}
                    </span>
                  </div>

                  {active.evidence.length === 0 ? (
                    <p className="mt-3 text-[11px] leading-relaxed text-console-label">
                      Nothing pinned yet. Use the bookmark control on any item in{" "}
                      <a href="/news" className="text-console-blue hover:underline">
                        News
                      </a>
                      ,{" "}
                      <a href="/social" className="text-console-blue hover:underline">
                        Social
                      </a>{" "}
                      or{" "}
                      <a href="/images" className="text-console-blue hover:underline">
                        Images
                      </a>
                      . Provenance travels with the pin, so the case can generate a cited product.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-1.5">
                      {active.evidence.map((e, i) => {
                        const Icon = KIND_ICON[e.kind] ?? FileText;
                        return (
                          <div
                            key={e.id}
                            className="rounded border border-console-border bg-console-deep/60 p-2.5"
                          >
                            <div className="flex items-start gap-2">
                              <Icon
                                className="mt-0.5 size-3.5 shrink-0"
                                style={{ color: KIND_COLOUR[e.kind] }}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2 font-mono text-[9px] text-console-label">
                                  <span className="text-console-blue">[{i + 1}]</span>
                                  <span>{e.source}</span>
                                  {e.publishedAt && (
                                    <span>{e.publishedAt.slice(0, 16).replace("T", " ")}</span>
                                  )}
                                  <span className="ml-auto">
                                    {e.credibility === null
                                      ? "not scored"
                                      : `cred ${(e.credibility * 100).toFixed(0)}%`}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-[11px] leading-snug text-console-text">
                                  {e.title}
                                </p>
                                {e.note && (
                                  <p className="mt-0.5 text-[10px] italic text-console-muted">
                                    Analyst note: {e.note}
                                  </p>
                                )}
                                {e.url && (
                                  <a
                                    href={e.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-0.5 inline-flex items-center gap-1 font-mono text-[9px] text-console-blue hover:underline"
                                  >
                                    open <ExternalLink className="size-2.5" />
                                  </a>
                                )}
                              </div>
                              <button
                                onClick={() => {
                                  removeEvidence(active.id, e.id);
                                  refresh();
                                }}
                                className="shrink-0 text-console-label hover:text-console-red"
                                title="Remove from case"
                              >
                                <Trash2 className="size-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* ── Product generation ───────────────────────────────────── */}
              <Card className={CARD}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Sparkles className="size-3.5 text-console-green" />
                    <h3 className="text-xs font-bold uppercase text-console-text">
                      Generate intelligence product
                    </h3>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {PRODUCT_TYPES.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setProductType(p.id)}
                        className={`rounded border px-2 py-1 text-[10px] ${
                          productType === p.id
                            ? "border-console-blue/60 bg-console-blue/10 text-console-blue"
                            : "border-console-border bg-console-deep text-console-label"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>

                  <Button
                    onClick={generate}
                    disabled={generating || active.evidence.length === 0}
                    className="mt-3 h-8 w-full gap-1.5 bg-console-green font-bold text-console-accent-foreground hover:bg-console-green-hover"
                  >
                    {generating ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="size-3.5" />
                    )}
                    {generating
                      ? "Generating…"
                      : `Generate from ${active.evidence.length} pinned item(s)`}
                  </Button>

                  <p className="mt-1.5 text-[10px] leading-relaxed text-console-label">
                    The model sees only the pinned evidence above, numbered. Every claim it makes is
                    validated to cite one of those numbers; a product that fails validation is
                    retried once and then rejected rather than returned partial.
                  </p>

                  {genError && (
                    <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                      <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                      <div className="font-mono text-[10px] leading-relaxed text-console-red">
                        <span className="font-bold">No product was produced.</span>
                        <div className="pt-0.5 opacity-80">{genError}</div>
                      </div>
                    </div>
                  )}

                  {product && (
                    <div className="mt-3 space-y-2 rounded border border-console-blue/40 bg-console-deep/60 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-bold text-console-text">
                          {product.typeLabel}
                        </span>
                        <Badge
                          variant="outline"
                          className="border-console-amber/40 bg-console-amber/10 font-mono text-[9px] font-normal text-console-amber"
                        >
                          {product.classification}
                        </Badge>
                        <Badge
                          variant="outline"
                          className="border-console-purple/40 bg-console-purple/10 font-mono text-[9px] font-normal text-console-purple"
                        >
                          {product.provenance.model}
                        </Badge>
                        <div className="ml-auto flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              const bytes = await renderProductPdf(product);
                              download(
                                new Blob([bytes as unknown as BlobPart], {
                                  type: "application/pdf",
                                }),
                                `${active.id}_${product.type}.pdf`,
                              );
                            }}
                            className="h-6 text-[9px]"
                          >
                            PDF
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              download(
                                new Blob([toMarkdown(product)], { type: "text/markdown" }),
                                `${active.id}_${product.type}.md`,
                              )
                            }
                            className="h-6 text-[9px]"
                          >
                            MD
                          </Button>
                        </div>
                      </div>

                      <p className="text-[11px] leading-relaxed text-console-text">
                        {product.bottomLine}
                      </p>

                      <div>
                        <div className="text-[9px] font-bold uppercase tracking-wider text-console-blue">
                          Key judgements
                        </div>
                        {product.keyJudgements.map((kj, i) => (
                          <p key={i} className="mt-1 text-[10px] leading-relaxed text-console-muted">
                            <span className="font-mono font-bold text-console-text">KJ-{i + 1}</span>{" "}
                            <span className="text-console-amber">({kj.confidence})</span> {kj.judgement}{" "}
                            <span className="font-mono text-console-blue">
                              {kj.sources.map((n) => `[${n}]`).join("")}
                            </span>
                          </p>
                        ))}
                      </div>

                      <div>
                        <div className="text-[9px] font-bold uppercase tracking-wider text-console-amber">
                          Intelligence gaps
                        </div>
                        {product.gaps.map((g, i) => (
                          <p key={i} className="mt-0.5 text-[10px] leading-relaxed text-console-muted">
                            • <span className="text-console-text">{g.gap}</span> — {g.why}
                          </p>
                        ))}
                      </div>

                      <p className="rounded border border-console-amber/30 bg-console-amber/5 p-2 text-[9px] leading-relaxed text-console-amber">
                        {product.provenance.notice}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* ── Analyst notes ────────────────────────────────────────── */}
              <Card className={CARD}>
                <CardContent className="p-4">
                  <h3 className="text-xs font-bold uppercase text-console-text">Analyst notes</h3>
                  <Textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    rows={4}
                    placeholder="Your own working notes. Never auto-generated."
                    className="mt-2 border-console-border bg-console-deep text-[11px] text-console-text"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      updateAnalystNotes(active.id, noteDraft);
                      refresh();
                      toast.success("Notes saved.");
                    }}
                    className="mt-2 h-7 gap-1 text-[10px]"
                  >
                    <Save className="size-3" /> Save notes
                  </Button>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-console-border bg-console-deep/60 p-2">
      <div className="text-[9px] uppercase tracking-wider text-console-label">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-bold text-console-text">{value}</div>
      {sub && <div className="mt-0.5 text-[9px] leading-tight text-console-muted">{sub}</div>}
    </div>
  );
}
