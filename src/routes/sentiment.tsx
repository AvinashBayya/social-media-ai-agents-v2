import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AreaChart, Area, ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip,
} from "recharts";
import { Search, Loader2, AlertTriangle, Info, Sparkles, BarChart3 } from "lucide-react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { fetchNews } from "./news";
import { llmAnalyseContent } from "@/utils/llm";
import { LlmQuotaCard } from "@/components/llm-quota";

/**
 * Sentiment Analytics — Module 2.
 *
 * Everything on this page was generated. The 30-day timeline was
 * `30 + Math.sin(i/4)*12 + Math.random()*6` — a plausible-looking series that
 * changed on every render. The emotion distribution was eight fixed
 * percentages, the country comparison six fixed triples, and the headline tiles
 * read "34% · vs 40% last week" with no last week to compare to. A
 * SampleDataBanner sat above it, which labelled the problem without fixing it.
 *
 * Three things are genuinely measurable here and are what remain:
 *
 *   - PUBLICATION VOLUME over time, counted from collected pubDate values.
 *   - CATEGORY MIX from the deterministic keyword classifier in news.tsx.
 *   - SENTIMENT PER ARTICLE, on demand, from the configured model.
 *
 * Aggregate sentiment is built only from articles the analyst actually
 * assessed, and the denominator is shown, because a percentage over 4 of 35
 * articles is a different claim from one over all 35.
 *
 * What is deliberately absent: a 30-day history (nothing persists previous
 * collections), week-on-week deltas (same reason), an emotion wheel (no model
 * here scores Plutchik categories), and per-country sentiment (a feed's region
 * tag is where the outlet publishes, not where an audience reacted).
 */

export const Route = createFileRoute("/sentiment")({
  head: () => ({ meta: [{ title: "Sentiment Analytics — Sentinel AI" }] }),
  component: Page,
});

const CARD = "bg-[#111827] border-[#263548]";

const SENTIMENT_COLOURS: Record<string, string> = {
  positive: "#10B981",
  neutral: "#3B82F6",
  negative: "#F59E0B",
  critical: "#EF4444",
};

interface Story {
  id: string;
  title: string;
  source: string;
  body: string;
  pubDate: string;
  category: string;
}

interface Assessed {
  sentiment: string;
  topic: string;
  threatLevel: string;
  summary: string;
  model: string;
}

