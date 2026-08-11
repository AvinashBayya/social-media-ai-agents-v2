import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle, Layers, GitCompare, Languages, Scale } from "lucide-react";
import { aiSummariseCluster, aiCompareFraming } from "@/utils/analysis-llm";
import { buildTimeline, type StoryCluster } from "@/utils/analysis";

/**
 * Cross-source panel for one story cluster.
 *
 * Two things here are deterministic and free: the source list and the timeline,
 * both computed by analysis.ts with no model involved. They render immediately
 * and keep rendering when the LLM is unreachable.
 *
 * The synthesis and framing comparison are model calls behind explicit buttons.
 * A feed of 35 stories forms roughly a dozen clusters; firing a synthesis for
 * each on render would exhaust a free tier on a single page load.
 */

interface Synthesis {
  consensus: string;
  disagreements: { point: string; positions: { source: string; claim: string }[] }[];
  uncorroborated: string[];
  confidence: number;
  model: string;
  cacheHit: boolean;
  languages: string[];
  crossLingual: boolean;
  sourcesAnalysed: number;
}

export function ClusterPanel({ cluster }: { cluster: StoryCluster }) {
  const [synth, setSynth] = useState<Synthesis | null>(null);
  const [framing, setFraming] = useState<{ text: string; model: string } | null>(null);
  const [busy, setBusy] = useState<"synth" | "framing" | null>(null);
  const [error, setError] = useState("");

  const timeline = buildTimeline(cluster);
  const independent = cluster.independentDomains.length;

  const run = async (kind: "synth" | "framing") => {
    setBusy(kind);
    setError("");
    try {
      if (kind === "synth") {
        setSynth((await aiSummariseCluster({ data: { cluster } })) as unknown as Synthesis);
      } else {
        const res: any = await aiCompareFraming({ data: { cluster } });
        setFraming({ text: res.text, model: res.model });
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-[#3B82F6]/25 bg-[#3B82F6]/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Layers className="size-3.5 text-[#3B82F6]" />
        <span className="text-xs font-semibold">
          {independent} source{independent === 1 ? "" : "s"} reporting this
        </span>
        {cluster.syndicated && (
          <Badge
            variant="outline"
            className="border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[10px] font-normal text-[#F59E0B]"
            title={
              `Collapsed as syndicated re-publication: ${cluster.syndicatedDomains.join(", ")}. ` +
              `Counting a wire pickup as independent corroboration is how one story ` +
              `is made to look like five.`
            }
          >
            {cluster.syndicatedDomains.length} syndicated copy
            {cluster.syndicatedDomains.length === 1 ? "" : "ies"} collapsed
          </Badge>
        )}
      </div>

      {/* Deterministic — always present, no model call. */}
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{timeline.summary}</p>

      <div className="mt-2 flex flex-wrap gap-1">
        {cluster.independentDomains.map((d) => (
          <Badge key={d} variant="secondary" className="text-[10px] font-normal">
            {d}
            {timeline.brokenBy === d && <span className="ml-1 text-[#10B981]">first</span>}
          </Badge>
        ))}
        {cluster.syndicatedDomains.map((d) => (
          <Badge
            key={`syn-${d}`}
            variant="outline"
            className="text-[10px] font-normal text-muted-foreground line-through"
            title="Near-identical text to another member — counted once, not twice."
          >
            {d}
          </Badge>
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || synth !== null || cluster.members.length < 2}
          onClick={() => run("synth")}
          className="h-7 gap-1 text-xs"
          title={
            cluster.members.length < 2
              ? "Cross-source synthesis needs at least two reports"
              : "Compare what the sources agree and disagree on"
          }
        >
          {busy === "synth" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Scale className="size-3" />
          )}
          Analyse across sources
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || framing !== null || cluster.members.length < 2}
          onClick={() => run("framing")}
          className="h-7 gap-1 text-xs"
        >
          {busy === "framing" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <GitCompare className="size-3" />
          )}
          Compare framing
        </Button>
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
          <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
          <div className="font-mono text-[10px] leading-relaxed text-[#EF4444]">
            <span className="font-bold">AI unavailable.</span> No synthesis was produced.
            <div className="pt-0.5 opacity-80">{error}</div>
          </div>
        </div>
      )}

      {synth && (
        <div className="mt-2 space-y-2 rounded border bg-muted/30 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              AI-generated · {synth.model}
              {synth.cacheHit ? " · cached" : ""}
            </span>
            <span className="text-[10px] text-muted-foreground">
              model-reported confidence {synth.confidence.toFixed(2)}
            </span>
            {synth.crossLingual && (
              <Badge className="gap-1 border-[#8B5CF6]/30 bg-[#8B5CF6]/10 text-[10px] font-normal text-[#8B5CF6]">
                <Languages className="size-2.5" />
                cross-lingual: {synth.languages.join(" + ")}
              </Badge>
            )}
          </div>

          <p className="text-sm leading-relaxed">{synth.consensus}</p>

          {synth.disagreements.length > 0 ? (
            <div className="rounded border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[#F59E0B]">
                Sources disagree ({synth.disagreements.length})
              </div>
              <ul className="mt-1 space-y-1.5">
                {synth.disagreements.map((d, i) => (
                  <li key={i} className="text-[11px]">
                    <div className="font-medium">{d.point}</div>
                    <ul className="mt-0.5 space-y-0.5 pl-3">
                      {d.positions.map((p, j) => (
                        <li key={j} className="text-muted-foreground">
                          <span className="font-mono text-[10px] text-foreground">{p.source}</span>
                          {" — "}
                          {p.claim}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No factual contradictions found between these {synth.sourcesAnalysed} reports.
            </p>
          )}

          {synth.uncorroborated.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Carried by one source only
              </div>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                {synth.uncorroborated.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {framing && (
        <div className="mt-2 rounded border bg-muted/30 p-2.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Framing comparison · {framing.model}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed">{framing.text}</p>
        </div>
      )}
    </div>
  );
}
