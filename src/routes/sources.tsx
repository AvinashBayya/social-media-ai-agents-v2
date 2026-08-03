import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Gauge, ChevronDown, ChevronRight, Loader2, AlertTriangle, RotateCcw, Save, Sparkles,
} from "lucide-react";
import { fetchNews } from "./news";
import { llmAssessLanguage } from "@/utils/llm";
import {
  FACTORS, DEFAULT_WEIGHTS, BUILTIN_PROFILES, fetchDomainAges, scoreAll, bandFor, domainOf,
  type ScorableArticle, type ScoringContext, type Weights, type WeightProfile,
} from "@/utils/credibility";
import { getActiveTarget } from "@/utils/active-target";

export const Route = createFileRoute("/sources")({
  head: () => ({ meta: [{ title: "Source Credibility — Sentinel AI" }] }),
  component: SourcesPage,
});

const CARD = "bg-[#111827] border-[#263548]";
const DIM = "text-[#64748B]";
const MUTED = "text-[#94A3B8]";
const PROFILE_KEY = "sentinel_weight_profiles";

type LanguageMap = NonNullable<ScoringContext["language"]>;

const TONE: Record<string, string> = {
  high: "border-[#10B981]/30 bg-[#10B981]/10 text-[#10B981]",
  medium: "border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[#F59E0B]",
  low: "border-[#EF4444]/30 bg-[#EF4444]/10 text-[#EF4444]",
  unknown: "border-[#64748B]/30 bg-[#64748B]/10 text-[#94A3B8]",
};

