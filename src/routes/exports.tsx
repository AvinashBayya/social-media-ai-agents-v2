import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, FileText, Sparkles, RefreshCw, CheckCircle2, FileCode, FileSpreadsheet, AlertTriangle } from "lucide-react";
import { getActiveTarget } from "@/utils/active-target";
import { fetchNews, fetchSocialIntelligence, fetchOSINT } from "./news";
import { llmReport } from "@/utils/llm";
import { defaultFactors, scoreCorpus, type Article } from "@/utils/credibility";
import { compileReportText, generatePDFBlob, generateHTML, generateCSV, generateJSON } from "@/utils/export-helpers";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/exports")({
  head: () => ({ meta: [{ title: "Exports — Sentinel AI" }] }),
  component: ExportsPage,
});

function ExportsPage() {
  const activeTarget = getActiveTarget();
  const [loadingFormat, setLoadingFormat] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<{ format: string; text: string; model: string } | null>(null);
  const [exportError, setExportError] = useState("");

  const handleExport = async (format: string) => {
    setLoadingFormat(format);
    setExportError("");
    toast.info(`Gathering live intelligence & generating AI analysis for "${activeTarget}"...`);

    try {
      // 1. Fetch real intelligence data across modules
      const [newsRes, socialRes, osintRes] = await Promise.all([
        fetchNews({ data: { query: activeTarget, q: activeTarget } }),
        fetchSocialIntelligence({ data: { query: activeTarget, q: activeTarget } }),
        fetchOSINT({ data: { query: activeTarget, q: activeTarget } })
      ]);

      // 2. Score the collected corpus with Module 1 so the dossier carries a
      //    real credibility figure rather than a constant. Default weights, and
      //    the export says so — a retuned profile would give a different number.
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

      const scored = corpus.length ? scoreCorpus(corpus, defaultFactors()) : [];
      const usable = scored.filter((s) => s.score !== null);
      const meanCredibility = usable.length
        ? Math.round((usable.reduce((sum, s) => sum + (s.score ?? 0), 0) / usable.length) * 100)
        : null;

      // 3. Generate the narrative from the ACTUAL collected material. Passing
      //    only counts, as this did, gives the model nothing to work from and
      //    invites it to pad an intelligence dossier out of its own priors.
      const collected =
        `Target: ${activeTarget}\n` +
        `Collected ${corpus.length} news item(s), ${socialRes?.mentions?.length ?? 0} social mention(s).\n` +
        (osintRes?.whois?.Registrar ? `WHOIS registrar: ${osintRes.whois.Registrar}\n` : "") +
        (meanCredibility !== null
          ? `Mean source credibility across the collected corpus: ${meanCredibility}% (Module 1, default weights).\n`
          : "") +
        `\nHEADLINES COLLECTED:\n` +
        corpus.slice(0, 25).map((a, i) => `${i + 1}. [${a.source}] ${a.title}`).join("\n");

      const aiReport = await llmReport({
        data: {
          type: "Comprehensive OSINT Intelligence Dossier",
          target: activeTarget,
          data: collected,
        }
      });

      const config = {
        reportType: "Classified Intelligence Dossier",
        format: format,
        sections: {
          summary: true,
          threats: true,
          risk: true,
          timeline: true,
          findings: true,
          entities: true,
          relationships: true,
          sentiment: true,
          media: true,
          evidence: true,
          recommendations: true,
          confidence: true,
          references: true
        },
        query: activeTarget,
        analyst: "Unassigned (no authenticated user)",
        data: {
          profile: {
            summary: aiReport.text,
            // NOT a number. `risk: 75` used to be printed into the exported PDF
            // as "Subject overall risk rating: 75/100" under a classification
            // header. Nothing in this system computes a subject risk score, so
            // the dossier now says that in words instead.
            risk: null,
            credibility: meanCredibility,
            credibilityBasis:
              meanCredibility === null
                ? ""
                : `mean of Module 1 scores across ${usable.length} of ${corpus.length} ` +
                  `collected item(s); ${corpus.length - usable.length} could not be scored`,
            findings: [
              `Target "${activeTarget}" appears in ${corpus.length} collected news item(s).`,
              `Social mentions collected in this run: ${socialRes?.mentions?.length ?? 0}.`,
              ...(osintRes?.whois?.Registrar
                ? [`WHOIS registrar: ${osintRes.whois.Registrar}.`]
                : ["No WHOIS registrar was returned for this target."]),
              ...(meanCredibility !== null
                ? [`Mean source credibility ${meanCredibility}% across scored items (Module 1, default weights).`]
                : ["Source credibility could not be scored — no collected item yielded a usable factor."]),
            ],
            // Recommendations are the model's, derived from the collected
            // material above. The two hardcoded lines that used to sit here
            // ("Perform continuous C2 subnet scans") were printed as though an
            // analyst had reached them.
            recommendations: [],
          },
          stories: newsRes?.stories || [],
          socialMentions: socialRes?.mentions || [],
          osintCyberThreats: []
        }
      };

      let blob: Blob;
      let filename = `Sentinel_Intel_${activeTarget.replace(/[^a-zA-Z0-9]/g, "_")}_${new Date().toISOString().slice(0, 10)}`;

      if (format === "pdf") {
        blob = await generatePDFBlob(config);
        filename += ".pdf";
      } else if (format === "html") {
        const htmlStr = generateHTML(config);
        blob = new Blob([htmlStr], { type: "text/html" });
        filename += ".html";
      } else if (format === "json") {
        const jsonStr = generateJSON(config);
        blob = new Blob([jsonStr], { type: "application/json" });
        filename += ".json";
      } else if (format === "csv") {
        const csvStr = generateCSV(config);
        blob = new Blob([csvStr], { type: "text/csv" });
        filename += ".csv";
      } else {
        const textStr = compileReportText(config);
        blob = new Blob([textStr], { type: "text/plain" });
        filename += ".md";
      }

      // Trigger browser download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setLastExport({ format, text: aiReport.text, model: aiReport.model });
      toast.success(`Successfully exported ${filename}`);
    } catch (err: any) {
      // The real upstream cause, not "please try again". A truncated model
      // response and a revoked API key need different actions from the analyst,
      // and a generic toast makes them indistinguishable.
      const message = err?.message ?? String(err);
      setExportError(message);
      toast.error(`Export failed: ${message.slice(0, 120)}`);
    } finally {
      setLoadingFormat(null);
    }
  };

  return (
    <AppShell>
      <PageHeader
        title="Intelligence Export Manager"
        description="Fetch live intelligence telemetry, run AI analysis, and export ready-to-file PDF, HTML, JSON, CSV, or Markdown reports."
      />

      <div className="p-6 space-y-6 font-mono text-xs">
        <Card className="bg-[#111827] border-[#263548] p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Badge className="bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 text-xs">
                ACTIVE EXPORT TARGET: {activeTarget.toUpperCase()}
              </Badge>
              <div className="text-sm font-bold text-[#F3F4F6]">
                Select Export Document Format
              </div>
            </div>
            <span className="text-xs text-[#94A3B8]">Classification: UNCLASSIFIED // DEMONSTRATOR</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {[
              { id: "pdf", name: "PDF Dossier", icon: FileText, desc: "A4 Printable Executive PDF" },
              { id: "html", name: "HTML Briefing", icon: FileCode, desc: "Interactive Web Report" },
              { id: "markdown", name: "Markdown File", icon: FileText, desc: "Formatted Plain Text" },
              { id: "json", name: "JSON Data", icon: FileCode, desc: "Structured Telemetry JSON" },
              { id: "csv", name: "CSV Spreadsheet", icon: FileSpreadsheet, desc: "Tabular Data Sheet" }
            ].map((f) => {
              const Icon = f.icon;
              const isWorking = loadingFormat === f.id;
              return (
                <Card key={f.id} className="bg-[#0B1220] border-[#263548] p-4 flex flex-col justify-between space-y-3">
                  <div className="space-y-1.5">
                    <Icon className="size-5 text-[#10B981]" />
                    <div className="font-bold text-[#F3F4F6] text-xs">{f.name}</div>
                    <div className="text-[10px] text-[#94A3B8]">{f.desc}</div>
                  </div>
                  <Button
                    disabled={!!loadingFormat}
                    onClick={() => handleExport(f.id)}
                    className="w-full h-8 bg-[#10B981] hover:bg-[#059669] text-black font-bold text-[10px] gap-1.5"
                  >
                    {isWorking ? (
                      <>
                        <RefreshCw className="size-3 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Download className="size-3" />
                        Export {f.id.toUpperCase()}
                      </>
                    )}
                  </Button>
                </Card>
              );
            })}
          </div>
        </Card>

        {exportError && (
          <Card className="border-[#EF4444]/40 bg-[#111827] p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="size-4 shrink-0 text-[#EF4444]" />
              <div className="text-[10px] leading-relaxed text-[#EF4444]">
                <span className="font-bold">Export failed. No file was written.</span>
                <div className="pt-0.5 opacity-80">{exportError}</div>
              </div>
            </div>
          </Card>
        )}

        {lastExport && (
          <Card className="bg-[#111827] border-[#263548] p-6 space-y-3">
            <h3 className="text-sm font-bold text-[#10B981] flex items-center gap-2">
              <Sparkles className="size-4" />
              {/* Was hardcoded "GEMINI AI" — a model this project does not and
                  cannot use, and which would mislabel whatever actually ran. */}
              AI-GENERATED SUMMARY · {lastExport.model} ({lastExport.format.toUpperCase()})
            </h3>
            <pre className="text-xs text-[#CBD5E1] bg-[#0B1220] p-4 rounded border border-[#263548] whitespace-pre-wrap leading-relaxed">
              {lastExport.text}
            </pre>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
