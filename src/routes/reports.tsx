import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileBarChart, Sparkles, AlertTriangle, Loader2, Info } from "lucide-react";
import { getActiveTarget } from "@/utils/active-target";
import { llmReport } from "@/utils/llm";
import { fetchNews } from "./news";
import { clusterStories, type Article } from "@/utils/analysis";
import { bandFor, defaultFactors, scoreCorpus } from "@/utils/credibility";
import { useState } from "react";
import { toast } from "sonner";

/**
 * Report generator — Module 5 (PS-18 §6.5).
 *
 * Two things were wrong here and both mattered.
 *
 * The report was generated from NOTHING. The prompt received
 * `"Target: X. Report generation requested."` and the model was asked for a
 * structured intelligence report with sections for Key Findings, Threat
 * Assessment and Entity Analysis. With no material to work from, the only way
 * to satisfy that instruction is to invent it — a fabrication generator with a
 * Generate button on it. Reports are now compiled from a live collection, and
 * refuse to run when nothing was collected.
 *
 * The output was captioned "GEMINI 2.0 FLASH" regardless of what actually ran.
 * Gemini was removed from this project and is barred by the open-source-LLM
 * constraint; the label was both wrong and a hard-constraint violation. The
 * model that produced the text is now reported from the response.
 */

export const Route = createFileRoute("/reports")({
  head: () => ({ meta: [{ title: "Reports — Sentinel AI" }] }),
  component: ReportsPage,
});

const REPORT_TYPES = [
  "Executive Brief",
  "Intelligence Dossier",
  "Daily SITREP",
  "Social Intel Summary",
  "Threat Assessment",
  "Media Verification Report",
];

interface Output {
  type: string;
  text: string;
  model: string;
  cacheHit: boolean;
  itemsUsed: number;
  sourcesUsed: number;
  meanCredibility: number | null;
}