function SourcesPage() {
  const [articles, setArticles] = useState<ScorableArticle[]>([]);
  const [domainAges, setDomainAges] = useState<Record<string, string | null>>({});
  const [language, setLanguage] = useState<LanguageMap>({});
  const [weights, setWeights] = useState<Weights>({ ...DEFAULT_WEIGHTS });
  const [profiles, setProfiles] = useState<WeightProfile[]>(BUILTIN_PROFILES);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [llmBusy, setLlmBusy] = useState<string | null>(null);
  const [llmError, setLlmError] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      const saved = localStorage.getItem(PROFILE_KEY);
      if (saved) setProfiles([...BUILTIN_PROFILES, ...JSON.parse(saved)]);
    } catch {
      /* corrupt profile store is not worth failing the page over */
    }
  }, []);

  // Ingest the real feed. No seed data — an empty feed shows as empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const res: any = await fetchNews({ data: { query: getActiveTarget() } });
        if (cancelled) return;

        const mapped: ScorableArticle[] = (res?.stories ?? []).map((s: any, i: number) => ({
          id: `${s.primaryLink || s.url || i}`,
          title: s.primaryTitle || "",
          source: s.primarySource || "",
          url: s.primaryLink || s.url || "",
          pubDate: s.pubDate || "",
          body: s.body || s.contentSnippet || "",
        })).filter((a: ScorableArticle) => a.title);

        setArticles(mapped);

        const domains = Array.from(
          new Set(mapped.map((a) => domainOf(a.url) || domainOf(a.source)).filter(Boolean)),
        );
        if (domains.length) {
          try {
            const ages = await fetchDomainAges({ data: { domains } });
            if (!cancelled) setDomainAges(ages);
          } catch {
            // Domain age is one factor of six; it reports itself uncomputable.
          }
        }
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const ctx: ScoringContext = useMemo(
    () => ({ all: articles, domainAges, language }),
    [articles, domainAges, language],
  );

  // Recomputed on every weight change — this is what makes the sliders live.
  const scored = useMemo(() => scoreAll(articles, ctx, weights), [articles, ctx, weights]);

  const assessLanguage = useCallback(async (a: ScorableArticle) => {
    if (language[a.id] || llmBusy) return;
    setLlmBusy(a.id);
    setLlmError((p) => ({ ...p, [a.id]: "" }));
    try {
      const res = await llmAssessLanguage({ data: { text: `${a.title}\n\n${a.body ?? ""}`.trim() } });
      setLanguage((p) => ({
        ...p,
        [a.id]: {
          emotiveLoad: res.emotiveLoad, hedging: res.hedging,
          absolutism: res.absolutism, sensationalism: res.sensationalism,
          rationale: res.rationale,
        },
      }));
    } catch (err: any) {
      setLlmError((p) => ({ ...p, [a.id]: err?.message ?? String(err) }));
    } finally {
      setLlmBusy(null);
    }
  }, [language, llmBusy]);

  const saveProfile = () => {
    const name = prompt("Profile name");
    if (!name?.trim()) return;
    const next: WeightProfile = { id: `custom-${Date.now()}`, name: name.trim(), weights: { ...weights } };
    const custom = [...profiles.filter((p) => p.id.startsWith("custom-")), next];
    setProfiles([...BUILTIN_PROFILES, ...custom]);
    localStorage.setItem(PROFILE_KEY, JSON.stringify(custom));
  };

  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);

  return (
    <AppShell>
      <PageHeader
        title="Source Credibility"
        description="PS-18 Module 1 — credibility scored on analyst-defined factors, with a per-factor breakdown for every article."
      />

      <div className="grid gap-4 p-6 lg:grid-cols-[320px_1fr]">
        {/* ── Weight controls ─────────────────────────────────────────── */}
        <div className="space-y-3">
          <Card className={`${CARD} space-y-3 p-4`}>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 font-mono text-xs font-bold text-[#F3F4F6]">
                <Gauge className="size-4 text-[#06B6D4]" /> Factor weights
              </span>
              <span className={`font-mono text-[10px] ${DIM}`}>Σ {totalWeight.toFixed(2)}</span>
            </div>

            {FACTORS.map((f) => (
              <div key={f.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-[#F3F4F6]">
                    {f.name}
                    {f.requiresLlm && <Sparkles className="ml-1 inline size-2.5 text-[#8B5CF6]" />}
                  </span>
                  <span className={`font-mono text-[10px] ${MUTED}`}>
                    {(weights[f.id] ?? 0).toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[(weights[f.id] ?? 0) * 100]}
                  max={100}
                  step={1}
                  onValueChange={([v]) => setWeights((p) => ({ ...p, [f.id]: v / 100 }))}
                />
                <p className={`font-mono text-[9px] leading-relaxed ${DIM}`}>{f.description}</p>
              </div>
            ))}

            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => setWeights({ ...DEFAULT_WEIGHTS })}
                className="h-7 flex-1 rounded bg-[#1A2332] font-mono text-[9px] text-[#94A3B8] hover:bg-[#263548]"
              >
                <RotateCcw className="mr-1 size-3" /> Reset
              </Button>
              <Button
                size="sm"
                onClick={saveProfile}
                className="h-7 flex-1 rounded bg-[#06B6D4] font-mono text-[9px] font-bold text-[#0B1220] hover:bg-[#06B6D4]/90"
              >
                <Save className="mr-1 size-3" /> Save
              </Button>
            </div>
          </Card>

          <Card className={`${CARD} space-y-2 p-4`}>
            <span className="font-mono text-xs font-bold text-[#F3F4F6]">Weight profiles</span>
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => setWeights({ ...DEFAULT_WEIGHTS, ...p.weights })}
                className="w-full rounded border border-[#263548] bg-[#0B1220] p-2 text-left font-mono text-[10px] text-[#F3F4F6] hover:border-[#06B6D4]/50"
              >
                {p.name}
              </button>
            ))}
          </Card>
        </div>

        {/* ── Ranked articles ─────────────────────────────────────────── */}
        <div className="space-y-3">
          {loading && (
            <Card className={`${CARD} flex items-center gap-2 p-4 font-mono text-xs ${MUTED}`}>
              <Loader2 className="size-4 animate-spin" /> Ingesting live feed…
            </Card>
          )}

          {loadError && (
            <Card className={`${CARD} p-4`}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="size-4 shrink-0 text-[#EF4444]" />
                <div className="font-mono text-[11px] text-[#EF4444]">
                  Feed collection failed — no articles to score.
                  <div className={`pt-1 ${DIM}`}>{loadError}</div>
                </div>
              </div>
            </Card>
          )}

          {!loading && !loadError && scored.length === 0 && (
            <Card className={`${CARD} p-4 font-mono text-xs ${MUTED}`}>
              The feed returned no articles for the active target. Nothing to score.
            </Card>
          )}

          {scored.map((s) => {
            const band = bandFor(s.score);
            const open = expanded === s.article.id;
            return (
              <Card key={s.article.id} className={`${CARD} p-3`}>
                <button
                  onClick={() => setExpanded(open ? null : s.article.id)}
                  className="flex w-full items-start gap-3 text-left"
                >
                  {open ? <ChevronDown className={`mt-0.5 size-4 shrink-0 ${DIM}`} />
                        : <ChevronRight className={`mt-0.5 size-4 shrink-0 ${DIM}`} />}
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] text-[#F3F4F6]">{s.article.title}</div>
                    <div className={`font-mono text-[9px] ${DIM}`}>
                      {s.article.source}
                      {s.article.pubDate && ` · ${new Date(s.article.pubDate).toLocaleString()}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {s.partial && (
                      <Badge className="border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[9px] text-[#F59E0B]">
                        Partial
                      </Badge>
                    )}
                    <Badge className={`text-[10px] ${TONE[band.tone]}`}>
                      {s.score === null ? "—" : s.score.toFixed(2)} {band.label}
                    </Badge>
                  </div>
                </button>

                {open && (
                  <div className="mt-3 space-y-2 border-t border-[#263548] pt-3">
                    {s.factors.map((f) => (
                      <div key={f.id} className="space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] text-[#F3F4F6]">
                            {f.name}
                            <span className={DIM}> · weight {f.weight.toFixed(2)}</span>
                          </span>
                          <span
                            className={`font-mono text-[10px] ${
                              f.score === null ? DIM : "text-[#06B6D4]"
                            }`}
                          >
                            {f.score === null ? "not computed" : f.score.toFixed(2)}
                          </span>
                        </div>
                        <p className={`font-mono text-[9px] leading-relaxed ${MUTED}`}>{f.detail}</p>
                      </div>
                    ))}

                    {/* Linguistic factor is opt-in per article to protect free-tier quota. */}
                    {!language[s.article.id] && (
                      <div className="pt-1">
                        <Button
                          size="sm"
                          disabled={llmBusy === s.article.id}
                          onClick={() => assessLanguage(s.article)}
                          className="h-7 rounded bg-[#8B5CF6] px-3 font-mono text-[9px] font-bold text-[#F3F4F6] hover:bg-[#8B5CF6]/90"
                        >
                          {llmBusy === s.article.id
                            ? <><Loader2 className="mr-1 size-3 animate-spin" /> Assessing…</>
                            : <><Sparkles className="mr-1 size-3" /> Run language assessment</>}
                        </Button>
                        {llmError[s.article.id] && (
                          <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
                            <AlertTriangle className="size-3 shrink-0 text-[#EF4444]" />
                            <span className="font-mono text-[9px] leading-relaxed text-[#EF4444]">
                              AI unavailable — the other five factors still produced the score
                              above, marked Partial. {llmError[s.article.id]}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    <a
                      href={s.article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block pt-1 font-mono text-[9px] text-[#3B82F6] hover:underline"
                    >
                      Open source article →
                    </a>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
