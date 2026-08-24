import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Activity, AlertTriangle } from "lucide-react";
import { getLlmStats } from "@/utils/llm";

/**
 * Live free-tier burn monitor.
 *
 * Both providers are request-limited rather than rupee-limited on their free
 * tiers, so the number that matters during a demo is calls made and how many of
 * them the cache absorbed. Counters are per-process and reset when the container
 * restarts or scales to zero — that is stated in the UI rather than implied,
 * because a "0 calls" readout after a restart otherwise looks like unused quota.
 */

interface Stats {
  configured: boolean;
  primary: { model: string; baseUrl: string } | null;
  fallback: { model: string; baseUrl: string } | null;
  totalCalls: number;
  cacheHits: number;
  failures: number;
  cacheSize: number;
  cacheLimit: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number;
}

export function LlmQuotaCard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setStats((await getLlmStats()) as Stats);
      setError("");
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-start gap-2 p-3">
          <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
          <span className="font-mono text-[10px] text-console-red">
            LLM stats unavailable: {error}
          </span>
        </CardContent>
      </Card>
    );
  }

  if (!stats) return null;

  const hitRate = stats.totalCalls > 0 ? Math.round((stats.cacheHits / stats.totalCalls) * 100) : 0;

  const row = (label: string, value: string) => (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </div>
  );

  return (
    <Card>
      <CardContent className="space-y-1.5 p-3 font-mono text-[10px]">
        <div className="flex items-center gap-1.5 pb-1">
          <Activity className="size-3.5 text-console-green" />
          <span className="text-[10px] font-bold uppercase tracking-wider">AI usage</span>
        </div>

        {!stats.configured ? (
          <div className="text-console-amber">
            No LLM provider configured — AI features will report unavailable.
          </div>
        ) : (
          <>
            {row("Model", stats.primary?.model ?? "—")}
            {stats.fallback && row("Fallback", stats.fallback.model)}
            {row("Calls this process", String(stats.totalCalls))}
            {row("Cache hits", `${stats.cacheHits} (${hitRate}%)`)}
            {row("Failures", String(stats.failures))}
            {row("Cache", `${stats.cacheSize}/${stats.cacheLimit}`)}
            {row("Tokens in/out", `${stats.promptTokens}/${stats.completionTokens}`)}
            {row("Avg latency", `${stats.avgLatencyMs}ms`)}
            <div className="pt-1 text-[9px] leading-relaxed text-muted-foreground">
              Per-process counters. Reset on container restart or scale-to-zero.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
