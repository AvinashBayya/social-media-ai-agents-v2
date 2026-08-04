import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TrendingUp, Loader2, AlertTriangle, Search, Info, Layers } from "lucide-react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { fetchNews } from "./news";
import {
  clusterStories, corpusTerms, detectLanguage,
  type Article, type Keyword, type StoryCluster,
} from "@/utils/analysis";

/**
 * Trend Analytics — Module 2, corpus-level.
 *
 * This page carried eight hardcoded topics with invented volumes and growth
 * rates ("#ElectionIntegrity · 412,000 · +184%") and a twenty-word "topic
 * cloud" with fixed weights. Nothing measured any of it, and the growth rates
 * in particular implied a previous measurement that never existed.
 *
 * It now runs TF-IDF over a live collection, which Module 2 already implements
 * and Module 1 already consumes. Two deliberate absences:
 *
 *   - No growth rate. Reporting "+184%" needs a previous collection to compare
 *     against, and nothing persists one. An invented delta is the most
 *     convincing-looking number on a trends page and the least defensible.
 *   - No engagement volume. We collect articles, not impressions. "412,000"
 *     was never measurable from an RSS feed.
 *
 * What IS measurable — how many collected documents carry a term, how many
 * independent outlets a story reached, and the language mix — is shown instead.
 */

export const Route = createFileRoute("/trends")({
  head: () => ({ meta: [{ title: "Trend Analytics — Sentinel AI" }] }),
  component: Page,
});

const CARD = "bg-[#111827] border-[#263548]";

function Page() {
  const [target, setTarget] = useState(() => getActiveTarget());
  const [draft, setDraft] = useState(() => getActiveTarget());
  const [corpus, setCorpus] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res: any = await fetchNews({ data: { query: target, q: target } });
        if (cancelled) return;
        setCorpus(
          (res?.stories ?? [])
            .map((s: any, i: number) => ({
              id: String(s.id ?? s.primaryLink ?? i),
              title: s.primaryTitle || "",
              source: s.primarySource || "",
              url: s.primaryLink || s.url || "",
              pubDate: s.pubDate || "",
              body: s.body || "",
            }))
            .filter((a: Article) => a.title),
        );
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [target]);

  const terms = useMemo<Keyword[]>(() => corpusTerms(corpus, 20), [corpus]);
  const clusters = useMemo<StoryCluster[]>(() => clusterStories(corpus), [corpus]);

  /** Language mix, from the deterministic script detector. No model involved. */
  const languages = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of corpus) {
      const name = detectLanguage(a).name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [corpus]);

  const maxDocs = Math.max(1, ...terms.map((t) => t.documentCount));
  const reachingStories = clusters.filter((c) => c.independentDomains.length > 1);

  const search = () => {
    const v = draft.trim();
    if (!v) return;
    setActiveTarget(v);
    setTarget(v);
  };

  return (
    <AppShell>
      <PageHeader
        title="Trend Analytics"
        description="Term frequency and story reach across a live collection. Every figure is counted from collected documents."
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
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : "Analyse"}
            </Button>
            <span className="font-mono text-[10px] text-[#64748B]">
              {corpus.length} document(s) collected for "{target}"
            </span>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-[#64748B]">
            <Info className="mt-px size-3 shrink-0" />
            No growth percentage is shown. That would need a previous collection to compare
            against and nothing stores one — an invented delta is the most convincing-looking
            number on a page like this and the least defensible. No engagement volume either:
            this collects articles, not impressions.
          </p>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
              <span className="font-mono text-[10px] leading-relaxed text-[#EF4444]">{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card className={CARD}>
          <CardContent className="p-4">
            <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
              <TrendingUp className="size-3.5 text-[#3B82F6]" />
              Dominant terms
            </h3>

            {loading ? (
              <div className="flex items-center gap-2 py-6 text-[11px] text-[#94A3B8]">
                <Loader2 className="size-3.5 animate-spin" /> Collecting…
              </div>
            ) : terms.length === 0 ? (
              <p className="mt-3 text-[11px] leading-relaxed text-[#64748B]">
                Not enough collected documents to rank terms. TF-IDF needs at least two
                documents to have anything to be inverse-frequent against, and a term appearing
                in only one document says nothing about the collection.
              </p>
            ) : (
              <>
                <div className="mt-3 space-y-1.5">
                  {terms.map((t) => (
                    <div key={t.term} className="flex items-center gap-2">
                      <span className="w-32 shrink-0 truncate font-mono text-[11px] text-[#F3F4F6]">
                        {t.term}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#0B1220]">
                        <div
                          className="h-full rounded-full bg-[#3B82F6]"
                          style={{ width: `${(t.documentCount / maxDocs) * 100}%` }}
                        />
                      </div>
                      <span
                        className="w-24 shrink-0 text-right font-mono text-[10px] text-[#94A3B8]"
                        title={`TF-IDF score ${t.score.toFixed(4)}`}
                      >
                        {t.documentCount}/{corpus.length} docs
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[10px] leading-relaxed text-[#64748B]">
                  Ranked by TF-IDF across this collection; the bar shows how many collected
                  documents contain the term, which is the part an analyst can check. Hover a
                  row for the raw score.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
                <Layers className="size-3.5 text-[#8B5CF6]" />
                Widest-reaching stories
              </h3>
              {reachingStories.length === 0 ? (
                <p className="mt-2 text-[11px] leading-relaxed text-[#64748B]">
                  {loading
                    ? "Collecting…"
                    : "No story in this collection was carried by more than one independent outlet."}
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  {reachingStories.slice(0, 6).map((c) => (
                    <div key={c.id} className="rounded border border-[#263548] bg-[#0B1220]/60 p-2">
                      <p className="line-clamp-2 text-[11px] leading-snug text-[#F3F4F6]">
                        {c.title}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant="outline"
                          className="border-[#8B5CF6]/40 bg-[#8B5CF6]/10 text-[9px] font-normal text-[#8B5CF6]"
                        >
                          {c.independentDomains.length} independent sources
                        </Badge>
                        {c.syndicated && (
                          <Badge
                            variant="outline"
                            className="border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[9px] font-normal text-[#F59E0B]"
                          >
                            {c.syndicatedDomains.length} syndicated collapsed
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-[#64748B]">
                Reach measured as distinct outlets carrying one story, after collapsing
                syndicated copies — counting wire pickups separately is how one story is made
                to look like five.
              </p>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="text-xs font-bold uppercase text-white">Language mix</h3>
              {languages.length === 0 ? (
                <p className="mt-2 text-[11px] text-[#64748B]">Nothing collected yet.</p>
              ) : (
                <div className="mt-2 space-y-1">
                  {languages.map(([name, count]) => (
                    <div key={name} className="flex items-center justify-between font-mono text-[10px]">
                      <span className="truncate text-[#94A3B8]">{name}</span>
                      <span className="shrink-0 tabular-nums text-white">{count}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-[#64748B]">
                Detected from Unicode script ranges — deterministic, no model call. Scripts
                carrying several languages (Devanagari, Bengali) are reported at script level
                rather than guessed.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