function ReportsPage() {
  const [activeTarget] = useState(() => getActiveTarget());
  const [output, setOutput] = useState<Output | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const handleGenerate = async (type: string) => {
    setBusy(type);
    setError("");
    setOutput(null);

    try {
      // 1. Collect. A report with no collection behind it is a creative writing
      //    exercise wearing a classification header.
      const res: any = await fetchNews({ data: { query: activeTarget, q: activeTarget } });
      const corpus: Article[] = (res?.stories ?? [])
        .map((s: any, i: number) => ({
          id: String(s.id ?? s.primaryLink ?? i),
          title: s.primaryTitle || "",
          source: s.primarySource || "",
          url: s.primaryLink || s.url || "",
          pubDate: s.pubDate || "",
          body: s.body || "",
        }))
        .filter((a: Article) => a.title);

      if (corpus.length === 0) {
        throw new Error(
          `No open-source material was collected for "${activeTarget}", so there is nothing to ` +
            `report on. Refusing to generate — a report written without collection would be the ` +
            `model's invention, not intelligence.`,
        );
      }

      // 2. Score and cluster, so the brief carries real corroboration structure.
      const clusters = clusterStories(corpus);
      const scored = scoreCorpus(corpus, defaultFactors(), { clusters });
      const usable = scored.filter((s) => s.score !== null);
      const meanCredibility = usable.length
        ? usable.reduce((sum, s) => sum + (s.score ?? 0), 0) / usable.length
        : null;

      const sources = new Set(corpus.map((a) => a.source)).size;

      const collected =
        `COLLECTION SUMMARY\n` +
        `Target: ${activeTarget}\n` +
        `Items collected: ${corpus.length} from ${sources} distinct outlet(s)\n` +
        `Distinct stories after clustering: ${clusters.length}\n` +
        `Corroborated by more than one independent source: ` +
        `${clusters.filter((c) => c.independentDomains.length > 1).length}\n` +
        (meanCredibility !== null
          ? `Mean source credibility: ${(meanCredibility * 100).toFixed(0)}% ` +
            `(${bandFor(meanCredibility).label}, Module 1 default weights, ` +
            `${usable.length}/${corpus.length} scorable)\n`
          : `Source credibility: not scorable for any collected item\n`) +
        `\nCOLLECTED MATERIAL\n` +
        clusters
          .slice(0, 20)
          .map((c, i) => {
            const cred = scored.find((s) => s.article.id === c.id)?.score;
            return (
              `${i + 1}. ${c.title}\n` +
              `   Sources (${c.independentDomains.length} independent): ${c.independentDomains.join(", ")}` +
              (c.syndicated ? ` | ${c.syndicatedDomains.length} syndicated copy/copies collapsed` : "") +
              `\n   First reported: ${c.earliest}` +
              (cred != null ? ` | credibility ${(cred * 100).toFixed(0)}%` : "") +
              (c.members[0]?.body ? `\n   ${c.members[0].body.slice(0, 300)}` : "")
            );
          })
          .join("\n\n");

      const report = await llmReport({ data: { type, target: activeTarget, data: collected } });

      setOutput({
        type,
        text: report.text,
        model: report.model,
        cacheHit: report.cacheHit,
        itemsUsed: corpus.length,
        sourcesUsed: sources,
        meanCredibility,
      });
      toast.success(`${type} compiled from ${corpus.length} collected item(s) by ${report.model}.`);
    } catch (err: any) {
      // The real cause. "Failed to generate report" hid whether the provider was
      // down, the key was rejected, or nothing had been collected — three
      // problems with three different responses.
      const message = err?.message ?? String(err);
      setError(message);
      toast.error(message.slice(0, 120));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell>
      <PageHeader
        title="Report Generator"
        description="Compiles briefings from material actually collected for the active target. Every figure in the brief traces to a collection run."
      />

      <div className="p-6 space-y-6">
        <Card className="border-[#263548] bg-[#111827] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <FileBarChart className="size-4 text-[#3B82F6]" />
            <span className="font-mono text-xs font-bold text-[#F3F4F6]">
              Active target: {activeTarget}
            </span>
          </div>
          <p className="mt-1.5 flex items-start gap-1.5 font-mono text-[10px] leading-relaxed text-[#64748B]">
            <Info className="mt-px size-3 shrink-0" />
            Each report runs a fresh collection, scores it with Module 1 and clusters it with
            Module 2 before the model sees anything. If nothing is collected, generation is
            refused rather than producing a brief with no basis.
          </p>
        </Card>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {REPORT_TYPES.map((rt) => (
            <Card
              key={rt}
              className="flex items-center justify-between border-[#263548] bg-[#111827] p-4"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-bold text-[#F3F4F6]">{rt}</div>
                <div className="truncate font-mono text-[10px] text-[#94A3B8]">
                  Target: {activeTarget}
                </div>
              </div>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => handleGenerate(rt)}
                className="ml-2 shrink-0 bg-[#10B981] font-mono text-xs font-bold text-black hover:bg-[#059669]"
              >
                {busy === rt ? <Loader2 className="size-3 animate-spin" /> : "Generate"}
              </Button>
            </Card>
          ))}
        </div>

        {busy && (
          <Card className="border-[#263548] bg-[#111827] p-4">
            <div className="flex items-center gap-2 font-mono text-xs text-[#94A3B8]">
              <Loader2 className="size-3.5 animate-spin text-[#3B82F6]" />
              Collecting open sources for "{activeTarget}", scoring and clustering, then
              compiling the {busy}…
            </div>
          </Card>
        )}

        {error && (
          <Card className="border-[#EF4444]/40 bg-[#111827] p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="size-4 shrink-0 text-[#EF4444]" />
              <div className="font-mono text-[11px] leading-relaxed text-[#EF4444]">
                <span className="font-bold">No report was produced.</span>
                <div className="pt-0.5 opacity-80">{error}</div>
              </div>
            </div>
          </Card>
        )}

        {output && (
          <Card className="space-y-3 border-[#263548] bg-[#111827] p-6">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="size-4 text-[#10B981]" />
              <h3 className="font-mono text-sm font-bold text-[#10B981]">
                {output.type.toUpperCase()}
              </h3>
              <Badge
                variant="outline"
                className="border-[#263548] font-mono text-[9px] font-normal text-[#94A3B8]"
              >
                {output.model}
                {output.cacheHit ? " · cached" : ""}
              </Badge>
            </div>

            <div className="flex flex-wrap gap-3 border-y border-[#263548] py-2 font-mono text-[10px] text-[#94A3B8]">
              <span>{output.itemsUsed} item(s) collected</span>
              <span>{output.sourcesUsed} outlet(s)</span>
              <span>
                mean credibility{" "}
                {output.meanCredibility === null
                  ? "not scorable"
                  : `${(output.meanCredibility * 100).toFixed(0)}% (${bandFor(output.meanCredibility).label})`}
              </span>
            </div>

            <pre className="whitespace-pre-wrap rounded border border-[#263548] bg-[#0B1220] p-4 font-mono text-xs leading-relaxed text-[#CBD5E1]">
              {output.text}
            </pre>

            <p className="font-mono text-[10px] leading-relaxed text-[#64748B]">
              Generated by {output.model} from the {output.itemsUsed} item(s) listed above and
              nothing else. Where the collection did not support a section, the model was
              instructed to write "No supporting data collected" rather than fill it — check
              that it did.
            </p>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