function Page() {
  const [target, setTarget] = useState(() => getActiveTarget());
  const [draft, setDraft] = useState(() => getActiveTarget());
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [assessed, setAssessed] = useState<Record<string, Assessed>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [aiError, setAiError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      setAssessed({});
      try {
        const res: any = await fetchNews({ data: { query: target, q: target } });
        if (cancelled) return;
        setStories(
          (res?.stories ?? [])
            .map((s: any, i: number) => ({
              id: String(s.id ?? s.primaryLink ?? i),
              title: s.primaryTitle || "",
              source: s.primarySource || "",
              body: s.body || "",
              pubDate: s.pubDate || "",
              category: s.category || "general",
            }))
            .filter((s: Story) => s.title),
        );
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [target]);

  /** Real publication counts per day, from the feed's own timestamps. */
  const volume = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const s of stories) {
      const t = new Date(s.pubDate).getTime();
      if (!Number.isFinite(t)) continue;
      const day = new Date(t).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    return Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, count]) => ({ day: day.slice(5), count }));
  }, [stories]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of stories) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [stories]);

  const sentimentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of Object.values(assessed)) {
      counts.set(a.sentiment, (counts.get(a.sentiment) ?? 0) + 1);
    }
    return counts;
  }, [assessed]);

  const assessedCount = Object.keys(assessed).length;

  const assess = async (story: Story) => {
    setBusyId(story.id);
    setAiError("");
    try {
      const res: any = await llmAnalyseContent({
        data: { text: `${story.title}\n\n${story.body}`.trim() },
      });
      setAssessed((prev) => ({
        ...prev,
        [story.id]: {
          sentiment: res.sentiment,
          topic: res.topic,
          threatLevel: res.threatLevel,
          summary: res.summary,
          model: res.model,
        },
      }));
    } catch (err: any) {
      setAiError(err?.message ?? String(err));
    } finally {
      setBusyId(null);
    }
  };

  const search = () => {
    const v = draft.trim();
    if (!v) return;
    setActiveTarget(v);
    setTarget(v);
  };

  return (
    <AppShell>
      <PageHeader
        title="Sentiment Analytics"
        description="Publication volume and category mix counted from a live collection; sentiment assessed per article on request."
      />

      <Card className={`${CARD} mb-4`}>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#64748B]" />
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder="Subject to analyse…"
                className="h-8 border-[#263548] bg-[#0B1220] pl-8 text-[11px] text-white"
              />
            </div>
            <Button size="sm" onClick={search} disabled={loading} className="h-8">
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : "Collect"}
            </Button>
            <span className="font-mono text-[10px] text-[#64748B]">
              {stories.length} article(s) · {assessedCount} assessed
            </span>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-[#64748B]">
            <Info className="mt-px size-3 shrink-0" />
            No multi-day sentiment history, week-on-week delta, emotion wheel or per-country
            breakdown is shown. Nothing persists a previous collection to compare against, no
            model here scores emotion categories, and a feed's region tag is where the outlet
            publishes — not where an audience reacted.
          </p>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
              <span className="font-mono text-[10px] leading-relaxed text-[#EF4444]">{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
                <BarChart3 className="size-3.5 text-[#3B82F6]" />
                Publication volume
              </h3>
              {volume.length < 2 ? (
                <p className="mt-2 text-[11px] leading-relaxed text-[#64748B]">
                  {loading
                    ? "Collecting…"
                    : `Collected items span ${volume.length} day(s) — too few to plot a trend. This ` +
                      `counts articles collected, not audience engagement, which an RSS feed does ` +
                      `not carry.`}
                </p>
              ) : (
                <>
                  <div className="mt-3 h-56">
                    <ResponsiveContainer>
                      <AreaChart data={volume} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#263548" vertical={false} />
                        <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#94A3B8" }} axisLine={false} tickLine={false} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "#94A3B8" }} axisLine={false} tickLine={false} />
                        <Tooltip
                          contentStyle={{ background: "#0B1220", border: "1px solid #263548", borderRadius: 6, fontSize: 11 }}
                          labelStyle={{ color: "#94A3B8" }}
                        />
                        <Area type="monotone" dataKey="count" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.25} name="articles" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-[#64748B]">
                    Articles collected per publication day, from each feed's own timestamp. The
                    window is whatever the upstream feeds currently return, not a fixed 30 days.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="size-3.5 text-[#8B5CF6]" />
                <h3 className="text-xs font-bold uppercase text-white">Per-article sentiment</h3>
                <span className="ml-auto font-mono text-[10px] text-[#64748B]">
                  {assessedCount}/{stories.length} assessed
                </span>
              </div>

              {assessedCount > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Array.from(sentimentCounts.entries()).map(([s, n]) => (
                    <Badge
                      key={s}
                      className="text-[10px] font-normal"
                      style={{
                        borderColor: `${SENTIMENT_COLOURS[s] ?? "#64748B"}66`,
                        background: `${SENTIMENT_COLOURS[s] ?? "#64748B"}1a`,
                        color: SENTIMENT_COLOURS[s] ?? "#94A3B8",
                      }}
                    >
                      {s} {n}/{assessedCount}
                    </Badge>
                  ))}
                </div>
              )}

              {aiError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
                  <div className="font-mono text-[10px] leading-relaxed text-[#EF4444]">
                    <span className="font-bold">AI unavailable.</span> No assessment was produced.
                    <div className="pt-0.5 opacity-80">{aiError}</div>
                  </div>
                </div>
              )}

              <div className="mt-3 space-y-2">
                {loading && (
                  <div className="flex items-center gap-2 text-[11px] text-[#94A3B8]">
                    <Loader2 className="size-3.5 animate-spin" /> Collecting…
                  </div>
                )}
                {!loading && stories.length === 0 && !error && (
                  <p className="text-[11px] text-[#64748B]">
                    Nothing collected for this subject.
                  </p>
                )}
                {stories.map((s) => {
                  const a = assessed[s.id];
                  return (
                    <div key={s.id} className="rounded border border-[#263548] bg-[#0B1220]/60 p-2.5">
                      <div className="flex items-center gap-2 font-mono text-[10px] text-[#64748B]">
                        <span className="truncate">{s.source}</span>
                        {a && (
                          <span
                            className="ml-auto shrink-0 font-semibold"
                            style={{ color: SENTIMENT_COLOURS[a.sentiment] ?? "#94A3B8" }}
                          >
                            {a.sentiment} · {a.topic} · threat {a.threatLevel}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[#F3F4F6]">
                        {s.title}
                      </p>
                      {a ? (
                        <p className="mt-1 text-[10px] leading-relaxed text-[#94A3B8]">
                          {a.summary}{" "}
                          <span className="text-[#64748B]">— {a.model}</span>
                        </p>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId !== null}
                          onClick={() => assess(s)}
                          className="mt-1.5 h-6 gap-1 text-[10px]"
                        >
                          {busyId === s.id ? (
                            <Loader2 className="size-2.5 animate-spin" />
                          ) : (
                            <Sparkles className="size-2.5" />
                          )}
                          Assess sentiment
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="mt-2 text-[10px] leading-relaxed text-[#64748B]">
                One model call per article, on request — assessing a whole feed automatically
                would exhaust a request-limited free tier on a single page load. Aggregate
                counts above are over assessed articles only, and the denominator is shown for
                that reason.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <LlmQuotaCard />

          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="text-xs font-bold uppercase text-white">Category mix</h3>
              {categories.length === 0 ? (
                <p className="mt-2 text-[11px] text-[#64748B]">Nothing collected yet.</p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {categories.map(([name, count]) => (
                    <div key={name} className="flex items-center gap-2">
                      <span className="w-24 shrink-0 truncate font-mono text-[10px] text-[#94A3B8]">
                        {name}
                      </span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#0B1220]">
                        <div
                          className="h-full rounded-full bg-[#3B82F6]"
                          style={{ width: `${(count / stories.length) * 100}%` }}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-white">
                        {count}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-[#64748B]">
                Deterministic keyword classifier, matched on word boundaries. Coarse by design
                and no model is involved — an article can only fall in the first bucket that
                matches.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
