import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, AlertTriangle, Tags } from "lucide-react";
import { llmSummarise, llmExtractEntities } from "@/utils/llm";

/**
 * Per-article AI panel.
 *
 * Runs on explicit user action only — never automatically on feed render. The
 * free tier is request-limited, and an analyst does not want 35 model calls
 * fired because a page loaded.
 *
 * Every AI-produced element is labelled with the model that produced it. In a
 * defence context the provenance of an assertion matters as much as the
 * assertion, and the model is now swappable, so a hardcoded label would drift.
 *
 * On failure this renders the error. It never renders a fallback summary.
 */

interface Props {
  title: string;
  body?: string;
  source?: string;
}

interface Entity {
  entity: string;
  type: string;
  confidence: number;
}

const TYPE_COLOURS: Record<string, string> = {
  PERSON: "border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[#3B82F6]",
  ORGANISATION: "border-[#8B5CF6]/30 bg-[#8B5CF6]/10 text-[#8B5CF6]",
  LOCATION: "border-[#10B981]/30 bg-[#10B981]/10 text-[#10B981]",
  EQUIPMENT: "border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[#F59E0B]",
  EVENT: "border-[#06B6D4]/30 bg-[#06B6D4]/10 text-[#06B6D4]",
  OTHER: "border-[#64748B]/30 bg-[#64748B]/10 text-[#94A3B8]",
};

export function ArticleAiPanel({ title, body, source }: Props) {
  const [summary, setSummary] = useState<string>("");
  const [keyPoints, setKeyPoints] = useState<string[]>([]);
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const [model, setModel] = useState("");
  const [cached, setCached] = useState(false);
  const [busy, setBusy] = useState<"summary" | "entities" | null>(null);
  const [error, setError] = useState("");

  const text = `${title}\n\n${body ?? ""}`.trim();

  const runSummary = async () => {
    setBusy("summary");
    setError("");
    try {
      const res: any = await llmSummarise({ data: { text, source } });
      setSummary(res.summary);
      setKeyPoints(res.keyPoints ?? []);
      setModel(res.model);
      setCached(res.cacheHit);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  const runEntities = async () => {
    setBusy("entities");
    setError("");
    try {
      const res: any = await llmExtractEntities({ data: { text } });
      setEntities(res.entities ?? []);
      setModel(res.model);
      setCached(res.cacheHit);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || Boolean(summary)}
          onClick={runSummary}
          className="h-7 gap-1 text-xs"
        >
          {busy === "summary" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Sparkles className="size-3" />
          )}
          Summarise
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || entities !== null}
          onClick={runEntities}
          className="h-7 gap-1 text-xs"
        >
          {busy === "entities" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Tags className="size-3" />
          )}
          Extract entities
        </Button>
        {model && (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {cached ? "cached · " : ""}
            {model}
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
          <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
          <div className="font-mono text-[10px] leading-relaxed text-[#EF4444]">
            <span className="font-bold">AI unavailable.</span> No summary was produced.
            <div className="pt-0.5 opacity-80">{error}</div>
          </div>
        </div>
      )}

      {summary && (
        <div className="rounded border bg-muted/30 p-2.5">
          <div className="mb-1 flex items-center gap-1.5">
            <Sparkles className="size-3 text-[#8B5CF6]" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              AI-generated · {model}
            </span>
          </div>
          <p className="text-sm leading-relaxed">{summary}</p>
          {keyPoints.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {keyPoints.map((k, i) => (
                <li key={i}>{k}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {entities && entities.length === 0 && (
        <p className="font-mono text-[10px] text-muted-foreground">
          {model} extracted no entities from this text.
        </p>
      )}

      {entities && entities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entities.map((e, i) => (
            <Badge
              key={`${e.entity}-${i}`}
              className={`text-[10px] font-normal ${TYPE_COLOURS[e.type] ?? TYPE_COLOURS.OTHER}`}
              title={`${e.type} · model-reported confidence ${e.confidence}`}
            >
              {e.entity}
              <span className="ml-1 opacity-60">{e.confidence.toFixed(2)}</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
